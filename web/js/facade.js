// Procedural facades. The window grid itself stays what it always was (floors every 3.2 m, columns every 3 m, in world
// space, see WINDOW_GLSL in render.js), but what a cell holds now depends on the building:
//   * each building has a window style (classic, tall French windows, ribbon, small, paired),
//   * ground-floor columns can hold a door, an arched passage (an alley opening) or a wide shop window,
//   * some upper-floor columns are blank (stairwell strips, party walls).
// Everything is decided from two numbers per building, a seed and the ground level, so the shader and the SVG export
// agree. The shader source below is generated from the tables here; tools/facade.test.mjs checks that its scalar
// functions give the same answers as the JS ones.

export const FLOOR_H = 3.2; // floor spacing, m
export const COL_W = 3; // column spacing, m

/** A window rectangle is [uLo, uHi, yLo, yHi] inside a column cell: u across the column, y up the floor, metres. */
export const STYLES = [
  { id: 'classic', weight: 0.34, rects: [[0.7, 2.3, 0.8, 2.5]] },
  { id: 'tall', weight: 0.14, rects: [[0.85, 2.15, 0.1, 2.85]] },
  { id: 'ribbon', weight: 0.1, rects: [[0.12, 2.88, 1.0, 2.4]] },
  { id: 'small', weight: 0.18, rects: [[1.0, 2.0, 1.0, 2.2]] },
  { id: 'pair', weight: 0.24, rects: [[0.3, 1.3, 0.8, 2.4], [1.7, 2.7, 0.8, 2.5]] },
];
export const RIBBON = 2; // index of the continuous style: it never has blank columns

// Ground-floor openings. Heights are above the building's ground level, widths across the column.
export const DOOR = { u0: 1.05, u1: 1.95, h: 2.2 };
export const PASSAGE = { u0: 0.6, u1: 2.4, h: 2.9, arch: 2.0 }; // straight to `arch`, then a half ellipse up to `h`
export const SHOP = { u0: 0.2, u1: 2.8, y0: 0.45, y1: 2.6 };

// share of ground-floor columns (at full "openings"): door, then passage, then shop window in shop buildings
const P_DOOR = 0.13;
const P_PASSAGE = 0.03;
const P_SHOP = 0.55;
const SHOP_BUILDINGS = 0.35; // share of buildings with shop windows on the ground floor
const P_BLANK = 0.07; // share of upper-floor columns left blank

const mod = (x, m) => ((x % m) + m) % m;

/** Small integer hash in [0, 1). Every intermediate stays below 2^24, so float32 on the GPU gives the same answer. */
export function fcHash(a, b, s) {
  let h = mod(a * 127 + b * 311 + s * 73 + 19, 1031);
  h = mod(h * h + 7 * s + 3, 1031);
  h = mod(h * h + 31 * a + 11 * b, 1031);
  return h / 1031;
}

/** Seed for a building from any string id (small non-negative integer). */
export function facadeSeed(hash32) {
  return hash32 % 1000;
}

/** Style index of a building. `variety` 0..1 is the share of buildings that leave the classic window. */
export function styleOf(seed, variety = 1) {
  if (fcHash(seed, 2, 8) >= variety) return 0;
  const h = fcHash(seed, 1, 5);
  let acc = 0;
  for (let i = 0; i < STYLES.length - 1; i++) {
    acc += STYLES[i].weight;
    if (h < acc) return i;
  }
  return STYLES.length - 1;
}

const isShop = (seed) => fcHash(seed, 9, 2) < SHOP_BUILDINGS;

/** What the ground floor of column c holds before neighbours are considered: 0 nothing, 1 door, 2 passage, 3 shop window. */
function rawGround(seed, c, openings) {
  const h = fcHash(c, 7, seed);
  if (h < P_DOOR * openings) return 1;
  if (h < (P_DOOR + P_PASSAGE) * openings) return 2;
  if (isShop(seed) && h < (P_DOOR + P_PASSAGE + P_SHOP) * openings) return 3;
  return 0;
}

/** Ground-floor content of column c: two doors or passages never stand side by side. */
export function groundKind(seed, c, openings = 1) {
  const k = rawGround(seed, c, openings);
  if ((k === 1 || k === 2) && [1, 2].includes(rawGround(seed, c - 1, openings))) return 0;
  return k;
}

/** True when column c has no windows above the ground floor. */
export function isBlank(seed, c, variety = 1) {
  if (styleOf(seed, variety) === RIBBON) return false;
  return fcHash(c, 13, seed) < P_BLANK * variety;
}

/** Index of the floor row that is the ground floor of a building standing at height `base`. */
export function groundFloor(base) {
  return Math.ceil((base - 1.0) / FLOOR_H) + 0; // + 0 turns -0 into 0
}

/** Door colour index 0..3 of column c. */
export function doorColour(seed, c) {
  return Math.floor(fcHash(c, 17, seed) * 4);
}

/**
 * Shapes on the wall stretch u in [uMin, uMax] (world coordinate along the wall) of a building with ground level `base`,
 * whose walls reach up to `wallTop`: whole windows as {u0, u1, y0, y1} and ground-floor openings as {kind, u0, u1, y0, y1}.
 * Mirrors the shader (fcCell / fcOpeningAt in render.js), so the SVG export lines up with the picture.
 */
export function facadeShapes(seed, base, uMin, uMax, bottom, wallTop, { variety = 1, openings = 1 } = {}) {
  const windows = [];
  const doors = [];
  const style = STYLES[styleOf(seed, variety)];
  const f0 = groundFloor(base);
  for (let c = Math.floor(uMin / COL_W); c * COL_W < uMax; c++) {
    const o = c * COL_W;
    const ground = groundKind(seed, c, openings);
    if (ground === 1 || ground === 2) {
      const d = ground === 1 ? DOOR : PASSAGE;
      if (o + d.u0 >= uMin && o + d.u1 <= uMax) doors.push({ kind: ground, u0: o + d.u0, u1: o + d.u1, y0: base, y1: base + d.h });
    }
    for (let f = Math.floor((bottom - 1) / FLOOR_H); f * FLOOR_H < wallTop; f++) {
      const y = f * FLOOR_H;
      let rects = style.rects;
      if (f === f0 && ground === 3) rects = [[SHOP.u0, SHOP.u1, base + SHOP.y0 - y, base + SHOP.y1 - y]];
      else if (f === f0 && ground > 0) continue;
      else if (f > f0 && isBlank(seed, c, variety)) continue;
      for (const [a, b, lo, hi] of rects) {
        const x0 = o + a;
        const x1 = o + b;
        const y0 = y + lo;
        const y1 = y + hi;
        if (x0 < uMin || x1 > uMax || y0 < bottom + 0.3 || y1 > wallTop - 0.2) continue; // only whole windows
        windows.push({ u0: x0, u1: x1, y0, y1 });
      }
    }
  }
  return { windows, doors };
}

// ---- GLSL ------------------------------------------------------------------------------------------------------------

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
const vec4 = (r) => `vec4(${r.map(f).join(', ')})`;

function glslStyle() {
  let acc = 0;
  const lines = [];
  for (let i = 0; i < STYLES.length - 1; i++) {
    acc += STYLES[i].weight;
    lines.push(`  if (h < ${f(Number(acc.toFixed(4)))}) return ${f(i)};`);
  }
  return lines.join('\n');
}

function glslRects() {
  const lines = [];
  STYLES.forEach((s, i) => {
    const pick = (k) => (s.rects[k] ? vec4(s.rects[k]) : 'vec4(0.0)');
    lines.push(`  if (st < ${f(i + 0.5)}) return k < 0.5 ? ${pick(0)} : ${pick(1)};`);
  });
  return lines.join('\n');
}

/**
 * Scalar functions (hash, style, ground content, blank columns) and the style table, as GLSL. `uFacade` is declared by
 * the caller: x = share of buildings with a non-classic window style, y = amount of doors / passages / shop windows.
 */
export function facadeGlsl() {
  return `
  float fcHash(float a, float b, float s) {
    float h = mod(a * 127.0 + b * 311.0 + s * 73.0 + 19.0, 1031.0);
    h = mod(h * h + 7.0 * s + 3.0, 1031.0);
    h = mod(h * h + 31.0 * a + 11.0 * b, 1031.0);
    return h / 1031.0;
  }
  float fcStyle(float s) {
    if (fcHash(s, 2.0, 8.0) >= uFacade.x) return 0.0;
    float h = fcHash(s, 1.0, 5.0);
${glslStyle()}
    return ${f(STYLES.length - 1)};
  }
  float fcShop(float s) {
    return fcHash(s, 9.0, 2.0) < ${f(SHOP_BUILDINGS)} ? 1.0 : 0.0;
  }
  float fcRaw(float s, float c) {
    float h = fcHash(c, 7.0, s);
    float o = uFacade.y;
    if (h < ${f(P_DOOR)} * o) return 1.0;
    if (h < ${f(Number((P_DOOR + P_PASSAGE).toFixed(4)))} * o) return 2.0;
    if (fcShop(s) > 0.5 && h < ${f(Number((P_DOOR + P_PASSAGE + P_SHOP).toFixed(4)))} * o) return 3.0;
    return 0.0;
  }
  float fcGround(float s, float c) {
    float k = fcRaw(s, c);
    float q = fcRaw(s, c - 1.0);
    if (k > 0.5 && k < 2.5 && q > 0.5 && q < 2.5) return 0.0;
    return k;
  }
  float fcBlank(float s, float c) {
    float st = fcStyle(s);
    if (st > ${f(RIBBON - 0.5)} && st < ${f(RIBBON + 0.5)}) return 0.0;
    return fcHash(c, 13.0, s) < ${f(P_BLANK)} * uFacade.x ? 1.0 : 0.0;
  }
  float fcDoorColour(float s, float c) {
    return floor(fcHash(c, 17.0, s) * 4.0);
  }
  vec4 fcRect(float st, float k) {
${glslRects()}
    return vec4(0.0);
  }
`;
}
