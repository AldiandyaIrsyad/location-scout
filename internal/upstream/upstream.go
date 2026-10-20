// Package upstream fetches data from third-party services (Overpass, Nominatim, elevation tiles)
// through the caching layer, with per-request deduplication of identical in-flight calls.
package upstream

import (
	"context"
	"errors"
	"net/url"
	"time"
)

// Fetcher performs cached HTTP requests. Cached bodies are returned without contacting the server.
type Fetcher interface {
	// Get fetches url and caches a successful (2xx) body for ttl.
	Get(ctx context.Context, url string, ttl time.Duration) ([]byte, error)
	// PostForm posts form (application/x-www-form-urlencoded) and caches a successful body for ttl.
	PostForm(ctx context.Context, url string, form url.Values, ttl time.Duration) ([]byte, error)
}

// StatusError is returned for non-2xx responses.
type StatusError struct {
	URL    string
	Status int
}

func (e *StatusError) Error() string {
	return "upstream " + e.URL + ": HTTP " + itoa(e.Status)
}

// ErrNotFound reports a 404 from upstream (e.g. a missing elevation tile).
var ErrNotFound = errors.New("upstream: not found")

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
