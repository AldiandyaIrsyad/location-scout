// Well-known urban spots: the built-in candidate list, in display order. Kept short for now and grown
// again once the known scene issues are fixed.
// internal/places embeds the same list (places.json); a Go test keeps the two in sync.

export const PLACES = [
  // Global
  { name: 'Eiffel Tower, Paris', lat: 48.8584, lon: 2.2945 },
  { name: 'Louvre Pyramid, Paris', lat: 48.8610, lon: 2.3359 },
  { name: 'Big Ben, London', lat: 51.5007, lon: -0.1246 },
  { name: 'Colosseum, Rome', lat: 41.8902, lon: 12.4922 },
  { name: 'Sagrada Familia, Barcelona', lat: 41.4036, lon: 2.1744 },
  { name: 'Brandenburg Gate, Berlin', lat: 52.5163, lon: 13.3777 },
  { name: 'Red Square, Moscow', lat: 55.7539, lon: 37.6208 },
  { name: 'Hagia Sophia, Istanbul', lat: 41.0086, lon: 28.9802 },
  { name: 'Burj Khalifa, Dubai', lat: 25.1972, lon: 55.2744 },
  { name: 'Marina Bay Sands, Singapore', lat: 1.2834, lon: 103.8607 },
  { name: 'Victoria Harbour, Tsim Sha Tsui, Hong Kong', lat: 22.295, lon: 114.17 },
  { name: 'Times Square, New York', lat: 40.758, lon: -73.9855 },
  { name: 'Brooklyn Bridge, New York', lat: 40.7061, lon: -73.9969 },
  { name: 'Golden Gate Bridge, San Francisco', lat: 37.8199, lon: -122.4783 },
  { name: 'Sydney Opera House', lat: -33.8568, lon: 151.2153 },
  // Japan
  { name: 'Shibuya Crossing, Tokyo', lat: 35.6595, lon: 139.7005 },
  { name: 'Akihabara, Tokyo', lat: 35.6984, lon: 139.7731 },
  { name: 'Kamakurakokomae Railroad Crossing', lat: 35.3066013, lon: 139.5020923 },
  { name: 'Osaka Dotonbori', lat: 34.6687, lon: 135.5013 },
  { name: 'Kyoto Fushimi Inari Shrine', lat: 34.9671, lon: 135.7727 },
  // South Korea
  { name: 'Gwanghwamun Square, Seoul', lat: 37.5759, lon: 126.9768 },
  { name: 'Myeongdong, Seoul', lat: 37.5636, lon: 126.9869 },
  { name: 'Gangnam Station, Seoul', lat: 37.4979, lon: 127.0276 },
  { name: 'Hongdae, Seoul', lat: 37.5563, lon: 126.9236 },
  { name: 'Namsan Tower, Seoul', lat: 37.5512, lon: 126.9882 },
  // Indonesia
  { name: 'Monas, Jakarta', lat: -6.1754, lon: 106.8272 },
  { name: 'Bundaran HI, Jakarta', lat: -6.1951, lon: 106.8231 },
  { name: 'Kota Tua (Fatahillah Square), Jakarta', lat: -6.1352, lon: 106.8133 },
  { name: 'Malioboro, Yogyakarta', lat: -7.7926, lon: 110.3658 },
  { name: 'Gedung Sate, Bandung', lat: -6.9025, lon: 107.6186 },
];

// Place candidates and search. The candidate list and the search (built-in list, then Nominatim)
// live in the Go backend (internal/places); this module only calls the API.

let candidatesCache = null;

/**
 * Built-in candidate list, in display order: [{ name, lat, lon }]. Loaded once per page.
 * Rejects when the server cannot be reached; the caller decides what to show.
 */
export async function loadPlaces() {
  if (!candidatesCache) {
    candidatesCache = (async () => {
      // ?v=2 steps past copies that browsers cached for 24 h before the list became revalidated by ETag.
      const res = await fetch('api/places?v=2', { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`places: HTTP ${res.status}`);
      return res.json();
    })().catch((err) => {
      candidatesCache = null; // allow a retry on the next call
      throw err;
    });
  }
  return candidatesCache;
}

/**
 * Search places: built-in matches first, then Nominatim results (deduplicated by the server).
 * Returns [{ name, lat, lon }]. Rejects on a network or server error (AbortError when aborted).
 */
export async function searchPlaces(query, signal) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const res = await fetch(`api/places/search?${new URLSearchParams({ q })}`, {
    signal,
    headers: { Accept: 'application/json' },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: keep the status text below */
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return Array.isArray(body) ? body : [];
}
