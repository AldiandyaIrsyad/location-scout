package upstream

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"panelscape/internal/cache"
	"panelscape/internal/flight"
)

// maxBodyBytes caps a response body. Larger responses are an error and are never cached.
const maxBodyBytes = 64 << 20

// defaultClientTimeout applies when NewHTTPFetcher is given a nil client.
const defaultClientTimeout = 60 * time.Second

// HTTPFetcher implements Fetcher over net/http. Successful bodies are cached; identical concurrent
// requests share a single upstream call. HTTPFetcher is safe for concurrent use.
type HTTPFetcher struct {
	client    *http.Client
	cache     cache.Cache
	userAgent string
	logger    *slog.Logger
	group     flight.Group
}

var _ Fetcher = (*HTTPFetcher)(nil)

// NewHTTPFetcher returns a fetcher that sends requests with client, caches successful bodies in c
// and sets User-Agent to userAgent on every request. nil arguments are replaced with safe
// defaults: a client with a timeout, cache.Nop and a discarding logger.
func NewHTTPFetcher(client *http.Client, c cache.Cache, userAgent string, logger *slog.Logger) *HTTPFetcher {
	if client == nil {
		client = &http.Client{Timeout: defaultClientTimeout}
	}
	if c == nil {
		c = cache.Nop{}
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &HTTPFetcher{client: client, cache: c, userAgent: userAgent, logger: logger}
}

// Get fetches rawURL with GET. A cached body is returned without contacting the server.
func (f *HTTPFetcher) Get(ctx context.Context, rawURL string, ttl time.Duration) ([]byte, error) {
	return f.do(ctx, http.MethodGet, rawURL, "", ttl)
}

// PostForm posts form as application/x-www-form-urlencoded to rawURL. The cache key includes the
// encoded form, so different forms are cached separately.
func (f *HTTPFetcher) PostForm(ctx context.Context, rawURL string, form url.Values, ttl time.Duration) ([]byte, error) {
	return f.do(ctx, http.MethodPost, rawURL, form.Encode(), ttl)
}

func (f *HTTPFetcher) do(ctx context.Context, method, rawURL, encodedForm string, ttl time.Duration) ([]byte, error) {
	key := cacheKey(method, rawURL, encodedForm)
	if body, ok := f.cache.Get(ctx, key); ok {
		f.logger.Debug("upstream cache hit", "method", method, "url", rawURL)
		return body, nil
	}
	f.logger.Debug("upstream cache miss", "method", method, "url", rawURL)

	body, err, shared := f.group.Do(key, func() ([]byte, error) {
		// Another call may have stored the body between our miss and taking the flight slot.
		if body, ok := f.cache.Get(ctx, key); ok {
			return body, nil
		}
		body, err := f.fetch(ctx, method, rawURL, encodedForm)
		if err != nil {
			return nil, err
		}
		f.cache.Set(ctx, key, body, ttl)
		return body, nil
	})
	if shared {
		f.logger.Debug("upstream request deduplicated", "method", method, "url", rawURL)
	}
	return body, err
}

// fetch performs one upstream request. It returns ErrNotFound for 404, *StatusError for other
// non-2xx responses, and an error for bodies over maxBodyBytes.
func (f *HTTPFetcher) fetch(ctx context.Context, method, rawURL, encodedForm string) ([]byte, error) {
	var reqBody io.Reader
	if method == http.MethodPost {
		reqBody = strings.NewReader(encodedForm)
	}
	req, err := http.NewRequestWithContext(ctx, method, rawURL, reqBody)
	if err != nil {
		return nil, fmt.Errorf("upstream %s: %w", rawURL, err)
	}
	if method == http.MethodPost {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if f.userAgent != "" {
		req.Header.Set("User-Agent", f.userAgent)
	}

	resp, err := f.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("upstream %s: %w", rawURL, err)
	}
	defer resp.Body.Close()
	f.logger.Debug("upstream response", "method", method, "url", rawURL, "status", resp.StatusCode)

	switch {
	case resp.StatusCode == http.StatusNotFound:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return nil, ErrNotFound
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return nil, &StatusError{URL: rawURL, Status: resp.StatusCode}
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil {
		return nil, fmt.Errorf("upstream %s: read body: %w", rawURL, err)
	}
	if int64(len(body)) > maxBodyBytes {
		return nil, fmt.Errorf("upstream %s: response larger than %d bytes", rawURL, maxBodyBytes)
	}
	return body, nil
}

// cacheKey is the hex SHA-256 of method, URL and encoded form.
func cacheKey(method, rawURL, encodedForm string) string {
	sum := sha256.Sum256([]byte(method + " " + rawURL + "\n" + encodedForm))
	return hex.EncodeToString(sum[:])
}
