// Package cache defines the caching layer used for upstream responses (Overpass, Nominatim,
// elevation tiles) and for computed results (parsed cities, elevation grids).
//
// Implementations: Memory (in-process LRU bounded by bytes, with TTL), File (on-disk, survives
// restarts), Layered (read-through over several caches, fastest first) and Nop.
package cache

import (
	"context"
	"time"
)

// Cache stores opaque byte values under string keys with a time-to-live.
// Implementations must be safe for concurrent use.
type Cache interface {
	// Get returns the value and true when the key is present and not expired.
	Get(ctx context.Context, key string) ([]byte, bool)
	// Set stores the value; ttl <= 0 means "use the implementation's default".
	Set(ctx context.Context, key string, value []byte, ttl time.Duration)
}

// Nop is a Cache that stores nothing (useful in tests and to disable caching).
type Nop struct{}

// Get always misses.
func (Nop) Get(context.Context, string) ([]byte, bool) { return nil, false }

// Set discards the value.
func (Nop) Set(context.Context, string, []byte, time.Duration) {}
