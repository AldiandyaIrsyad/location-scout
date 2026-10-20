package app

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"panelscape/internal/config"
)

func testConfig(cacheDir string) config.Config {
	return config.Config{
		Addr:            ":0",
		CacheDir:        cacheDir,
		MemoryCacheMB:   16,
		OverpassURLs:    []string{"https://overpass.invalid/api/interpreter"},
		NominatimURL:    "https://nominatim.invalid/search",
		UserAgent:       "Panelscape-test",
		OSMTTL:          time.Hour,
		TileTTL:         time.Hour,
		SearchTTL:       time.Hour,
		ResultTTL:       time.Hour,
		UpstreamTimeout: 5 * time.Second,
	}
}

func build(t *testing.T, cacheDir string) *App {
	t.Helper()
	a, err := New(testConfig(cacheDir), slog.New(slog.DiscardHandler))
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(a.Close)
	return a
}

func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func TestAppWiresHealthAndAbout(t *testing.T) {
	// CacheDir "" disables the disk layer, so this runs without touching the file system.
	a := build(t, "")

	health := get(t, a.Handler, "/api/health")
	if health.Code != http.StatusOK || !strings.Contains(health.Body.String(), `"ok"`) {
		t.Fatalf("health: %d %q", health.Code, health.Body.String())
	}

	rec := get(t, a.Handler, "/api/about")
	if rec.Code != http.StatusOK {
		t.Fatalf("about: %d", rec.Code)
	}
	var about struct {
		Name    string `json:"name"`
		Author  string `json:"author"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &about); err != nil {
		t.Fatal(err)
	}
	if about.Author != "Aldiandya Irsyad" || about.Version != Version || about.Name != "Panelscape" {
		t.Fatalf("about = %+v", about)
	}
}

func TestAppServesEmbeddedFrontend(t *testing.T) {
	a := build(t, "")
	rec := get(t, a.Handler, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("/: %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "<title>Panelscape</title>") {
		t.Fatalf("/ did not serve index.html")
	}
	if ct := get(t, a.Handler, "/js/main.js").Header().Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
		t.Fatalf("main.js Content-Type = %q", ct)
	}
}

func TestAppStatsWithFileCache(t *testing.T) {
	a := build(t, t.TempDir())
	rec := get(t, a.Handler, "/api/cache/stats")
	if rec.Code != http.StatusOK {
		t.Fatalf("stats: %d", rec.Code)
	}
	var stats map[string]int64
	if err := json.Unmarshal(rec.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"memory.hits", "memory.misses", "file.hits", "file.misses"} {
		if _, ok := stats[k]; !ok {
			t.Fatalf("missing %s in %v", k, stats)
		}
	}
}

func TestNewRejectsMissingStaticDir(t *testing.T) {
	cfg := testConfig("")
	cfg.StaticDir = t.TempDir() + "/does-not-exist"
	if _, err := New(cfg, slog.New(slog.DiscardHandler)); err == nil {
		t.Fatal("expected an error for a missing static dir")
	}
}
