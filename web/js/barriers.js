// Barriers (fences, walls, hedges) and street furniture (benches, bins, bus stops): how each is drawn,
// where a road crosses a barrier (an opening), and which way a fixture faces. Pure geometry in local
// metres (x east, y north), no rendering.

export const BARRIER_STYLES = {
  fence: { form: 'rails', height: 1.6, color: '#5d646b' },
  handrail: { form: 'rails', height: 1.0, color: '#6a7077' },
  guard_rail: { form: 'rails', height: 0.8, color: '#9aa0a6' },
  wall: { form: 'solid', height: 1.8, thickness: 0.3, color: '#cfc7b8' },
  city_wall: { form: 'solid', height: 5, thickness: 1.2, color: '#c2b9a8' },
  retaining_wall: { form: 'solid', height: 1.0, thickness: 0.35, color: '#b9b2a4' },
  hedge: { form: 'solid', height: 1.1, thickness: 0.8, color: '#5f9650' },
  jersey_barrier: { form: 'solid', height: 0.8, thickness: 0.5, color: '#b9b9b6' },
};

/** Mapped height when usable (clamped so a typo cannot make a skyscraper), else the style's. */
export function barrierHeight(barrier) {
  const style = BARRIER_STYLES[barrier.kind];
  if (!style) return 0;
  return barrier.height > 0 ? Math.min(Math.max(barrier.height, 0.3), 12) : style.height;
}

const CELL = 32;
const cellKey = (i, j) => `${i},${j}`;

/**
 * Spatial index over the drivable and walkable roads. Bridges and tunnels are left out: a bridge over
 * a fence does not open it, and a tunnel does not either.
 */
export function roadIndex(roads) {
  const cells = new Map();
  for (const road of roads || []) {
    if (!Number.isFinite(road.width) || road.bridge || road.tunnel || road.layer) continue;
    const pts = road.points || [];
    for (let i = 1; i < pts.length; i++) {
      const seg = { ax: pts[i - 1][0], ay: pts[i - 1][1], bx: pts[i][0], by: pts[i][1], half: road.width / 2 };
      const x0 = Math.floor(Math.min(seg.ax, seg.bx) / CELL), x1 = Math.floor(Math.max(seg.ax, seg.bx) / CELL);
      const y0 = Math.floor(Math.min(seg.ay, seg.by) / CELL), y1 = Math.floor(Math.max(seg.ay, seg.by) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(seg);
      }
    }
  }
  const nearby = (x, y) => {
    const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL), out = [];
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) out.push(...(cells.get(cellKey(i, j)) || []));
    return out;
  };
  const distanceTo = (s, x, y) => {
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / (dx * dx + dy * dy || 1)));
    const px = s.ax + dx * t, py = s.ay + dy * t;
    return { d: Math.hypot(x - px, y - py), px, py };
  };
  return {
    /** True when the point is on a road's paved width (a margin inside the edge, so a barrier mapped along a road's edge stays). */
    insideRoad(x, y) {
      return nearby(x, y).some((s) => distanceTo(s, x, y).d < s.half - 0.3);
    },
    /** Nearest point on any road within maxDistance (<= CELL), or null. */
    nearest(x, y, maxDistance) {
      let best = null;
      for (const s of nearby(x, y)) {
        const { d, px, py } = distanceTo(s, x, y);
        if (d <= maxDistance && (!best || d < best.d)) best = { d, x: px, y: py };
      }
      return best;
    },
  };
}

/**
 * Split a barrier line into runs, leaving a gap wherever the line is on a road. The line is sampled at
 * `step` metres (keeping its own vertices), so an opening is as wide as the road to within one step.
 */
export function barrierRuns(points, insideRoad, step = 1.5) {
  const runs = [];
  let run = [];
  const visit = (x, y) => {
    if (insideRoad(x, y)) {
      if (run.length > 1) runs.push(run);
      run = [];
    } else {
      run.push([x, y]);
    }
  };
  for (let i = 0; i < points.length; i++) {
    visit(points[i][0], points[i][1]);
    if (i === points.length - 1) break;
    const [ax, ay] = points[i], [bx, by] = points[i + 1];
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
    for (let k = 1; k < n; k++) visit(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** Angle (radians, atan2 over local x east / y north) a fixture faces. */
export function fixtureFacing(fixture, index) {
  if (Number.isFinite(fixture.direction)) return Math.PI / 2 - (fixture.direction * Math.PI) / 180; // compass degrees
  const [x, y] = fixture.position;
  const road = index?.nearest(x, y, 25);
  if (road && road.d > 1e-6) return Math.atan2(road.y - y, road.x - x); // faces the road or path beside it
  let h = 0; // untagged and nowhere near a road: a stable quarter turn from the id
  for (const ch of String(fixture.id)) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return ((Math.abs(h) % 4) * Math.PI) / 2;
}
