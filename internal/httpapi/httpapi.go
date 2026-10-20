// Package httpapi is the HTTP layer: JSON routes under /api/, the frontend served from an fs.FS, and
// the middleware around them. It depends only on the service interfaces, so tests pass fakes.
package httpapi

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"math"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"panelscape/internal/coords"
	"panelscape/internal/elevation"
	"panelscape/internal/osm"
	"panelscape/internal/places"
)

// About describes the running server (GET /api/about).
type About struct {
	Name    string `json:"name"`
	Author  string `json:"author"`
	Version string `json:"version"`
}

// Deps are the collaborators of the handler. Everything is injected; nothing is global.
type Deps struct {
	City       osm.Service
	Elevation  elevation.Service
	Places     places.Service
	Locate     func(text string) (*coords.Location, bool)
	LocateFile func(name string, data []byte) (*coords.Location, error)
	Static     fs.FS // frontend files; "index.html" is served at "/"
	Logger     *slog.Logger
	Info       About
	CacheStats func() map[string]int64
}

const (
	maxUploadBytes = 10 << 20
	maxQueryLen    = 200

	cacheGeo    = "public, max-age=3600" // city, surroundings, elevation
	cachePlaces = "public, no-cache"     // candidate list: always revalidated by ETag (304 when unchanged)
	cacheSearch = "public, max-age=3600" // place search
	cacheAbout  = "no-cache"
	noStore     = "no-store"
)

// route is one API endpoint. Methods and paths also feed the 405 response.
type route struct {
	method  string
	path    string
	handler http.HandlerFunc
}

// New builds the full handler: middleware around the API routes and the static frontend.
func New(d Deps) http.Handler {
	logger := d.Logger
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	if d.Locate == nil {
		d.Locate = func(string) (*coords.Location, bool) { return nil, false }
	}
	if d.LocateFile == nil {
		d.LocateFile = func(string, []byte) (*coords.Location, error) {
			return nil, errors.New("file import is not configured")
		}
	}
	if d.CacheStats == nil {
		d.CacheStats = func() map[string]int64 { return map[string]int64{} }
	}
	h := &apiHandlers{d: d, logger: logger}

	routes := []route{
		{http.MethodGet, "/api/health", h.health},
		{http.MethodGet, "/api/about", h.about},
		{http.MethodGet, "/api/city", h.city},
		{http.MethodGet, "/api/surroundings", h.surroundings},
		{http.MethodGet, "/api/elevation", h.elevation},
		{http.MethodGet, "/api/places", h.placeList},
		{http.MethodGet, "/api/places/search", h.placeSearch},
		{http.MethodGet, "/api/locate", h.locate},
		{http.MethodPost, "/api/locate/file", h.locateFile},
		{http.MethodGet, "/api/cache/stats", h.cacheStats},
	}
	mux := http.NewServeMux()
	methods := map[string][]string{}
	for _, rt := range routes {
		mux.HandleFunc(rt.method+" "+rt.path, rt.handler)
		methods[rt.path] = append(methods[rt.path], rt.method)
	}
	allow := make(map[string]string, len(methods))
	for p, ms := range methods {
		allow[p] = strings.Join(append(ms, http.MethodOptions), ", ")
	}
	// Unknown API paths: 405 when the path exists with other methods, otherwise 404 (both JSON).
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		if a, ok := allow[r.URL.Path]; ok {
			w.Header().Set("Allow", a)
			writeError(w, http.StatusMethodNotAllowed, "method not allowed")
			return
		}
		writeError(w, http.StatusNotFound, "not found")
	})
	mux.Handle("/", staticHandler(d.Static))

	// Outermost first: logging sees the final status (including recovered panics).
	return requestLog(logger, recoverer(logger, cors(gzipMiddleware(mux))))
}

type apiHandlers struct {
	d      Deps
	logger *slog.Logger
}

func (h *apiHandlers) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, map[string]string{"status": "ok"}, noStore)
}

func (h *apiHandlers) about(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, r, http.StatusOK, h.d.Info, cacheAbout)
}

// GET /api/city?lat=&lon=&size=&seed=
func (h *apiHandlers) city(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	lat, lon, err := latLon(q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	size, err := citySize(q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	seed := 0
	if strings.TrimSpace(q.Get("seed")) != "" {
		if seed, err = intParam(q, "seed"); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	city, err := h.d.City.City(r.Context(), lat, lon, size, seed)
	if err != nil || city == nil {
		h.upstreamFailed(w, r, "city", err)
		return
	}
	writeJSON(w, r, http.StatusOK, city, cacheGeo)
}

// GET /api/surroundings?lat=&lon=&size=&far=   (far in meters: 2000 or 4000)
func (h *apiHandlers) surroundings(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	lat, lon, err := latLon(q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	size, err := citySize(q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	far, err := intParam(q, "far")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if far != 2000 && far != 4000 {
		writeError(w, http.StatusBadRequest, "far must be 2000 or 4000")
		return
	}
	sur, err := h.d.City.Surroundings(r.Context(), lat, lon, size, far)
	if err != nil || sur == nil {
		h.upstreamFailed(w, r, "surroundings", err)
		return
	}
	writeJSON(w, r, http.StatusOK, sur, cacheGeo)
}

// GET /api/elevation?lat=&lon=&size=&n=   (size 100-5000 m, n 17-257 samples per side)
func (h *apiHandlers) elevation(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	lat, lon, err := latLon(q)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	size, err := floatParam(q, "size", 100, 5000)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	n, err := intParam(q, "n")
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if n < 17 || n > 257 {
		writeError(w, http.StatusBadRequest, "n must be between 17 and 257")
		return
	}
	grid, err := h.d.Elevation.Grid(r.Context(), lat, lon, size, n)
	if err != nil || grid == nil {
		h.upstreamFailed(w, r, "elevation", err)
		return
	}
	writeJSON(w, r, http.StatusOK, grid, cacheGeo)
}

// GET /api/places: the built-in candidate list, in display order.
func (h *apiHandlers) placeList(w http.ResponseWriter, r *http.Request) {
	list := h.d.Places.Candidates()
	if list == nil {
		list = []places.Place{}
	}
	writeJSON(w, r, http.StatusOK, list, cachePlaces)
}

// GET /api/places/search?q=
func (h *apiHandlers) placeSearch(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, http.StatusBadRequest, "q is required")
		return
	}
	if len(q) > maxQueryLen {
		writeError(w, http.StatusBadRequest, "q is too long")
		return
	}
	found, err := h.d.Places.Search(r.Context(), q)
	if err != nil {
		h.upstreamFailed(w, r, "place search", err)
		return
	}
	if found == nil {
		found = []places.Place{}
	}
	writeJSON(w, r, http.StatusOK, found, cacheSearch)
}

// GET /api/locate?q=  : a map link, coordinates or Plus Code.
func (h *apiHandlers) locate(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeError(w, http.StatusBadRequest, "q is required")
		return
	}
	if len(q) > maxQueryLen*5 {
		writeError(w, http.StatusBadRequest, "q is too long")
		return
	}
	loc, ok := h.d.Locate(q)
	if !ok || loc == nil {
		writeError(w, http.StatusNotFound, "not a location")
		return
	}
	writeJSON(w, r, http.StatusOK, loc, noStore)
}

// POST /api/locate/file: multipart field "file" (KML, KMZ or GeoJSON, at most 10 MB).
func (h *apiHandlers) locateFile(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+64<<10)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			writeError(w, http.StatusRequestEntityTooLarge, "file is larger than 10 MB")
			return
		}
		writeError(w, http.StatusBadRequest, "expected a multipart/form-data upload")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "the file field is required")
		return
	}
	defer f.Close()
	if hdr.Size > maxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "file is larger than 10 MB")
		return
	}
	data, err := io.ReadAll(io.LimitReader(f, maxUploadBytes+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "could not read the file")
		return
	}
	if len(data) > maxUploadBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "file is larger than 10 MB")
		return
	}
	loc, err := h.d.LocateFile(hdr.Filename, data)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err.Error())
		return
	}
	if loc == nil {
		writeError(w, http.StatusUnprocessableEntity, "no location found in the file")
		return
	}
	writeJSON(w, r, http.StatusOK, loc, noStore)
}

// GET /api/cache/stats: hit/miss counters of the cache layers.
func (h *apiHandlers) cacheStats(w http.ResponseWriter, r *http.Request) {
	stats := h.d.CacheStats()
	if stats == nil {
		stats = map[string]int64{}
	}
	writeJSON(w, r, http.StatusOK, stats, noStore)
}

// upstreamFailed answers 502. The detail goes to the log, not to the client.
func (h *apiHandlers) upstreamFailed(w http.ResponseWriter, r *http.Request, what string, err error) {
	if err == nil {
		err = errors.New("empty result")
	}
	h.logger.WarnContext(r.Context(), "upstream failed", "what", what, "err", err)
	writeError(w, http.StatusBadGateway, "could not load "+what+": upstream request failed")
}

// ---------------------------------------------------------------------------
// Parameters

var citySizes = []int{200, 300, 400, 600, 800, 1000}

func citySize(q url.Values) (int, error) {
	size, err := intParam(q, "size")
	if err != nil {
		return 0, err
	}
	for _, s := range citySizes {
		if s == size {
			return size, nil
		}
	}
	return 0, errors.New("size must be one of 200, 300, 400, 600, 800, 1000")
}

func latLon(q url.Values) (float64, float64, error) {
	lat, err := floatParam(q, "lat", -90, 90)
	if err != nil {
		return 0, 0, err
	}
	lon, err := floatParam(q, "lon", -180, 180)
	if err != nil {
		return 0, 0, err
	}
	return lat, lon, nil
}

func floatParam(q url.Values, name string, lo, hi float64) (float64, error) {
	raw := strings.TrimSpace(q.Get(name))
	if raw == "" {
		return 0, fmt.Errorf("%s is required", name)
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, fmt.Errorf("%s must be a number", name)
	}
	if v < lo || v > hi {
		return 0, fmt.Errorf("%s must be between %g and %g", name, lo, hi)
	}
	return v, nil
}

func intParam(q url.Values, name string) (int, error) {
	raw := strings.TrimSpace(q.Get(name))
	if raw == "" {
		return 0, fmt.Errorf("%s is required", name)
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", name)
	}
	return v, nil
}

// ---------------------------------------------------------------------------
// Responses

// writeJSON encodes v. A 200 carries a strong ETag (SHA-1 of the body) and answers 304 when the
// client already has that body.
func writeJSON(w http.ResponseWriter, r *http.Request, status int, v any, cacheControl string) {
	body, err := json.Marshal(v)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not encode the response")
		return
	}
	body = append(body, '\n')
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", cacheControl)
	if status == http.StatusOK {
		sum := sha1.Sum(body)
		etag := `"` + hex.EncodeToString(sum[:]) + `"`
		h.Set("ETag", etag)
		if etagMatch(r.Header.Get("If-None-Match"), etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// writeError sends {"error": msg} with the given status.
func writeError(w http.ResponseWriter, status int, msg string) {
	body, _ := json.Marshal(map[string]string{"error": msg})
	h := w.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Cache-Control", noStore)
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

// etagMatch implements the weak comparison of If-None-Match (gzip turns strong ETags weak).
func etagMatch(header, etag string) bool {
	if header == "" {
		return false
	}
	want := strings.TrimPrefix(etag, "W/")
	for _, part := range strings.Split(header, ",") {
		p := strings.TrimSpace(part)
		if p == "*" || strings.TrimPrefix(p, "W/") == want {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Static frontend

// staticHandler serves files from fsys ("/" is index.html). ETags are content hashes and the
// browser must revalidate (no-cache), so edited files show up at once.
func staticHandler(fsys fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if fsys == nil {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if strings.HasSuffix(r.URL.Path, "/") || name == "" {
			name = path.Join(name, "index.html")
		}
		if !fs.ValidPath(name) {
			http.NotFound(w, r)
			return
		}
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		sum := sha1.Sum(data)
		h := w.Header()
		h.Set("Content-Type", contentType(name))
		h.Set("Cache-Control", "no-cache")
		h.Set("ETag", `"`+hex.EncodeToString(sum[:])+`"`)
		// Zero modtime: ServeContent handles ranges and If-None-Match (via the ETag) only.
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
	})
}

// contentType prefers explicit types: the system MIME registry can map .js to text/plain.
func contentType(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".woff2":
		return "font/woff2"
	case ".wasm":
		return "application/wasm"
	case ".txt":
		return "text/plain; charset=utf-8"
	}
	if t := mime.TypeByExtension(path.Ext(name)); t != "" {
		return t
	}
	return "application/octet-stream"
}
