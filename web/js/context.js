// Preserve mapped context without drawing a second copy of the detailed inner streets.
const key = (a) => a.id || JSON.stringify([a.outer, a.holes, a.kind]);
const unique = (a = [], b = [], identify = key) => {
  const seen = new Set();
  return [...a, ...b].filter((item) => { const k = identify(item); if (seen.has(k)) return false; seen.add(k); return true; });
};

export function outsideSquare(points, half) {
  const pieces = []; let current = [];
  const append = (a, b) => {
    const last = current.at(-1);
    if (last && Math.hypot(last[0] - a[0], last[1] - a[1]) > 1e-6) { pieces.push(current); current = []; }
    if (!current.length) current.push(a);
    current.push(b);
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], d = [b[0] - a[0], b[1] - a[1]];
    let lo = 0, hi = 1, intersects = true;
    for (let axis = 0; axis < 2; axis++) {
      if (Math.abs(d[axis]) < 1e-12) { if (Math.abs(a[axis]) > half) intersects = false; continue; }
      const t0 = (-half - a[axis]) / d[axis], t1 = (half - a[axis]) / d[axis];
      lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
    }
    if (!intersects || lo >= hi) { append(a, b); continue; }
    const at = (t) => [a[0] + d[0] * t, a[1] + d[1] * t];
    if (lo > 1e-9) append(a, at(lo));
    if (current.length) { pieces.push(current); current = []; }
    if (hi < 1 - 1e-9) append(at(hi), b);
  }
  if (current.length) pieces.push(current);
  return pieces.filter(p => p.length > 1);
}

export function composeContext(city, surroundings) {
  const sur = surroundings || {};
  const nearIds = new Set((city.buildings || []).map(b => b.id));
  const exterior = (list) => (list || []).flatMap((road) => outsideSquare(road.points || [], city.size * 0.6)
    .map((points, i) => ({ ...road, id: `${road.id}:context:${i}`, points, sourceRoad: road })));
  const rails = [...(city.railways || []), ...(sur.railways || [])];
  return {
    ...city, size: Math.max(city.size, sur.contextSize || 0),
    water: unique(city.water, sur.water), green: unique(city.green, sur.green), areas: unique(city.areas, sur.areas),
    props: unique(city.props, sur.props),
    trees: unique(city.trees, sur.trees, p => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`),
    // Both representations stay in the surface graph so clipped inner roads use their actual profile.
    roads: [...(city.roads || []), ...(sur.roads || []), ...rails],
    contextRoads: exterior(sur.roads), contextRailways: exterior(sur.railways),
    contextBuildings: (sur.buildings || []).filter(b => !nearIds.has(b.id)),
  };
}
