package httpapi_test

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"panelscape/internal/coords"
	"panelscape/internal/elevation"
	"panelscape/internal/geo"
	"panelscape/internal/httpapi"
	"panelscape/internal/osm"
	"panelscape/internal/places"
)

// ---------------------------------------------------------------------------
// Fakes. The handler only sees the interfaces, so these stand in for the real services.

type fakeCity struct {
	err      error
	panicMsg string
	calls    int
	lastSize int
	lastSeed int
	lastFar  int
}

func (f *fakeCity) City(_ context.Context, lat, lon float64, size, seed int) (*osm.CityData, error) {
	f.calls++
	f.lastSize, f.lastSeed = size, seed
	if f.panicMsg != "" {
		panic(f.panicMsg)
	}
	if f.err != nil {
		return nil, f.err
	}
	return &osm.CityData{
		Center:    osm.LatLon{Lat: lat, Lon: lon},
		Size:      size,
		Seed:      seed,
		Buildings: []osm.Building{{ID: "w1", Outer: []geo.Point{{0, 0}, {10, 0}, {10, 10}}, Height: 12, Kind: "yes"}},
		Stats:     osm.Stats{Buildings: 1},
	}, nil
}

func (f *fakeCity) Surroundings(_ context.Context, _, _ float64, size, farSize int) (*osm.Surroundings, error) {
	f.calls++
	f.lastSize, f.lastFar = size, farSize
	if f.err != nil {
		return nil, f.err
	}
	return &osm.Surroundings{Buildings: []osm.Building{{ID: "s1", Outer: []geo.Point{{0, 0}, {1, 0}, {1, 1}}}}}, nil
}

type fakeElevation struct {
	err   error
	calls int
}

func (f *fakeElevation) Grid(_ context.Context, _, _ float64, size float64, n int) (*elevation.Grid, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &elevation.Grid{Size: size, N: n, Heights: make([]float32, n*n), BaseElevation: 40, Source: "Terrain Tiles"}, nil
}

type fakePlaces struct {
	searchErr error
}

var fakeCandidates = []places.Place{{Name: "Shibuya Crossing, Tokyo", Lat: 35.6595, Lon: 139.7005}}

func (f *fakePlaces) Candidates() []places.Place { return fakeCandidates }

func (f *fakePlaces) Search(_ context.Context, q string) ([]places.Place, error) {
	if f.searchErr != nil {
		return nil, f.searchErr
	}
	var out []places.Place
	for _, p := range fakeCandidates {
		if strings.Contains(strings.ToLower(p.Name), strings.ToLower(q)) {
			out = append(out, p)
		}
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// Harness

type harness struct {
	h      http.Handler
	city   *fakeCity
	elev   *fakeElevation
	places *fakePlaces
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	city, elev, pl := &fakeCity{}, &fakeElevation{}, &fakePlaces{}
	h := httpapi.New(httpapi.Deps{
		City:      city,
		Elevation: elev,
		Places:    pl,
		Locate: func(text string) (*coords.Location, bool) {
			if text == "35.66,139.70" {
				return &coords.Location{Lat: 35.66, Lon: 139.70}, true
			}
			return nil, false
		},
		LocateFile: func(name string, data []byte) (*coords.Location, error) {
			if !strings.HasSuffix(name, ".kml") {
				return nil, errors.New("unsupported file")
			}
			if !bytes.Contains(data, []byte("<kml")) {
				return nil, nil
			}
			return &coords.Location{Lat: 48.85, Lon: 2.29, Name: "Eiffel"}, nil
		},
		Static: fstest.MapFS{
			"index.html":    {Data: []byte("<!doctype html><title>Panelscape</title>")},
			"js/app.js":     {Data: []byte("export const x = 1;")},
			"css/style.css": {Data: []byte("body{}")},
		},
		Logger: slog.New(slog.DiscardHandler),
		Info:   httpapi.About{Name: "Panelscape", Author: "Aldiandya Irsyad", Version: "test"},
		CacheStats: func() map[string]int64 {
			return map[string]int64{"memory.hits": 3, "memory.misses": 1}
		},
	})
	return &harness{h: h, city: city, elev: elev, places: pl}
}

func (hn *harness) do(req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	hn.h.ServeHTTP(rec, req)
	return rec
}

func (hn *harness) get(target string, headers ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	return hn.do(req)
}

func errorText(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("error body is not JSON: %v (%q)", err, rec.Body.String())
	}
	if body.Error == "" {
		t.Fatalf("error body has no error field: %q", rec.Body.String())
	}
	return body.Error
}

func expectStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d; body %q", rec.Code, want, rec.Body.String())
	}
}

func multipartUpload(t *testing.T, field, filename string, data []byte) (*bytes.Buffer, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, err := mw.CreateFormFile(field, filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return &buf, mw.FormDataContentType()
}

// ---------------------------------------------------------------------------
// Tests

func TestHealth(t *testing.T) {
	rec := newHarness(t).get("/api/health")
	expectStatus(t, rec, http.StatusOK)
	if got := strings.TrimSpace(rec.Body.String()); got != `{"status":"ok"}` {
		t.Fatalf("body = %s", got)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}
}

func TestAboutCarriesAuthor(t *testing.T) {
	rec := newHarness(t).get("/api/about")
	expectStatus(t, rec, http.StatusOK)
	var about httpapi.About
	if err := json.Unmarshal(rec.Body.Bytes(), &about); err != nil {
		t.Fatal(err)
	}
	if about.Author != "Aldiandya Irsyad" || about.Name != "Panelscape" || about.Version != "test" {
		t.Fatalf("about = %+v", about)
	}
}

func TestCityValidation(t *testing.T) {
	cases := []string{
		"/api/city",
		"/api/city?lat=35&lon=139",
		"/api/city?lat=abc&lon=139&size=300",
		"/api/city?lat=91&lon=0&size=300",
		"/api/city?lat=0&lon=181&size=300",
		"/api/city?lat=NaN&lon=0&size=300",
		"/api/city?lat=0&lon=0&size=250",
		"/api/city?lat=0&lon=0&size=300&seed=x",
	}
	for _, target := range cases {
		hn := newHarness(t)
		rec := hn.get(target)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", target, rec.Code)
		}
		errorText(t, rec)
		if hn.city.calls != 0 {
			t.Errorf("%s: service was called for invalid input", target)
		}
	}
}

func TestCityHappyPath(t *testing.T) {
	hn := newHarness(t)
	rec := hn.get("/api/city?lat=35.6595&lon=139.7005&size=300&seed=7")
	expectStatus(t, rec, http.StatusOK)
	if hn.city.lastSize != 300 || hn.city.lastSeed != 7 {
		t.Fatalf("service got size=%d seed=%d", hn.city.lastSize, hn.city.lastSeed)
	}
	var city osm.CityData
	if err := json.Unmarshal(rec.Body.Bytes(), &city); err != nil {
		t.Fatal(err)
	}
	if city.Size != 300 || city.Seed != 7 || len(city.Buildings) != 1 {
		t.Fatalf("city = %+v", city)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=3600" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if rec.Header().Get("ETag") == "" {
		t.Fatal("missing ETag")
	}
}

func TestCitySeedDefaultsToZero(t *testing.T) {
	hn := newHarness(t)
	expectStatus(t, hn.get("/api/city?lat=1&lon=2&size=200"), http.StatusOK)
	if hn.city.lastSeed != 0 {
		t.Fatalf("seed = %d, want 0", hn.city.lastSeed)
	}
}

func TestUpstreamFailureIs502WithoutDetail(t *testing.T) {
	hn := newHarness(t)
	hn.city.err = errors.New("overpass secret-host unreachable")
	rec := hn.get("/api/city?lat=1&lon=2&size=300")
	expectStatus(t, rec, http.StatusBadGateway)
	if msg := errorText(t, rec); strings.Contains(msg, "secret-host") {
		t.Fatalf("upstream detail leaked to client: %q", msg)
	}
}

func TestETagNotModified(t *testing.T) {
	hn := newHarness(t)
	first := hn.get("/api/city?lat=1&lon=2&size=300")
	expectStatus(t, first, http.StatusOK)
	etag := first.Header().Get("ETag")

	second := hn.get("/api/city?lat=1&lon=2&size=300", "If-None-Match", etag)
	expectStatus(t, second, http.StatusNotModified)
	if second.Body.Len() != 0 {
		t.Fatalf("304 carried a body: %q", second.Body.String())
	}

	other := hn.get("/api/city?lat=1&lon=2&size=300", "If-None-Match", `"stale"`)
	expectStatus(t, other, http.StatusOK)
}

func TestGzipWhenAccepted(t *testing.T) {
	hn := newHarness(t)
	rec := hn.get("/api/city?lat=1&lon=2&size=300", "Accept-Encoding", "gzip, deflate")
	expectStatus(t, rec, http.StatusOK)
	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q", rec.Header().Get("Content-Encoding"))
	}
	if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
		t.Fatalf("Vary = %q", rec.Header().Get("Vary"))
	}
	if !strings.HasPrefix(rec.Header().Get("ETag"), `W/"`) {
		t.Fatalf("ETag should be weak once encoded, got %q", rec.Header().Get("ETag"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	var city osm.CityData
	if err := json.Unmarshal(plain, &city); err != nil {
		t.Fatalf("decompressed body is not JSON: %v", err)
	}

	// The weak tag from the encoded response still earns a 304.
	again := hn.get("/api/city?lat=1&lon=2&size=300", "Accept-Encoding", "gzip", "If-None-Match", rec.Header().Get("ETag"))
	expectStatus(t, again, http.StatusNotModified)
}

func TestNoGzipWithoutAcceptance(t *testing.T) {
	rec := newHarness(t).get("/api/city?lat=1&lon=2&size=300")
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("unexpected Content-Encoding %q", rec.Header().Get("Content-Encoding"))
	}
}

func TestSurroundings(t *testing.T) {
	hn := newHarness(t)
	for _, target := range []string{
		"/api/surroundings?lat=1&lon=2&size=300",
		"/api/surroundings?lat=1&lon=2&size=300&far=3000",
		"/api/surroundings?lat=1&lon=2&size=999&far=2000",
	} {
		expectStatus(t, hn.get(target), http.StatusBadRequest)
	}
	rec := hn.get("/api/surroundings?lat=1&lon=2&size=300&far=4000")
	expectStatus(t, rec, http.StatusOK)
	if hn.city.lastFar != 4000 {
		t.Fatalf("far = %d", hn.city.lastFar)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, max-age=3600" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestElevation(t *testing.T) {
	hn := newHarness(t)
	for _, target := range []string{
		"/api/elevation?lat=1&lon=2&size=50&n=129",
		"/api/elevation?lat=1&lon=2&size=6000&n=129",
		"/api/elevation?lat=1&lon=2&size=300&n=16",
		"/api/elevation?lat=1&lon=2&size=300&n=258",
		"/api/elevation?lat=1&lon=2&size=300",
	} {
		expectStatus(t, hn.get(target), http.StatusBadRequest)
	}
	rec := hn.get("/api/elevation?lat=1&lon=2&size=300&n=17")
	expectStatus(t, rec, http.StatusOK)
	var grid elevation.Grid
	if err := json.Unmarshal(rec.Body.Bytes(), &grid); err != nil {
		t.Fatal(err)
	}
	if grid.N != 17 || len(grid.Heights) != 17*17 || grid.Source != "Terrain Tiles" {
		t.Fatalf("grid = n %d, %d heights, source %q", grid.N, len(grid.Heights), grid.Source)
	}
}

func TestElevationUpstreamFailure(t *testing.T) {
	hn := newHarness(t)
	hn.elev.err = errors.New("tile server down")
	expectStatus(t, hn.get("/api/elevation?lat=1&lon=2&size=300&n=17"), http.StatusBadGateway)
}

func TestPlaces(t *testing.T) {
	rec := newHarness(t).get("/api/places")
	expectStatus(t, rec, http.StatusOK)
	var list []places.Place
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != "Shibuya Crossing, Tokyo" {
		t.Fatalf("list = %+v", list)
	}
	if got := rec.Header().Get("Cache-Control"); got != "public, no-cache" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestPlaceSearch(t *testing.T) {
	hn := newHarness(t)
	expectStatus(t, hn.get("/api/places/search"), http.StatusBadRequest)
	expectStatus(t, hn.get("/api/places/search?q=%20%20"), http.StatusBadRequest)

	rec := hn.get("/api/places/search?q=shibuya")
	expectStatus(t, rec, http.StatusOK)
	var found []places.Place
	if err := json.Unmarshal(rec.Body.Bytes(), &found); err != nil || len(found) != 1 {
		t.Fatalf("found = %v (%v)", found, err)
	}

	hn.places.searchErr = errors.New("nominatim down")
	expectStatus(t, hn.get("/api/places/search?q=shibuya"), http.StatusBadGateway)
}

func TestLocate(t *testing.T) {
	hn := newHarness(t)
	expectStatus(t, hn.get("/api/locate"), http.StatusBadRequest)

	miss := hn.get("/api/locate?q=hello")
	expectStatus(t, miss, http.StatusNotFound)
	if msg := errorText(t, miss); msg != "not a location" {
		t.Fatalf("error = %q", msg)
	}

	rec := hn.get("/api/locate?q=35.66%2C139.70")
	expectStatus(t, rec, http.StatusOK)
	var loc coords.Location
	if err := json.Unmarshal(rec.Body.Bytes(), &loc); err != nil {
		t.Fatal(err)
	}
	if loc.Lat != 35.66 || loc.Lon != 139.70 {
		t.Fatalf("loc = %+v", loc)
	}
}

func TestLocateFileMultipart(t *testing.T) {
	hn := newHarness(t)
	body, ctype := multipartUpload(t, "file", "spot.kml", []byte("<kml><Placemark/></kml>"))
	req := httptest.NewRequest(http.MethodPost, "/api/locate/file", body)
	req.Header.Set("Content-Type", ctype)
	rec := hn.do(req)
	expectStatus(t, rec, http.StatusOK)
	var loc coords.Location
	if err := json.Unmarshal(rec.Body.Bytes(), &loc); err != nil {
		t.Fatal(err)
	}
	if loc.Name != "Eiffel" {
		t.Fatalf("loc = %+v", loc)
	}
}

func TestLocateFileRejections(t *testing.T) {
	hn := newHarness(t)

	// The service finds no location in the file: 422.
	body, ctype := multipartUpload(t, "file", "empty.kml", []byte("nothing here"))
	req := httptest.NewRequest(http.MethodPost, "/api/locate/file", body)
	req.Header.Set("Content-Type", ctype)
	expectStatus(t, hn.do(req), http.StatusUnprocessableEntity)

	// The parser rejects the file type: 422 with its message.
	body, ctype = multipartUpload(t, "file", "notes.txt", []byte("x"))
	req = httptest.NewRequest(http.MethodPost, "/api/locate/file", body)
	req.Header.Set("Content-Type", ctype)
	rec := hn.do(req)
	expectStatus(t, rec, http.StatusUnprocessableEntity)
	if msg := errorText(t, rec); msg != "unsupported file" {
		t.Fatalf("error = %q", msg)
	}

	// Wrong field name: 400.
	body, ctype = multipartUpload(t, "upload", "spot.kml", []byte("<kml/>"))
	req = httptest.NewRequest(http.MethodPost, "/api/locate/file", body)
	req.Header.Set("Content-Type", ctype)
	expectStatus(t, hn.do(req), http.StatusBadRequest)

	// Not multipart: 400.
	req = httptest.NewRequest(http.MethodPost, "/api/locate/file", strings.NewReader("plain"))
	req.Header.Set("Content-Type", "text/plain")
	expectStatus(t, hn.do(req), http.StatusBadRequest)

	// Larger than 10 MB: 413.
	big, ctype := multipartUpload(t, "file", "big.kml", bytes.Repeat([]byte("a"), 10<<20+1))
	req = httptest.NewRequest(http.MethodPost, "/api/locate/file", big)
	req.Header.Set("Content-Type", ctype)
	expectStatus(t, hn.do(req), http.StatusRequestEntityTooLarge)
}

func TestStaticFrontend(t *testing.T) {
	hn := newHarness(t)

	root := hn.get("/")
	expectStatus(t, root, http.StatusOK)
	if !strings.Contains(root.Body.String(), "Panelscape") {
		t.Fatalf("/ did not serve index.html: %q", root.Body.String())
	}
	if ct := root.Header().Get("Content-Type"); ct != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if root.Header().Get("ETag") == "" {
		t.Fatal("static file has no ETag")
	}

	js := hn.get("/js/app.js")
	expectStatus(t, js, http.StatusOK)
	if ct := js.Header().Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
		t.Fatalf("js Content-Type = %q", ct)
	}
	css := hn.get("/css/style.css")
	if ct := css.Header().Get("Content-Type"); ct != "text/css; charset=utf-8" {
		t.Fatalf("css Content-Type = %q", ct)
	}

	again := hn.get("/js/app.js", "If-None-Match", js.Header().Get("ETag"))
	expectStatus(t, again, http.StatusNotModified)

	expectStatus(t, hn.get("/missing.js"), http.StatusNotFound)
}

func TestMethodsAndUnknownAPI(t *testing.T) {
	hn := newHarness(t)

	req := httptest.NewRequest(http.MethodPost, "/api/city?lat=1&lon=2&size=300", nil)
	rec := hn.do(req)
	expectStatus(t, rec, http.StatusMethodNotAllowed)
	if allow := rec.Header().Get("Allow"); !strings.Contains(allow, "GET") {
		t.Fatalf("Allow = %q", allow)
	}
	errorText(t, rec)

	unknown := hn.get("/api/nope")
	expectStatus(t, unknown, http.StatusNotFound)
	errorText(t, unknown)
}

func TestCORSOnAPI(t *testing.T) {
	hn := newHarness(t)
	if got := hn.get("/api/health").Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("ACAO = %q", got)
	}
	req := httptest.NewRequest(http.MethodOptions, "/api/city", nil)
	req.Header.Set("Origin", "https://example.org")
	req.Header.Set("Access-Control-Request-Method", "GET")
	rec := hn.do(req)
	expectStatus(t, rec, http.StatusNoContent)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("preflight ACAO = %q", got)
	}
	if got := hn.get("/js/app.js").Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("CORS header on static file: %q", got)
	}
}

func TestNoSniffHeaderOnAllResponses(t *testing.T) {
	hn := newHarness(t)
	for _, p := range []string{"/api/health", "/js/app.js", "/api/nope"} {
		if got := hn.get(p).Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options = %q, want nosniff", p, got)
		}
	}
}

func TestPanicIsRecovered(t *testing.T) {
	hn := newHarness(t)
	hn.city.panicMsg = "boom"
	rec := hn.get("/api/city?lat=1&lon=2&size=300")
	expectStatus(t, rec, http.StatusInternalServerError)
	if msg := errorText(t, rec); strings.Contains(msg, "boom") {
		t.Fatalf("panic value leaked: %q", msg)
	}
	// The server keeps serving after the panic.
	expectStatus(t, hn.get("/api/health"), http.StatusOK)
}

func TestCacheStats(t *testing.T) {
	rec := newHarness(t).get("/api/cache/stats")
	expectStatus(t, rec, http.StatusOK)
	var stats map[string]int64
	if err := json.Unmarshal(rec.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if stats["memory.hits"] != 3 || stats["memory.misses"] != 1 {
		t.Fatalf("stats = %v", stats)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q", cc)
	}
}

// A minimal DI check: New works with nothing but the fakes and no logger, static FS or stats.
func TestNewWithMinimalDeps(t *testing.T) {
	h := httpapi.New(httpapi.Deps{City: &fakeCity{}, Elevation: &fakeElevation{}, Places: &fakePlaces{}})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 without a static FS", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/cache/stats", nil))
	expectStatus(t, rec, http.StatusOK)
}
