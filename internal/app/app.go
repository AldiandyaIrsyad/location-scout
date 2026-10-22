// Package app is the composition root: it builds the cache, the upstream fetcher, the services and
// the HTTP handler from a config. Tests use it the same way as cmd/server does.
package app

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"time"

	"panelscape/internal/cache"
	"panelscape/internal/config"
	"panelscape/internal/coords"
	"panelscape/internal/elevation"
	"panelscape/internal/httpapi"
	"panelscape/internal/osm"
	"panelscape/internal/places"
	"panelscape/internal/snapshot"
	"panelscape/internal/upstream"
	"panelscape/web"
)

// Version is reported by /api/about and in the server banner.
const Version = "1.0.0"

// App is a fully wired server. Handler serves the API and the frontend.
type App struct {
	Handler http.Handler

	memory *cache.Instrumented // nil when the memory layer is disabled
	file   *cache.Instrumented // nil when CacheDir is ""
	cancel context.CancelFunc  // stops background work (cache pruning)
}

// New builds the object graph from cfg. The caller owns the HTTP server and calls Close on shutdown.
func New(cfg config.Config, logger *slog.Logger) (*App, error) {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &App{cancel: cancel}

	// Cache: memory (fast, bounded) in front of disk (survives restarts). Both are instrumented.
	var layers []cache.Cache
	var file *cache.File
	if cfg.MemoryCacheMB > 0 {
		a.memory = cache.NewInstrumented("memory", cache.NewMemory(int64(cfg.MemoryCacheMB)<<20, cfg.ResultTTL))
		layers = append(layers, a.memory)
	}
	if cfg.CacheDir != "" {
		f, err := cache.NewFile(cfg.CacheDir, cfg.OSMTTL)
		if err != nil {
			cancel()
			return nil, fmt.Errorf("open cache dir: %w", err)
		}
		file = f
		a.file = cache.NewInstrumented("file", f)
		layers = append(layers, a.file)
	}
	var c cache.Cache = cache.Nop{}
	if len(layers) > 0 {
		c = cache.NewLayered(layers...)
	}
	if file != nil {
		go pruneLoop(ctx, file, logger)
	}

	// Upstream access: one client with a timeout, one fetcher shared by all services.
	// The client's limit is the longest any request may take; the city and surroundings queries
	// get their own (shorter or equal) limits below.
	client := &http.Client{Timeout: max(cfg.UpstreamTimeout, cfg.SurroundingsTimeout)}
	live := upstream.NewHTTPFetcher(client, c, cfg.UserAgent, logger)
	// Recorded responses for the built-in places come first; everything else goes live (unless SNAPSHOT_MODE says otherwise).
	mode, err := snapshot.ParseMode(cfg.SnapshotMode)
	if err != nil {
		cancel()
		return nil, err
	}
	snapshots := snapshot.NewDir(cfg.SnapshotDir)
	if mode != snapshot.ModeOff && !snapshots.Exists() {
		logger.Warn("snapshot directory not found; every request goes live", "dir", cfg.SnapshotDir, "mode", mode)
	}
	fetcher := snapshot.NewFetcher(live, snapshots, mode)

	cityService := osm.NewService(fetcher, cfg.OverpassURLs, cfg.OSMTTL, c, cfg.ResultTTL, logger)
	cityService.CityTimeout = cfg.UpstreamTimeout
	cityService.SurroundingsTimeout = cfg.SurroundingsTimeout
	elevationService := elevation.NewService(fetcher, cfg.TileTTL, c, cfg.ResultTTL, logger)
	placeService, err := places.NewService(fetcher, cfg.NominatimURL, cfg.SearchTTL, logger)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("places: %w", err)
	}

	static, err := staticFiles(cfg.StaticDir)
	if err != nil {
		cancel()
		return nil, err
	}

	a.Handler = httpapi.New(httpapi.Deps{
		City:       cityService,
		Elevation:  elevationService,
		Places:     placeService,
		Locate:     coords.Parse,
		LocateFile: coords.ParseFile,
		Static:     static,
		Logger:     logger,
		Info:       httpapi.About{Name: "Panelscape", Author: config.Author, Version: Version},
		CacheStats: a.cacheStats,
	})

	logger.Info("cache configured",
		"memory_mb", cfg.MemoryCacheMB, "cache_dir", cfg.CacheDir, "snapshot_dir", cfg.SnapshotDir, "snapshot_mode", mode,
		"overpass", len(cfg.OverpassURLs), "static_dir", cfg.StaticDir)
	return a, nil
}

// Close stops background work. It does not shut down the HTTP server; the caller does that.
func (a *App) Close() {
	a.cancel()
}

// cacheStats merges the hit/miss counters of the cache layers.
func (a *App) cacheStats() map[string]int64 {
	out := map[string]int64{}
	for _, layer := range []*cache.Instrumented{a.memory, a.file} {
		if layer == nil {
			continue
		}
		for k, v := range layer.Snapshot() {
			out[k] = v
		}
	}
	return out
}

// staticFiles serves the embedded frontend, or the directory in dir when set (development).
func staticFiles(dir string) (fs.FS, error) {
	if dir == "" {
		return web.FS, nil
	}
	info, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("static dir: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("static dir %q is not a directory", dir)
	}
	return os.DirFS(dir), nil
}

// pruneLoop removes expired disk entries once an hour until ctx is cancelled.
func pruneLoop(ctx context.Context, f *cache.File, logger *slog.Logger) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if err := f.Prune(ctx); err != nil && ctx.Err() == nil {
			logger.Warn("cache prune failed", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
