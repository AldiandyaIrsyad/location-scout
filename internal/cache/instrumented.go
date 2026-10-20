package cache

import (
	"context"
	"sync/atomic"
	"time"
)

// Instrumented wraps a Cache and counts hits and misses. Its counters are safe for concurrent use.
type Instrumented struct {
	name   string
	inner  Cache
	hits   atomic.Int64
	misses atomic.Int64
}

var _ Cache = (*Instrumented)(nil)

// NewInstrumented wraps c (nil means Nop) and reports its counters under name in Snapshot.
func NewInstrumented(name string, c Cache) *Instrumented {
	if c == nil {
		c = Nop{}
	}
	return &Instrumented{name: name, inner: c}
}

// Get delegates to the wrapped cache and counts the outcome.
func (i *Instrumented) Get(ctx context.Context, key string) ([]byte, bool) {
	v, ok := i.inner.Get(ctx, key)
	if ok {
		i.hits.Add(1)
	} else {
		i.misses.Add(1)
	}
	return v, ok
}

// Set delegates to the wrapped cache.
func (i *Instrumented) Set(ctx context.Context, key string, value []byte, ttl time.Duration) {
	i.inner.Set(ctx, key, value, ttl)
}

// Snapshot returns the counters as {"<name>.hits": n, "<name>.misses": m}.
func (i *Instrumented) Snapshot() map[string]int64 {
	return map[string]int64{
		i.name + ".hits":   i.hits.Load(),
		i.name + ".misses": i.misses.Load(),
	}
}
