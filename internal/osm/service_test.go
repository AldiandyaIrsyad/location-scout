package osm

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"panelscape/internal/cache"
	"panelscape/internal/upstream"
)

const (
	urlA = "https://overpass-a.test/api/interpreter"
	urlB = "https://overpass-b.test/api/interpreter"
)

// fakeFetcher serves canned Overpass bodies and counts requests per URL.
type fakeFetcher struct {
	mu        sync.Mutex
	body      []byte
	bodies    map[string][]byte
	fail      map[string]error
	calls     map[string]int
	lastQuery string
}

func newFakeFetcher(body []byte) *fakeFetcher {
	return &fakeFetcher{body: body, bodies: map[string][]byte{}, fail: map[string]error{}, calls: map[string]int{}}
}

var _ upstream.Fetcher = (*fakeFetcher)(nil)

func (f *fakeFetcher) Get(context.Context, string, time.Duration) ([]byte, error) {
	return nil, errors.New("fakeFetcher: Get is not used by the osm service")
}

func (f *fakeFetcher) PostForm(_ context.Context, u string, form url.Values, _ time.Duration) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[u]++
	f.lastQuery = form.Get("data")
	if err := f.fail[u]; err != nil {
		return nil, err
	}
	if b, ok := f.bodies[u]; ok {
		return b, nil
	}
	return f.body, nil
}

func (f *fakeFetcher) count(u string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[u]
}

// memCache is a minimal in-test cache.Cache (no expiry).
type memCache struct {
	mu sync.Mutex
	m  map[string][]byte
}

var _ cache.Cache = (*memCache)(nil)

func newMemCache() *memCache { return &memCache{m: map[string][]byte{}} }

func (c *memCache) Get(_ context.Context, key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.m[key]
	return v, ok
}

func (c *memCache) Set(_ context.Context, key string, value []byte, _ time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[key] = value
}

func TestCityResultIsCached(t *testing.T) {
	f := newFakeFetcher(loadSample(t))
	svc := NewService(f, []string{urlA, urlB}, time.Hour, newMemCache(), time.Hour, nil)
	ctx := context.Background()

	c1, err := svc.City(ctx, testLat, testLon, testSize, 0)
	if err != nil {
		t.Fatalf("City: %v", err)
	}
	if !strings.HasPrefix(f.lastQuery, "[out:json][timeout:60];") || !strings.Contains(f.lastQuery, `node["natural"="tree"]`) {
		t.Errorf("unexpected Overpass query: %q", f.lastQuery[:min(len(f.lastQuery), 80)])
	}
	c2, err := svc.City(ctx, testLat, testLon, testSize, 0)
	if err != nil {
		t.Fatalf("second City: %v", err)
	}
	if n := f.count(urlA); n != 1 {
		t.Errorf("overpass requests after two identical City calls = %d, want 1", n)
	}
	j1, _ := json.Marshal(c1)
	j2, _ := json.Marshal(c2)
	if string(j1) != string(j2) {
		t.Error("cached City result differs from the original")
	}

	// A new seed is a new result: it is parsed again, and the guessed heights change.
	c3, err := svc.City(ctx, testLat, testLon, testSize, 7)
	if err != nil {
		t.Fatalf("City seed 7: %v", err)
	}
	if c3.Seed != 7 {
		t.Errorf("seed = %d, want 7", c3.Seed)
	}
	if b := buildingByID(c3, "w1003"); b == nil || b.Height != 8 {
		t.Errorf("w1003 at seed 7 = %+v, want height 8", b)
	}
}

func TestCityFallsBackToSecondURL(t *testing.T) {
	f := newFakeFetcher(loadSample(t))
	f.fail[urlA] = &upstream.StatusError{URL: urlA, Status: 502}
	svc := NewService(f, []string{urlA, urlB}, time.Hour, cache.Nop{}, time.Hour, nil)

	c, err := svc.City(context.Background(), testLat, testLon, testSize, 0)
	if err != nil {
		t.Fatalf("City with first server down: %v", err)
	}
	if len(c.Buildings) != 6 {
		t.Errorf("buildings = %d, want 6", len(c.Buildings))
	}
	if f.count(urlA) != 1 || f.count(urlB) != 1 {
		t.Errorf("requests A=%d B=%d, want 1 and 1", f.count(urlA), f.count(urlB))
	}
}

func TestCityFallsBackOnInvalidBody(t *testing.T) {
	f := newFakeFetcher(loadSample(t))
	f.bodies[urlA] = []byte(`{"remark":"runtime error: query timed out"}`)
	svc := NewService(f, []string{urlA, urlB}, time.Hour, cache.Nop{}, time.Hour, nil)

	if _, err := svc.City(context.Background(), testLat, testLon, testSize, 0); err != nil {
		t.Fatalf("City with a remark-only body from the first server: %v", err)
	}
	if f.count(urlB) != 1 {
		t.Errorf("second server requests = %d, want 1", f.count(urlB))
	}
}

func TestCityErrorWhenAllServersFail(t *testing.T) {
	f := newFakeFetcher(loadSample(t))
	f.fail[urlA] = &upstream.StatusError{URL: urlA, Status: 504}
	f.fail[urlB] = errors.New("connection reset")
	svc := NewService(f, []string{urlA, urlB}, time.Hour, cache.Nop{}, time.Hour, nil)
	svc.RetryDelays = []time.Duration{0, 0}

	if _, err := svc.City(context.Background(), testLat, testLon, testSize, 0); err == nil {
		t.Fatal("City succeeded although every server failed")
	}
	// Busy servers are retried: first attempt plus one round per delay.
	if got := f.count(urlA); got != 3 {
		t.Fatalf("urlA called %d times, want 3 (1 + 2 retries)", got)
	}
}

// hangingFetcher blocks a request to the hanging URL until its context ends; other URLs answer normally.
type hangingFetcher struct {
	*fakeFetcher
	hang string
}

func (f *hangingFetcher) PostForm(ctx context.Context, u string, form url.Values, ttl time.Duration) ([]byte, error) {
	if u == f.hang {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return f.fakeFetcher.PostForm(ctx, u, form, ttl)
}

func TestAttemptTimeoutMovesOnFromAHangingServer(t *testing.T) {
	f := &hangingFetcher{fakeFetcher: newFakeFetcher(loadSample(t)), hang: urlA}
	svc := NewService(f, []string{urlA, urlB}, time.Hour, cache.Nop{}, time.Hour, nil)
	svc.CityTimeout = 50 * time.Millisecond

	start := time.Now()
	if _, err := svc.City(context.Background(), testLat, testLon, testSize, 0); err != nil {
		t.Fatalf("City with a hanging first server: %v", err)
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("City took %v; the hanging server was not cut off", took)
	}
	if f.count(urlB) != 1 {
		t.Errorf("second server requests = %d, want 1", f.count(urlB))
	}
}

func TestCityStopsRetryingOnceBudgetIsSpent(t *testing.T) {
	f := newFakeFetcher(loadSample(t))
	f.fail[urlA] = &upstream.StatusError{URL: urlA, Status: 504}
	svc := NewService(f, []string{urlA}, time.Hour, cache.Nop{}, time.Hour, nil)
	svc.RetryDelays = []time.Duration{time.Hour, time.Hour} // would hang the test if a retry were attempted
	svc.RetryBudget = time.Second

	if _, err := svc.City(context.Background(), testLat, testLon, testSize, 0); err == nil {
		t.Fatal("City succeeded although the server failed")
	}
	if got := f.count(urlA); got != 1 {
		t.Fatalf("urlA called %d times, want 1 (the next round would exceed the budget)", got)
	}
}

// flakyFetcher fails every request with a busy status until failures run out.
type flakyFetcher struct {
	*fakeFetcher
	mu           sync.Mutex
	failuresLeft int
}

func (f *flakyFetcher) PostForm(ctx context.Context, u string, form url.Values, ttl time.Duration) ([]byte, error) {
	f.mu.Lock()
	busy := f.failuresLeft > 0
	if busy {
		f.failuresLeft--
	}
	f.mu.Unlock()
	if busy {
		f.fakeFetcher.PostForm(ctx, u, form, ttl) // count the call
		return nil, &upstream.StatusError{URL: u, Status: 502}
	}
	return f.fakeFetcher.PostForm(ctx, u, form, ttl)
}

func TestCityRetriesWhenAllServersBusy(t *testing.T) {
	f := &flakyFetcher{fakeFetcher: newFakeFetcher(loadSample(t)), failuresLeft: 2} // both servers busy in round 1
	svc := NewService(f, []string{urlA, urlB}, time.Hour, cache.Nop{}, time.Hour, nil)
	svc.RetryDelays = []time.Duration{0}

	city, err := svc.City(context.Background(), testLat, testLon, testSize, 0)
	if err != nil {
		t.Fatalf("City after retry: %v", err)
	}
	if len(city.Buildings) == 0 {
		t.Fatal("no buildings after retry")
	}
	if got := f.count(urlA); got != 2 {
		t.Fatalf("urlA called %d times, want 2 (busy, then ok)", got)
	}
}

func TestCityServesStaleCopyWhenAllServersFail(t *testing.T) {
	f := newFakeFetcher(loadSample(t))
	results := newMemCache()
	svc := NewService(f, []string{urlA}, time.Hour, results, time.Hour, nil)
	svc.RetryDelays = nil

	if _, err := svc.City(context.Background(), testLat, testLon, testSize, 0); err != nil {
		t.Fatalf("first City: %v", err)
	}
	// Overpass goes down. A different seed misses the result cache, so the raw data must come
	// from the last-good copy.
	f.fail[urlA] = &upstream.StatusError{URL: urlA, Status: 504}
	city, err := svc.City(context.Background(), testLat, testLon, testSize, 7)
	if err != nil {
		t.Fatalf("City with Overpass down: %v (want the stale copy)", err)
	}
	if len(city.Buildings) == 0 || city.Seed != 7 {
		t.Fatalf("stale city: %d buildings, seed %d", len(city.Buildings), city.Seed)
	}
}

func TestCityDoesNotRetryBadRequest(t *testing.T) {
	f := newFakeFetcher(loadSample(t))
	f.fail[urlA] = &upstream.StatusError{URL: urlA, Status: 400}
	svc := NewService(f, []string{urlA}, time.Hour, cache.Nop{}, time.Hour, nil)
	svc.RetryDelays = []time.Duration{0, 0}

	if _, err := svc.City(context.Background(), testLat, testLon, testSize, 0); err == nil {
		t.Fatal("City succeeded on a 400")
	}
	if got := f.count(urlA); got != 1 {
		t.Fatalf("urlA called %d times, want 1 (400 is not retried)", got)
	}
}

func TestSurroundingsResultIsCached(t *testing.T) {
	f := newFakeFetcher(loadSample(t))
	svc := NewService(f, []string{urlA}, time.Hour, newMemCache(), time.Hour, nil)
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		s, err := svc.Surroundings(ctx, testLat, testLon, testSize, 800)
		if err != nil {
			t.Fatalf("Surroundings: %v", err)
		}
		if len(s.Buildings) != 1 {
			t.Errorf("surroundings buildings = %d, want 1", len(s.Buildings))
		}
	}
	if n := f.count(urlA); n != 1 {
		t.Errorf("overpass requests = %d, want 1", n)
	}
}
