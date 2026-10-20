package upstream_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"panelscape/internal/cache"
	"panelscape/internal/upstream"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// countingServer serves handler and counts every request it receives.
func countingServer(t *testing.T, handler http.HandlerFunc) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		handler(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, &calls
}

func newFetcher(c cache.Cache) *upstream.HTTPFetcher {
	return upstream.NewHTTPFetcher(&http.Client{Timeout: 10 * time.Second}, c, "test-agent/1.0", quietLogger())
}

func TestGetCachesSuccessfulBody(t *testing.T) {
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "payload")
	})
	f := newFetcher(cache.NewMemory(1<<20, time.Minute))
	ctx := context.Background()

	for i := 0; i < 3; i++ {
		body, err := f.Get(ctx, srv.URL+"/x?a=1", time.Minute)
		if err != nil || string(body) != "payload" {
			t.Fatalf("Get #%d = %q, %v; want payload, nil", i, body, err)
		}
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("server called %d times; want 1 (later calls must hit the cache)", n)
	}
}

func TestGetCacheKeyIncludesURL(t *testing.T) {
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.URL.Path)
	})
	f := newFetcher(cache.NewMemory(1<<20, time.Minute))
	ctx := context.Background()

	a, _ := f.Get(ctx, srv.URL+"/a", time.Minute)
	b, _ := f.Get(ctx, srv.URL+"/b", time.Minute)
	if string(a) != "/a" || string(b) != "/b" {
		t.Fatalf("bodies = %q, %q; want /a, /b", a, b)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("server called %d times; want 2", n)
	}
}

func TestGetSendsUserAgent(t *testing.T) {
	var got atomic.Value
	srv, _ := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		got.Store(r.Header.Get("User-Agent"))
		_, _ = io.WriteString(w, "ok")
	})
	f := newFetcher(cache.Nop{})
	if _, err := f.Get(context.Background(), srv.URL, time.Minute); err != nil {
		t.Fatal(err)
	}
	if ua, _ := got.Load().(string); ua != "test-agent/1.0" {
		t.Fatalf("User-Agent = %q; want test-agent/1.0", ua)
	}
}

func TestPostFormCachesByForm(t *testing.T) {
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s; want POST", r.Method)
		}
		if ct := r.Header.Get("Content-Type"); ct != "application/x-www-form-urlencoded" {
			t.Errorf("Content-Type = %q", ct)
		}
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm: %v", err)
		}
		_, _ = io.WriteString(w, "result:"+r.PostForm.Get("data"))
	})
	f := newFetcher(cache.NewMemory(1<<20, time.Minute))
	ctx := context.Background()

	form := url.Values{"data": {"query-one"}}
	for i := 0; i < 2; i++ {
		body, err := f.PostForm(ctx, srv.URL, form, time.Minute)
		if err != nil || string(body) != "result:query-one" {
			t.Fatalf("PostForm #%d = %q, %v", i, body, err)
		}
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("identical forms: server called %d times; want 1", n)
	}

	body, err := f.PostForm(ctx, srv.URL, url.Values{"data": {"query-two"}}, time.Minute)
	if err != nil || string(body) != "result:query-two" {
		t.Fatalf("different form = %q, %v", body, err)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("different form: server called %d times; want 2", n)
	}
}

func TestPostAndGetOfSameURLAreCachedSeparately(t *testing.T) {
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.Method)
	})
	f := newFetcher(cache.NewMemory(1<<20, time.Minute))
	ctx := context.Background()

	g, _ := f.Get(ctx, srv.URL, time.Minute)
	p, _ := f.PostForm(ctx, srv.URL, url.Values{}, time.Minute)
	if string(g) != "GET" || string(p) != "POST" {
		t.Fatalf("GET=%q POST=%q; want GET, POST", g, p)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("server called %d times; want 2", n)
	}
}

func TestNotFoundReturnsErrNotFoundAndIsNotCached(t *testing.T) {
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	f := newFetcher(cache.NewMemory(1<<20, time.Minute))
	ctx := context.Background()

	for i := 0; i < 2; i++ {
		_, err := f.Get(ctx, srv.URL+"/tile", time.Minute)
		if !errors.Is(err, upstream.ErrNotFound) {
			t.Fatalf("Get #%d err = %v; want ErrNotFound", i, err)
		}
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("404 must not be cached: server called %d times; want 2", n)
	}
}

func TestServerErrorReturnsStatusErrorAndIsNotCached(t *testing.T) {
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	f := newFetcher(cache.NewMemory(1<<20, time.Minute))
	ctx := context.Background()

	var se *upstream.StatusError
	for i := 0; i < 2; i++ {
		_, err := f.Get(ctx, srv.URL, time.Minute)
		if !errors.As(err, &se) {
			t.Fatalf("Get #%d err = %v; want *StatusError", i, err)
		}
	}
	if se.Status != http.StatusInternalServerError {
		t.Fatalf("Status = %d; want 500", se.Status)
	}
	if se.URL != srv.URL {
		t.Fatalf("StatusError.URL = %q; want %q", se.URL, srv.URL)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("5xx must not be cached: server called %d times; want 2", n)
	}
}

func TestOtherClientErrorIsStatusError(t *testing.T) {
	srv, _ := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusTooManyRequests)
	})
	f := newFetcher(cache.Nop{})
	_, err := f.Get(context.Background(), srv.URL, time.Minute)
	var se *upstream.StatusError
	if !errors.As(err, &se) || se.Status != http.StatusTooManyRequests {
		t.Fatalf("err = %v; want *StatusError with 429", err)
	}
	if errors.Is(err, upstream.ErrNotFound) {
		t.Fatal("429 must not be reported as ErrNotFound")
	}
}

func TestNon200SuccessIsCached(t *testing.T) {
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	f := newFetcher(cache.NewMemory(1<<20, time.Minute))
	for i := 0; i < 2; i++ {
		if _, err := f.Get(context.Background(), srv.URL, time.Minute); err != nil {
			t.Fatalf("204 should be success: %v", err)
		}
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("2xx should be cached: server called %d times; want 1", n)
	}
}

func TestBodyOverLimitIsErrorAndNotCached(t *testing.T) {
	const limit = 64 << 20
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.CopyN(w, zeroReader{}, limit+1)
	})
	f := newFetcher(cache.NewMemory(1<<30, time.Minute))
	ctx := context.Background()

	if _, err := f.Get(ctx, srv.URL, time.Minute); err == nil {
		t.Fatal("body larger than 64 MB must be an error")
	}
	if _, err := f.Get(ctx, srv.URL, time.Minute); err == nil {
		t.Fatal("second call should also fail, not serve a cached body")
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("server called %d times; want 2", n)
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}

func TestConcurrentIdenticalCallsAreDeduplicated(t *testing.T) {
	release := make(chan struct{})
	arrived := make(chan struct{}, 1)
	srv, calls := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case arrived <- struct{}{}:
		default:
		}
		<-release
		_, _ = io.WriteString(w, "shared-body")
	})
	// Nop cache: only the in-flight deduplication can prevent a second upstream call.
	f := newFetcher(cache.Nop{})
	ctx := context.Background()

	const callers = 10
	var wg sync.WaitGroup
	results := make([]string, callers)
	errs := make([]error, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			body, err := f.Get(ctx, srv.URL, time.Minute)
			results[i], errs[i] = string(body), err
		}(i)
	}

	<-arrived
	time.Sleep(200 * time.Millisecond) // let the other callers join the in-flight request
	close(release)
	wg.Wait()

	for i := 0; i < callers; i++ {
		if errs[i] != nil || results[i] != "shared-body" {
			t.Fatalf("caller %d = %q, %v", i, results[i], errs[i])
		}
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("server called %d times for %d concurrent callers; want 1", n, callers)
	}
}

func TestContextCancellationAbortsRequest(t *testing.T) {
	release := make(chan struct{})
	srv, _ := countingServer(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	defer close(release)

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	f := newFetcher(cache.Nop{})
	_, err := f.Get(ctx, srv.URL, time.Minute)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v; want context.DeadlineExceeded", err)
	}
}
