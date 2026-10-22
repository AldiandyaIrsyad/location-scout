# Panelscape

Turn a real city block anywhere in the world into 3D, using OpenStreetMap data and elevation, and draw it as
manga background art: color, color + lines, line art, lines + screentone, or clay.

**Live:** https://panelscape.aldiandyainf.com · **Author:** Aldiandya Irsyad

It is a full-stack app:

- **Go backend** (`cmd/`, `internal/`). It fetches and parses map data into buildings, roads, trees and camera viewpoints. It also builds elevation grids, runs place search, and parses location links and KML/KMZ/GeoJSON files. All of this sits behind a two-level cache, with a JSON API and the web app embedded in one binary.
- **Web frontend** (`web/`). It keeps only what has to run in the browser: three.js rendering (WebGL), the manga shaders, the UI and exports.

## Run

Everything runs in Docker, so no local Go install is needed.

```bash
docker compose up -d --build
```

Open http://localhost:8080. The cache persists in the `cache` volume. Stop it with `docker compose down`.

**Makefile targets.** The Go targets use a local `go` if one is installed; otherwise they run Go in Docker through `tools/go.sh`.

| Target | What it does |
|---|---|
| `make up` / `make down` | Start or stop with docker compose |
| `make docker-build` / `make docker-run` | Build or run the production image |
| `make test` / `make vet` / `make fmt` | Run tests, vet and gofmt |
| `make run` | Run the server from source on :8080 |
| `make build` | Build `bin/server` |
| `make warm` | Pre-fill the cache of a running server for every candidate place (see below) |

**Without make**, use the wrapper directly: `tools/go.sh test ./...` and `tools/go.sh vet ./...`.

**Configuration** comes from environment variables. See `internal/config/config.go`.

| Variable | Default |
|---|---|
| `ADDR` / `PORT` | `:8080` |
| `CACHE_DIR` | `data/cache` (`off` to disable) |
| `MEMORY_CACHE_MB` | `256` |
| `OVERPASS_URLS` | 3 public servers, comma separated |
| `NOMINATIM_URL` | public Nominatim |
| `USER_AGENT` | `Panelscape/1.0 (by Aldiandya Irsyad)` |
| `OSM_TTL` / `TILE_TTL` / `SEARCH_TTL` / `RESULT_TTL` | `168h` / `720h` / `168h` / `168h` |
| `UPSTREAM_TIMEOUT` | `20s` (per request; the large surroundings query has its own limit below) |
| `SURROUNDINGS_TIMEOUT` | `45s` |
| `STATIC_DIR` | Serve `web/` from disk instead of the embedded copy (for frontend development) |
| `LOG_FORMAT` / `LOG_LEVEL` | `json` / `info` |

### Warming the cache for the candidates

The candidate places are what most people open, so `tools/warm_cache.py` asks a running server for
each of them (the area, the elevation grid and the surroundings) and the server keeps the answers
in its memory and disk cache. Afterwards the first visit is instant and survives restarts.

```sh
python tools/warm_cache.py                      # all candidates: 300 m area, 2 km surroundings
python tools/warm_cache.py --group Japan        # one region only
python tools/warm_cache.py --size 300,600 --far 2,4
make warm ARGS="--only tokyo --limit 5"         # same thing through make
```

It spaces out the requests that really reach Overpass (`--delay`, 1 s by default), skips what is
already cached, and can be stopped and started again at any time. Cached map data lasts `OSM_TTL`
(7 days by default), so repeat it about weekly (cron, Task Scheduler) to keep the list warm.

## Architecture

```
cmd/server            main: config → app.New → http.Server (graceful shutdown)
internal/app          composition root: builds the dependency graph
internal/httpapi      routes, validation, ETag/304, gzip, CORS, logging, recovery
internal/osm          Overpass queries → CityData (buildings, roads, trees, viewpoints), surroundings
internal/elevation    GSI 5 m / 10 m (Japan) and Terrarium tiles → height grids
internal/places       built-in candidates (embedded JSON) + Nominatim search
internal/coords       map links, DMS, Plus Codes, KML / KMZ / GeoJSON
internal/upstream     cached HTTP fetcher (User-Agent, size cap, request de-duplication)
internal/cache        Memory (LRU, TTL) · File (disk) · Layered · Instrumented
internal/flight       singleflight: identical concurrent requests share one call
internal/config, geo  settings, coordinate helpers
web/                  frontend (embedded into the binary through web/embed.go)
```

### Dependency injection

- **Interfaces at package boundaries:** every package exposes an interface (`cache.Cache`, `upstream.Fetcher`, `osm.Service`, `elevation.Service`, `places.Service`), and constructors take their dependencies as parameters.
- **One composition root:** `internal/app.New` builds the whole graph from a `config.Config`.
- **No hidden state:** there are no globals, no `http.DefaultClient` and no `init()` side effects.
- **Tests use fakes:** `internal/httpapi` tests run the API against fake services; `internal/osm` tests run against a fake fetcher.

### Caching layers

1. **Upstream responses** (Overpass, tiles, Nominatim) are cached by request in **memory → disk**, with a TTL for each kind. Identical in-flight requests are merged into one.
2. **Computed results** (parsed cities, surroundings, elevation grids) are cached as JSON, so a repeat request skips parsing. Re-rolling heights reuses the cached raw map data.
3. **Resilience:** busy Overpass servers are retried with backoff, but no new retry round starts once 30 s have passed, so a failed load of the detailed area is reported within about a minute (the surroundings load in the background and may take up to about two). If every server fails, the last good copy of the data is served (it is kept for 30 days).
4. **HTTP:** responses carry an `ETag`, and a client that sends it back with `If-None-Match` gets `304`. `Cache-Control` is set per route, and responses are gzip-compressed. Hit and miss counters are at `/api/cache/stats`.

## API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/city?lat=&lon=&size=&seed=` | Buildings, roads, railways, water, green, trees, viewpoints, stats. Size is one of 200/300/400/600/800/1000. |
| GET | `/api/surroundings?lat=&lon=&size=&far=` | Simplified building footprints. `far` is 2000 or 4000. |
| GET | `/api/elevation?lat=&lon=&size=&n=` | Height grid relative to the centre, plus its source |
| GET | `/api/places` | Built-in candidate places (30), each with its region `group`; the page lists them as one dropdown group per region |
| GET | `/api/places/search?q=` | Built-in matches, then Nominatim |
| GET | `/api/locate?q=` | A parsed link or coordinate |
| POST | `/api/locate/file` | Location from a KML/KMZ/GeoJSON upload (multipart field `file`) |
| GET | `/api/about`, `/api/health`, `/api/cache/stats` | App info and author, health check, cache counters |

The frontend also has an **embed API** for host pages (see `web/embed-demo.html`).

## Features

- **Search:** place names, Google Maps / Earth / OSM links, decimal or DMS coordinates, Plus Codes, and KML/KMZ/GeoJSON files.
- **Area:** 200 m to 1 km, plus 2 or 4 km of surroundings. Terrain comes from GSI elevation in Japan and Terrain Tiles elsewhere. Unknown building heights are guessed and can be re-rolled.
- **Cameras:** 10 presets, a free camera with 6 control schemes, and pin-based "Move camera here" and "Stand here".
- **Light and tone:** the real sun for any place, month and time; shade, haze and skylight; 27 screentone patterns; solid-black range.
- **Layout:** theater layout with a large viewer, a collapsible controls overlay, a compact two-column mode and fullscreen.
- **Filter presets:** Classic manga, Soft shoujo, Noir, Sketch, Action, Dusk, Study, Print and Manhwa. Manhwa is a Korean-webtoon look: pastel color, brown lines, cel shading, soft glow and a light haze. Presets can bring their own effects. A Strength slider blends from your own settings to the preset.
- **Effects** (✨ toolbar panel): stackable and reorderable, each with its own strength and settings. They show on screen and in saved pictures.
  - Image effects: mosaic, posterize, duotone, sepia, color grade, CRT scanlines, vignette, film grain, paper, chromatic aberration, glitch/VHS, CMYK halftone, dithering (B/W, Game Boy, CGA, sepia), oil paint (Kuwahara), watercolor, pencil, depth of field / tilt-shift, depth fog, bloom, cel shading, soft glow and line color.
  - World effects: night mode (lit windows, street lamps), rain, snow and sakura petals (animated).
- **Save:** pick PNG, JPEG, WebP, SVG, GLB, FBX or OBJ, then **Save** or **Save as…** (Ctrl+S / Ctrl+Shift+S).
  - Save writes straight into a folder you choose once (Chromium browsers). Other browsers download the file.
  - Files are named after the place, style and time.
  - All three 3D formats import into Blender.
- **Languages:** 9 UI languages.

## Credits

Map data © OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/copyright.
Elevation: GSI Japan and Terrain Tiles (AWS Open Data). Place search: Nominatim.

Monas also uses a bounded, checked-in Open-Elevation `srtm-250m` correction to replace a steep
Terrain Tiles artifact across the park. The grid reports both sources; its 250 m sampling is
appropriate for broad ground shape and does not reconstruct paving, steps, or small earthworks.
Snapshot provenance is in `internal/elevation/monas_srtm250m.json`.
