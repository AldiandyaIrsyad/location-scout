package places

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	_ "embed"

	"panelscape/internal/geo"
	"panelscape/internal/upstream"
)

// placesJSON is the built-in candidate list, generated once from the PLACES array in
// web/js/places.js (same names, coordinates and order).
//
//go:embed places.json
var placesJSON []byte

const (
	maxLocalMatches = 10
	maxRemoteHits   = 8
	dedupeMeters    = 150
)

// PlaceService implements Service: the embedded candidate list plus Nominatim search.
type PlaceService struct {
	fetcher      upstream.Fetcher
	nominatimURL string
	searchTTL    time.Duration
	logger       *slog.Logger
	places       []Place
}

// NewService builds the place service. nominatimURL is the search endpoint (for example
// https://nominatim.openstreetmap.org/search); when it is empty only the local list is searched.
func NewService(f upstream.Fetcher, nominatimURL string, searchTTL time.Duration, logger *slog.Logger) (*PlaceService, error) {
	var list []Place
	if err := json.Unmarshal(placesJSON, &list); err != nil {
		return nil, fmt.Errorf("places: decode embedded list: %w", err)
	}
	if len(list) == 0 {
		return nil, fmt.Errorf("places: embedded list is empty")
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &PlaceService{
		fetcher:      f,
		nominatimURL: nominatimURL,
		searchTTL:    searchTTL,
		logger:       logger,
		places:       list,
	}, nil
}

// Candidates returns a copy of the built-in list, in display order.
func (s *PlaceService) Candidates() []Place {
	out := make([]Place, len(s.places))
	copy(out, s.places)
	return out
}

// Search matches the built-in list (accent- and case-insensitive, substring or all tokens), then
// appends Nominatim results that are not duplicates by name or within 150 m. If Nominatim fails,
// only the local matches are returned and the error is not reported.
func (s *PlaceService) Search(ctx context.Context, query string) ([]Place, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return []Place{}, nil
	}

	local := s.localMatches(q)
	remote, err := s.remoteMatches(ctx, q)
	if err != nil {
		s.logger.Warn("place search: Nominatim unavailable, returning local matches", "query", q, "err", err)
		return local, nil
	}

	results := make([]Place, 0, len(local)+len(remote))
	results = append(results, local...)
	for _, r := range remote {
		if !isDuplicate(results, r) {
			results = append(results, r)
		}
	}
	return results, nil
}

// localMatches returns up to maxLocalMatches built-in places: the whole query is a substring of the
// name, or every query token appears in it. Names starting with the query come first, then shorter names.
func (s *PlaceService) localMatches(query string) []Place {
	q := normalize(query)
	if q == "" {
		return []Place{}
	}
	tokens := strings.Fields(q)

	type candidate struct {
		place  Place
		norm   string
		starts bool
	}
	var hits []candidate
	for _, p := range s.places {
		name := normalize(p.Name)
		if !strings.Contains(name, q) && !containsAll(name, tokens) {
			continue
		}
		hits = append(hits, candidate{place: p, norm: name, starts: strings.HasPrefix(name, q)})
	}

	sort.SliceStable(hits, func(a, b int) bool {
		if hits[a].starts != hits[b].starts {
			return hits[a].starts
		}
		return utf8.RuneCountInString(hits[a].place.Name) < utf8.RuneCountInString(hits[b].place.Name)
	})
	if len(hits) > maxLocalMatches {
		hits = hits[:maxLocalMatches]
	}

	out := make([]Place, len(hits))
	for i, h := range hits {
		out[i] = h.place
	}
	return out
}

// nominatimHit is one entry of the Nominatim JSON search response.
type nominatimHit struct {
	DisplayName string `json:"display_name"`
	Name        string `json:"name"`
	Lat         string `json:"lat"`
	Lon         string `json:"lon"`
}

// remoteMatches queries Nominatim and keeps the hits with finite coordinates.
func (s *PlaceService) remoteMatches(ctx context.Context, q string) ([]Place, error) {
	if s.nominatimURL == "" {
		return nil, nil
	}
	params := url.Values{}
	params.Set("format", "json")
	params.Set("limit", strconv.Itoa(maxRemoteHits))
	params.Set("q", q)

	body, err := s.fetcher.Get(ctx, s.nominatimURL+"?"+params.Encode(), s.searchTTL)
	if err != nil {
		return nil, err
	}
	var hits []nominatimHit
	if err := json.Unmarshal(body, &hits); err != nil {
		return nil, fmt.Errorf("places: decode Nominatim response: %w", err)
	}

	out := make([]Place, 0, len(hits))
	for _, h := range hits {
		lat, errLat := strconv.ParseFloat(h.Lat, 64)
		lon, errLon := strconv.ParseFloat(h.Lon, 64)
		if errLat != nil || errLon != nil || !isFinite(lat) || !isFinite(lon) {
			continue
		}
		name := h.DisplayName
		if name == "" {
			name = h.Name
		}
		if name == "" {
			name = q
		}
		out = append(out, Place{Name: name, Lat: lat, Lon: lon})
	}
	return out, nil
}

// isDuplicate reports whether r has the same normalized name as, or lies within dedupeMeters of, a result.
func isDuplicate(results []Place, r Place) bool {
	rn := normalize(r.Name)
	for _, x := range results {
		if normalize(x.Name) == rn || distanceMeters(x.Lat, x.Lon, r.Lat, r.Lon) < dedupeMeters {
			return true
		}
	}
	return false
}

// distanceMeters is the equirectangular distance used by places.js.
func distanceMeters(lat1, lon1, lat2, lon2 float64) float64 {
	dLat := (lat2 - lat1) * geo.MetersPerDegLat
	dLon := (lon2 - lon1) * geo.MetersPerDegLon((lat1+lat2)/2)
	return math.Hypot(dLat, dLon)
}

func containsAll(s string, tokens []string) bool {
	for _, t := range tokens {
		if !strings.Contains(s, t) {
			return false
		}
	}
	return true
}

func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

// normalize lower-cases s, removes combining marks and folds common Latin accents to ASCII, so that
// "Medellin" matches "Medellín". It mirrors normalize() in places.js (NFD, strip marks, lower-case, trim)
// for the letters that occur in place names; the standard library has no NFD.
func normalize(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range strings.ToLower(s) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		b.WriteRune(foldAccent(r))
	}
	return strings.TrimSpace(b.String())
}

// foldAccent maps a lower-case accented Latin letter to its base letter; other runes are returned as is.
func foldAccent(r rune) rune {
	switch r {
	case 'à', 'á', 'â', 'ã', 'ä', 'å', 'ā', 'ă', 'ą':
		return 'a'
	case 'ç', 'ć', 'ĉ', 'ċ', 'č':
		return 'c'
	case 'ď', 'đ':
		return 'd'
	case 'è', 'é', 'ê', 'ë', 'ē', 'ĕ', 'ė', 'ę', 'ě':
		return 'e'
	case 'ĝ', 'ğ', 'ġ', 'ģ':
		return 'g'
	case 'ĥ', 'ħ':
		return 'h'
	case 'ì', 'í', 'î', 'ï', 'ĩ', 'ī', 'ĭ', 'į':
		return 'i'
	case 'ĵ':
		return 'j'
	case 'ķ':
		return 'k'
	case 'ĺ', 'ļ', 'ľ', 'ŀ', 'ł':
		return 'l'
	case 'ñ', 'ń', 'ņ', 'ň', 'ŉ':
		return 'n'
	case 'ò', 'ó', 'ô', 'õ', 'ö', 'ø', 'ō', 'ŏ', 'ő':
		return 'o'
	case 'ŕ', 'ŗ', 'ř':
		return 'r'
	case 'ś', 'ŝ', 'ş', 'š':
		return 's'
	case 'ţ', 'ť', 'ŧ':
		return 't'
	case 'ù', 'ú', 'û', 'ü', 'ũ', 'ū', 'ŭ', 'ů', 'ű', 'ų':
		return 'u'
	case 'ŵ':
		return 'w'
	case 'ý', 'ÿ', 'ŷ':
		return 'y'
	case 'ź', 'ż', 'ž':
		return 'z'
	}
	return r
}
