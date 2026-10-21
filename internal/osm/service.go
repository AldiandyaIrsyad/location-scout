package osm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"panelscape/internal/cache"
	"panelscape/internal/geo"
	"panelscape/internal/upstream"
)

// CityService implements Service. Raw Overpass responses are cached by the upstream fetcher
// (osmTTL); finished results are cached by results (resultTTL) as JSON.
type CityService struct {
	f            upstream.Fetcher
	overpassURLs []string
	osmTTL       time.Duration
	results      cache.Cache
	resultTTL    time.Duration
	logger       *slog.Logger
	// RetryDelays are the pauses between rounds over all servers when every server is busy
	// (429/502/503/504 or a network error). One round per entry plus the first attempt.
	RetryDelays []time.Duration
	// RetryBudget bounds the time spent before another round is started, so slow (timing-out)
	// servers are not retried for minutes. Zero means no bound.
	RetryBudget time.Duration
	// CityTimeout and SurroundingsTimeout bound one Overpass request for the detailed area and for
	// the (much larger) surroundings. Zero leaves the limit to the fetcher's HTTP client.
	CityTimeout         time.Duration
	SurroundingsTimeout time.Duration
	// StaleTTL keeps a last-good copy of each Overpass response, served when every server fails.
	StaleTTL time.Duration
}

// staleKey names the last-good copy of a query's response in the results cache.
func staleKey(query string) string {
	h := sha256.Sum256([]byte(query))
	return "osm-stale:v1:" + hex.EncodeToString(h[:])
}

var _ Service = (*CityService)(nil)

// NewService returns an OSM service that posts queries to overpassURLs in order, falling back to
// the next URL on error or on an invalid response. nil results or logger are replaced by a no-op
// cache and a discarding logger.
func NewService(f upstream.Fetcher, overpassURLs []string, osmTTL time.Duration, results cache.Cache, resultTTL time.Duration, logger *slog.Logger) *CityService {
	if results == nil {
		results = cache.Nop{}
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &CityService{
		f:            f,
		overpassURLs: append([]string(nil), overpassURLs...),
		osmTTL:       osmTTL,
		results:      results,
		resultTTL:    resultTTL,
		logger:       logger,
		RetryDelays:  []time.Duration{2 * time.Second, 5 * time.Second},
		RetryBudget:  30 * time.Second,
		StaleTTL:     30 * 24 * time.Hour,
	}
}

// City returns the size x size square centred on (lat, lon), with guessed heights re-rolled by seed.
func (s *CityService) City(ctx context.Context, lat, lon float64, size int, seed int) (*CityData, error) {
	key := fmt.Sprintf("city:v4:%s:%s:%d:%d", toFixed(lat, 5), toFixed(lon, 5), size, seed)
	var cached CityData
	if s.loadResult(ctx, key, &cached) {
		return &cached, nil
	}
	box := geo.BBoxFor(lat, lon, float64(size))
	raw, err := s.overpass(ctx, cityQuery(box), s.CityTimeout)
	if err != nil {
		return nil, err
	}
	city, err := Parse(raw, lat, lon, size, seed)
	if err != nil {
		return nil, err
	}
	s.storeResult(ctx, key, city)
	return city, nil
}

// Surroundings returns the building footprints of the farSize square outside the inner size square.
func (s *CityService) Surroundings(ctx context.Context, lat, lon float64, size, farSize int) (*Surroundings, error) {
	key := fmt.Sprintf("sur:v4:%s:%s:%d:%d", toFixed(lat, 5), toFixed(lon, 5), size, farSize)
	var cached Surroundings
	if s.loadResult(ctx, key, &cached) {
		return &cached, nil
	}
	farBox := geo.BBoxFor(lat, lon, float64(farSize))
	contextBox := geo.BBoxFor(lat, lon, float64(contextSizeFor(farSize)))
	raw, err := s.overpass(ctx, surroundingsQuery(farBox, contextBox), s.SurroundingsTimeout)
	if err != nil {
		return nil, err
	}
	sur, err := ParseSurroundings(raw, lat, lon, size, farSize)
	if err != nil {
		return nil, err
	}
	s.storeResult(ctx, key, sur)
	return sur, nil
}

// overpass posts the query to each server in order and returns the first valid response.
// When every server is busy it waits and tries again (RetryDelays); when all attempts fail it
// serves the last good response for the same query, if one was kept (StaleTTL).
func (s *CityService) overpass(ctx context.Context, query string, attemptTimeout time.Duration) ([]byte, error) {
	if len(s.overpassURLs) == 0 {
		return nil, errors.New("osm: no Overpass servers configured")
	}
	var lastErr error
	start := time.Now()
	for round := 0; round <= len(s.RetryDelays); round++ {
		if round > 0 {
			if s.RetryBudget > 0 && time.Since(start)+s.RetryDelays[round-1] > s.RetryBudget {
				break
			}
			s.logger.Info("all overpass servers busy, retrying", "round", round, "wait", s.RetryDelays[round-1])
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(s.RetryDelays[round-1]):
			}
		}
		retryable := false
		for _, u := range s.overpassURLs {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			body, err := s.post(ctx, u, query, attemptTimeout)
			if err == nil {
				err = checkOverpass(body)
			}
			if err == nil {
				s.results.Set(ctx, staleKey(query), body, s.StaleTTL)
				return body, nil
			}
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
			lastErr = fmt.Errorf("osm: overpass %s: %w", u, err)
			retryable = retryable || isBusy(err)
			s.logger.Warn("overpass server failed, trying next", "url", u, "err", err)
		}
		if !retryable {
			break
		}
	}
	if body, ok := s.results.Get(ctx, staleKey(query)); ok {
		s.logger.Warn("all overpass servers failed; serving last good copy", "err", lastErr)
		return body, nil
	}
	return nil, lastErr
}

// post sends one query to one server, giving up after timeout (0 = no extra limit).
func (s *CityService) post(ctx context.Context, u, query string, timeout time.Duration) ([]byte, error) {
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	return s.f.PostForm(ctx, u, url.Values{"data": {query}}, s.osmTTL)
}

// isBusy reports errors worth retrying later: rate limiting, gateway/overload statuses and
// transport errors (anything that is not a definite answer from the server).
func isBusy(err error) bool {
	var se *upstream.StatusError
	if errors.As(err, &se) {
		switch se.Status {
		case http.StatusTooManyRequests, http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout, http.StatusInternalServerError:
			return true
		}
		return false
	}
	return !errors.Is(err, upstream.ErrNotFound)
}

// checkOverpass reports an error for a body that is not an Overpass result (no elements array).
func checkOverpass(body []byte) error {
	var probe struct {
		Elements *[]json.RawMessage `json:"elements"`
		Remark   string             `json:"remark"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if probe.Elements == nil {
		if probe.Remark != "" {
			return fmt.Errorf("returned an error: %s", probe.Remark)
		}
		return errors.New("returned no elements")
	}
	return nil
}

func (s *CityService) loadResult(ctx context.Context, key string, v any) bool {
	raw, ok := s.results.Get(ctx, key)
	if !ok {
		return false
	}
	if err := json.Unmarshal(raw, v); err != nil {
		s.logger.Warn("discarding unreadable cached result", "key", key, "err", err)
		return false
	}
	return true
}

func (s *CityService) storeResult(ctx context.Context, key string, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		s.logger.Warn("cannot encode result", "key", key, "err", err)
		return
	}
	s.results.Set(ctx, key, raw, s.resultTTL)
}
