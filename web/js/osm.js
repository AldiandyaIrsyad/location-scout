// City data client. The Go backend (internal/osm) fetches OpenStreetMap data, parses it and caches
// the results; this module only asks for them. URLs are relative (api/...), so the app also works
// under a sub-path. Local coordinates are meters, x = east, y = north, origin = the area center.

/**
 * Buildings, roads, railways, water, green areas, trees and viewpoints for a size x size meter square
 * centered on lat/lon. seed re-rolls guessed building heights (0 = the default heights).
 */
export async function fetchCity({ lat, lon, size, seed = 0, signal, onProgress }) {
  onProgress?.('Fetching OpenStreetMap data');
  return getJSON('api/city', { lat, lon, size, seed }, signal);
}

/**
 * Building footprints in the farSize square (meters), outside the inner size square, simplified by
 * the server.
 */
export async function fetchSurroundings({ lat, lon, size, farSize, signal, onProgress }) {
  onProgress?.('Fetching surrounding buildings');
  return getJSON('api/surroundings', { lat, lon, size, far: farSize }, signal);
}

/** Camera viewpoints, computed by the server together with the city. */
export function findViewpoints(city) {
  return city?.viewpoints || [];
}

async function getJSON(path, params, signal) {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`${path}?${query}`, { signal, headers: { Accept: 'application/json' } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: keep the status text below */
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}
