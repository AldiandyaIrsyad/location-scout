package places

import (
	"context"
	"errors"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"panelscape/internal/upstream"
)

const testNominatim = "https://nominatim.example/search"

// fakeFetcher answers Get from a route function and records the URLs it was asked for.
type fakeFetcher struct {
	route func(rawURL string) ([]byte, error)

	mu   sync.Mutex
	urls []string
}

func (f *fakeFetcher) Get(_ context.Context, rawURL string, _ time.Duration) ([]byte, error) {
	f.mu.Lock()
	f.urls = append(f.urls, rawURL)
	f.mu.Unlock()
	return f.route(rawURL)
}

func (f *fakeFetcher) PostForm(context.Context, string, url.Values, time.Duration) ([]byte, error) {
	return nil, errors.New("PostForm not used by places")
}

func (f *fakeFetcher) requests() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.urls...)
}

var _ upstream.Fetcher = (*fakeFetcher)(nil)

// offline is a fetcher whose upstream always fails, so only the local list answers.
func offline() *fakeFetcher {
	return &fakeFetcher{route: func(string) ([]byte, error) {
		return nil, &upstream.StatusError{URL: testNominatim, Status: 503}
	}}
}

// nominatimReply serves a fixed Nominatim JSON body for any request.
func nominatimReply(body string) *fakeFetcher {
	return &fakeFetcher{route: func(string) ([]byte, error) { return []byte(body), nil }}
}

func newService(t *testing.T, f upstream.Fetcher) *PlaceService {
	t.Helper()
	s, err := NewService(f, testNominatim, time.Hour, nil)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func names(ps []Place) []string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.Name
	}
	return out
}

func TestCandidatesEmbeddedListOrderAndCopy(t *testing.T) {
	s := newService(t, offline())
	c := s.Candidates()
	if len(c) != 283 {
		t.Fatalf("got %d candidates, want 283", len(c))
	}
	if c[0] != (Place{Name: "Shibuya Crossing, Tokyo", Lat: 35.6595, Lon: 139.7005, Group: "Japan"}) {
		t.Fatalf("first candidate = %+v", c[0])
	}
	last := c[len(c)-1]
	if last != (Place{Name: "Wellington (New Zealand)", Lat: -41.2915, Lon: 174.7765, Group: "Oceania"}) {
		t.Fatalf("last candidate = %+v", last)
	}

	// The returned slice is a copy: mutating it must not change the service.
	c[0].Name = "changed"
	if s.Candidates()[0].Name != "Shibuya Crossing, Tokyo" {
		t.Fatal("Candidates returned a shared slice")
	}
}

// The embedded JSON must match the PLACES array in web/js/places.js exactly (names, coordinates,
// order), and every "// Region" header in places.js must be the group of the entries under it.
func TestEmbeddedListMatchesPlacesJS(t *testing.T) {
	path := filepath.Join("..", "..", "web", "js", "places.js")
	src, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("places.js not available: %v", err)
	}
	re := regexp.MustCompile(`\{ name: '((?:[^'\\]|\\.)*)', lat: (-?[0-9.]+), lon: (-?[0-9.]+) \}`)
	c := newService(t, offline()).Candidates()

	n, group := 0, ""
	for _, line := range strings.Split(string(src), "\n") {
		if h, ok := strings.CutPrefix(line, "  // "); ok {
			group = h
			continue
		}
		m := re.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		if n >= len(c) {
			t.Fatalf("places.js has more than %d entries, embedded list has %d", n, len(c))
		}
		name := strings.ReplaceAll(m[1], `\'`, `'`)
		lat, _ := strconv.ParseFloat(m[2], 64)
		lon, _ := strconv.ParseFloat(m[3], 64)
		if c[n].Name != name || c[n].Lat != lat || c[n].Lon != lon || c[n].Group != group {
			t.Fatalf("entry %d: embedded %+v, places.js {%q %v %v} under %q", n, c[n], name, lat, lon, group)
		}
		n++
	}
	if n != len(c) {
		t.Fatalf("places.js has %d entries, embedded list has %d", n, len(c))
	}
}

func TestLocalSearch(t *testing.T) {
	tests := []struct {
		name     string
		query    string
		wantTop  string   // expected first result ("" = just check Contains)
		contains []string // all of these must be present
	}{
		{name: "prefix first", query: "shibuya", wantTop: "Shibuya Crossing, Tokyo"},
		{name: "case insensitive", query: "KABUKICHO", wantTop: "Kabukicho, Shinjuku, Tokyo"},
		{name: "accent folded query", query: "medellin", contains: []string{"Medellín (Colombia)"}},
		{name: "accent in query", query: "Montréal", contains: []string{"Montréal (Canada)"}},
		{name: "tokens in any order", query: "tokyo tower", wantTop: "Tokyo Tower"},
		{name: "all tokens, not substring", query: "shinjuku kabukicho", contains: []string{"Kabukicho, Shinjuku, Tokyo"}},
		{name: "polish letter", query: "krakow", contains: []string{"Kraków (Poland)"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newService(t, offline())
			got, err := s.Search(context.Background(), tc.query)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) == 0 {
				t.Fatalf("no results for %q", tc.query)
			}
			if tc.wantTop != "" && got[0].Name != tc.wantTop {
				t.Fatalf("first result = %q, want %q (all: %v)", got[0].Name, tc.wantTop, names(got))
			}
			have := map[string]bool{}
			for _, p := range got {
				have[p.Name] = true
			}
			for _, want := range tc.contains {
				if !have[want] {
					t.Fatalf("%q missing from %v", want, names(got))
				}
			}
		})
	}
}

func TestLocalSearchLimitAndNoMatch(t *testing.T) {
	s := newService(t, offline())
	got, err := s.Search(context.Background(), "square")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != maxLocalMatches {
		t.Fatalf("got %d results for 'square', want %d", len(got), maxLocalMatches)
	}

	none, err := s.Search(context.Background(), "zzzz-no-such-place")
	if err != nil {
		t.Fatal(err)
	}
	if none == nil || len(none) != 0 {
		t.Fatalf("want empty non-nil slice, got %#v", none)
	}
}

func TestEmptyQueryDoesNotCallUpstream(t *testing.T) {
	f := offline()
	s := newService(t, f)
	for _, q := range []string{"", "   \t"} {
		got, err := s.Search(context.Background(), q)
		if err != nil || got == nil || len(got) != 0 {
			t.Fatalf("Search(%q) = %#v, %v; want empty", q, got, err)
		}
	}
	if n := len(f.requests()); n != 0 {
		t.Fatalf("upstream called %d times for empty queries", n)
	}
}

func TestNominatimMergeAndDedupe(t *testing.T) {
	body := `[
	  {"display_name": "Tokyo Station Hotel", "lat": "35.6815", "lon": "139.7663"},
	  {"display_name": "Tokyo Station", "lat": "10", "lon": "10"},
	  {"display_name": "Tokyo Dome", "lat": "35.7056", "lon": "139.7519"},
	  {"display_name": "Tokyo Dome", "lat": "35.7056", "lon": "139.7519"},
	  {"name": "Nowhere", "lat": "not-a-number", "lon": "1"},
	  {"name": "Named only", "lat": "36.0", "lon": "140.0"}
	]`
	s := newService(t, nominatimReply(body))

	got, err := s.Search(context.Background(), "tokyo station")
	if err != nil {
		t.Fatal(err)
	}
	local, _ := newService(t, offline()).Search(context.Background(), "tokyo station")
	if len(got) < len(local)+2 {
		t.Fatalf("got %d results, want local %d plus remote", len(got), len(local))
	}
	if got[0].Name != "Tokyo Station" {
		t.Fatalf("local match must come first, got %v", names(got))
	}

	// Remote hits: "Tokyo Station Hotel" is within 150 m of the local Tokyo Station (dropped),
	// the second "Tokyo Station" has the same normalized name (dropped), the first "Tokyo Dome" is
	// kept, the second copy is dropped as a duplicate of it, and the name-only entry is kept with its
	// name. Bad coordinates are dropped.
	for _, p := range got {
		if p.Name == "Tokyo Station Hotel" {
			t.Fatalf("near-duplicate by distance was not removed: %v", names(got))
		}
	}
	tail := names(got[len(local):])
	if strings.Join(tail, "|") != "Tokyo Dome|Named only" {
		t.Fatalf("remote tail = %v, want [Tokyo Dome Named only]", tail)
	}
	if got[len(local)].Lat != 35.7056 || got[len(local)].Lon != 139.7519 {
		t.Fatalf("remote coordinates not parsed: %+v", got[len(local)])
	}
}

func TestNominatimRequestURL(t *testing.T) {
	f := nominatimReply(`[]`)
	s := newService(t, f)
	if _, err := s.Search(context.Background(), "tokyo tower & more"); err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if len(reqs) != 1 {
		t.Fatalf("got %d upstream requests, want 1", len(reqs))
	}
	want := testNominatim + "?format=json&limit=8&q=tokyo+tower+%26+more"
	if reqs[0] != want {
		t.Fatalf("request URL = %q, want %q", reqs[0], want)
	}
}

func TestUpstreamFailureFallsBackToLocal(t *testing.T) {
	s := newService(t, offline())
	local, _ := s.Search(context.Background(), "tokyo tower")

	// Non-JSON body from upstream: also a fallback, not an error.
	bad := newService(t, nominatimReply(`<html>rate limited</html>`))
	got, err := bad.Search(context.Background(), "tokyo tower")
	if err != nil {
		t.Fatalf("upstream failure must not be an error, got %v", err)
	}
	if strings.Join(names(got), "|") != strings.Join(names(local), "|") {
		t.Fatalf("fallback = %v, want local %v", names(got), names(local))
	}

	// A 404 from upstream is handled the same way.
	nf := newService(t, &fakeFetcher{route: func(string) ([]byte, error) { return nil, upstream.ErrNotFound }})
	got, err = nf.Search(context.Background(), "tokyo tower")
	if err != nil || len(got) != len(local) {
		t.Fatalf("404 fallback: %v, %v", names(got), err)
	}
}

func TestNormalizeFolding(t *testing.T) {
	tests := map[string]string{
		"Medellín":           "medellin",
		"Kraków":             "krakow",
		"  ÀÉÎ  ":            "aei",
		"Ça Ira":             "ca ira",
		"Łódź":               "lodz",
		"Reykjavík":          "reykjavik",
		"Café":              "cafe", // decomposed input: combining mark dropped
		"Philosopher's Path": "philosopher's path",
	}
	for in, want := range tests {
		if got := normalize(in); got != want {
			t.Errorf("normalize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDistanceMeters(t *testing.T) {
	// One degree of latitude is about 110.574 km.
	if d := distanceMeters(35, 139, 36, 139); math.Abs(d-110574) > 1 {
		t.Fatalf("1 degree latitude = %v m", d)
	}
	// Same point is zero distance.
	if d := distanceMeters(35.6586, 139.7454, 35.6586, 139.7454); d != 0 {
		t.Fatalf("zero distance = %v", d)
	}
}
