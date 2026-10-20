package elevation

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"panelscape/internal/geo"
	"panelscape/internal/upstream"
)

const (
	terrariumPrefix = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/"
	gsi5mPrefix     = "https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/"
	gsi10mPrefix    = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/"

	// tolMetres bounds the error of nearest-pixel sampling: at zoom 14 a pixel is about 7.8 m, so a cell
	// can be off by half a pixel in each direction, and the centre by the same amount.
	tolMetres = 2.5
)

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

// fakeFetcher routes URLs to synthetic tile bodies and counts calls per URL.
type fakeFetcher struct {
	route func(rawURL string) ([]byte, error)

	mu    sync.Mutex
	calls int
}

func (f *fakeFetcher) Get(_ context.Context, rawURL string, _ time.Duration) ([]byte, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	return f.route(rawURL)
}

func (f *fakeFetcher) PostForm(context.Context, string, url.Values, time.Duration) ([]byte, error) {
	return nil, errors.New("PostForm not used by elevation")
}

func (f *fakeFetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

var _ upstream.Fetcher = (*fakeFetcher)(nil)

// memCache is an in-memory cache.Cache that records the keys it was asked for.
type memCache struct {
	mu   sync.Mutex
	data map[string][]byte
	keys []string
}

func newMemCache() *memCache { return &memCache{data: map[string][]byte{}} }

func (c *memCache) Get(_ context.Context, key string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.data[key]
	return v, ok
}

func (c *memCache) Set(_ context.Context, key string, value []byte, _ time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data[key] = value
	c.keys = append(c.keys, key)
}

// ---------------------------------------------------------------------------
// Synthetic tiles
// ---------------------------------------------------------------------------

// renderTile draws a 256x256 PNG for tile (z, x, y), evaluating encode at each pixel centre.
func renderTile(z, x, y int, encode func(lat, lon float64) [4]uint8) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, tilePx, tilePx))
	world := float64(tilePx) * math.Pow(2, float64(z))
	for py := 0; py < tilePx; py++ {
		for px := 0; px < tilePx; px++ {
			lon := (float64(x*tilePx+px)+0.5)/world*360 - 180
			merc := math.Pi - 2*math.Pi*(float64(y*tilePx+py)+0.5)/world
			lat := math.Atan(math.Sinh(merc)) * 180 / math.Pi
			c := encode(lat, lon)
			img.SetNRGBA(px, py, color.NRGBA{R: c[0], G: c[1], B: c[2], A: c[3]})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// encodeTerrarium stores height h (m) in the Terrarium layout: h = R*256 + G + B/256 - 32768.
func encodeTerrarium(h float64) [4]uint8 {
	v := h + 32768
	iv := int(math.Floor(v))
	b := int(math.Floor((v - float64(iv)) * 256))
	return [4]uint8{uint8(iv / 256), uint8(iv % 256), uint8(b), 255}
}

// encodeGSI stores height h (m) in the GSI layout: v = h*100 with two's complement above 2^23.
func encodeGSI(h float64) [4]uint8 {
	iv := int(math.Round(h * 100))
	if iv < 0 {
		iv += 1 << 24
	}
	return [4]uint8{uint8(iv >> 16), uint8(iv >> 8), uint8(iv), 255}
}

// parseTileURL extracts z, x, y from ".../{z}/{x}/{y}.png".
func parseTileURL(t *testing.T, rawURL, prefix string) (z, x, y int) {
	t.Helper()
	rest := strings.TrimSuffix(strings.TrimPrefix(rawURL, prefix), ".png")
	parts := strings.Split(rest, "/")
	if len(parts) != 3 {
		t.Fatalf("unexpected tile URL %q", rawURL)
	}
	vals := make([]int, 3)
	for i, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil {
			t.Fatalf("bad tile URL %q: %v", rawURL, err)
		}
		vals[i] = v
	}
	return vals[0], vals[1], vals[2]
}

// terrain is the synthetic surface used by most tests: a plane 100 m high at (lat0, lon0),
// rising 0.1 m per metre east and 0.2 m per metre north.
func terrain(lat0, lon0 float64) func(lat, lon float64) float64 {
	return func(lat, lon float64) float64 {
		p := geo.ToLocal(lat, lon, lat0, lon0)
		return 100 + 0.1*p[0] + 0.2*p[1]
	}
}

// ---------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------

func TestDecodeTerrarium(t *testing.T) {
	tests := []struct {
		name string
		px   []uint8
		want float64
	}{
		{"zero height", []uint8{128, 0, 0, 255}, 0},
		{"fraction", []uint8{128, 1, 128, 255}, 1.5},
		{"negative", []uint8{127, 255, 0, 255}, -1},
		{"high", []uint8{0xFF, 0xFF, 0xFF, 255}, 65535 + 255.0/256 - 32768},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeTerrarium(tc.px, 0)
			if math.Abs(got-tc.want) > 1e-9 {
				t.Fatalf("decodeTerrarium(%v) = %v, want %v", tc.px, got, tc.want)
			}
		})
	}
}

func TestDecodeGSI(t *testing.T) {
	tests := []struct {
		name string
		px   []uint8
		want float64 // NaN means no data
	}{
		{"zero", []uint8{0, 0, 0, 255}, 0},
		{"one hundredth step", []uint8{0, 1, 0, 255}, 2.56},
		{"minus one centimetre", []uint8{0xFF, 0xFF, 0xFF, 255}, -0.01},
		{"largest positive", []uint8{0x7F, 0xFF, 0xFF, 255}, 83886.07},
		{"no-data 2^23", []uint8{0x80, 0, 0, 255}, math.NaN()},
		{"transparent pixel", []uint8{0, 1, 0, 0}, math.NaN()},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := decodeGSI(tc.px, 0)
			if math.IsNaN(tc.want) {
				if !math.IsNaN(got) {
					t.Fatalf("decodeGSI(%v) = %v, want NaN", tc.px, got)
				}
				return
			}
			if math.Abs(got-tc.want) > 1e-6 {
				t.Fatalf("decodeGSI(%v) = %v, want %v", tc.px, got, tc.want)
			}
		})
	}
}

func TestDecodeTileResamplesPNG(t *testing.T) {
	// 512x512 image with four flat quadrants; decodeTile must sample it down to 256x256.
	img := image.NewNRGBA(image.Rect(0, 0, 512, 512))
	quad := map[[2]bool]color.NRGBA{
		{false, false}: {10, 20, 30, 255},
		{true, false}:  {40, 50, 60, 255},
		{false, true}:  {70, 80, 90, 255},
		{true, true}:   {100, 110, 120, 0},
	}
	for y := 0; y < 512; y++ {
		for x := 0; x < 512; x++ {
			img.SetNRGBA(x, y, quad[[2]bool{x >= 256, y >= 256}])
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	tile, err := decodeTile(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(tile) != tilePx*tilePx*4 {
		t.Fatalf("tile length %d, want %d", len(tile), tilePx*tilePx*4)
	}
	check := func(x, y int, want color.NRGBA) {
		o := (y*tilePx + x) * 4
		got := color.NRGBA{tile[o], tile[o+1], tile[o+2], tile[o+3]}
		if got != want {
			t.Fatalf("pixel (%d,%d) = %v, want %v", x, y, got, want)
		}
	}
	check(0, 0, color.NRGBA{10, 20, 30, 255})
	check(255, 0, color.NRGBA{40, 50, 60, 255})
	check(0, 255, color.NRGBA{70, 80, 90, 255})
	check(255, 255, color.NRGBA{100, 110, 120, 0})
}

func TestDecodeTileRejectsGarbage(t *testing.T) {
	if _, err := decodeTile([]byte("not a png")); err == nil {
		t.Fatal("expected an error for non-PNG data")
	}
}

// ---------------------------------------------------------------------------
// Grid construction
// ---------------------------------------------------------------------------

func newTestService(f upstream.Fetcher, results *memCache) *GridService {
	return NewService(f, time.Hour, results, time.Hour, nil)
}

func TestGridOrientationAndRelativeHeights(t *testing.T) {
	// San Francisco: outside Japan, so Terrarium only.
	const lat, lon = 37.42, -122.08
	surface := terrain(lat, lon)
	f := &fakeFetcher{route: func(rawURL string) ([]byte, error) {
		if !strings.HasPrefix(rawURL, terrariumPrefix) {
			t.Fatalf("unexpected URL %q", rawURL)
		}
		z, x, y := parseTileURL(t, rawURL, terrariumPrefix)
		return renderTile(z, x, y, func(la, lo float64) [4]uint8 { return encodeTerrarium(surface(la, lo)) }), nil
	}}
	svc := newTestService(f, newMemCache())

	const size, n = 200.0, 9
	g, err := svc.Grid(context.Background(), lat, lon, size, n)
	if err != nil {
		t.Fatal(err)
	}
	if g.Source != "Terrain Tiles" {
		t.Fatalf("Source = %q, want %q", g.Source, "Terrain Tiles")
	}
	if g.N != n || g.Size != size || len(g.Heights) != n*n {
		t.Fatalf("grid shape: N=%d Size=%v len=%d", g.N, g.Size, len(g.Heights))
	}
	if math.Abs(g.BaseElevation-100) > tolMetres {
		t.Fatalf("BaseElevation = %v, want about 100", g.BaseElevation)
	}

	// Expected relative height of cell (i, j): east = x, north = y, with the centre at 0.
	half := size / 2
	step := size / float64(n-1)
	for j := 0; j < n; j++ {
		for i := 0; i < n; i++ {
			x := -half + float64(i)*step
			y := half - float64(j)*step
			want := 0.1*x + 0.2*y
			got := float64(g.Heights[i+j*n])
			if math.Abs(got-want) > tolMetres {
				t.Fatalf("cell (i=%d, j=%d) height = %.3f, want about %.3f", i, j, got, want)
			}
		}
	}

	// Explicit orientation checks: row 0 is north, column 0 is west.
	north := g.Heights[(n / 2)]       // centre column, top row
	south := g.Heights[(n/2)+(n-1)*n] // centre column, bottom row
	west := g.Heights[0+(n/2)*n]      // left column, centre row
	east := g.Heights[(n-1)+(n/2)*n]  // right column, centre row
	if !(north > 0 && south < 0 && east > 0 && west < 0) {
		t.Fatalf("orientation wrong: north=%v south=%v east=%v west=%v", north, south, east, west)
	}
	if got := g.Heights[n/2+(n/2)*n]; math.Abs(float64(got)) > 1e-6 {
		t.Fatalf("centre height = %v, want 0", got)
	}
}

func TestGSIUsedInJapanWithNoDataFallback(t *testing.T) {
	// Tokyo, Japan. The 5 m tiles have no data (2^23) west of the centre, so those cells must come
	// from the 10 m tiles, and the result names both sources.
	const lat, lon = 35.6586, 139.7454
	surface := terrain(lat, lon)
	west := func(la, lo float64) bool { return lo < lon }
	f := &fakeFetcher{route: func(rawURL string) ([]byte, error) {
		switch {
		case strings.HasPrefix(rawURL, gsi5mPrefix):
			z, x, y := parseTileURL(t, rawURL, gsi5mPrefix)
			return renderTile(z, x, y, func(la, lo float64) [4]uint8 {
				if west(la, lo) {
					return [4]uint8{0x80, 0, 0, 255} // no data
				}
				return encodeGSI(surface(la, lo))
			}), nil
		case strings.HasPrefix(rawURL, gsi10mPrefix):
			z, x, y := parseTileURL(t, rawURL, gsi10mPrefix)
			return renderTile(z, x, y, func(la, lo float64) [4]uint8 { return encodeGSI(surface(la, lo)) }), nil
		default:
			t.Fatalf("Terrarium must not be needed here: %q", rawURL)
			return nil, errors.New("unreachable")
		}
	}}
	svc := newTestService(f, newMemCache())

	const size, n = 200.0, 9
	g, err := svc.Grid(context.Background(), lat, lon, size, n)
	if err != nil {
		t.Fatal(err)
	}
	if g.Source != "GSI 5 m + GSI 10 m" {
		t.Fatalf("Source = %q, want %q", g.Source, "GSI 5 m + GSI 10 m")
	}
	half := size / 2
	step := size / float64(n-1)
	for j := 0; j < n; j++ {
		for i := 0; i < n; i++ {
			x := -half + float64(i)*step
			y := half - float64(j)*step
			want := 0.1*x + 0.2*y
			got := float64(g.Heights[i+j*n])
			if math.Abs(got-want) > tolMetres {
				t.Fatalf("cell (i=%d, j=%d) height = %.3f, want about %.3f (no-data leaked?)", i, j, got, want)
			}
		}
	}
}

func TestGSIMissingFallsBackToTerrarium(t *testing.T) {
	// Tokyo: both GSI tile sets are 404, so the grid must come from Terrarium.
	const lat, lon = 35.6586, 139.7454
	surface := terrain(lat, lon)
	f := &fakeFetcher{route: func(rawURL string) ([]byte, error) {
		switch {
		case strings.HasPrefix(rawURL, gsi5mPrefix), strings.HasPrefix(rawURL, gsi10mPrefix):
			return nil, upstream.ErrNotFound
		case strings.HasPrefix(rawURL, terrariumPrefix):
			z, x, y := parseTileURL(t, rawURL, terrariumPrefix)
			return renderTile(z, x, y, func(la, lo float64) [4]uint8 { return encodeTerrarium(surface(la, lo)) }), nil
		default:
			return nil, errors.New("unexpected URL " + rawURL)
		}
	}}
	g, err := newTestService(f, newMemCache()).Grid(context.Background(), lat, lon, 200, 9)
	if err != nil {
		t.Fatal(err)
	}
	if g.Source != "Terrain Tiles" {
		t.Fatalf("Source = %q, want %q", g.Source, "Terrain Tiles")
	}
	if math.Abs(g.BaseElevation-100) > tolMetres {
		t.Fatalf("BaseElevation = %v, want about 100", g.BaseElevation)
	}
}

func TestGSI10mUsedWhen5mIsNotFound(t *testing.T) {
	const lat, lon = 35.6586, 139.7454
	surface := terrain(lat, lon)
	f := &fakeFetcher{route: func(rawURL string) ([]byte, error) {
		switch {
		case strings.HasPrefix(rawURL, gsi5mPrefix):
			return nil, upstream.ErrNotFound
		case strings.HasPrefix(rawURL, gsi10mPrefix):
			z, x, y := parseTileURL(t, rawURL, gsi10mPrefix)
			return renderTile(z, x, y, func(la, lo float64) [4]uint8 { return encodeGSI(surface(la, lo)) }), nil
		default:
			return nil, upstream.ErrNotFound
		}
	}}
	g, err := newTestService(f, newMemCache()).Grid(context.Background(), lat, lon, 200, 9)
	if err != nil {
		t.Fatal(err)
	}
	if g.Source != "GSI 10 m" {
		t.Fatalf("Source = %q, want %q", g.Source, "GSI 10 m")
	}
}

func TestFlatGridWhenCentreMissing(t *testing.T) {
	f := &fakeFetcher{route: func(string) ([]byte, error) { return nil, upstream.ErrNotFound }}
	g, err := newTestService(f, newMemCache()).Grid(context.Background(), 37.42, -122.08, 200, 9)
	if err != nil {
		t.Fatal(err)
	}
	if g.Source != "" || g.BaseElevation != 0 || len(g.Heights) != 81 {
		t.Fatalf("want flat grid, got Source=%q base=%v len=%d", g.Source, g.BaseElevation, len(g.Heights))
	}
	for k, h := range g.Heights {
		if h != 0 {
			t.Fatalf("heights[%d] = %v, want 0", k, h)
		}
	}
}

func TestFlatGridWhenTooManyTiles(t *testing.T) {
	f := &fakeFetcher{route: func(string) ([]byte, error) {
		t.Fatal("no tile should be fetched for an oversized request")
		return nil, nil
	}}
	g, err := newTestService(f, newMemCache()).Grid(context.Background(), 37.42, -122.08, 20000, 17)
	if err != nil {
		t.Fatal(err)
	}
	if g.Source != "" || f.callCount() != 0 {
		t.Fatalf("want flat grid without fetches, got Source=%q calls=%d", g.Source, f.callCount())
	}
}

func TestResultCacheAvoidsRefetch(t *testing.T) {
	const lat, lon = 37.42, -122.08
	surface := terrain(lat, lon)
	f := &fakeFetcher{route: func(rawURL string) ([]byte, error) {
		z, x, y := parseTileURL(t, rawURL, terrariumPrefix)
		return renderTile(z, x, y, func(la, lo float64) [4]uint8 { return encodeTerrarium(surface(la, lo)) }), nil
	}}
	results := newMemCache()
	svc := newTestService(f, results)

	first, err := svc.Grid(context.Background(), lat, lon, 200, 9)
	if err != nil {
		t.Fatal(err)
	}
	callsAfterFirst := f.callCount()
	if callsAfterFirst == 0 {
		t.Fatal("expected tile fetches on the first call")
	}

	second, err := svc.Grid(context.Background(), lat, lon, 200, 9)
	if err != nil {
		t.Fatal(err)
	}
	if f.callCount() != callsAfterFirst {
		t.Fatalf("second call fetched tiles again: %d -> %d", callsAfterFirst, f.callCount())
	}
	if second.Source != first.Source || second.BaseElevation != first.BaseElevation || len(second.Heights) != len(first.Heights) {
		t.Fatalf("cached grid differs from the original")
	}
	for k := range first.Heights {
		if first.Heights[k] != second.Heights[k] {
			t.Fatalf("heights[%d] differ: %v vs %v", k, first.Heights[k], second.Heights[k])
		}
	}

	const wantKey = "elev:v1:37.42000:-122.08000:200:9"
	if len(results.keys) != 1 || results.keys[0] != wantKey {
		t.Fatalf("result cache keys = %v, want [%s]", results.keys, wantKey)
	}
}

func TestTransientTileErrorIsNotCached(t *testing.T) {
	// A 500 from upstream must not be frozen into the result cache: the next call retries.
	f := &fakeFetcher{route: func(rawURL string) ([]byte, error) {
		return nil, &upstream.StatusError{URL: rawURL, Status: 500}
	}}
	results := newMemCache()
	svc := newTestService(f, results)

	g, err := svc.Grid(context.Background(), 37.42, -122.08, 200, 9)
	if err != nil {
		t.Fatal(err)
	}
	if g.Source != "" {
		t.Fatalf("Source = %q, want flat grid", g.Source)
	}
	if len(results.keys) != 0 {
		t.Fatalf("degraded grid was cached: %v", results.keys)
	}
	before := f.callCount()
	if _, err := svc.Grid(context.Background(), 37.42, -122.08, 200, 9); err != nil {
		t.Fatal(err)
	}
	if f.callCount() == before {
		t.Fatal("second call did not retry the upstream")
	}
}

func TestGridRejectsBadArguments(t *testing.T) {
	svc := newTestService(&fakeFetcher{route: func(string) ([]byte, error) { return nil, upstream.ErrNotFound }}, newMemCache())
	if _, err := svc.Grid(context.Background(), 0, 0, 200, 1); err == nil {
		t.Fatal("n < 2 must fail")
	}
	if _, err := svc.Grid(context.Background(), 0, 0, 0, 9); err == nil {
		t.Fatal("size <= 0 must fail")
	}
}

func TestSquarePixelsCoversCentre(t *testing.T) {
	r := squarePixels(37.42, -122.08, 100, 15)
	cx := lonToPx(-122.08, 15)
	cy := latToPx(37.42, 15)
	if !(r.minX < cx && cx < r.maxX && r.minY < cy && cy < r.maxY) {
		t.Fatalf("pixel rect %+v does not contain the centre (%v, %v)", r, cx, cy)
	}
	if r.maxX-r.minX < 1 || r.maxY-r.minY < 1 {
		t.Fatalf("degenerate pixel rect %+v", r)
	}
	// Sanity: at latitude 37.42 and zoom 15 one pixel is about 3.8 m, so 200 m is about 53 px.
	if w := r.maxX - r.minX; math.Abs(w-200/3.8) > 3 {
		t.Fatalf("width %.1f px, expected about %.1f", w, 200/3.8)
	}
}
