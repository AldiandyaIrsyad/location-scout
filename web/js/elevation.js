// Terrain elevation client. The Go backend (internal/elevation) loads GSI and Terrarium tiles and
// builds the height grid; this module fetches the grid and samples it for the renderer.

/**
 * Height grid of n x n samples over a size x size meter square centered on (lat, lon).
 * Heights are relative to the center (center = 0), index = i + j*n, i: west->east, j: north->south.
 * baseElevation is the absolute height at the center in meters; source names the tile sources used
 * ("" when no data was available, and the grid is then flat).
 */
export async function fetchElevation({ lat, lon, size, n = 129, signal }) {
  // Version the request as well as the server result cache, so a browser's old
  // terrain response cannot hide a newly corrected elevation source.
  const query = new URLSearchParams({ lat: String(lat), lon: String(lon), size: String(size), n: String(n), v: '4' });
  const res = await fetch(`api/elevation?${query}`, { signal, headers: { Accept: 'application/json' } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: keep the status text below */
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return {
    size: body.size,
    n: body.n,
    heights: Float32Array.from(body.heights),
    baseElevation: body.baseElevation,
    source: body.source,
  };
}

/**
 * Bilinear sample of the grid at local meters (x east, y north) relative to the center.
 * Points outside the grid are clamped to its edge. Returns 0 when grid is null.
 */
export function sampleHeight(grid, x, y) {
  if (!grid || !grid.heights) return 0;
  const { size, n, heights } = grid;
  const step = size / (n - 1);
  const clamp = (v) => Math.max(0, Math.min(n - 1, v));
  const fi = clamp((x + size / 2) / step);
  const fj = clamp((size / 2 - y) / step);
  const i0 = Math.floor(fi), j0 = Math.floor(fj);
  const i1 = Math.min(i0 + 1, n - 1), j1 = Math.min(j0 + 1, n - 1);
  const tx = fi - i0, ty = fj - j0;
  const h00 = heights[i0 + j0 * n];
  const h10 = heights[i1 + j0 * n];
  const h01 = heights[i0 + j1 * n];
  const h11 = heights[i1 + j1 * n];
  return (h00 * (1 - tx) + h10 * tx) * (1 - ty) + (h01 * (1 - tx) + h11 * tx) * ty;
}
