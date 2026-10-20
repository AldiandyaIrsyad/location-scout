// Command server runs Panelscape: the JSON API under /api/ and the frontend, on one port.
//
// Settings come from the environment (see internal/config). Two more variables control logging:
// LOG_FORMAT=json|text (default json) and LOG_LEVEL=debug|info|warn|error (default info).
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"panelscape/internal/app"
	"panelscape/internal/config"
)

const shutdownTimeout = 10 * time.Second

func main() {
	logger := newLogger(os.Getenv("LOG_FORMAT"), os.Getenv("LOG_LEVEL"), os.Stderr)
	if err := run(logger); err != nil {
		logger.Error("server failed", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg := config.Load()

	a, err := app.New(cfg, logger)
	if err != nil {
		return fmt.Errorf("build app: %w", err)
	}
	defer a.Close()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           a.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      180 * time.Second, // covers a cold Overpass query with fallback to a second server
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}

	// SIGINT (Ctrl+C) and SIGTERM (docker stop) start a graceful shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger.Info(fmt.Sprintf("Panelscape %s by %s", app.Version, config.Author),
		"listen", cfg.Addr, "url", listenURL(cfg.Addr))

	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.ListenAndServe() }()

	select {
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("listen %s: %w", cfg.Addr, err)
	case <-ctx.Done():
	}

	logger.Info("shutting down", "timeout", shutdownTimeout.String())
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	logger.Info("stopped")
	return nil
}

// newLogger returns a JSON (default) or text logger at the requested level.
func newLogger(format, level string, w io.Writer) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	if strings.EqualFold(strings.TrimSpace(format), "text") {
		return slog.New(slog.NewTextHandler(w, opts))
	}
	return slog.New(slog.NewJSONHandler(w, opts))
}

// listenURL turns ":8080" into "http://localhost:8080" for the banner.
func listenURL(addr string) string {
	if strings.HasPrefix(addr, ":") {
		return "http://localhost" + addr
	}
	return "http://" + addr
}
