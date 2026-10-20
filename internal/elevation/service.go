package elevation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image/color"
	"image/png"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"panelscape/internal/cache"
	"panelscape/internal/geo"
	"panelscape/internal/upstream"
)

// Port of web/js/elevation.js. Tile sources, zoom rules, decoders and the NaN-filling order follow
// the browser implementation.

const (
	tilePx       = 256
	maxTiles     = 36 // a request covering more tiles than this returns a flat grid
	fetchWorkers = 8  // concurrent tile downloads per source

	terrariumFormat = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/%d/%d/%d.png"
	gsi5mFormat     = "https://cyberjapandata.gsi.go.jp/xyz/dem5a_png/%d/%d/%d.png"
	gsi10mFormat    = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/%d/%d/%d.png"

	gsiNoData   = 1 << 23 // GSI encodes "no data" as 2^23
	gsiWrapSpan = 1 << 24
)

// tileSource is one elevation tile provider.
type tileSource struct {
	name    string
	maxZoom int // 0 means no limit
	format  string
	decode  func(px []uint8, o int) float64
}

// sourcesFor returns the providers to try, in order: GSI 5 m, GSI 10 m, Terrarium inside Japan;
// Terrarium elsewhere.
func sourcesFor(lat, lon float64) []tileSource {
	terrarium := tileSource{name: "Terrain Tiles", format: terrariumFormat, decode: decodeTerrarium}
	if inJapan(lat, lon) {
		return []tileSource{
			{name: "GSI 5 m", maxZoom: 15, format: gsi5mFormat, decode: decodeGSI},
			{name: "GSI 10 m", maxZoom: 14, format: gsi10mFormat, decode: decodeGSI},
			terrarium,
		}
	}
	return []tileSource{terrarium}
}

// inJapan is the rough bounding box of Japan (GSI coverage).
func inJapan(lat, lon float64) bool {
	return lat > 20 && lat < 46.5 && lon > 122 && lon < 154.5
}

// decodeTerrarium reads height = R*256 + G + B/256 - 32768 from the RGBA pixel at offset o.
func decodeTerrarium(px []uint8, o int) float64 {
	return float64(px[o])*256 + float64(px[o+1]) + float64(px[o+2])/256 - 32768
}

// decodeGSI reads v = R*65536 + G*256 + B, height = v * 0.01 (two's complement above 2^23).
// Transparent pixels and the 2^23 no-data value give NaN.
func decodeGSI(px []uint8, o int) float64 {
	if px[o+3] == 0 {
		return math.NaN()
	}
	v := int(px[o])*65536 + int(px[o+1])*256 + int(px[o+2])
	if v == gsiNoData {
		return math.NaN()
	}
	if v > gsiNoData {
		v -= gsiWrapSpan
	}
	return float64(v) * 0.01
}

// rgbaTile is a 256x256 tile of non-premultiplied RGBA bytes, the same layout as canvas getImageData.
type rgbaTile []uint8

// decodeTile decodes a PNG and resamples it to 256x256 (nearest neighbour; tiles are normally 256 already).
func decodeTile(data []byte) (rgbaTile, error) {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	if b.Dx() <= 0 || b.Dy() <= 0 {
		return nil, errors.New("elevation: empty tile image")
	}
	out := make(rgbaTile, tilePx*tilePx*4)
	for y := 0; y < tilePx; y++ {
		sy := b.Min.Y + y*b.Dy()/tilePx
		for x := 0; x < tilePx; x++ {
			sx := b.Min.X + x*b.Dx()/tilePx
			c := color.NRGBAModel.Convert(img.At(sx, sy)).(color.NRGBA)
			o := (y*tilePx + x) * 4
			out[o], out[o+1], out[o+2], out[o+3] = c.R, c.G, c.B, c.A
		}
	}
	return out, nil
}

// Web Mercator helpers, identical to elevation.js (pixel space at zoom z).

func lonToPx(lon float64, z int) float64 {
	return (lon + 180) / 360 * tilePx * math.Pow(2, float64(z))
}

func latToPx(lat float64, z int) float64 {
	clamped := math.Max(-85.05112878, math.Min(85.05112878, lat))
	r := clamped * math.Pi / 180
	merc := math.Log(math.Tan(r) + 1/math.Cos(r))
	return (1 - merc/math.Pi) / 2 * tilePx * math.Pow(2, float64(z))
}

// pxRect is a pixel-space bounding box at one zoom level.
type pxRect struct {
	minX, maxX, minY, maxY float64
}

// squarePixels returns the pixel bounds of the square of half-side half around (lat, lon).
// Mercator is monotonic, so the four corners give the extremes.
func squarePixels(lat, lon, half float64, z int) pxRect {
	r := pxRect{minX: math.Inf(1), maxX: math.Inf(-1), minY: math.Inf(1), maxY: math.Inf(-1)}
	corners := [4][2]float64{{-half, -half}, {half, -half}, {-half, half}, {half, half}}
	for _, c := range corners {
		la, lo := geo.ToLatLon(c[0], c[1], lat, lon)
		px := lonToPx(lo, z)
		py := latToPx(la, z)
		r.minX = math.Min(r.minX, px)
		r.maxX = math.Max(r.maxX, px)
		r.minY = math.Min(r.minY, py)
		r.maxY = math.Max(r.maxY, py)
	}
	return r
}

// tileRange returns the inclusive tile index range covering r.
func (r pxRect) tileRange() (tx0, tx1, ty0, ty1 int) {
	return int(math.Floor(r.minX / tilePx)), int(math.Floor(r.maxX / tilePx)),
		int(math.Floor(r.minY / tilePx)), int(math.Floor(r.maxY / tilePx))
}

type tileKey struct{ x, y int }

// GridService implements Service with tile fetching through an upstream.Fetcher and a result cache.
type GridService struct {
	fetcher   upstream.Fetcher
	tileTTL   time.Duration
	results   cache.Cache
	resultTTL time.Duration
	logger    *slog.Logger
}

// NewService builds the elevation service. tileTTL is the cache lifetime for tile downloads and
// resultTTL the lifetime for finished grids.
func NewService(f upstream.Fetcher, tileTTL time.Duration, results cache.Cache, resultTTL time.Duration, logger *slog.Logger) *GridService {
	if results == nil {
		results = cache.Nop{}
	}
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &GridService{
		fetcher:   f,
		tileTTL:   tileTTL,
		results:   results,
		resultTTL: resultTTL,
		logger:    logger,
	}
}

// Grid returns an n x n grid of heights relative to the centre, covering a size x size meter square
// around (lat, lon). Index = i + j*n, with i west to east and j north to south.
func (s *GridService) Grid(ctx context.Context, lat, lon, size float64, n int) (*Grid, error) {
	if n < 2 {
		return nil, fmt.Errorf("elevation: n must be at least 2, got %d", n)
	}
	if !(size > 0) {
		return nil, fmt.Errorf("elevation: size must be positive, got %v", size)
	}

	key := cacheKey(lat, lon, size, n)
	if raw, ok := s.results.Get(ctx, key); ok {
		var g Grid
		if json.Unmarshal(raw, &g) == nil && g.N == n && len(g.Heights) == n*n {
			return &g, nil
		}
	}

	g, degraded, err := s.build(ctx, lat, lon, size, n)
	if err != nil {
		return nil, err
	}
	// A grid built while some tile downloads failed for reasons other than "not found" is incomplete,
	// so it is not cached: the next request may find the upstream healthy again.
	if !degraded {
		if raw, err := json.Marshal(g); err == nil {
			s.results.Set(ctx, key, raw, s.resultTTL)
		}
	}
	return g, nil
}

func cacheKey(lat, lon, size float64, n int) string {
	return fmt.Sprintf("elev:v1:%.5f:%.5f:%s:%d", lat, lon, strconv.FormatFloat(size, 'f', -1, 64), n)
}

// build samples the sources in order. degraded reports whether any tile download failed for a reason
// other than "not found".
func (s *GridService) build(ctx context.Context, lat, lon, size float64, n int) (g *Grid, degraded bool, err error) {
	zoom := 15
	if size > 1000 {
		zoom = 14
	}
	half := size / 2
	step := size / float64(n-1)

	base := squarePixels(lat, lon, half, zoom)
	tx0, tx1, ty0, ty1 := base.tileRange()
	if (tx1-tx0+1)*(ty1-ty0+1) > maxTiles {
		return flatGrid(size, n), false, nil
	}

	absolute := make([]float64, n*n)
	for k := range absolute {
		absolute[k] = math.NaN()
	}
	var used []string
	for _, src := range sourcesFor(lat, lon) {
		z := zoom
		if src.maxZoom > 0 && src.maxZoom < z {
			z = src.maxZoom
		}
		filled, bad, err := s.sampleSource(ctx, src, z, absolute, lat, lon, half, step, n)
		if err != nil {
			return nil, false, err
		}
		degraded = degraded || bad
		if filled > 0 {
			used = append(used, src.name)
		}
		if !anyNaN(absolute) {
			break
		}
	}

	centre := n/2 + (n/2)*n
	centreHeight := absolute[centre]
	if math.IsNaN(centreHeight) || math.IsInf(centreHeight, 0) {
		return flatGrid(size, n), degraded, nil
	}

	heights := make([]float32, n*n)
	for k, a := range absolute {
		if !math.IsNaN(a) && !math.IsInf(a, 0) {
			heights[k] = float32(a - centreHeight)
		}
	}
	return &Grid{
		Size:          size,
		N:             n,
		Heights:       heights,
		BaseElevation: centreHeight,
		Source:        strings.Join(used, " + "),
	}, degraded, nil
}

// sampleSource fills the still-NaN cells of absolute from one source at zoom z. It returns how many
// cells it filled and whether a tile download failed transiently.
func (s *GridService) sampleSource(ctx context.Context, src tileSource, z int, absolute []float64,
	lat, lon, half, step float64, n int) (filled int, degraded bool, err error) {

	r := squarePixels(lat, lon, half, z)
	tx0, tx1, ty0, ty1 := r.tileRange()
	if (tx1-tx0+1)*(ty1-ty0+1) > maxTiles {
		return 0, false, nil
	}

	tiles, degraded, err := s.loadTiles(ctx, src, z, tx0, tx1, ty0, ty1)
	if err != nil {
		return 0, false, err
	}

	for j := 0; j < n; j++ {
		y := half - float64(j)*step
		for i := 0; i < n; i++ {
			k := i + j*n
			if !math.IsNaN(absolute[k]) {
				continue
			}
			x := -half + float64(i)*step
			la, lo := geo.ToLatLon(x, y, lat, lon)
			px := lonToPx(lo, z)
			py := latToPx(la, z)
			tx := int(math.Floor(px / tilePx))
			ty := int(math.Floor(py / tilePx))
			tile, ok := tiles[tileKey{tx, ty}]
			if !ok {
				continue
			}
			lx := clampInt(int(math.Floor(px-float64(tx)*tilePx)), 0, tilePx-1)
			ly := clampInt(int(math.Floor(py-float64(ty)*tilePx)), 0, tilePx-1)
			h := src.decode(tile, (ly*tilePx+lx)*4)
			if !math.IsNaN(h) && !math.IsInf(h, 0) {
				absolute[k] = h
				filled++
			}
		}
	}
	return filled, degraded, nil
}

// loadTiles downloads and decodes the tile range concurrently (bounded by fetchWorkers). Missing
// tiles (not found) and corrupt images are skipped; other download failures set degraded.
func (s *GridService) loadTiles(ctx context.Context, src tileSource, z, tx0, tx1, ty0, ty1 int) (tiles map[tileKey]rgbaTile, degraded bool, err error) {
	var keys []tileKey
	for ty := ty0; ty <= ty1; ty++ {
		for tx := tx0; tx <= tx1; tx++ {
			keys = append(keys, tileKey{tx, ty})
		}
	}

	tiles = make(map[tileKey]rgbaTile, len(keys))
	var (
		mu  sync.Mutex
		wg  sync.WaitGroup
		sem = make(chan struct{}, fetchWorkers)
	)
	for _, k := range keys {
		wg.Add(1)
		go func(k tileKey) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			url := fmt.Sprintf(src.format, z, k.x, k.y)
			raw, ferr := s.fetcher.Get(ctx, url, s.tileTTL)

			var (
				tile rgbaTile
				derr error
				bad  bool
			)
			switch {
			case ferr == nil:
				tile, derr = decodeTile(raw)
				if derr != nil {
					s.logger.Warn("elevation tile decode failed", "source", src.name, "url", url, "err", derr)
				}
			case errors.Is(ferr, upstream.ErrNotFound):
				// No tile here: the cell stays missing.
			case ctx.Err() != nil:
				// Cancelled; reported below.
			default:
				bad = true
				s.logger.Warn("elevation tile fetch failed", "source", src.name, "url", url, "err", ferr)
			}

			mu.Lock()
			defer mu.Unlock()
			if tile != nil && derr == nil {
				tiles[k] = tile
			}
			if bad {
				degraded = true
			}
		}(k)
	}
	wg.Wait()

	if cerr := ctx.Err(); cerr != nil {
		return nil, false, cerr
	}
	return tiles, degraded, nil
}

func flatGrid(size float64, n int) *Grid {
	return &Grid{Size: size, N: n, Heights: make([]float32, n*n)}
}

func anyNaN(v []float64) bool {
	for _, x := range v {
		if math.IsNaN(x) {
			return true
		}
	}
	return false
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
