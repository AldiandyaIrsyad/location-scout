// Command snapshot records the upstream responses (Overpass results and elevation tiles) of the built-in
// places into a snapshot directory, which the server then serves without contacting any third party
// (see internal/snapshot and the SNAPSHOT_DIR / SNAPSHOT_MODE settings).
//
// It asks for exactly what the web app asks for at its defaults: the detail area, the surroundings and the
// elevation grid. Places already in the manifest are skipped unless -force is given, so an interrupted run
// resumes where it stopped. Only the places named by -place (comma separated, case-insensitive substrings
// of the name) or -group are recorded when either is given.
//
//	tools/go.sh run ./cmd/snapshot -place "eiffel,monas"
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"time"

	"panelscape/internal/cache"
	"panelscape/internal/config"
	"panelscape/internal/elevation"
	"panelscape/internal/osm"
	"panelscape/internal/places"
	"panelscape/internal/snapshot"
	"panelscape/internal/upstream"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "snapshot:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg := config.Load()
	dir := flag.String("dir", cfg.SnapshotDir, "snapshot directory to write")
	only := flag.String("place", "", "comma separated name fragments; record only matching places")
	group := flag.String("group", "", "record only this group (Global, Japan, ...)")
	size := flag.Int("size", 300, "detail area in metres (the web default)")
	far := flag.Int("far", 2000, "surroundings in metres (the web default)")
	elevN := flag.Int("elev-n", 161, "elevation samples per side (the web default for surroundings)")
	delay := flag.Duration("delay", 5*time.Second, "pause between places, to go easy on Overpass")
	timeout := flag.Duration("timeout", 3*time.Minute, "limit for one Overpass request")
	force := flag.Bool("force", false, "record places that are already in the manifest again")
	cacheDir := flag.String("cache", "", "optional directory for a fetch cache, so a re-run does not repeat requests")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var fetchCache cache.Cache = cache.Nop{}
	if *cacheDir != "" {
		f, err := cache.NewFile(*cacheDir, cfg.OSMTTL)
		if err != nil {
			return err
		}
		fetchCache = f
	}
	live := upstream.NewHTTPFetcher(&http.Client{Timeout: *timeout}, fetchCache, cfg.UserAgent, logger)
	store := snapshot.NewDir(*dir)
	rec := snapshot.NewRecorder(live, store)

	// Results caches are off: every request must reach the recorder, not be answered from a parsed result.
	city := osm.NewService(rec, cfg.OverpassURLs, cfg.OSMTTL, cache.Nop{}, cfg.ResultTTL, logger)
	city.CityTimeout = *timeout
	city.SurroundingsTimeout = *timeout
	city.RetryDelays = []time.Duration{5 * time.Second, 15 * time.Second, 30 * time.Second}
	city.RetryBudget = 0
	grid := elevation.NewService(rec, cfg.TileTTL, cache.Nop{}, cfg.ResultTTL, logger)
	placeList, err := places.NewService(live, cfg.NominatimURL, cfg.SearchTTL, logger)
	if err != nil {
		return err
	}

	manifest, err := snapshot.LoadManifest(*dir)
	if err != nil {
		return fmt.Errorf("read manifest: %w", err)
	}
	done := map[string]bool{}
	for _, p := range manifest.Places {
		done[p.Name] = true
	}

	var failed []string
	recorded := 0
	for _, p := range placeList.Candidates() {
		if !wanted(p, *only, *group) {
			continue
		}
		if done[p.Name] && !*force {
			logger.Info("already recorded, skipping", "place", p.Name)
			continue
		}
		if ctx.Err() != nil {
			break
		}
		if recorded > 0 {
			select {
			case <-ctx.Done():
			case <-time.After(*delay):
			}
		}
		t0 := time.Now()
		logger.Info("recording", "place", p.Name)
		if _, err := city.City(ctx, p.Lat, p.Lon, *size, 0); err != nil {
			failed = append(failed, p.Name)
			logger.Error("city failed", "place", p.Name, "err", err)
			rec.Drain()
			continue
		}
		if _, err := city.Surroundings(ctx, p.Lat, p.Lon, *size, *far); err != nil {
			failed = append(failed, p.Name)
			logger.Error("surroundings failed", "place", p.Name, "err", err)
			rec.Drain()
			continue
		}
		// Elevation is optional in the web app (it carries on flat without it), so a failure only warns.
		if _, err := grid.Grid(ctx, p.Lat, p.Lon, float64(*far), *elevN); err != nil {
			logger.Warn("elevation failed; the place will be flat offline", "place", p.Name, "err", err)
		}
		files, err := rec.Drain()
		if err != nil {
			failed = append(failed, p.Name)
			logger.Error("writing snapshot failed", "place", p.Name, "err", err)
			continue
		}
		manifest.Set(snapshot.PlaceRecord{Name: p.Name, Lat: p.Lat, Lon: p.Lon, Size: *size, Far: *far, Recorded: time.Now().Format("2006-01-02"), Files: dedupe(files)})
		if err := manifest.Save(*dir); err != nil {
			return fmt.Errorf("write manifest: %w", err)
		}
		recorded++
		logger.Info("recorded", "place", p.Name, "files", len(files), "took", time.Since(t0).Round(time.Second))
	}
	logger.Info("finished", "recorded", recorded, "failed", len(failed))
	if len(failed) > 0 {
		return fmt.Errorf("failed: %s", strings.Join(failed, ", "))
	}
	return nil
}

// wanted applies the -place and -group filters.
func wanted(p places.Place, only, group string) bool {
	if group != "" && !strings.EqualFold(p.Group, group) {
		return false
	}
	if only == "" {
		return true
	}
	for _, frag := range strings.Split(only, ",") {
		if frag = strings.TrimSpace(frag); frag != "" && strings.Contains(strings.ToLower(p.Name), strings.ToLower(frag)) {
			return true
		}
	}
	return false
}

// dedupe keeps one entry per file: a retried request records the same response twice.
func dedupe(files []snapshot.Entry) []snapshot.Entry {
	seen := map[string]bool{}
	out := files[:0:0]
	for _, f := range files {
		if !seen[f.File] {
			seen[f.File] = true
			out = append(out, f)
		}
	}
	return out
}
