package cache

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

// fakeClock is a settable clock for TTL tests.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func TestMemorySetGet(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(1024, time.Minute)

	if _, ok := m.Get(ctx, "missing"); ok {
		t.Fatal("expected miss for unknown key")
	}
	m.Set(ctx, "a", []byte("hello"), 0)
	v, ok := m.Get(ctx, "a")
	if !ok || string(v) != "hello" {
		t.Fatalf("Get(a) = %q, %v; want hello, true", v, ok)
	}
	if m.Len() != 1 || m.Bytes() != 5 {
		t.Fatalf("Len=%d Bytes=%d; want 1, 5", m.Len(), m.Bytes())
	}
}

func TestMemoryOverwriteUpdatesBytes(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(1024, time.Minute)
	m.Set(ctx, "a", []byte("12345"), 0)
	m.Set(ctx, "a", []byte("123"), 0)

	v, ok := m.Get(ctx, "a")
	if !ok || string(v) != "123" {
		t.Fatalf("Get(a) = %q, %v; want 123, true", v, ok)
	}
	if m.Len() != 1 || m.Bytes() != 3 {
		t.Fatalf("Len=%d Bytes=%d; want 1, 3", m.Len(), m.Bytes())
	}
}

func TestMemoryStoresCopies(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(1024, time.Minute)

	in := []byte("abc")
	m.Set(ctx, "k", in, 0)
	in[0] = 'X' // mutating the input must not affect the cache

	out, _ := m.Get(ctx, "k")
	if string(out) != "abc" {
		t.Fatalf("cache saw caller mutation: %q", out)
	}
	out[1] = 'Y' // mutating the output must not affect the cache
	again, _ := m.Get(ctx, "k")
	if string(again) != "abc" {
		t.Fatalf("cache saw output mutation: %q", again)
	}
}

func TestMemoryEvictsLeastRecentlyUsedByBytes(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(10, time.Minute)

	m.Set(ctx, "a", []byte("1234"), 0) // 4 bytes
	m.Set(ctx, "b", []byte("5678"), 0) // 8 bytes total
	if _, ok := m.Get(ctx, "a"); !ok { // a becomes most recently used; b is now LRU
		t.Fatal("a should be present")
	}
	m.Set(ctx, "c", []byte("9abc"), 0) // would be 12 bytes: evict b

	if _, ok := m.Get(ctx, "b"); ok {
		t.Fatal("b should have been evicted as least recently used")
	}
	for _, k := range []string{"a", "c"} {
		if _, ok := m.Get(ctx, k); !ok {
			t.Fatalf("%s should still be present", k)
		}
	}
	if m.Bytes() != 8 || m.Len() != 2 {
		t.Fatalf("Bytes=%d Len=%d; want 8, 2", m.Bytes(), m.Len())
	}
}

func TestMemoryEvictsSeveralToFitLargeValue(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(10, time.Minute)
	for i := 0; i < 5; i++ {
		m.Set(ctx, fmt.Sprint("k", i), []byte("aa"), 0) // 5 x 2 = 10 bytes, full
	}
	m.Set(ctx, "big", make([]byte, 8), 0)

	if m.Bytes() > 10 {
		t.Fatalf("Bytes=%d exceeds budget 10", m.Bytes())
	}
	if _, ok := m.Get(ctx, "big"); !ok {
		t.Fatal("big value should be stored")
	}
	// Exactly one 2-byte entry can share the budget with the 8-byte value.
	if m.Len() != 2 {
		t.Fatalf("Len=%d; want 2", m.Len())
	}
}

func TestMemoryRejectsOversizedValue(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(4, time.Minute)

	m.Set(ctx, "a", []byte("ok"), 0)
	m.Set(ctx, "big", []byte("too large"), 0)
	if _, ok := m.Get(ctx, "big"); ok {
		t.Fatal("value larger than the budget must not be stored")
	}
	if _, ok := m.Get(ctx, "a"); !ok {
		t.Fatal("unrelated entry should be untouched")
	}
}

func TestMemoryOversizedUpdateDropsOldValue(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(4, time.Minute)

	m.Set(ctx, "a", []byte("old"), 0)
	m.Set(ctx, "a", []byte("way too large"), 0)
	if _, ok := m.Get(ctx, "a"); ok {
		t.Fatal("a stale value must not survive an oversized update")
	}
	if m.Len() != 0 || m.Bytes() != 0 {
		t.Fatalf("Len=%d Bytes=%d; want 0, 0", m.Len(), m.Bytes())
	}
}

func TestMemoryZeroBudgetStoresNothing(t *testing.T) {
	ctx := context.Background()
	m := NewMemory(0, time.Minute)
	m.Set(ctx, "a", []byte{}, 0)
	if _, ok := m.Get(ctx, "a"); ok {
		t.Fatal("zero budget must store nothing")
	}
}

func TestMemoryTTLExpiry(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()
	m := NewMemory(1024, time.Minute)
	m.now = clock.now

	m.Set(ctx, "short", []byte("s"), time.Second)
	m.Set(ctx, "long", []byte("l"), time.Hour)

	clock.advance(999 * time.Millisecond)
	if _, ok := m.Get(ctx, "short"); !ok {
		t.Fatal("short should still be live just before its ttl")
	}

	clock.advance(2 * time.Second)
	if _, ok := m.Get(ctx, "short"); ok {
		t.Fatal("short should have expired")
	}
	if _, ok := m.Get(ctx, "long"); !ok {
		t.Fatal("long should still be live")
	}
	if m.Len() != 1 || m.Bytes() != 1 {
		t.Fatalf("expired entry should be removed on read: Len=%d Bytes=%d", m.Len(), m.Bytes())
	}
}

func TestMemoryDefaultTTL(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()
	m := NewMemory(1024, 10*time.Second)
	m.now = clock.now

	m.Set(ctx, "k", []byte("v"), 0) // ttl <= 0 uses the default
	clock.advance(9 * time.Second)
	if _, ok := m.Get(ctx, "k"); !ok {
		t.Fatal("entry should live for the default ttl")
	}
	clock.advance(2 * time.Second)
	if _, ok := m.Get(ctx, "k"); ok {
		t.Fatal("entry should expire after the default ttl")
	}
}

func TestMemoryNoExpiryWhenNoTTL(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()
	m := NewMemory(1024, 0)
	m.now = clock.now

	m.Set(ctx, "k", []byte("v"), 0)
	clock.advance(10 * 365 * 24 * time.Hour)
	if _, ok := m.Get(ctx, "k"); !ok {
		t.Fatal("entry without any ttl should never expire")
	}
}

func TestMemoryExpiredEntryDoesNotCountAsHit(t *testing.T) {
	ctx := context.Background()
	clock := newFakeClock()
	m := NewMemory(1024, time.Second)
	m.now = clock.now

	m.Set(ctx, "k", []byte("v"), 0)
	clock.advance(time.Second) // expires exactly at the boundary
	if _, ok := m.Get(ctx, "k"); ok {
		t.Fatal("entry must be a miss at its expiry instant")
	}
}

func TestMemoryConcurrentAccessKeepsInvariants(t *testing.T) {
	ctx := context.Background()
	const budget = 4096
	m := NewMemory(budget, time.Minute)

	var wg sync.WaitGroup
	for g := 0; g < 16; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 2000; i++ {
				key := fmt.Sprint("k", (g*7+i)%64)
				if i%3 == 0 {
					m.Set(ctx, key, make([]byte, (i*13)%200), 0)
				} else {
					m.Get(ctx, key)
				}
			}
		}(g)
	}
	wg.Wait()

	m.mu.Lock()
	defer m.mu.Unlock()
	var sum int64
	n := 0
	for el := m.order.Front(); el != nil; el = el.Next() {
		e := el.Value.(*memEntry)
		sum += int64(len(e.value))
		n++
		if m.items[e.key] != el {
			t.Fatalf("index out of sync for key %q", e.key)
		}
	}
	if sum != m.size {
		t.Fatalf("size=%d but entries sum to %d", m.size, sum)
	}
	if m.size > budget {
		t.Fatalf("size=%d exceeds budget %d", m.size, budget)
	}
	if n != len(m.items) {
		t.Fatalf("list has %d entries, index has %d", n, len(m.items))
	}
}
