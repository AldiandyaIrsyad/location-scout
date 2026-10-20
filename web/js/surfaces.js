// Terrain is bare earth: bridge decks and water surfaces must not follow its riverbed.
// Heights here use the renderer's local vertical datum, not absolute sea level.
const areaBounds = new WeakMap();
// [minX, minY, maxX, maxY] of the outer ring, cached per area.
function boundsOf(area) {
  let bounds = areaBounds.get(area);
  if (!bounds) {
    bounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [px, py] of area.outer) {
      bounds[0] = Math.min(bounds[0], px); bounds[1] = Math.min(bounds[1], py);
      bounds[2] = Math.max(bounds[2], px); bounds[3] = Math.max(bounds[3], py);
    }
    areaBounds.set(area, bounds);
  }
  return bounds;
}

export function inArea(x, y, area) {
  if (!area.outer?.length) return false;
  const bounds = boundsOf(area);
  if (x < bounds[0] || y < bounds[1] || x > bounds[2] || y > bounds[3]) return false;
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[i], [bx, by] = ring[j];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  };
  return area.outer?.length >= 3 && inRing(area.outer) && !(area.holes || []).some(inRing);
}

const quantile = (values, q) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) * q)] : 0;
};
const vertexKey = (p) => `${Math.round(p[0] * 5)},${Math.round(p[1] * 5)}`;
const raised = (r) => !r.tunnel && (r.bridge || r.layer > 0);
const deckLayer = (r) => Math.max(1, r.layer || 1);

function interiorHeights(area, half, terrainAt) {
  // Scan the actual polygon interior. A fixed square grid can miss a narrow canal entirely.
  const bounds = boundsOf(area);
  const lo = Math.max(-half, bounds[1]), hi = Math.min(half, bounds[3]);
  const samples = [];
  if (hi <= lo) return samples;
  for (let row = 0; row < 25; row++) {
    const y = lo + (row + 0.5) * (hi - lo) / 25;
    const xs = [-half, half];
    for (const ring of [area.outer, ...(area.holes || [])]) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[j], [bx, by] = ring[i];
        if ((ay > y) === (by > y)) continue;
        const x = ax + (y - ay) * (bx - ax) / (by - ay);
        if (x > -half && x < half) xs.push(x);
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      const left = xs[i - 1], width = xs[i] - left;
      if (width <= 1e-9 || !inArea(left + width / 2, y, area)) continue;
      for (const t of [0.25, 0.5, 0.75]) samples.push(terrainAt(left + width * t, y));
    }
  }
  return samples;
}

export function makeSurfaces(city, elevation, terrainAt, { deckHint } = {}) {
  const half = (city.size || 300) * 1.5;
  const water = new Map();
  for (const a of city.water || []) {
    if (!a.outer || a.outer.length < 3) continue;
    // Sample locally, not vertices kilometres away that clamp to the DEM edge.
    const samples = interiorHeights(a, half, terrainAt);
    if (!samples.length) for (const [x, y] of a.outer) {
      if (Math.abs(x) <= half && Math.abs(y) <= half) samples.push(terrainAt(x, y));
    }
    // The lower interior quantile rejects embankments and DEM surface noise. Preserve a mapped
    // absolute water elevation when supplied. This is a local visual estimate, not a tidal model.
    const mapped = Number.isFinite(a.elevation) && Number.isFinite(elevation?.baseElevation);
    const h = mapped ? a.elevation - elevation.baseElevation : quantile(samples, 0.2);
    water.set(a, h + 0.05);
  }
  // Keyed by the millimetre position as one number; a string key per query is wasteful, since
  // terrain, roads and crowd all ask for the water level at every vertex they place.
  const waterSamples = new Map();
  const waterHeightAt = (x, y) => {
    const key = (Math.round(x * 1000) + 1e7) * 2e7 + Math.round(y * 1000) + 1e7;
    if (waterSamples.has(key)) return waterSamples.get(key);
    let h = null;
    for (const [a, level] of water) if (inArea(x, y, a)) h = h === null ? level : Math.min(h, level);
    waterSamples.set(key, h);
    return h;
  };
  const groundAt = (x, y) => {
    const h = terrainAt(x, y), level = waterHeightAt(x, y);
    return level === null ? h : Math.min(h, level - 0.12);
  };
  const roads = (city.roads || []).filter((r) => r.points?.length >= 2 && !r.tunnel);
  const bridges = roads.filter(raised), vertices = new Map();
  roads.forEach((r) => r.points.forEach((p) => {
    const key = vertexKey(p);
    if (!vertices.has(key)) vertices.set(key, []);
    vertices.get(key).push(r);
  }));
  const seen = new Set(), profiles = new Map(), bridgeDecks = [];
  for (const first of bridges) {
    if (seen.has(first)) continue;
    const group = [], pending = [first];
    while (pending.length) {
      const road = pending.pop();
      if (seen.has(road)) continue;
      seen.add(road); group.push(road);
      for (const p of road.points) for (const next of vertices.get(vertexKey(p)) || []) {
        if (raised(next) && deckLayer(next) === deckLayer(first) && !seen.has(next)) pending.push(next);
      }
    }
    const anchors = new Map(), levels = [], ground = [];
    for (const road of group) for (const p of road.points) {
      ground.push(terrainAt(...p));
      const level = waterHeightAt(...p);
      if (level !== null) levels.push(level);
      if ((vertices.get(vertexKey(p)) || []).some((r) => !raised(r))) anchors.set(vertexKey(p), [...p, terrainAt(...p)]);
    }
    const hint = deckHint?.(group);
    const estimated = !anchors.size && !Number.isFinite(hint);
    const fallback = Number.isFinite(hint) ? hint : Math.max(quantile(ground, 0.75) + deckLayer(first) * 4.5,
      levels.length ? Math.max(...levels) + 4.5 : -Infinity);
    const points = [...anchors.values()];
    const heightAt = (x, y) => {
      let h = fallback;
      if (points.length && !Number.isFinite(hint)) {
        let weight = 0, sum = 0;
        for (const [ax, ay, ah] of points) {
          const d2 = (x - ax) ** 2 + (y - ay) ** 2;
          if (d2 < 0.01) {
            const wet = waterHeightAt(x, y);
            return wet === null ? ah : Math.max(ah, wet + 0.45);
          }
          const w = 1 / d2;
          weight += w; sum += ah * w;
        }
        h = sum / weight;
      }
      const wet = waterHeightAt(x, y);
      return wet === null ? h : Math.max(h, wet + 0.45);
    };
    const profile = { roads: group, heightAt, estimated, anchored: !!points.length };
    bridgeDecks.push(profile);
    for (const r of group) profiles.set(r, profile);
  }
  const heightFor = (road, x, y) => profiles.get(road)?.heightAt(x, y) ?? groundAt(x, y);
  const distanceToRoad = (r, x, y) => {
    let d = Infinity;
    for (let i = 1; i < r.points.length; i++) {
      const [ax, ay] = r.points[i - 1], [bx, by] = r.points[i];
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    return d;
  };
  const surfaceAt = (x, y) => {
    let h = groundAt(x, y);
    for (const [r, profile] of profiles) {
      if (distanceToRoad(r, x, y) <= (r.width || 6) / 2 + 2.5) h = Math.max(h, profile.heightAt(x, y));
    }
    return h;
  };
  return { water, waterHeightAt, groundAt, heightFor, surfaceAt, profiles, bridgeDecks };
}
