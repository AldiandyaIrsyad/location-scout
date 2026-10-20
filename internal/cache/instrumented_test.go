package cache

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestInstrumentedCountsHitsAndMisses(t *testing.T) {
	ctx := context.Background()
	c := NewInstrumented("mem", NewMemory(1024, time.Minute))

	if _, ok := c.Get(ctx, "a"); ok {
		t.Fatal("expected miss")
	}
	c.Set(ctx, "a", []byte("v"), 0)
	if _, ok := c.Get(ctx, "a"); !ok {
		t.Fatal("expected hit")
	}
	if _, ok := c.Get(ctx, "a"); !ok {
		t.Fatal("expected hit")
	}
	if _, ok := c.Get(ctx, "b"); ok {
		t.Fatal("expected miss")
	}

	snap := c.Snapshot()
	if len(snap) != 2 {
		t.Fatalf("Snapshot has %d keys; want 2: %v", len(snap), snap)
	}
	if snap["mem.hits"] != 2 || snap["mem.misses"] != 2 {
		t.Fatalf("Snapshot = %v; want mem.hits=2 mem.misses=2", snap)
	}
}

func TestInstrumentedSetIsPassThrough(t *testing.T) {
	ctx := context.Background()
	inner := NewMemory(1024, time.Minute)
	c := NewInstrumented("x", inner)
	c.Set(ctx, "k", []byte("v"), time.Minute)

	if v, ok := inner.Get(ctx, "k"); !ok || string(v) != "v" {
		t.Fatalf("inner cache = %q, %v; want v, true", v, ok)
	}
	if snap := c.Snapshot(); snap["x.hits"] != 0 || snap["x.misses"] != 0 {
		t.Fatalf("Set must not count: %v", snap)
	}
}

func TestInstrumentedNilInnerIsNop(t *testing.T) {
	ctx := context.Background()
	c := NewInstrumented("n", nil)
	c.Set(ctx, "k", []byte("v"), 0)
	if _, ok := c.Get(ctx, "k"); ok {
		t.Fatal("nil inner must behave like Nop")
	}
	if snap := c.Snapshot(); snap["n.misses"] != 1 {
		t.Fatalf("Snapshot = %v; want n.misses=1", snap)
	}
}

func TestInstrumentedSnapshotIsACopy(t *testing.T) {
	ctx := context.Background()
	c := NewInstrumented("s", Nop{})
	c.Get(ctx, "k")
	snap := c.Snapshot()
	snap["s.misses"] = 999
	if got := c.Snapshot()["s.misses"]; got != 1 {
		t.Fatalf("mutating a snapshot changed the counter: %d", got)
	}
}

func TestInstrumentedConcurrentCounts(t *testing.T) {
	ctx := context.Background()
	mem := NewMemory(1<<20, time.Minute)
	c := NewInstrumented("c", mem)
	for i := 0; i < 10; i++ {
		c.Set(ctx, fmt.Sprint("k", i), []byte("v"), 0)
	}

	const goroutines = 20
	const perG = 500
	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < perG; i++ {
				// Even i hit (keys k0..k9 exist), odd i miss.
				if i%2 == 0 {
					c.Get(ctx, fmt.Sprint("k", i%10))
				} else {
					c.Get(ctx, "absent")
				}
			}
		}(g)
	}
	wg.Wait()

	snap := c.Snapshot()
	wantHits := int64(goroutines * perG / 2)
	wantMisses := int64(goroutines * perG / 2)
	if snap["c.hits"] != wantHits || snap["c.misses"] != wantMisses {
		t.Fatalf("Snapshot = %v; want hits=%d misses=%d", snap, wantHits, wantMisses)
	}
}
