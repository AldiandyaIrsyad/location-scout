// Landmark models. Map data draws some landmarks as plain extruded footprints, which turns the Eiffel
// Tower into a solid block and the Monas obelisk into stacked boxes. For the landmarks listed here the
// map's pieces are dropped and a hand-built model is drawn in their place (same material and edges as
// the other buildings). A landmark is only replaced when the map really has tall pieces at its spot, so
// a place that is missing from the map data is left alone.
//
// To add one: give it a lat / lon and a radius, a `pick(b)` that says which map pieces belong to it,
// and a `build(m)` that draws it with the helpers below (see EIFFEL / MONAS).

import { toLocal } from './geo.js';

// ----- geometry helpers ---------------------------------------------------------------------------
// A model is drawn in its own frame: (x, y) metres on the ground around `m.cx, m.cy`, turned by `m.yaw`,
// and h metres above the ground. `batch` takes triangles through tri(a, b, c, hint, col) / quad(...).

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const hex = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

function frame(cx, cy, g, yaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  // model frame (x, y, h) -> three.js world [X, Y, Z] (Z = -north)
  return (x, y, h) => [cx + x * c - y * s, g + h, -(cy + x * s + y * c)];
}

/** Square-section bar from A to B (world points), half thickness ha at A and hb at B. */
function beam(batch, A, B, ha, hb, col) {
  const d = norm(sub(B, A));
  const ref = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(d, ref));
  const v = cross(d, u);
  const K = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const at = (P, h, k) => [P[0] + (u[0] * K[k][0] + v[0] * K[k][1]) * h, P[1] + (u[1] * K[k][0] + v[1] * K[k][1]) * h, P[2] + (u[2] * K[k][0] + v[2] * K[k][1]) * h];
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    const hint = [0, 1, 2].map((i) => u[i] * (K[k][0] + K[k2][0]) + v[i] * (K[k][1] + K[k2][1]));
    batch.quad(at(A, ha, k), at(A, ha, k2), at(B, hb, k2), at(B, hb, k), hint, col);
  }
  batch.quad(at(A, ha, 0), at(A, ha, 1), at(A, ha, 2), at(A, ha, 3), d.map((x) => -x), col);
  batch.quad(at(B, hb, 0), at(B, hb, 1), at(B, hb, 2), at(B, hb, 3), d, col);
}

/** Rectangular block / frustum: half sizes (hx0, hy0) at height z0 up to (hx1, hy1) at z1. */
function block(batch, P, z0, z1, hx0, hy0, hx1, hy1, col) {
  const K = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const lo = K.map(([i, j]) => P(i * hx0, j * hy0, z0));
  const hi = K.map(([i, j]) => P(i * hx1, j * hy1, z1));
  const c0 = P(0, 0, z0), c1 = P(0, 0, z1);
  for (let k = 0; k < 4; k++) {
    const k2 = (k + 1) % 4;
    const mid = [(lo[k][0] + lo[k2][0] + hi[k][0] + hi[k2][0]) / 4, (lo[k][1] + lo[k2][1] + hi[k][1] + hi[k2][1]) / 4, (lo[k][2] + lo[k2][2] + hi[k][2] + hi[k2][2]) / 4];
    const axis = [(c0[0] + c1[0]) / 2, (c0[1] + c1[1]) / 2, (c0[2] + c1[2]) / 2];
    const hint = sub(mid, axis);
    hint[1] = 0;
    batch.quad(lo[k], lo[k2], hi[k2], hi[k], hint, col);
  }
  batch.quad(hi[0], hi[1], hi[2], hi[3], [0, 1, 0], col);
  batch.quad(lo[0], lo[1], lo[2], lo[3], [0, -1, 0], col);
}

/** Round frustum (n sides): radius r0 at z0 to r1 at z1. */
function cone(batch, P, z0, z1, r0, r1, n, col) {
  const ring = (z, r) => Array.from({ length: n }, (_, k) => P(Math.cos((k * 2 * Math.PI) / n) * r, Math.sin((k * 2 * Math.PI) / n) * r, z));
  const lo = ring(z0, r0), hi = ring(z1, r1);
  const c0 = P(0, 0, z0), c1 = P(0, 0, z1);
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    const mid = [(lo[k][0] + lo[k2][0]) / 2, 0, (lo[k][2] + lo[k2][2]) / 2];
    batch.quad(lo[k], lo[k2], hi[k2], hi[k], [mid[0] - c0[0], 0, mid[2] - c0[2]], col);
  }
  for (let k = 1; k < n - 1; k++) {
    batch.tri(hi[0], hi[k], hi[k + 1], [0, 1, 0], col);
    batch.tri(lo[0], lo[k], lo[k + 1], [0, -1, 0], col);
  }
  void c1;
}

// ----- Eiffel Tower -------------------------------------------------------------------------------
// 330 m. Four lattice legs on a 125 m square, joined by arches under the first platform (57.6 m),
// closing into one shaft above the second platform (115.7 m), with the third platform at 276 m, the top
// cabin at 300 m and the antenna to 330 m. The map draws it rotated 45 degrees to north.

const IRON = hex('#76695a');
const IRON_LIGHT = hex('#8b7d6a');
const L1 = 57.6, L2 = 115.7, L3 = 276;
const fall = (z, p) => Math.pow(Math.max(0, 1 - z / L3), p);
const legCentre = (z) => 3 + 47 * fall(z, 2.8); // leg axis, from the tower axis
const legHalf = (z) => 1.2 + 11.3 * fall(z, 1.6); // half the width of one leg
const outerHalf = (z) => legCentre(z) + legHalf(z);
const postHalf = (z) => 0.3 + 0.7 * fall(z, 1.5); // main post, half thickness

function buildEiffel(batch, P) {
  const SIGN = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const V = (x, y, z) => P(x, y, z);

  // lattice of a square tube: corner posts, rings and X braces, between the given heights
  const tube = (centre, half, levels, thick) => {
    const corner = (k, z) => V(centre(z)[0] + SIGN[k][0] * half(z), centre(z)[1] + SIGN[k][1] * half(z), z);
    for (let i = 0; i < levels.length - 1; i++) {
      const za = levels[i], zb = levels[i + 1];
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) % 4;
        beam(batch, corner(k, za), corner(k, zb), thick(za), thick(zb), IRON);
        beam(batch, corner(k, zb), corner(k2, zb), thick(zb) * 0.55, thick(zb) * 0.55, IRON);
        beam(batch, corner(k, za), corner(k2, zb), thick(zb) * 0.4, thick(zb) * 0.4, IRON);
        beam(batch, corner(k2, za), corner(k, zb), thick(zb) * 0.4, thick(zb) * 0.4, IRON);
      }
    }
  };

  const low = [0, 9, 18, 28, 38, 48, L1];
  const mid = [L1, 70, 83, 95, 106, L2];
  const high = [L2, 131, 148, 166, 186, 207, 229, 252, L3];

  // four legs up to the second platform
  for (const [sx, sy] of SIGN) {
    tube((z) => [sx * legCentre(z), sy * legCentre(z)], legHalf, [...low, ...mid.slice(1)], (z) => postHalf(z) * 1.5);
  }
  // one shaft above it
  tube(() => [0, 0], outerHalf, high, (z) => postHalf(z) * 1.3);

  // arches between the legs, under the first platform
  const span = legCentre(0) - legHalf(0); // clear half-width at the ground
  const crown = 38;
  for (let side = 0; side < 4; side++) {
    const ang = (side * Math.PI) / 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    // point on the side: t along the face (-1..1), height z
    const onSide = (t, z, out = 0) => {
      const d = outerHalf(z) - 0.5 + out; // face plane, sloping in with height
      return V(d * c - t * span * s, d * s + t * span * c, z);
    };
    const N = 14;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const t = -1 + (2 * i) / N;
      const z = crown * Math.sqrt(Math.max(0, 1 - t * t));
      const here = onSide(t, z);
      if (prev) {
        const w = 0.5 + 0.9 * (1 - Math.abs(t));
        beam(batch, prev.p, here, prev.w, w, IRON);
        beam(batch, onSide(prev.t, prev.z, -0.8), onSide(t, z, -0.8), prev.w * 0.7, w * 0.7, IRON);
      }
      prev = { p: here, w: 0.5 + 0.9 * (1 - Math.abs(t)), t, z };
    }
    // uprights between the arch and the platform girder
    for (let k = -4; k <= 4; k++) {
      const t = k / 4.4;
      const z = crown * Math.sqrt(Math.max(0, 1 - t * t));
      beam(batch, onSide(t, z), onSide(t, L1 - 4), 0.35, 0.35, IRON);
    }
  }

  // platforms
  const slab = (z0, z1, half, col = IRON_LIGHT) => block(batch, P, z0, z1, half, half, half, half, col);
  slab(L1 - 5.5, L1 - 1.5, outerHalf(L1) + 1.5);
  slab(L1 - 1.5, L1, outerHalf(L1) + 1.8);
  slab(L1, L1 + 2.2, outerHalf(L1) - 3);
  slab(L2 - 3.5, L2, outerHalf(L2) + 2);
  slab(L2, L2 + 1.8, outerHalf(L2) - 2.5);
  slab(L3 - 3, L3, 9);

  // top: cabin, roof, shaft, lantern, antenna
  block(batch, P, L3, L3 + 8, 6.4, 6.4, 6.4, 6.4, IRON_LIGHT);
  block(batch, P, L3 + 8, L3 + 12, 7.2, 7.2, 3.2, 3.2, IRON);
  block(batch, P, L3 + 12, 300, 2.6, 2.6, 1.4, 1.4, IRON);
  block(batch, P, 300, 304, 2, 2, 2, 2, IRON_LIGHT);
  beam(batch, P(0, 0, 304), P(0, 0, 330), 0.9, 0.2, IRON);
}

// ----- Monas (National Monument, Jakarta) ---------------------------------------------------------
// 132 m marble obelisk on a stepped cup, an observation deck at 115 m and a gilded flame on top.
// The map keeps the 6 m terrace under it, so the model starts at the terrace top.

const MARBLE = hex('#ebe8df');
const MARBLE_DARK = hex('#d9d4c7');
const GOLD = hex('#dfb13a');

function buildMonas(batch, P) {
  block(batch, P, 6, 14, 12, 12, 12, 12, MARBLE_DARK); // stem of the cup
  block(batch, P, 14, 17, 12, 12, 19, 19, MARBLE); // the cup flares out
  block(batch, P, 17, 21, 20.5, 20.5, 20.5, 20.5, MARBLE); // courtyard deck
  block(batch, P, 21, 23, 9.5, 9.5, 9.5, 9.5, MARBLE_DARK); // pedestal
  block(batch, P, 23, 108, 6.5, 6.5, 3.6, 3.6, MARBLE); // the obelisk, narrowing up
  block(batch, P, 108, 113, 3.6, 3.6, 8.5, 8.5, MARBLE_DARK); // underside of the observation deck
  block(batch, P, 113, 115, 8.8, 8.8, 8.8, 8.8, MARBLE); // observation deck
  block(batch, P, 115, 116, 6.2, 6.2, 6.2, 6.2, MARBLE_DARK); // rail
  // the flame
  cone(batch, P, 115, 118, 3.2, 4.2, 14, GOLD);
  cone(batch, P, 118, 123, 4.2, 3.4, 14, GOLD);
  cone(batch, P, 123, 128, 3.4, 2, 14, GOLD);
  cone(batch, P, 128, 132, 2, 0.2, 14, GOLD);
}

// ----- Louvre Pyramid -------------------------------------------------------------------------------
// 35.4 m square, 21.64 m high, a lattice of steel bars and glass. The map draws it as a solid hexagon
// with one pyramid roof, and the courtyard slopes under it, so one corner ends up buried. This model is
// sized from the map's outline and rests on a plinth that reaches down to the lowest ground under it.

const GLASS = hex('#aac6d3');
const STEEL = hex('#5d6670');
const STONE = hex('#b3aa9c');

function buildLouvre(batch, P, { hx, hy, drop }) {
  const H = 21.64;
  const A = [P(-hx, -hy, 0.5), P(hx, -hy, 0.5), P(hx, hy, 0.5), P(-hx, hy, 0.5)];
  const T = P(0, 0, H);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const N = 12;
  for (let f = 0; f < 4; f++) {
    const a = A[f], b = A[(f + 1) % 4];
    batch.tri(a, b, T, [(a[0] + b[0]) / 2 - T[0], 0.6, (a[2] + b[2]) / 2 - T[2]], GLASS);
    // triangular lattice: bars parallel to the base and to both slanting edges
    for (let k = 1; k < N; k++) beam(batch, lerp(a, T, k / N), lerp(b, T, k / N), 0.06, 0.06, STEEL);
    for (let j = 1; j < N; j++) {
      const pj = lerp(a, b, j / N);
      beam(batch, pj, lerp(b, T, 1 - j / N), 0.06, 0.06, STEEL); // parallel to a-T
      beam(batch, pj, lerp(a, T, j / N), 0.06, 0.06, STEEL); // parallel to b-T
    }
    beam(batch, a, b, 0.22, 0.22, STEEL);
    beam(batch, a, T, 0.16, 0.1, STEEL);
  }
  // plinth: reaches down to the lowest ground under the pyramid so no corner is buried or floating
  block(batch, P, -drop, 0.5, hx + 0.6, hy + 0.6, hx + 0.6, hy + 0.6, STONE);
}

// ----- registry -----------------------------------------------------------------------------------

const tall = (b) => (b.height || 0) >= 20 || (b.minHeight || 0) > 0 || b.kind === 'tower';

/**
 * fit(pieces) -> { cx, cy, yaw, hx?, hy? } or null: where the landmark stands, from the map pieces that
 * pick() chose. hx / hy (half size) make the model rest on the highest ground under its footprint and
 * pass `drop` (how far the lowest ground is below that) to build().
 */

// towers: centred on the tallest pieces; null when the map has no tall piece here
const towerFit = (yaw) => (pieces) => {
  const tallest = pieces.filter((b) => (b.height || 0) >= 100);
  if (!tallest.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of tallest) {
    for (const [x, y] of b.outer) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, yaw };
};

/** Smallest rectangle around a ring, at any angle: { cx, cy, yaw, hx, hy }. */
function orientedBox(ring) {
  let best = null;
  for (let deg = 0; deg < 90; deg += 0.5) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ring) {
      const u = x * c + y * s, v = -x * s + y * c;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u);
      y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (!best || area < best.area) best = { area, a, c, s, x0, x1, y0, y1 };
  }
  const mu = (best.x0 + best.x1) / 2, mv = (best.y0 + best.y1) / 2;
  return { cx: mu * best.c - mv * best.s, cy: mu * best.s + mv * best.c, yaw: best.a, hx: (best.x1 - best.x0) / 2, hy: (best.y1 - best.y0) / 2 };
}

export const LANDMARKS = [
  { id: 'eiffel', name: 'Eiffel Tower', lat: 48.85837, lon: 2.29448, radius: 110, cameraHeight: 330, cameraRadius: 89, pick: tall, fit: towerFit(Math.PI / 4), build: buildEiffel },
  // plainWalls: radius in metres around the landmark where the map buildings left standing (terraces, steps,
  // entrance halls) get no window grid
  { id: 'monas', name: 'Monas', lat: -6.1754, lon: 106.8272, radius: 60, cameraHeight: 132, cameraRadius: 60, plainWalls: 100, pick: tall, fit: towerFit(0), build: buildMonas },
  {
    id: 'louvre-pyramid', name: 'Louvre Pyramid', lat: 48.8610, lon: 2.3359, radius: 60,
    cameraHeight: 21.64,
    // the map has it as a 15-30 m pyramid roof on a ground-level footprint about 35 m across
    pick: (b) => b.roofShape === 'pyramidal' && (b.height || 0) >= 15 && (b.height || 0) <= 30 && !(b.minHeight > 0),
    fit: (pieces) => {
      const big = pieces.map((b) => orientedBox(b.outer)).filter((o) => o.hx >= 14 && o.hx <= 25 && o.hy >= 14 && o.hy <= 25);
      return big[0] || null;
    },
    build: buildLouvre,
  },
];

const centroid = (ring) => {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
};

/**
 * Which map buildings to keep and what to draw in place of the others.
 * Returns { buildings, draw(batch, groundHeight) } (draw is null when no landmark is in the area).
 */
export function landmarksFor(city, enabled = true) {
  const list = city.buildings || [];
  const c = city.center;
  if (!enabled || !c) return { buildings: list, draw: null };
  const found = [];
  let drop = null;
  let plain = null;
  for (const lm of LANDMARKS) {
    const [lx, ly] = toLocal(lm.lat, lm.lon, c.lat, c.lon);
    const hit = list.filter((b) => {
      if (!b.outer || b.outer.length < 3 || !lm.pick(b)) return false;
      const [x, y] = centroid(b.outer);
      return Math.hypot(x - lx, y - ly) <= lm.radius;
    });
    // the map must really have the landmark here; the fit says where it stands
    const spot = hit.length ? lm.fit(hit) : null;
    if (!spot) continue;
    found.push({ lm, ...spot });
    if (lm.plainWalls) {
      for (const b of list) {
        if (hit.includes(b) || !b.outer || b.outer.length < 3) continue;
        const [x, y] = centroid(b.outer);
        if (Math.hypot(x - lx, y - ly) <= lm.plainWalls) (plain ??= new Set()).add(b);
      }
    }
    drop ??= new Set();
    for (const b of hit) drop.add(b);
  }
  if (!found.length) return { buildings: list, draw: null };
  return {
    replacements: found.map(({ cx, cy }) => [cx, cy]),
    // Frame the complete replacement model, including the ground below elevated
    // map parts. A tower's upper platform alone is an invalid camera subject.
    subjects: found.map(({ lm, cx, cy, hx, hy }) => ({
      center: [cx, cy], baseHeight: 0, height: lm.cameraHeight,
      radius: lm.cameraRadius || Math.hypot(hx || 0, hy || 0),
    })),
    buildings: list.filter((b) => !drop.has(b)).map((b) => (plain && plain.has(b) ? { ...b, noWindows: true } : b)),
    draw(batch, groundHeight) {
      for (const { lm, cx, cy, yaw, hx, hy } of found) {
        let g = groundHeight(cx, cy);
        const info = { hx, hy, drop: 0 };
        if (hx) {
          // rest on the highest ground under the footprint; the model reaches down to the lowest
          const cs = Math.cos(yaw), sn = Math.sin(yaw);
          let hi = -Infinity, lo = Infinity;
          for (let i = -2; i <= 2; i++) {
            for (let j = -2; j <= 2; j++) {
              const u = (i / 2) * hx, v = (j / 2) * hy;
              const h = groundHeight(cx + u * cs - v * sn, cy + u * sn + v * cs);
              hi = Math.max(hi, h);
              lo = Math.min(lo, h);
            }
          }
          g = hi;
          info.drop = hi - lo + 0.4;
        }
        lm.build(batch, frame(cx, cy, g, yaw), info);
      }
    },
  };
}
