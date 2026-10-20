package cache

import (
	"context"
	"testing"
	"time"
)

func TestLayeredMissEverywhere(t *testing.T) {
	ctx := context.Background()
	l := NewLayered(NewMemory(1024, time.Minute), NewMemory(1024, time.Minute))
	if _, ok := l.Get(ctx, "nope"); ok {
		t.Fatal("expected miss when no layer has the key")
	}
}

func TestLayeredEmptyHasNoLayers(t *testing.T) {
	ctx := context.Background()
	l := NewLayered()
	l.Set(ctx, "k", []byte("v"), 0) // must not panic
	if _, ok := l.Get(ctx, "k"); ok {
		t.Fatal("layered cache with no layers must miss")
	}
}

func TestLayeredIgnoresNilLayers(t *testing.T) {
	ctx := context.Background()
	mem := NewMemory(1024, time.Minute)
	l := NewLayered(nil, mem, nil)
	l.Set(ctx, "k", []byte("v"), 0)
	if v, ok := l.Get(ctx, "k"); !ok || string(v) != "v" {
		t.Fatalf("Get = %q, %v; want v, true", v, ok)
	}
}

func TestLayeredSetWritesAllLayers(t *testing.T) {
	ctx := context.Background()
	fast := NewMemory(1024, time.Minute)
	slow := NewMemory(1024, time.Minute)
	l := NewLayered(fast, slow)

	l.Set(ctx, "k", []byte("v"), time.Minute)
	if _, ok := fast.Get(ctx, "k"); !ok {
		t.Fatal("fast layer missing value after Set")
	}
	if _, ok := slow.Get(ctx, "k"); !ok {
		t.Fatal("slow layer missing value after Set")
	}
}

func TestLayeredBackfillsFasterLayers(t *testing.T) {
	ctx := context.Background()
	fast := NewMemory(1024, time.Minute)
	mid := NewMemory(1024, time.Minute)
	slow := NewMemory(1024, time.Minute)
	l := NewLayered(fast, mid, slow)

	slow.Set(ctx, "k", []byte("from-slow"), time.Minute) // only the slowest layer has it

	v, ok := l.Get(ctx, "k")
	if !ok || string(v) != "from-slow" {
		t.Fatalf("Get = %q, %v; want from-slow, true", v, ok)
	}
	if got, ok := fast.Get(ctx, "k"); !ok || string(got) != "from-slow" {
		t.Fatal("fastest layer was not back-filled")
	}
	if got, ok := mid.Get(ctx, "k"); !ok || string(got) != "from-slow" {
		t.Fatal("middle layer was not back-filled")
	}
}

func TestLayeredHitInFastLayerDoesNotTouchSlower(t *testing.T) {
	ctx := context.Background()
	fast := NewMemory(1024, time.Minute)
	slow := NewMemory(1024, time.Minute)
	l := NewLayered(fast, slow)

	fast.Set(ctx, "k", []byte("fast"), time.Minute)
	if _, ok := l.Get(ctx, "k"); !ok {
		t.Fatal("expected hit")
	}
	if _, ok := slow.Get(ctx, "k"); ok {
		t.Fatal("slow layer should not be written on a fast-layer hit")
	}
}

func TestLayeredBackfillUsesFasterLayerDefaultTTL(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()

	fast := NewMemory(1024, 2*time.Second) // short default ttl
	fast.now = clock.now
	slow := NewMemory(1024, time.Hour)
	slow.now = clock.now
	l := NewLayered(fast, slow)

	slow.Set(ctx, "k", []byte("v"), 0)
	if _, ok := l.Get(ctx, "k"); !ok { // back-fills fast with its default ttl
		t.Fatal("expected hit")
	}

	clock.advance(3 * time.Second)
	if _, ok := fast.Get(ctx, "k"); ok {
		t.Fatal("back-filled entry should use the fast layer's default ttl and expire")
	}
	if _, ok := l.Get(ctx, "k"); !ok {
		t.Fatal("slow layer should still serve the value")
	}
}

func TestLayeredSetHonoursTTLPerLayer(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()
	a := NewMemory(1024, time.Hour)
	a.now = clock.now
	b := NewMemory(1024, time.Hour)
	b.now = clock.now
	l := NewLayered(a, b)

	l.Set(ctx, "k", []byte("v"), time.Second)
	clock.advance(2 * time.Second)
	if _, ok := l.Get(ctx, "k"); ok {
		t.Fatal("explicit ttl must apply to every layer")
	}
}
