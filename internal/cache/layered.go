package cache

import (
	"context"
	"time"
)

// Layered is a read-through cache over several layers, ordered fastest first (for example
// Memory, then File). Get tries the layers in order; on a hit it back-fills every faster layer
// with the value, using each layer's default ttl. Set writes to all layers.
type Layered struct {
	layers []Cache
}

var _ Cache = (*Layered)(nil)

// NewLayered returns a Layered cache over layers, fastest first. Nil layers are ignored.
func NewLayered(layers ...Cache) *Layered {
	ls := make([]Cache, 0, len(layers))
	for _, l := range layers {
		if l != nil {
			ls = append(ls, l)
		}
	}
	return &Layered{layers: ls}
}

// Get returns the value from the first layer that has it and copies it into the faster layers.
func (l *Layered) Get(ctx context.Context, key string) ([]byte, bool) {
	for i, layer := range l.layers {
		v, ok := layer.Get(ctx, key)
		if !ok {
			continue
		}
		for _, faster := range l.layers[:i] {
			faster.Set(ctx, key, v, 0) // 0 = the faster layer's default ttl
		}
		return v, true
	}
	return nil, false
}

// Set stores value in every layer with the given ttl (<= 0 means each layer's default).
func (l *Layered) Set(ctx context.Context, key string, value []byte, ttl time.Duration) {
	for _, layer := range l.layers {
		layer.Set(ctx, key, value, ttl)
	}
}
