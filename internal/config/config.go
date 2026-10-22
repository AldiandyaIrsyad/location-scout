// Package config loads server settings from environment variables (12-factor style).
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Author is shown in the UI footer, /api/about and the server banner.
const Author = "Aldiandya Irsyad"

// Config holds every tunable setting. Zero values are never used: Load fills defaults.
type Config struct {
	Addr                string        // listen address, e.g. ":8080" (env ADDR, or PORT)
	StaticDir           string        // serve the frontend from this directory instead of the embedded copy (env STATIC_DIR; dev only)
	CacheDir            string        // on-disk cache directory; "" disables the disk layer (env CACHE_DIR)
	MemoryCacheMB       int           // in-memory cache budget in MB (env MEMORY_CACHE_MB)
	OverpassURLs        []string      // Overpass API endpoints, tried in order (env OVERPASS_URLS, comma separated)
	NominatimURL        string        // Nominatim search endpoint (env NOMINATIM_URL)
	UserAgent           string        // sent to upstream services, as their usage policies require (env USER_AGENT)
	OSMTTL              time.Duration // cache time for Overpass responses (env OSM_TTL, Go duration)
	TileTTL             time.Duration // cache time for elevation tiles (env TILE_TTL)
	SearchTTL           time.Duration // cache time for place searches (env SEARCH_TTL)
	ResultTTL           time.Duration // cache time for computed results: parsed cities, grids (env RESULT_TTL)
	UpstreamTimeout     time.Duration // per-request timeout for upstream calls (env UPSTREAM_TIMEOUT)
	SurroundingsTimeout time.Duration // per-request timeout for the large surroundings query (env SURROUNDINGS_TIMEOUT)
	SnapshotDir         string        // directory of recorded upstream responses for the built-in places (env SNAPSHOT_DIR)
	SnapshotMode        string        // prefer (snapshot first, then live), only (never live) or off (env SNAPSHOT_MODE)
}

// Load reads the environment and applies defaults.
func Load() Config {
	c := Config{
		Addr:          env("ADDR", ""),
		StaticDir:     env("STATIC_DIR", ""),
		CacheDir:      env("CACHE_DIR", "data/cache"),
		MemoryCacheMB: envInt("MEMORY_CACHE_MB", 256),
		OverpassURLs: envList("OVERPASS_URLS", []string{
			"https://overpass.openstreetmap.fr/api/interpreter",
			"https://overpass-api.de/api/interpreter",
			"https://overpass.private.coffee/api/interpreter",
		}),
		NominatimURL:        env("NOMINATIM_URL", "https://nominatim.openstreetmap.org/search"),
		UserAgent:           env("USER_AGENT", "Panelscape/1.0 (by "+Author+")"),
		OSMTTL:              envDuration("OSM_TTL", 7*24*time.Hour),
		TileTTL:             envDuration("TILE_TTL", 30*24*time.Hour),
		SearchTTL:           envDuration("SEARCH_TTL", 7*24*time.Hour),
		ResultTTL:           envDuration("RESULT_TTL", 7*24*time.Hour),
		UpstreamTimeout:     envDuration("UPSTREAM_TIMEOUT", 20*time.Second),
		SurroundingsTimeout: envDuration("SURROUNDINGS_TIMEOUT", 45*time.Second),
		SnapshotDir:         env("SNAPSHOT_DIR", "snapshots"),
		SnapshotMode:        env("SNAPSHOT_MODE", "prefer"),
	}
	if c.Addr == "" {
		c.Addr = ":" + env("PORT", "8080")
	}
	if strings.EqualFold(c.CacheDir, "off") || strings.EqualFold(c.CacheDir, "none") {
		c.CacheDir = ""
	}
	return c
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func envInt(key string, def int) int {
	if n, err := strconv.Atoi(env(key, "")); err == nil {
		return n
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if d, err := time.ParseDuration(env(key, "")); err == nil && d > 0 {
		return d
	}
	return def
}

func envList(key string, def []string) []string {
	v := env(key, "")
	if v == "" {
		return def
	}
	var out []string
	for _, s := range strings.Split(v, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}
