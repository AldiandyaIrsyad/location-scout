// js/render.js
// three.js scene, geometry generation and render styles for Panelscape.
// World convention: local [x, y] (east, north) -> THREE.Vector3(x, h, -y).
//
// Styles:
//   color, clay          direct shaded passes (Lambert / Standard + shadows)
//   lineart              normal+depth pass -> fullscreen composite draws ink lines on white paper
//   lines-tone           lit grayscale pass + normal/depth pass -> composite quantises to
//                        white / halftone / solid, plus ink lines
//   color-lines          colour pass + normal/depth pass -> ink lines multiplied on top
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleHeight } from './elevation.js';
import { EffectStack } from './effects.js';
import { facadeGlsl, facadeShapes, facadeSeed } from './facade.js';
import { canOpen, columnOf, gapFits, rowOf, windowBox } from './facadefit.js';
import { landmarksFor } from './landmarks.js';
import { makeSurfaces } from './surfaces.js';
import { viewDepthRange } from './camera-fit.js';
import { composeContext } from './context.js';
import { clipTriangle, clipSegment, drapeTriangle, groundGridHeight } from './surface-geometry.js';
import { courtKind, courtLayout, courtSurface, courtToLocal, pitchFrame } from './courts.js';
import { BARRIER_GROUPS, BARRIER_STYLES, barrierHeight, barrierRuns, fixtureFacing, roadIndex } from './barriers.js';
import { benchColor, benchParts, benchWear, roofColors, roofShapeFor, wallColors } from './scenestyle.js';
import { paletteFor } from './palette.js';
import { buildWallIndex, insideBuilding, nearestWall } from './walls.js';
import { hydrantChance, hydrantColour, hydrantParts, hydrantSpacing } from './hydrants.js';
import { canBeTaxi, roofLight, taxiChance, taxiColour } from './taxis.js';
import { cafeChance, cafeSpacing, chairColour, chairParts, hasParasol, parasolColour, parasolParts, tableParts, terraceLayout } from './cafe.js';
import { isClosed, shutterChance, shutterColour, shutterParts, shutterRows, shutterRun, shutterSpacing } from './shutters.js';
import { hasTrim, outwardStrips, trimBands, trimTone } from './walltrim.js';
import { litterColour, litterCount, litterKind, litterScatter, litterShape } from './litter.js';
import { hasUmbrella, umbrellaColour, umbrellaParts } from './umbrellas.js';
import { plateCentre, plateChance, plateColour, plateInk, plateParts, plateSpacing } from './streetnames.js';
import { BIN_COLOURS, bagColour, bagPile, binColour, binParts, rubbishChance, rubbishKind, rubbishSpacing } from './rubbish.js';
import { adChance, adKind, adSpacing, posterColour, posterParts } from './posters.js';
import { BIRD_COLOURS, birdChance, birdKind, birdParts, birdSpacing, flockSize } from './birds.js';
import { scooterChance, scooterColour, scooterGroup, scooterParts, scooterSpacing, scooterStyle } from './scooters.js';
import { postboxChance, postboxColour, postboxParts, postboxSpacing, postboxStyleFor } from './postboxes.js';
import { NOREN_COLOURS, lanternChance, lanternColour, lanternCount, lanternParts, lanternSpacing, norenParts } from './lanterns.js';
import { acChance, acParts, acSpacing, acTone, gapCentre, unitHeights } from './acunits.js';
import { BALCONY_COLOURS, balconyChance, balconyParts, balconySpacing, balconyStyleFor, columnCentre, laundryItems, slabHeights } from './balconies.js';
import { LEAF_COLOURS, POT_COLOURS, flowerColour, planterChance, planterCount, planterKind, planterParts, planterSpacing, planterWidth } from './planters.js';
import { LAMP_GLASS, LAMP_POLE, lampChance, lampHeight, lampParts, lampSpacing, lampStyleFor } from './lamps.js';
import { CRACK_SPACING, PATCH_SPACING, crackPoints, patchChance, patchPolygon, patchShade, patchSize, puddleChance, puddlePolygon, puddleSize, wetDarkening } from './roadpatches.js';
import { COVER_SPACING, coverChance, coverShapes, coverTone, manholeOffset } from './roadcovers.js';
import { MIRROR_POLE, POLE_COLOUR as SIGN_POLE, hasCurveMirror, roadSignChance, roadSignKind, roadSignSpacing, roadSignStyle, signShapes } from './roadsigns.js';
import { WHEEL_RADIUS, bicycleParts, bikeChance, bikeColour, bikeGroup, bikeSpacing, bikeStyle } from './bicycle.js';
import { itemSize, parapetStrips, placeOnRoof, roofAxis, rooftopPlan, tankColour } from './rooftop.js';
import { awningColour, awningParts, awningSpacing, awningWidth, shopChance, signColour, signParts, signSpacing } from './shopfront.js';
import { DRINK_COLOURS, VENDING_WIDTH, vendingChance, vendingColour, vendingGroupSize, vendingParts, vendingSpacing } from './vending.js';
import { INSULATOR_COLOUR, POLE_HEIGHT, POLE_LOOK, TRANSFORMER_COLOUR, WIRE_COLOUR, catenary, hasTransformer, poleStyleFor, spanSag, wireSlots, wireSpans } from './wires.js';

const DEG = Math.PI / 180;
// One number per millimetre position, for Map keys on hot per-vertex paths (no string allocation).
const gridKey = (x, y) => (Math.round(x * 1000) + 1e7) * 2e7 + Math.round(y * 1000) + 1e7;
const UP = [0, 1, 0];
const UP_VEC = new THREE.Vector3(0, 1, 0);
const GROUP_NAMES = ['buildings', 'roads', 'ground', 'water', 'green', 'trees', 'details', 'people', 'surroundings'];

// Layers: 0 = always visible, 1 = trunks shown only in the colour/tone pass ('tone-noline'),
// 2 = trees shown only in the edge pass ('lines'), 3 = tone crowns ('tone' / 'tone-noline').
// Tone crowns are in the colour/lit pass; they are in the edge pass only for lines-tone or treeStyle 'tone'.
const LAYER_TONE_CROWN = 3;
const LAYER_BASE_MASK = (1 << 0) | (1 << 1) | (1 << LAYER_TONE_CROWN);
const LAYER_EDGE_MASK = (1 << 0) | (1 << 2);
const LAYER_TREE_MASK = 1 << LAYER_TONE_CROWN;
// Layer 5: night lamp glow sprites (colour pass only; hidden from the ND and lit passes)
const LAYER_GLOW = 5;
const LAYER_GLOW_BIT = 1 << LAYER_GLOW;
const LAYER_ALL_NO_GLOW = ~LAYER_GLOW_BIT;
// Night world effect colours (linear, mixed in by the night strength)
const NIGHT_SKY_COL = new THREE.Color(0x0b1230);
const NIGHT_GROUND_COL = new THREE.Color(0x05060a);
const NIGHT_FOG_COL = new THREE.Color(0x1b2440);
const MOON_COL = new THREE.Color(0x9db8ff);
const WARM_WINDOW_COL = new THREE.Color('#ffd27a');
// Particle box (metres) that follows the camera; positions are wrapped in the vertex shaders
const BOX_M = [120, 60, 120];

// ---------------------------------------------------------------------------
// Palette (anime-ish flat colours; stored as hex and converted to linear by three)
// ---------------------------------------------------------------------------
const PAPER = '#ffffff';

// Fake view-space normal offsets for the edge pass, per flat surface (see _addMesh).
const FLAT_TILTS = {
  sidewalks: new THREE.Vector3(1.2, 0, 0),
  footways: new THREE.Vector3(1.2, 0, 0),
  areas: new THREE.Vector3(1.2, 0, 0),
  asphalt: new THREE.Vector3(-1.2, 0, 0),
  railways: new THREE.Vector3(-1.2, 0, 0),
  markings: new THREE.Vector3(0, 0, -1.2),
  green: new THREE.Vector3(0, 0, -1.2),
  water: new THREE.Vector3(0, -1.2, 0),
  tactile: new THREE.Vector3(0, 0, 1.2),
};

const PAL = {
  ground: '#e6dfd0',
  sidewalk: '#f2ede3',
  road: '#8c8e95',
  roadMinor: '#9a9ca3',
  lane: '#fbfbf6',
  water: '#7fbbe6',
  green: '#a8d08a',
  area: '#ebe2cc',
  parking: '#cfccc2',
  rail: '#6d6d70',
  guard: '#7d8189',
  tactile: '#e8b923',
  courtLine: '#fbfbf6',
  hoopPole: '#5c6168',
  backboard: '#e8eef3',
  rim: '#e8703a',
  goal: '#f4f4f0',
  netPost: '#5a5f66',
  netTape: '#f4f4f0',
  benchFrame: '#4a4f55',
  bin: '#4c6a58',
  binLid: '#3b4a41',
  stopPole: '#6a7077',
  stopSign: '#2d6cb5',
  shelterRoof: '#8b9299',
  shelterGlass: '#cfe0ea',
  pole: '#5a4a3c',
  signal: '#3d3d3d',
  trunk: '#7b5a3e',
  surr: '#ddd6c7',
  person: '#c58f6a',
  car: ['#e9e9ee', '#c94a3b', '#3d5a80', '#f0c040', '#2f2f36', '#8fa3b0'],
};

// Sky colours per palette: [dusk, day] for the zenith and the horizon, and the colour of the glow around the sun.
const SKY_PALETTES = {
  clear: { top: ['#4b5a9a', '#4aa3ea'], hor: ['#f7a874', '#dff2fb'], glow: '#fff3c8' },
  pastel: { top: ['#6a6fb0', '#8cc9f2'], hor: ['#f9b9a0', '#ffeef0'], glow: '#fff0d8' },
  deep: { top: ['#3a4b94', '#2a72d6'], hor: ['#f29a68', '#bfe0fb'], glow: '#fff6d0' },
  teal: { top: ['#44609a', '#28b4d8'], hor: ['#f5b184', '#e6fbf4'], glow: '#fffbd8' },
  warm: { top: ['#5a5a9a', '#6fa8e0'], hor: ['#f59a5a', '#ffe2b8'], glow: '#ffd89a' },
  overcast: { top: ['#6a708c', '#9eabbe'], hor: ['#c8a898', '#e4e8ee'], glow: '#f4f4f0' },
};
const mix = (a, b, t) => a + (b - a) * t;
// Ambient colours for tinted shadows: [sky (surfaces facing up and sideways), ground bounce]
const SHADOW_TINTS = {
  blue: { sky: '#8fb2f2', ground: '#a6a8b8' },
  violet: { sky: '#b09af0', ground: '#b09eb8' },
  teal: { sky: '#8fd6c8', ground: '#a0b8a8' },
  warm: { sky: '#f0c49a', ground: '#c8a888' },
};

// Crown colours per season (instance colours are picked from these with jitter)
const SEASON_CROWN = {
  spring: ['#f7b6cc', '#b9dd7c', '#e7a0bd', '#cfe68f', '#f2c6d6', '#a8d56e', '#fbe5ea', '#d8ec9c'],
  summer: ['#4f9d35', '#66b23f', '#3f8a32', '#78bf48', '#5aa83a', '#2f7a3a', '#8fc34e', '#3e9a4f'],
  autumn: ['#e2822c', '#c4481f', '#e0a23a', '#b23a22', '#d9a02a', '#a8321e', '#cf6a24', '#8a3a1d'],
  winter: null,
};
// A few trees in every season stand out (flowering, yellowing, dark), picked at random.
const ACCENT_CROWN = {
  spring: ['#ffffff', '#f4eef0', '#f08fb0', '#e8d96a'],
  summer: ['#9bc53d', '#2c6e46', '#b5cf4a', '#1f5f3a'],
  autumn: ['#f0c23a', '#7a2a1a', '#e9e2a0', '#5b7a2a'],
};
// Vertical gradient baked into crown vertex colours (multiplies the instance colour): shaded and cooler
// underneath, light and warmer on top.
const CROWN_TINT = {
  summer: { bottom: [0.5, 0.64, 0.58], top: [1, 1, 0.8] },
  spring: { bottom: [0.8, 0.76, 0.8], top: [1, 1, 0.9] },
  autumn: { bottom: [0.74, 0.44, 0.4], top: [1, 0.96, 0.6] },
};
const CONIFER_TINT = { bottom: [0.5, 0.64, 0.6], top: [0.98, 1, 0.9] };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Smooth value noise in 3D, 0..1. */
function valueNoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const sm = (t) => t * t * (3 - 2 * t);
  const fx = sm(x - xi), fy = sm(y - yi), fz = sm(z - zi);
  const l = (a, b, t) => a + (b - a) * t;
  const h = (a, b, c) => hash3(xi + a, yi + b, zi + c);
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), fx), l(h(0, 1, 0), h(1, 1, 0), fx), fy),
    l(l(h(0, 0, 1), h(1, 0, 1), fx), l(h(0, 1, 1), h(1, 1, 1), fx), fy),
    fz,
  );
}

/**
 * Writes a vertical gradient (bottom -> top over the geometry's height) and soft patchy variation into the
 * vertex colours of a non-indexed geometry, so a crown is not one flat colour. Multiplies the instance colour.
 */
function tintGeometry(geo, tint, noiseAmp = 0.14) {
  const pos = geo.attributes.position;
  const c = geo.attributes.color;
  if (!c || !tint) return geo;
  geo.computeBoundingBox();
  const y0 = geo.boundingBox.min.y, y1 = geo.boundingBox.max.y;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const t = clamp((y - y0) / Math.max(1e-6, y1 - y0), 0, 1);
    const f = t * t * (3 - 2 * t);
    const m = 1 - noiseAmp + 2 * noiseAmp * valueNoise3(x * 2.3, y * 2.3, z * 2.3);
    for (let ch = 0; ch < 3; ch++) {
      c.array[i * 3 + ch] = clamp((tint.bottom[ch] + (tint.top[ch] - tint.bottom[ch]) * f) * m, 0, 1);
    }
  }
  c.needsUpdate = true;
  return geo;
}

/** Linear mix of two #rrggbb colours (t = 0 gives a, t = 1 gives b). */
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t);
  return '#' + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, '0')).join('');
}

/** Deterministic PRNG (mulberry32). Returns a function giving numbers in [0, 1). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_WINDOW = { half: 0.8, y0: 0.8, y1: 2.5 }; // the classic window, for walls whose building is unknown

/** Facade seed of a building: what the shader and the SVG export key its windows by. */
function facadeSeedOf(b) {
  return facadeSeed(hashStr(`fac:${b.id ?? b.outer.length}`));
}

/** FNV-1a string hash -> uint32. */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Hex colour -> linear [r, g, b] (three.js colour management). */
function colArr(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s * 0.5;
}

function ringCentroid(ring) {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

/** Centroid of the outer ring (falls back to the first point). */
function polyCentroid(outer) {
  if (!outer || outer.length === 0) return [0, 0];
  return ringCentroid(outer);
}

/** Principal axes of a ring: returns { c, e1, e2 } with e1 the major axis. */
function principalAxes(ring) {
  const c = ringCentroid(ring);
  let cxx = 0;
  let cyy = 0;
  let cxy = 0;
  for (const p of ring) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    cxx += dx * dx;
    cyy += dy * dy;
    cxy += dx * dy;
  }
  const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  const e1 = [Math.cos(ang), Math.sin(ang)];
  const e2 = [-e1[1], e1[0]];
  return { c, e1, e2 };
}

/** Triangulate a polygon with holes. Returns { pts: [x,y][], faces: [i,j,k][] } (flat index array). */
function triangulate(outer, holes) {
  const contour = outer.map((p) => new THREE.Vector2(p[0], p[1]));
  const hs = (holes || [])
    .filter((h) => h && h.length > 2)
    .map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
  // ShapeUtils mutates arrays (removes duplicate closing points) so triangulate before reading them
  const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  const pts = contour.concat(...hs);
  return { pts, tris };
}

/** Resample a polyline so no segment is longer than maxSeg (keeps original vertices). */
function resamplePolyline(points, maxSeg) {
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const k = Math.max(1, Math.ceil(len / maxSeg));
    for (let j = 0; j < k; j++) {
      const t = j / k;
      out.push([a[0] + dx * t, a[1] + dy * t]);
    }
  }
  if (points.length) out.push(points[points.length - 1]);
  return out;
}

/** Total length of a polyline. */
function polyLength(points) {
  let L = 0;
  for (let i = 0; i < points.length - 1; i++) {
    L += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  }
  return L;
}

// ---------------------------------------------------------------------------
// Batch: accumulates flat-shaded, non-indexed triangles (position / normal / color).
// Winding is fixed so that the geometric normal agrees with the hint direction.
// ---------------------------------------------------------------------------
class Batch {
  constructor() {
    this.p = [];
    this.n = [];
    this.c = [];
  }

  /** Add triangle a,b,c (3-vectors). hint: direction the face should point to. col: [r,g,b]. */
  tri(a, b, c, hint, col) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return; // degenerate
    let B = b;
    let C = c;
    if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
      B = c;
      C = b;
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    nx /= len;
    ny /= len;
    nz /= len;
    this.p.push(a[0], a[1], a[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    for (let k = 0; k < 3; k++) this.n.push(nx, ny, nz);
    for (let k = 0; k < 3; k++) this.c.push(col[0], col[1], col[2]);
  }

  /** Quad a,b,c,d (in order around the face). */
  quad(a, b, c, d, hint, col) {
    this.tri(a, b, c, hint, col);
    this.tri(a, c, d, hint, col);
  }

  get empty() {
    return this.p.length === 0;
  }

  toGeometry() {
    if (this.empty) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Normalise a geometry to position / normal / color, non-indexed (for mergeGeometries). */
function toBatchable(geo, col) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.position.count;
  const cols = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    cols[i * 3] = col[0];
    cols[i * 3 + 1] = col[1];
    cols[i * 3 + 2] = col[2];
  }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

// Window grid on building walls (world space, metres), shared by the edge pass and the Lambert
// colour / lit materials so all of them agree: floors every 3.2 m, columns every 3 m. What a cell holds comes
// from facade.js: the window rectangles of the building's style, or on the ground floor a door, an arched
// passage or a wide shop window. Only inner building walls carry the aWin / aFac attributes (see _buildBuildings);
// fac = (building seed, ground level).
const WINDOW_GLSL = `
  uniform vec2 uFacade;     // x: share of buildings with a non-classic window style, y: amount of doors / passages / shop windows
  ${facadeGlsl()}
  // position in the cell of the wall point: across the column and up the floor, metres
  vec2 fcCellUV(vec3 p, vec3 n) {
    float u = abs(n.x) > 0.5 ? p.z : p.x;
    return vec2(u - floor(u / 3.0) * 3.0, p.y - floor(p.y / 3.2) * 3.2);
  }
  // Window rectangles of the cell a wall point is in. Returns 0 for a cell without windows (door, passage, blank
  // column), 1 for the style's windows (a, b), 2 for a shop window (a).
  float fcCell(vec3 p, vec3 n, vec2 fac, out vec4 a, out vec4 b) {
    a = vec4(0.0);
    b = vec4(0.0);
    if (abs(n.y) > 0.5) return 0.0;
    float u = abs(n.x) > 0.5 ? p.z : p.x;
    float c = floor(u / 3.0);
    float f = floor(p.y / 3.2);
    float seed = floor(fac.x + 0.5); // fac is interpolated, so a seed can come out a hair off an integer
    float f0 = ceil((fac.y - 1.0) / 3.2);
    float g = f == f0 ? fcGround(seed, c) : 0.0;
    if (g > 0.5 && g < 2.5) return 0.0;
    if (g > 2.5) {
      a = vec4(0.2, 2.8, fac.y + 0.45 - f * 3.2, fac.y + 2.6 - f * 3.2);
      return 2.0;
    }
    if (f > f0 && fcBlank(seed, c) > 0.5) return 0.0;
    float st = fcStyle(seed);
    a = fcRect(st, 0.0);
    b = fcRect(st, 1.0);
    return 1.0;
  }
  bool fcIn(vec4 r, vec2 q) {
    return r.y > r.x && q.x >= r.x && q.x <= r.y && q.y >= r.z && q.y <= r.w;
  }
  // The window rectangle (uLo, uHi, yLo, yHi) the wall point is inside, or vec4(0.0) when it is on bare wall
  vec4 fcWindowAt(vec3 p, vec3 n, vec2 fac) {
    vec4 a;
    vec4 b;
    if (fcCell(p, n, fac, a, b) < 0.5) return vec4(0.0);
    vec2 q = fcCellUV(p, n);
    if (fcIn(a, q)) return a;
    if (fcIn(b, q)) return b;
    return vec4(0.0);
  }
  // 1 inside a window on a wall (|n.y| < 0.5), 0 elsewhere
  float windowMask(vec3 p, vec3 n, vec2 fac) {
    vec4 r = fcWindowAt(p, n, fac);
    return r.y > r.x ? 1.0 : 0.0;
  }
  // Ground-floor door or passage opening: x = kind (1 door, 2 passage, 0 none), y / z = position across / up it, 0..1
  vec3 fcOpeningAt(vec3 p, vec3 n, vec2 fac) {
    if (abs(n.y) > 0.5) return vec3(0.0);
    float rel = p.y - fac.y;
    if (rel < 0.0 || rel > 3.0) return vec3(0.0);
    float u = abs(n.x) > 0.5 ? p.z : p.x;
    float c = floor(u / 3.0);
    float fu = u - c * 3.0;
    float g = fcGround(floor(fac.x + 0.5), c);
    if (g < 0.5 || g > 2.5) return vec3(0.0);
    if (g < 1.5) {
      if (fu < 1.05 || fu > 1.95 || rel > 2.2) return vec3(0.0);
      return vec3(1.0, (fu - 1.05) / 0.9, rel / 2.2);
    }
    if (fu < 0.6 || fu > 2.4 || rel > 2.9) return vec3(0.0);
    float ax = (fu - 1.5) / 0.9;
    float ay = (rel - 2.0) / 0.9;
    if (rel > 2.0 && ax * ax + ay * ay > 1.0) return vec3(0.0);
    return vec3(2.0, (fu - 0.6) / 1.8, rel / 2.9);
  }
  // Visibility by projected width in CSS px: focalPx * 1.6 m / depth. distant = 1 keeps windows down to ~4 px
  // (smaller ones turn into moire and broken dashes under the line pass), distant = 0 fades them out below ~6 px.
  float windowFade(float focalPx, float depth, float distant) {
    float px = focalPx * 1.6 / max(depth, 0.5);
    return mix(smoothstep(5.0, 7.0, px), smoothstep(3.6, 5.4, px), distant);
  }
`;

// Normal + depth output for the edge pass: rgb = view-space normal * 0.5 + 0.5, a = linear depth / far.
// Building walls (aWin = 1) get window rectangles: inside a window the normal is tilted across the wall,
// so the crease detector inks the window outline.
const ND_VERT = `
  uniform float uFar;
  uniform vec3 uTilt;
  attribute float aWin;
  attribute vec2 aFac;
  varying vec3 vN;
  varying float vDepth;
  varying vec3 vWPos;
  varying vec3 vWNrm;
  varying float vWin;
  varying vec2 vFac;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    mat3 nm = normalMatrix;
    #ifdef USE_INSTANCING
      mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
      nm = normalMatrix * mat3(instanceMatrix);
    #endif
    vN = normalize(nm * normal) + uTilt;
    vDepth = -mv.z;
    vWPos = wp.xyz;
    vWNrm = normalize(mat3(modelMatrix) * normal);
    vWin = aWin;
    vFac = aFac;
    gl_Position = projectionMatrix * mv;
  }
`;
const ND_FRAG = `
  uniform float uFar;
  uniform float uFocalPx;   // focal length in CSS px (target px / render scale)
  uniform float uWinDist;   // 1 = keep distant windows, 0 = fade them out below ~6 px
  varying vec3 vN;
  varying float vDepth;
  varying vec3 vWPos;
  varying vec3 vWNrm;
  varying float vWin;
  varying vec2 vFac;
  ${WINDOW_GLSL}
  void main() {
    vec3 nv = normalize(vN);
    float opened = max(windowMask(vWPos, vWNrm, vFac), step(0.5, fcOpeningAt(vWPos, vWNrm, vFac).x));
    float win = vWin * opened * windowFade(uFocalPx, vDepth, uWinDist);
    vec3 t = cross(nv, vec3(0.0, 1.0, 0.0));
    float tl = length(t);
    if (win > 0.5 && tl > 1e-3) {
      // window glass / frame: a strong tilt across the wall, so the crease detector inks the outline
      nv = normalize(nv + (t / tl) * 1.8);
    }
    gl_FragColor = vec4(nv * 0.5 + 0.5, vDepth / uFar);
  }
`;

// Fullscreen composite: edge detection on normal/depth and tone / ink combination.
const COMPOSITE_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;
const COMPOSITE_FRAG = `
  uniform sampler2D tColor;
  uniform sampler2D tND;
  uniform sampler2D tAlb;   // linear albedo (vertex colour), only sampled when uBase > 0
  uniform sampler2D tTree;  // tone crowns: r = 1 on crown, g = normal.y, b = underside noise, a = depth / far
  uniform int uMode;        // 0 lineart, 1 lines-tone, 2 color-lines, 3 passthrough (sRGB)
  uniform vec2 uTexel;      // 1 / render target size
  uniform vec2 uRes;        // render target size in px
  uniform float uInner;     // crease line radius in target px
  uniform float uOuter;     // silhouette line radius in target px
  uniform float uCell;      // tone cell size in target px (9 px dots / gradient, 15 px others, * size * export scale)
  uniform float uTransparent;
  uniform int uPat;         // tone pattern index (TONE_PATTERNS in render.js)
  uniform float uSeed;
  uniform float uOpacity;   // multiplies tone ink
  uniform float uGray;      // 1 = flat grey tone instead of the pattern
  uniform float uBlack;     // solid-black luminance cut (blackRange * 0.55)
  uniform float uWhite;     // 1 = ink lines drawn white inside solid black
  uniform float uShadow;    // strength of lighting-derived tone
  uniform float uBase;      // base-colour tone strength (0 = albedo term off)
  uniform float uShade;     // AO strength
  uniform float uTree;      // 1 = tone crowns on (lines-tone with treeStyle tone / tone-noline)
  uniform float uTreeOutline; // 1 = thick silhouette around the crowns (treeStyle tone)
  uniform float uFar;       // camera far plane in metres (depth = a * uFar)
  uniform float uFocal;     // focal length in target px
  uniform float uAoR;       // AO radius in metres
  uniform mat3 uCamRot;     // camera -> world rotation (sky rays)
  uniform vec2 uCamTan;     // tan(fov / 2) * aspect, tan(fov / 2)
  uniform vec4 uCloud;      // cover 0..1, scale, softness 0..1, shade 0..1
  uniform vec3 uCloudSun;   // direction to the sun in world space
  uniform vec3 uCloudLit;   // sunlit cloud colour (sRGB)
  uniform vec3 uCloudDark;  // shaded cloud colour (sRGB)
  uniform vec3 uCloudOpt;   // style (0 puffy, 1 wispy, 2 layered), seed offset x / y
  uniform vec3 uSkyTop;     // sky colour overhead (sRGB), colour styles only
  uniform vec3 uSkyHor;     // sky colour at the horizon (sRGB)
  uniform vec3 uSkyGlow;    // sun glow colour (sRGB)
  uniform vec4 uSkyOpt;     // gradient curve, glow exponent, glow amount, on (0 = keep the background texture)
  uniform vec2 uSkyTone;    // lines + tone: sky screentone strength and how far down from the zenith it reaches
  uniform vec2 uInk;        // ink tint toward the local colour (colour + lines), ink fade with distance
  uniform vec2 uThin;       // x: how far line radii shrink with distance (0..1), y: smallest radius in target px
  uniform float uHaze;      // lines + tone: how much the tone thins out with distance (the Haze slider, 0..1.5)
  varying vec2 vUv;

  const vec2 DIRS[8] = vec2[8](
    vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0),
    vec2(0.7071, 0.7071), vec2(-0.7071, 0.7071), vec2(0.7071, -0.7071), vec2(-0.7071, -0.7071)
  );
  const vec3 LUMA3 = vec3(0.2126, 0.7152, 0.0722);
  const float PI = 3.14159265;
  const float TAU = 6.28318531;
  const vec2 N1 = vec2(0.70710678, -0.70710678);  // normal of lines running (1, 1)
  const vec2 N2 = vec2(0.70710678, 0.70710678);   // normal of lines running (1, -1)
  const vec2 N3 = vec2(1.0, 0.0);                 // vertical lines
  const vec2 N0 = vec2(0.0, 1.0);                 // horizontal lines
  // Lit-luminance tone coverage: sky / ambient-only shade (L 0.45..0.62) gets the light value,
  // deep shade and cast shadows (L below 0.45) the deeper one.
  const float TONE_LIGHT = 0.28;
  const float TONE_DEEP = 0.32;

  vec2 gUV;  // screen uv of the current fragment (set in main, used by the neighbourhood patterns)

  vec3 toSRGB(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }

  // Silhouette / depth discontinuity, relative (scale invariant), 0..1.
  // Inverse depth is linear in screen space across a flat surface, so each opposite neighbour pair is
  // tested for deviation from that line. A plain depth difference reads ground at a grazing angle
  // (steep depth gradient near the horizon) as one solid silhouette.
  // With nearSide > 0 the line is kept only on the nearer surface of a silhouette: a line one pixel wide that
  // sits on the thing it outlines instead of a three pixel band spread over both sides. Far lattice towers
  // keep their open gaps that way.
  float depthEdge(vec2 uv, float r, float nearSide) {
    float i0 = 1.0 / max(texture2D(tND, uv).a, 1e-4);
    float e = 0.0;
    float nearest = i0;
    for (int k = 0; k < 8; k += 2) {
      // DIRS pairs: (0,1) (2,3) (4,7) (5,6) are opposite directions.
      int a = k < 4 ? k : (k == 4 ? 4 : 5);
      int b = k < 4 ? k + 1 : (k == 4 ? 7 : 6);
      float ia = 1.0 / max(texture2D(tND, uv + DIRS[a] * uTexel * r).a, 1e-4);
      float ib = 1.0 / max(texture2D(tND, uv + DIRS[b] * uTexel * r).a, 1e-4);
      float rel = abs(ia + ib - 2.0 * i0) / max(max(ia, ib), i0);
      e = max(e, smoothstep(0.03, 0.07, rel));
      nearest = max(nearest, max(ia, ib));
    }
    // inverse depth: a bigger value is nearer, so a pixel with a nearer neighbour is on the far side of the edge
    float farSide = smoothstep(0.02, 0.06, (nearest - i0) / nearest);
    return e * (1.0 - farSide * nearSide);
  }

  // Crease / normal discontinuity, 0..1
  float creaseEdge(vec2 uv, float r) {
    vec3 n0 = normalize(texture2D(tND, uv).rgb * 2.0 - 1.0);
    float e = 0.0;
    for (int k = 0; k < 8; k++) {
      vec3 n1 = normalize(texture2D(tND, uv + DIRS[k] * uTexel * r).rgb * 2.0 - 1.0);
      e = max(e, smoothstep(0.22, 0.38, 1.0 - dot(n0, n1)));
    }
    return e;
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
  }

  // 1 inside a radius r (px), anti-aliased over about 1.4 px
  float inside(float d, float r) {
    return 1.0 - smoothstep(r - 0.7, r + 0.7, d);
  }

  // Parallel lines spaced 'period' px along coordinate d (px), half-width hw (px)
  float lineAt(float d, float period, float hw) {
    if (hw < 0.05) return 0.0;
    return inside(abs(fract(d / period) - 0.5) * period, hw);
  }

  // Per-seed offset in cell units, [0, 1)^2
  vec2 seedOff() {
    return hash22(vec2(uSeed, uSeed * 0.618 + 1.7));
  }

  // Luminance of the lit grey pass (1 = paper)
  float litLum(vec3 lit) {
    return toSRGB(vec3(1.25 * dot(lit, LUMA3))).x;
  }

  // 1 where the lit pass is in shade (toned), 0 where sunlit or sky
  float tonedAt(vec2 uv) {
    return step(litLum(texture2D(tColor, uv).rgb), 0.62);
  }

  // Spokes around the screen centre; fill = share of each angular slot that is ink (width grows with radius)
  float spokesFill(vec2 p, float N, float fill, float wob) {
    vec2 d = p - uRes * 0.5;
    float r = length(d) + 1e-3;
    float a = atan(d.y + 1e-5, d.x) * N / TAU + uSeed * 0.37 + wob * sin(r / (uCell * 1.5));
    float spacing = TAU * r / N;
    float dist = abs(fract(a) - 0.5) * spacing;
    return inside(dist, 0.5 * spacing * fill);
  }

  // Spokes of constant pixel half-width hw around the screen centre
  float spokesPx(vec2 p, float N, float hw, float wob) {
    vec2 d = p - uRes * 0.5;
    float r = length(d) + 1e-3;
    float a = atan(d.y + 1e-5, d.x) * N / TAU + uSeed * 0.37 + wob * sin(r / (uCell * 1.5));
    float spacing = TAU * r / N;
    float dist = abs(fract(a) - 0.5) * spacing;
    return inside(dist, hw);
  }

  // Classic 45 degree halftone (rotated square screen), ink = dot
  float pDots(vec2 p, float C, vec2 so) {
    mat2 rot = mat2(0.7071, -0.7071, 0.7071, 0.7071);
    vec2 q = rot * p / uCell + so;
    float dist = length(fract(q) - 0.5) * uCell;
    return inside(dist, uCell * sqrt(C / PI));
  }

  // Thin black radial lines converging on the centre; clear disc of 25% of the short side
  float pFocus(vec2 p, float C) {
    float R0 = min(uRes.x, uRes.y) * 0.5;
    float clr = smoothstep(0.46 * R0, 0.54 * R0, length(p - uRes * 0.5));
    return spokesPx(p, 90.0, 0.5 * uCell * (0.15 + 0.5 * C), 0.0) * clr;
  }

  // Fewer, thicker tapered black rays from the centre (each ray widens with radius)
  float pFlash(vec2 p, float C) {
    float r = length(p - uRes * 0.5) / (0.6 * min(uRes.x, uRes.y));
    float taper = clamp(1.0 - r, 0.0, 1.0);
    return spokesFill(p, 48.0, clamp((0.15 + 0.5 * C) * taper, 0.0, 0.55), 0.0);
  }

  // Solid black with thin white rays converging on the centre
  float pBlackflash(vec2 p) {
    return 1.0 - spokesPx(p, 40.0, 0.5 * uCell * 0.45, 0.0);
  }

  // Dense short spikes in a ring around the centre (urchin flash)
  float pUrchin(vec2 p, float C) {
    float R0 = min(uRes.x, uRes.y) * 0.5;
    vec2 d = p - uRes * 0.5;
    float r = length(d) + 1e-3;
    float N = 72.0;
    float a = atan(d.y + 1e-5, d.x) * N / TAU + uSeed * 0.37;
    float id = floor(a);
    float h1 = hash12(vec2(id, uSeed + 2.0));
    float h2 = hash12(vec2(id, uSeed + 5.0));
    float h3 = hash12(vec2(id, uSeed + 8.0));
    float rs = R0 * (0.16 + 0.12 * h1);
    float re = rs + R0 * (0.10 + 0.14 * h2);
    float spacing = TAU * r / N;
    float dist = abs(fract(a) - 0.5) * spacing;
    float ring = smoothstep(rs - 0.7, rs + 0.7, r) * (1.0 - smoothstep(re - 0.7, re + 0.7, r));
    float dense = step(0.15, h3);
    return inside(dist, 0.5 * spacing * (0.3 + 0.4 * C)) * ring * dense;
  }

  // Horizontal speed streaks: two per row at most, each with its own start, length and thickness
  float pSpeed(vec2 p, float C) {
    float c = uCell;
    float row = floor(p.y / c);
    float xn = p.x / uRes.x;
    float dist = abs(fract(p.y / c) - 0.5) * c;
    float ink = 0.0;
    for (int k = 0; k < 2; k++) {
      float fk = float(k) * 11.0;
      float h1 = hash12(vec2(row, uSeed + 1.0 + fk));
      float h2 = hash12(vec2(row, uSeed + 4.0 + fk));
      float h3 = hash12(vec2(row, uSeed + 6.0 + fk));
      float on = step(hash12(vec2(row, uSeed + 7.0 + fk)), 0.25 + 0.6 * C);
      float x0 = h2 * 0.8;
      float len = 0.1 + 0.4 * h1;
      float seg = step(x0, xn) * step(xn, x0 + len);
      ink = max(ink, seg * on * inside(dist, 0.5 * c * (0.25 + 0.6 * h3)));
    }
    return ink;
  }

  // Thin concentric arcs around a point below the screen (large circles), broken into sectors
  float pCurved(vec2 p, float C, vec2 so) {
    vec2 cc = vec2(uRes.x * 0.5, -uRes.y * 0.8);
    vec2 d = p - cc;
    float per = uCell * 3.2;
    float ring = lineAt(length(d) + so.x * per, per, 0.5 * uCell * (0.22 + 0.6 * C));
    float sec = floor((atan(d.y, d.x) / TAU + 0.5) * 7.0);
    return ring * step(0.35, hash12(vec2(sec, uSeed + 2.0)));
  }

  // Sparse sweeping slanted strokes, each a short arc of random length and bend
  float pWind(vec2 p, float C) {
    float cs = uCell * 4.0;
    vec2 id = floor(p / cs);
    vec2 t0 = normalize(vec2(1.0, 0.45));
    float ink = 0.0;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        vec2 cell = id + vec2(float(i), float(j));
        vec2 h = hash22(cell + uSeed * 0.61);
        float on = step(hash12(cell + uSeed * 0.43 + 1.7), 0.4 + 0.8 * C);
        vec2 cen = (cell + 0.25 + 0.5 * h) * cs;
        float ang = (h.x - 0.5) * 0.5;
        vec2 t = vec2(cos(ang) * t0.x - sin(ang) * t0.y, sin(ang) * t0.x + cos(ang) * t0.y);
        vec2 nrm = vec2(-t.y, t.x);
        vec2 dl = p - cen;
        float u = dot(dl, t);
        float v = dot(dl, nrm);
        float hl = cs * (0.2 + 0.3 * h.y);
        float k = (hash12(cell + uSeed * 2.3) - 0.5) * 1.2 / cs;
        float stroke = inside(abs(v - k * u * u), 0.5 * uCell * (0.3 + 0.2 * h.y)) * step(abs(u), hl);
        ink = max(ink, on * stroke);
      }
    }
    return ink;
  }

  // Vertical streaks hanging from the top edge, sparse, random length per column
  float pDrop(vec2 p, float C) {
    float c3 = uCell * 2.6;
    float col = floor(p.x / c3);
    float h1 = hash12(vec2(col, uSeed + 0.5));
    float h2 = hash12(vec2(col, uSeed + 9.5));
    float h3 = hash12(vec2(col, uSeed + 13.5));
    float on = step(h1, 0.2 + 0.7 * C);
    float len = uRes.y * (0.15 + 0.6 * h2);
    float fromTop = uRes.y - p.y;
    float dist = abs(p.x - (col + 0.5) * c3);
    return on * step(fromTop, len) * inside(dist, 0.5 * uCell * (0.25 + 0.2 * h3));
  }

  // Short thin dashes at about -70 degrees on a jittered grid (3x3 neighbourhood so dashes are not clipped)
  float pRain(vec2 p, float C) {
    vec2 dir = normalize(vec2(0.36, -0.93));
    vec2 perp = vec2(-dir.y, dir.x);
    vec2 id = floor(p / uCell);
    float ink = 0.0;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        vec2 cell = id + vec2(float(i), float(j));
        vec2 h = hash22(cell + uSeed * 0.53);
        float on = step(hash12(cell + uSeed * 0.91 + 4.4), clamp(C * 1.1, 0.0, 1.0));
        vec2 cen = (cell + 0.15 + 0.7 * h) * uCell;
        vec2 dl = p - cen;
        float halfLen = uCell * (0.45 + 0.4 * h.y);
        float dash = inside(abs(dot(dl, perp)), 0.5 * uCell * 0.22) * inside(abs(dot(dl, dir)), halfLen);
        ink = max(ink, on * dash);
      }
    }
    return ink;
  }

  // Patchy hatch blocks (3 cells square). Blocks differ in intensity and a gentle angle jitter, but the
  // lines are laid out in absolute screen space, so neighbouring blocks read as one continuous hatching
  // field instead of a mosaic of tiles.
  // on = block visibility threshold, f1 / f2 = fill of the two hatch sets.
  float hatchBlocks(vec2 p, float thr, float f1, float f2, vec2 so) {
    float B = uCell * 3.0;
    vec2 bid = floor(p / B);
    float h1 = hash12(bid + uSeed * 0.77);
    float h2 = hash12(bid + uSeed * 1.31 + 2.2);
    // smooth value noise over the block grid: patches are organic blobs with soft borders, not square tiles
    vec2 q = p / (B * 1.5);
    vec2 qi = floor(q);
    vec2 qf = fract(q);
    qf = qf * qf * (3.0 - 2.0 * qf);
    float n00 = hash12(qi + uSeed * 0.19 + 5.5);
    float n10 = hash12(qi + vec2(1.0, 0.0) + uSeed * 0.19 + 5.5);
    float n01 = hash12(qi + vec2(0.0, 1.0) + uSeed * 0.19 + 5.5);
    float n11 = hash12(qi + vec2(1.0, 1.0) + uSeed * 0.19 + 5.5);
    float h3 = clamp(0.5 + (mix(mix(n00, n10, qf.x), mix(n01, n11, qf.x), qf.y) - 0.5) * 1.7, 0.0, 1.0);
    float on = smoothstep(h3 - 0.3, h3 + 0.2, thr);   // graded: patches vary in intensity, edges fade instead of dropping to bare paper
    float a1 = 0.8 + (h1 - 0.5) * 0.7;
    float a2 = a1 + 1.1 + 0.5 * h2;
    vec2 d = p;
    vec2 n1 = vec2(-sin(a1), cos(a1));
    vec2 n2 = vec2(-sin(a2), cos(a2));
    float per = uCell * 0.9;
    float l1 = lineAt(dot(d, n1) + so.x * per, per, 0.5 * per * f1);
    float l2 = lineAt(dot(d, n2) + so.y * per, per, 0.5 * per * f2);
    return on * max(l1, l2);
  }

  // Cross-hatching: mid grey patches
  float pCrosshatch(vec2 p, float C, vec2 so) {
    return hatchBlocks(p, 0.3 + 0.9 * C, 0.3 * smoothstep(0.02, 0.2, C), 0.3 * smoothstep(0.15, 0.35, C), so);
  }

  // Hatch blocks whose density fades with coverage
  float pHatchgrad(vec2 p, float C, vec2 so) {
    return hatchBlocks(p, 0.4 + 0.8 * C, 0.45 * clamp(C * 1.8, 0.0, 1.0), 0.35 * smoothstep(0.3, 0.6, C), so);
  }

  // Solid black core; a hatch fringe where the blurred coverage falls off at the boundary
  float pBlackedge(vec2 p, float C, vec2 so) {
    float R = uCell * 1.5;
    float acc = tonedAt(gUV);
    for (int k = 0; k < 8; k++) {
      acc += tonedAt(gUV + DIRS[k] * uTexel * R);
    }
    float Cb = acc / 9.0;
    float core = smoothstep(0.6, 0.8, Cb) * smoothstep(0.42, 0.6, C);
    float per = uCell * 0.9;
    float hatch = lineAt(dot(p, N1) + so.x * per, per, 0.5 * per * 0.6);
    float fringe = smoothstep(0.02, 0.25, Cb) * (1.0 - core);
    return max(core, hatch * fringe);
  }

  // Sinuous lines along direction th (radians); fill = share of each period that is ink
  float ropeLines(vec2 p, float fill, float th, float o, float amp) {
    vec2 t = vec2(cos(th), sin(th));
    vec2 n = vec2(-t.y, t.x);
    float wave = amp * uCell * sin(dot(p, t) / (uCell * 2.5) + uSeed * 1.3 + o * TAU);
    return lineAt(dot(p, n) + wave + o * uCell, uCell, 0.5 * uCell * fill);
  }

  // Two sinuous sets 60 degrees apart, mid grey
  float pRope(vec2 p, float C, vec2 so) {
    float f = 0.22 + 0.5 * C;
    return max(ropeLines(p, f, 0.35, so.x, 0.35), ropeLines(p, f, 0.35 + 1.0472, so.y, 0.35));
  }

  // Rope with density fading by coverage
  float pRopegrad(vec2 p, float C, vec2 so) {
    float f1 = 0.5 * clamp(C * 1.8, 0.0, 1.0);
    float f2 = 0.5 * smoothstep(0.25, 0.6, C);
    return max(ropeLines(p, f1, 0.35, so.x, 0.35), ropeLines(p, f2, 0.35 + 1.0472, so.y, 0.35));
  }

  // Wavy spokes oriented radially from the screen centre
  float pRadialrope(vec2 p, float C) {
    return max(spokesFill(p, 150.0, 0.10 + 0.22 * C, 0.18), spokesFill(p, 110.0, 0.06 + 0.18 * C, -0.24));
  }

  // Horizontal parallel lines, thickness by coverage
  float pLinetone(vec2 p, float C, vec2 so) {
    return lineAt(p.y + so.x * uCell, uCell, 0.5 * uCell * clamp(0.1 + 0.9 * C, 0.0, 1.0));
  }

  // Dot screen whose dot size grows toward the bottom of the screen
  float pGradient(vec2 p, float C, vec2 so) {
    float g = 1.0 - p.y / uRes.y;
    float Cg = clamp(C * (0.5 + 1.2 * g), 0.0, 0.85);
    vec2 q = p / uCell + so;
    float dist = length(fract(q) - 0.5) * uCell;
    return inside(dist, uCell * sqrt(Cg / PI));
  }

  // Checkerboard of solid squares, cell = pattern size
  float pChecker(vec2 p) {
    vec2 id = floor(p / uCell);
    return mod(id.x + id.y, 2.0) < 0.5 ? 1.0 : 0.0;
  }

  // Random per-pixel grain, about 50% ink at full coverage
  float pSand(vec2 p, float C) {
    vec2 cell = floor(p / (uCell * 0.3));
    return step(hash12(cell + uSeed * 2.1), 0.5 * C);
  }

  // Motif masks, q = offset from the motif centre (px), r = radius (px), variant in [0, 1)
  float motif(vec2 q, float r, float ang, int kind, float variant) {
    float ca = cos(ang);
    float sa = sin(ang);
    q = mat2(ca, -sa, sa, ca) * q;
    if (kind == 0) {                       // four-point star (astroid-like)
      vec2 a = pow(abs(q) / r + 1e-4, vec2(0.6));
      float k = pow(a.x + a.y, 1.0 / 0.6);
      return 1.0 - smoothstep(0.92, 1.08, k);
    }
    if (kind == 1) {                       // five-petal flower, some with a white centre
      float rq = length(q);
      float aq = atan(q.y + 1e-5, q.x);
      float edge = r * (0.55 + 0.45 * cos(5.0 * aq));
      float f = 1.0 - smoothstep(-0.7, 0.7, rq - edge);
      float hole = 1.0 - smoothstep(-0.7, 0.7, rq - r * 0.22);
      return variant > 0.6 ? f * (1.0 - hole) : f;
    }
    if (kind == 2) {                       // heart (implicit curve, cleft at top)
      vec2 h = q / (r * 1.05);
      float s = h.x * h.x + h.y * h.y - 1.0;
      float f = s * s * s - h.x * h.x * h.y * h.y * h.y;
      return 1.0 - smoothstep(-0.06, 0.06, f);
    }
    if (kind == 3) {                       // almond / petal, pointed at both ends
      float t = q.y / r;
      float w = r * 0.42 * pow(max(0.0, 1.0 - t * t), 0.6);
      float side = 1.0 - smoothstep(-0.7, 0.7, abs(q.x) - w);
      return side * (1.0 - smoothstep(0.98, 1.02, abs(t)));
    }
    if (kind == 4) {                       // bubble (circle outline)
      float th = max(r * 0.14, 0.9);
      float d = abs(length(q) - r * 0.8) - th;
      return 1.0 - smoothstep(-0.7, 0.7, d);
    }
    if (kind == 5) {                       // snow blob, radius up to ~0.5 r
      return 1.0 - smoothstep(-0.7, 0.7, length(q) - r * 0.5);
    }
    return 1.0 - smoothstep(-0.7, 0.7, length(q) - r * 0.4);   // 6: stipple speck
  }

  // Sparse scattered motifs on a jittered grid (3x3 neighbourhood, constant bounds).
  // Each motif gets a random size (0.4x..1.6x), rotation and position; drawn only if its centre is toned.
  float scatter(vec2 p, int kind) {
    float G = kind == 6 ? uCell * 1.8 : uCell * 7.0;
    vec2 id = floor(p / G);
    float ink = 0.0;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        vec2 cell = id + vec2(float(i), float(j));
        vec2 h = hash22(cell + uSeed * 0.37);
        float on = step(hash12(cell + uSeed * 0.71 + 3.1), kind == 6 ? 0.5 : 0.6);
        vec2 cen = (cell + 0.2 + 0.6 * h) * G;
        float ang = hash12(cell + uSeed * 1.3 + 9.7) * TAU;
        float sf = 0.4 + 1.2 * hash12(cell + uSeed * 2.9 + 6.3);
        float rr = G * (kind == 6 ? 0.2 : 0.17) * sf;
        float variant = hash12(cell + uSeed * 1.7 + 12.1);
        float region = tonedAt(cen / uRes);
        ink = max(ink, on * region * motif(p - cen, rr, ang, kind, variant));
      }
    }
    return ink;
  }

  // Ink 0..1 (1 = dark) of tone pattern uPat at coverage C (0..0.9) and screen pixel p.
  // Index order must match TONE_PATTERNS in render.js.
  float patternInk(vec2 p, float C) {
    vec2 so = seedOff();
    if (uPat == 0) return pDots(p, C, so);
    if (uPat == 1) return pFocus(p, C);
    if (uPat == 2) return pFlash(p, C);
    if (uPat == 3) return pBlackflash(p);
    if (uPat == 4) return pUrchin(p, C);
    if (uPat == 5) return pSpeed(p, C);
    if (uPat == 6) return pCurved(p, C, so);
    if (uPat == 7) return pWind(p, C);
    if (uPat == 8) return pDrop(p, C);
    if (uPat == 9) return pRain(p, C);
    if (uPat == 10) return pCrosshatch(p, C, so);
    if (uPat == 11) return pHatchgrad(p, C, so);
    if (uPat == 12) return pBlackedge(p, C, so);
    if (uPat == 13) return pRope(p, C, so);
    if (uPat == 14) return pRopegrad(p, C, so);
    if (uPat == 15) return pRadialrope(p, C);
    if (uPat == 16) return pLinetone(p, C, so);
    if (uPat == 17) return pGradient(p, C, so);
    if (uPat == 18) return pChecker(p);
    if (uPat == 19) return scatter(p, 6);
    if (uPat == 20) return pSand(p, C);
    if (uPat == 21) return scatter(p, 0);
    if (uPat == 22) return scatter(p, 1);
    if (uPat == 23) return scatter(p, 2);
    if (uPat == 24) return scatter(p, 3);
    if (uPat == 25) return scatter(p, 4);
    return scatter(p, 5);
  }

  // Patterns that print solid black (no grey mix): blackflash, blackedge, checker, and all the
  // specks / motifs (stipple, sand, sparkles ... snow).
  bool isSolid() {
    return uPat == 3 || uPat == 12 || uPat == 18 || uPat >= 19;
  }

  // Tone value 0..1 (1 = paper) for coverage C. Coverage 0 (sunlit, sky) stays paper.
  float toneVal(float C, vec2 p) {
    float m = smoothstep(0.004, 0.03, C);
    if (m <= 0.0) return 1.0;
    if (uGray > 0.5) return 1.0 - 0.6 * C * uOpacity * m;
    float k = clamp(patternInk(p, C), 0.0, 1.0) * m;
    float fac = isSolid() ? 1.0 : 0.86;
    return 1.0 - fac * uOpacity * k;
  }

  // Ambient occlusion from the normal/depth target: 0 = open, 1 = deep nook.
  // Ring of 10 samples, projected radius uAoR metres at the centre depth d0 (metres).
  float aoOcc(vec2 uv, vec2 pix, float d0) {
    float Rpx = clamp(uAoR * uFocal / max(d0, 0.5), 2.0, uRes.y * 0.12);
    float jit = hash12(pix + uSeed);
    float occ = 0.0;
    for (int i = 0; i < 10; i++) {
      float fi = float(i);
      float ang = (fi + jit) * 2.39996323;
      float rr = sqrt((fi + 0.5) / 10.0) * Rpx;
      float ds = texture2D(tND, uv + vec2(cos(ang), sin(ang)) * rr * uTexel).a * uFar;
      float diff = d0 - ds;
      occ += smoothstep(0.1, 0.6 * uAoR, diff) * (1.0 - smoothstep(uAoR, 2.0 * uAoR, diff));
    }
    return occ / 10.0;
  }

  // The nearest surface at this pixel is a tone crown (tree target depth matches the normal/depth target;
  // tolerance covers half-float quantisation of the depth)
  bool isCrown(vec4 tn, float dq) {
    return tn.r > 0.5 && abs(tn.a - dq) < 0.0008 + 0.001 * dq;
  }

  // Thick silhouette of the tone crowns: 1 where a neighbour at distance r is not a crown
  float treeSil(vec2 uv, float r) {
    float e = 0.0;
    for (int k = 0; k < 8; k++) {
      vec2 q = uv + DIRS[k] * uTexel * r;
      vec4 tn = texture2D(tTree, q);
      float dq = texture2D(tND, q).a;
      bool crown = isCrown(tn, dq);
      e = max(e, crown ? 0.0 : 1.0);
    }
    return e;
  }


  // ---- clouds (sky pixels only) -------------------------------------------------------------
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash12(i);
    float b = hash12(i + vec2(1.0, 0.0));
    float c = hash12(i + vec2(0.0, 1.0));
    float d = hash12(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float fbmN(vec2 p, int oct) {
    float s = 0.0;
    float a = 0.5;
    float norm = 0.0;
    for (int i = 0; i < 5; i++) {
      if (i >= oct) break;
      s += a * vnoise(p);
      norm += a;
      p = p * 2.03 + vec2(17.1, 9.2);
      a *= 0.5;
    }
    return s / norm;
  }
  // density field in the sky plane; styles stretch the plane. oct: detail octaves (shape 4, lighting 3)
  float cloudField(vec2 p, int oct) {
    if (uCloudOpt.x > 1.5) p *= vec2(0.35, 1.7);      // layered: long flat banks
    else if (uCloudOpt.x > 0.5) p *= vec2(0.5, 1.9);  // wispy streaks
    float clump = vnoise(p * 0.45 + 3.1);
    // domain warp: pushes the shapes into billows instead of lacy fractal edges
    p += 0.45 * vec2(vnoise(p * 0.7 + 7.3), vnoise(p * 0.7 + 1.9)) - 0.225;
    return fbmN(p, oct) * 0.72 + clump * 0.28;
  }

  // Sky colour (sRGB) along a screen ray: horizon haze rising to the zenith colour, plus a glow around the sun
  vec3 skyGradient(vec2 uv) {
    vec3 d = normalize(uCamRot * vec3((uv * 2.0 - 1.0) * uCamTan, -1.0));
    float t = pow(clamp(d.y, 0.0, 1.0), uSkyOpt.x);
    vec3 col = mix(uSkyHor, uSkyTop, t);
    float sd = max(dot(d, normalize(uCloudSun)), 0.0);
    float glow = (pow(sd, uSkyOpt.y) + 0.25 * pow(sd, 5.0)) * uSkyOpt.z;
    return mix(col, uSkyGlow, clamp(glow, 0.0, 0.85));
  }

  // Sky-plane coordinate of a screen uv: xy = plane position, z = visibility (fades out at the horizon)
  vec3 skyPlane(vec2 uv) {
    vec3 d = normalize(uCamRot * vec3((uv * 2.0 - 1.0) * uCamTan, -1.0));
    float k = 1.0 / (d.y + 0.2);
    return vec3(d.xz * k * uCloud.y * 3.2 + uCloudOpt.yz, smoothstep(0.03, 0.22, d.y));
  }

  // x = cloud mask 0..1, y = outline 0..1 (ink styles), z = shade 0..1 (1 = in shadow), w = visible
  vec4 cloudSample(vec2 uv, float lineR) {
    if (uCloud.x <= 0.001) return vec4(0.0);
    vec3 sp = skyPlane(uv);
    float vis = sp.z;
    if (vis <= 0.0) return vec4(0.0);
    vec2 p = sp.xy;
    float n = cloudField(p, 3);
    float thr = mix(0.8, 0.32, clamp(uCloud.x, 0.0, 1.0));
    float aa = max(fwidth(n), 1e-4);
    float w = max(mix(0.004, 0.09, uCloud.z), aa);
    float m = smoothstep(thr - w, thr + w, n) * vis;
    // shade: the side facing away from the sun, and the underside (nothing of the cloud just below this pixel)
    vec2 sd = normalize(uCloudSun.xz + 1e-4);
    float n2 = cloudField(p * 0.93 + sd * 0.12, 2);
    float n1 = cloudField(p, 2);
    float shSun = smoothstep(0.0, 0.015 + 0.06 * uCloud.z, n2 - n1);
    float nb = cloudField(skyPlane(uv - vec2(0.0, 0.045)).xy, 3);
    float shBot = 1.0 - smoothstep(thr - 0.02, thr + 0.05 + 0.05 * uCloud.z, nb);
    float sh = max(shSun, shBot * 0.9) * smoothstep(thr - 0.02, thr + 0.07, n);
    float lineVis = smoothstep(0.35, 0.85, vis);
    float line = (1.0 - smoothstep(lineR * mix(0.55, 1.15, sh), lineR * mix(0.55, 1.15, sh) + 1.0, abs(n - thr) / aa)) * lineVis;
    return vec4(m, line, sh, vis);
  }

  void main() {
    gUV = vUv;
    float dN = texture2D(tND, vUv).a;
    // Far detail (lattice towers, distant windows) is thinner than a pixel, so a fixed line radius would
    // merge it into solid black. Shrink the radii with distance, down to about one pixel.
    float thin = uThin.x * smoothstep(12.0, 160.0, dN * uFar);
    float rOuter = mix(uOuter, min(uOuter, uThin.y), thin);
    float rInner = mix(uInner, min(uInner, uThin.y), thin);
    float ink = max(depthEdge(vUv, rOuter, thin), creaseEdge(vUv, rInner));
    vec2 pix = gl_FragCoord.xy;
    bool sky = dN >= 0.999;
    // far lines get lighter (atmospheric perspective): full strength within 40 m, down to (1 - fade) past 450 m
    ink *= 1.0 - uInk.y * 0.7 * smoothstep(40.0, 450.0, dN * uFar);

    float ao = 0.0;
    if (uMode >= 1 && uShade > 0.0 && !sky) ao = aoOcc(vUv, pix, dN * uFar);

    if (uMode == 3 || uMode == 2) {
      vec3 c = toSRGB(texture2D(tColor, vUv).rgb * (1.0 - clamp(uShade * ao * 0.55, 0.0, 0.85)));
      if (sky) {
        if (uSkyOpt.w > 0.5) c = skyGradient(vUv);
        vec4 cl = cloudSample(vUv, 0.0);
        c = mix(c, mix(uCloudLit, uCloudDark, cl.z * uCloud.w), cl.x);
      }
      // ink colour: near black, or a dark warm version of the colour it outlines (coloured line work)
      vec3 inkCol = mix(vec3(0.05, 0.045, 0.05), mix(c * c * 0.55, vec3(0.16, 0.09, 0.1), 0.3), uInk.x);
      gl_FragColor = vec4(uMode == 2 ? mix(c, inkCol, ink) : c, 1.0);
      return;
    }

    // Tone: paper everywhere except the toned (shade / cast shadow) regions. The sky is always paper.
    float tone = 1.0;
    bool blk = false;
    // Aerial perspective for the tone: from about 250 m the screentone thins out (smaller dots), so a far skyline
    // reads as a light silhouette instead of the darkest, busiest part of the page.
    float farT = min(uHaze, 1.0) * 0.9 * smoothstep(250.0, 1800.0, dN * uFar);
    if (uMode == 1 && !sky) {
      vec3 lit = texture2D(tColor, vUv).rgb;
      float L = litLum(lit);
      vec4 tt = texture2D(tTree, vUv);
      bool crown = uTree > 0.5 && isCrown(tt, dN);
      if (crown) {
        // Tone crown: upper foliage toned, underside solid black with a jagged border, no inner creases.
        // far crowns (dense forests): thinner silhouette and a toned, not solid black, underside
        float farK = smoothstep(60.0, 260.0, dN * uFar);
        ink = uTreeOutline > 0.5 ? treeSil(vUv, uOuter * 1.8 * mix(1.0, 0.4, farK)) * mix(1.0, 0.6, farK) : 0.0;
        float side = (tt.g * 2.0 - 1.0) + (tt.b - 0.5) * 0.9;
        if (side < 0.0) {
          tone = mix(0.0, toneVal(0.6, pix), farK * 0.85);
        } else {
          float shadeT = 1.0 - smoothstep(0.3, 0.9, L);
          tone = toneVal(0.3 + 0.45 * shadeT, pix);
        }
      } else {
        // One toneVal call for the cast-shadow black and the ordinary tone: every call inlines the whole pattern
        // table, and a third copy here made the shader fail to validate.
        bool keep = (uPat == 3 || uPat == 12);           // blackflash / blackedge keep their pattern
        bool black = uBlack > 0.0 && L < uBlack;         // solid cast-shadow black
        float C = 0.0;
        float cMax = 0.9;
        bool dots = true;
        if (black) {
          if (keep) { blk = true; C = 1.0; cMax = 1.0; }
          else if (farT > 0.0) C = mix(0.95, 0.3, farT);  // far: the black turns into dots that thin out with distance
          else { blk = true; tone = 0.14; dots = false; }
        } else if (L <= 0.62) {                          // toned region only: shadow, base tone and AO
          float lightBand = 1.0 - smoothstep(0.45, 0.62, L);
          float deepBand = 1.0 - smoothstep(0.30, 0.45, L);
          C = (TONE_LIGHT * lightBand + TONE_DEEP * deepBand) * uShadow;
          if (uBase > 0.0) {
            float al = toSRGB(vec3(dot(texture2D(tAlb, vUv).rgb, LUMA3))).x;
            C += uBase * 0.5 * clamp((0.45 - al) / 0.45, 0.0, 1.0);
          }
          C += uShade * ao * 0.25;
          C *= 1.0 - 0.85 * farT;
        }
        if (dots) tone = toneVal(clamp(C, 0.0, cMax), pix);
      }
    }

    if (sky) {
      // clouds in the ink styles: outline, plus tone on the shaded side (lines + tone)
      vec4 cl = cloudSample(vUv, uOuter * 0.4);
      if (uMode == 1) tone = min(tone, toneVal(0.34 * cl.z * cl.x * uCloud.w, pix));
      if (uMode == 1 && uSkyTone.x > 0.0) {
        // screentone fading from the zenith towards the horizon, kept off the clouds so they stay paper white
        vec3 sd3 = normalize(uCamRot * vec3((vUv * 2.0 - 1.0) * uCamTan, -1.0));
        float g = pow(smoothstep(0.03, 0.2 + uSkyTone.y * 0.8, clamp(sd3.y, 0.0, 1.0)), 1.4);
        tone = min(tone, toneVal(uSkyTone.x * g * (1.0 - cl.x), pix));
      }
      ink = max(ink, cl.y);
    }

    float v = (blk && uWhite > 0.5) ? mix(0.14, 1.0, ink) : min(tone, 1.0 - ink);
    if (uTransparent > 0.5) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0 - v);
    } else {
      gl_FragColor = vec4(vec3(v), 1.0);
    }
  }
`;

// Tone patterns; the index is the uPat uniform value (must match patternInk in COMPOSITE_FRAG).
const TONE_PATTERNS = [
  'dots', 'focus', 'flash', 'blackflash', 'urchin', 'speed', 'curved', 'wind', 'drop', 'rain',
  'crosshatch', 'hatchgrad', 'blackedge', 'rope', 'ropegrad', 'radialrope', 'linetone', 'gradient',
  'patterns', 'stipple', 'sand', 'sparkles', 'flowers', 'hearts', 'petals', 'bubbles', 'snow',
];
// setTone().blackRange is a 0..1 UI value; it is scaled so the default 0.4 keeps the old 0.22 luminance cut.
const BLACK_RANGE_SCALE = 0.55;
// Screen-space AO ring radius in metres (projected to pixels per sample).
const AO_RADIUS_M = 1.5;

// Unlit albedo (vertex colour) pass for the base-colour tone term.
const ALB_VERT = `
  varying vec3 vAlb;
  void main() {
    vAlb = vec3(1.0);
    #ifdef USE_COLOR
      vAlb = color;
    #endif
    #ifdef USE_INSTANCING_COLOR
      vAlb *= instanceColor;
    #endif
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    #ifdef USE_INSTANCING
      mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    #endif
    gl_Position = projectionMatrix * mv;
  }
`;
const ALB_FRAG = `
  varying vec3 vAlb;
  void main() {
    gl_FragColor = vec4(vAlb, 1.0);
  }
`;

// Tone crowns (lines-tone): world normal, underside noise and depth of the tree crowns.
// Output: r = 1 (crown), g = normal.y * 0.5 + 0.5, b = jagged value noise, a = depth / far.
const TREE_VERT = `
  varying vec3 vWN;
  varying vec3 vWP;
  varying float vDepth;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vec3 wn = normal;
    #ifdef USE_INSTANCING
      wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
      wn = mat3(instanceMatrix) * normal;
    #endif
    vWN = normalize((modelMatrix * vec4(wn, 0.0)).xyz);
    vWP = wp.xyz;
    vec4 mv = viewMatrix * wp;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const TREE_FRAG = `
  uniform float uFar;
  varying vec3 vWN;
  varying vec3 vWP;
  varying float vDepth;
  float h13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float a = mix(mix(h13(i), h13(i + vec3(1.0, 0.0, 0.0)), f.x), mix(h13(i + vec3(0.0, 1.0, 0.0)), h13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y);
    float b = mix(mix(h13(i + vec3(0.0, 0.0, 1.0)), h13(i + vec3(1.0, 0.0, 1.0)), f.x), mix(h13(i + vec3(0.0, 1.0, 1.0)), h13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y);
    return mix(a, b, f.z);
  }
  void main() {
    float n = 0.6 * vnoise(vWP * 1.6) + 0.4 * vnoise(vWP * 4.7 + 3.1);
    float ny = normalize(vWN).y;
    gl_FragColor = vec4(1.0, ny * 0.5 + 0.5, n, vDepth / uFar);
  }
`;

// ---------------------------------------------------------------------------
// World-effect particles (rain, snow, petals) and night lamp glow.
// Particles live in a box of BOX_M metres centred on the camera. Each particle has a fixed seed in
// [0, 1)^3 (the vertex position attribute, or gl_InstanceID for petals); the vertex shader moves it with
// uTime and wraps it into the box with mod(), so the CPU only sets uniforms. Particles are drawn over the
// finished composite and tested against the ND depth target (see CityRenderer._drawParticles).
// ---------------------------------------------------------------------------
const PART_UNI = `
  uniform float uTime;
  uniform vec3 uCam;
  uniform vec3 uBox;
  uniform float uFocal;     // focal length in target px
  uniform vec2 uRes;        // target size in px
  uniform sampler2D tDepth; // ND target: a = view depth / far, sky = 1
  uniform float uFar;
  uniform float uLine;      // 1 = line style (ink look)
  uniform float uOpacity;   // effect strength
`;
const WRAP_FN = `
  vec3 wrapBox(vec3 q) {
    vec3 o = uCam - 0.5 * uBox;
    return o + mod(q - o, uBox);
  }
`;
const DEPTH_FN = `
  // true where the particle is behind the scene surface at this pixel
  bool behindScene(float d) {
    float s = texture2D(tDepth, gl_FragCoord.xy / uRes).a * uFar;
    return d > s * 1.002 + 0.25;
  }
`;
// Rain: LineSegments, two vertices per drop (aEnd 0 = head, 1 = tail). Wind slants the fall.
const RAIN_VERT = `
  ${PART_UNI}
  uniform float uWind;
  attribute float aEnd;
  varying float vDepth;
  varying float vA;
  ${WRAP_FN}
  void main() {
    vec3 V = vec3(uWind * 4.0, -10.0, 0.0);
    vec3 w = wrapBox(position * uBox + V * uTime);
    w += aEnd * normalize(-V) * 1.1;
    vec4 mv = viewMatrix * vec4(w, 1.0);
    vDepth = -mv.z;
    vA = 1.0 - 0.8 * aEnd;
    gl_Position = projectionMatrix * mv;
  }
`;
const RAIN_FRAG = `
  ${PART_UNI}
  varying float vDepth;
  varying float vA;
  ${DEPTH_FN}
  void main() {
    if (behindScene(vDepth)) discard;
    vec3 col = uLine > 0.5 ? vec3(0.10, 0.10, 0.12) : vec3(0.78, 0.86, 0.95);
    float a = uLine > 0.5 ? 0.9 : 0.5;
    gl_FragColor = vec4(col, vA * a * uOpacity);
  }
`;
// Snow: Points, soft round flakes with a sine drift; line styles get a white flake with a dark rim.
const SNOW_VERT = `
  ${PART_UNI}
  uniform float uSnowSize;
  varying float vDepth;
  ${WRAP_FN}
  void main() {
    float sp = 0.9 + 0.8 * position.z;
    vec3 w = wrapBox(position * uBox - vec3(0.0, sp * uTime, 0.0));
    float ph = uTime * (0.5 + 0.6 * position.y) + position.x * 6.2831853;
    w.x += sin(ph) * 0.9;
    w.z += cos(ph * 0.7 + position.z * 6.2831853) * 0.9;
    vec4 mv = viewMatrix * vec4(w, 1.0);
    vDepth = -mv.z;
    float diam = 0.22 * uSnowSize * (0.6 + 0.8 * position.y);   // stylised manga flakes, ~22 cm
    gl_PointSize = clamp(diam * uFocal / max(vDepth, 0.5), 2.5, 64.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const SNOW_FRAG = `
  ${PART_UNI}
  varying float vDepth;
  ${DEPTH_FN}
  void main() {
    if (behindScene(vDepth)) discard;
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    vec3 white = vec3(0.97, 0.98, 1.0);
    if (uLine > 0.5) {
      float fill = 1.0 - smoothstep(0.66, 0.74, d);
      float rim = smoothstep(0.66, 0.74, d) * (1.0 - smoothstep(0.86, 0.94, d));
      float a = clamp(fill + rim, 0.0, 1.0);
      vec3 col = mix(vec3(0.12, 0.12, 0.14), white, fill);
      gl_FragColor = vec4(col, a * uOpacity);
    } else {
      float a = 1.0 - smoothstep(0.55, 1.0, d);
      gl_FragColor = vec4(white, a * 0.95 * uOpacity);
    }
  }
`;
// Petals: InstancedMesh of small cupped quads (instance seed from gl_InstanceID), tumbling and drifting.
const PETAL_VERT = `
  ${PART_UNI}
  varying vec2 vUv;
  varying float vDepth;
  ${WRAP_FN}
  mat3 rotX(float a) { float c = cos(a); float s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
  mat3 rotY(float a) { float c = cos(a); float s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
  void main() {
    float id = float(gl_InstanceID);
    vec3 s = fract(sin(vec3(id, id + 1.0, id + 2.0) * vec3(12.9898, 78.233, 37.719)) * 43758.5453);
    float sp = 0.6 + 0.5 * s.z;
    vec3 w = wrapBox(s * uBox - vec3(0.0, sp * uTime, 0.0));
    float ph = uTime * (0.6 + 0.5 * s.y) + s.x * 6.2831853;
    w.x += sin(ph) * 1.4;
    w.z += cos(ph * 0.8) * 1.2;
    mat3 R = rotY(uTime * (1.2 + 1.5 * s.y) + s.x * 6.2831853) * rotX(uTime * (2.0 + 2.5 * s.z) + s.y * 6.2831853);
    vec3 p = vec3(position.x * 0.38, position.y * 0.28, 0.0);   // stylised, readable petals
    p.z = 0.25 * position.x * position.x;   // cupped: the edges lift
    p = R * p;
    vec4 mv = viewMatrix * vec4(w + p, 1.0);
    vDepth = -mv.z;
    vUv = uv;
    gl_Position = projectionMatrix * mv;
  }
`;
const PETAL_FRAG = `
  ${PART_UNI}
  varying vec2 vUv;
  varying float vDepth;
  ${DEPTH_FN}
  void main() {
    if (behindScene(vDepth)) discard;
    vec2 q = vUv * 2.0 - 1.0;
    float r = length(q * vec2(1.0, 0.85));   // elliptical petal outline
    if (r > 1.0) discard;
    float rim = smoothstep(0.78, 0.96, r);
    vec3 fill = uLine > 0.5 ? vec3(0.96, 0.84, 0.88) : vec3(0.965, 0.718, 0.788);   // #f6b7c9
    vec3 ink = vec3(0.16, 0.13, 0.15);
    vec3 col = mix(fill, ink, uLine > 0.5 ? rim : rim * 0.3);
    gl_FragColor = vec4(col, 0.95 * uOpacity);
  }
`;
// Night lamp glow: additive soft points (colour pass only, depth tested against the buildings)
const GLOW_VERT = `
  uniform float uFocal;
  varying float vDepth;
  void main() {
    vec4 mv = viewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_PointSize = clamp(1.6 * uFocal / max(vDepth, 0.5), 4.0, 90.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const GLOW_FRAG = `
  uniform float uGlowOp;
  uniform vec3 uGlowCol;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float a = pow(1.0 - d, 2.0) * uGlowOp;
    gl_FragColor = vec4(uGlowCol, a);
  }
`;

// ---------------------------------------------------------------------------
// CityRenderer
// ---------------------------------------------------------------------------
export class CityRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 2000);
    this.camera.userData.yaw = 0;
    this.camera.userData.pitch = 0;

    this.cityGroup = new THREE.Group();
    this.cityGroup.name = 'city';
    this.scene.add(this.cityGroup);
    this.groups = {};
    for (const name of GROUP_NAMES) {
      const g = new THREE.Group();
      g.name = name;
      this.cityGroup.add(g);
      this.groups[name] = g;
    }

    // State
    this.style = 'color';
    this.lineWidth = 1;
    this.outlineWidth = 1;
    this.light = { azimuth: 150, elevation: 45 };
    this.options = {
      shadows: true,
      distantWindows: true,
      terrain: true,
      trees: true,
      details: true,
      lowPoly: false,
      detailDistance: 1,
      season: 'summer',
      treeStyle: 'tone',
      leafEdge: 'smooth',
      treeType: 'mixed',
      treeSize: 'normal',
      // World settings (what is in the scene); see web/js/world.js for the panel and the ranges.
      peopleDensity: 0, // 0..100
      hydrantDensity: 30, hydrantColour: 'auto', hydrantSize: 1, // fire hydrants
      taxiShare: 40, taxiColour: 'auto', // taxis among the cars: slider (scaled by the place) and colour
      cafeDensity: 20, cafeColour: 'auto', cafeParasol: 40, cafeSize: 1, // cafe terraces
      shutterDensity: 30, shutterColour: 'auto', shutterClosed: 15, // window shutters
      trimShare: 40, trimTone: 'light', trimDepth: 0.07, // wall trim: share of buildings, tone, depth
      litterDensity: 0, litterColour: 'auto', litterSize: 1, // fallen leaves under trees
      umbrellaShare: 0, umbrellaColour: 'mixed', umbrellaSize: 1, // % of people holding an umbrella, its colour and size
      walkShare: 75, standShare: 15, talkShare: 10, // relative weights of walkers / people standing / talking groups
      groupSize: 4, // most people in one talking group (2..6)
      kidsShare: 6, // % of people who are children
      crossing: 50, // % of junctions with people on the crossing
      gesture: 70, // % of talkers who gesture
      carDensity: 0, // 0..100
      carParked: 40, // % of cars parked at the curb
      carQueue: 3, // most cars waiting at a red light
      carTypes: 'sedan,compact,kei,suv,van,pickup,bus',
      carPalette: 'realistic', // realistic | mono | colorful
      trafficSide: 'auto', // auto | left | right
      worldSeed: 0, // shuffles people and cars without moving the camera
      treeDensity: 100, // % of the map's trees; above 100 adds street trees
      treeMix: 'auto', // 'auto' picks the species from the climate, or 'round:60,conifer:25,...'
      treeSizeMin: 0.95, treeSizeMax: 1.05,
      landmarks: true, // replace famous landmarks with hand-built models (see landmarks.js)
      detailPoles: true, detailSignals: true, detailRails: true, detailCrosswalks: true, detailTactile: true,
      edgeLines: 'both', roadSignDensity: 35, roadSignStyle: 'auto', mirrorDensity: 60, plateDensity: 25, plateColour: 'auto', plateSize: 1, rubbishDensity: 25, rubbishKind: 'auto', binColour: 'mixed', rubbishSize: 1, adDensity: 15, adStyle: 'auto', adSize: 1, posterColour: 'mixed', birdDensity: 25, birdKind: 'auto', birdSize: 1, scooterDensity: 20, scooterColour: 'mixed', scooterStyle: 'mixed', scooterSize: 1, postboxDensity: 20, postboxStyle: 'auto', postboxSize: 1, lanternDensity: 30, lanternColour: 'mixed', lanternSize: 1, norenDensity: 30, acDensity: 30, acTone: 'mixed', acSize: 1, balconyDensity: 35, balconyStyle: 'auto', balconyWidth: 2, laundryAmount: 50, wetStreets: 0, puddleSize: 1, planterDensity: 30, planterStyle: 'mixed', planterColour: 'mixed', planterSize: 1, skyScreentone: 0, skyScreentoneReach: 50, surroundWindows: true, lampDensity: 40, lampStyle: 'auto', lampHeight: 7, patchDensity: 40, crackDensity: 40, patchSize: 1, coverDensity: 50, coverTone: 'mixed', coverSize: 1, carTrim: true, bikeDensity: 30, bikeColour: 'mixed', bikeStyle: 'mixed', roofClutter: 60, roofParapet: 0.45, roofTank: 'auto', awningDensity: 35, awningColour: 'mixed', awningDepth: 1.2, signDensity: 30, vendingDensity: 30, vendingColour: 'mixed', poleSpacing: 30, poleStyle: 'auto', poleTransformers: 20, wireCount: 3, wireSag: 0.5, wireThickness: 0.035, // utility poles and wires, see wires.js
      roofStyle: 'auto', // auto (as mapped) | flat | gabled | hipped | pyramidal
      roofColor: 'auto', // auto (by place) | zinc | slate | terracotta | copper | charcoal
      wallTone: 'auto', // auto (by place) | stone | white | brick | grey
      furnBenches: true, furnBins: true, furnStops: true,
      benchStyle: 'park', benchColor: 'wood', binStyle: 'square', benchWear: 0, // see scenestyle.js
      barrierFences: true, barrierWalls: true, barrierHedges: true, barrierScale: 1,
      // Sky (see the Sky section of the World settings); drawn in the composite pass, so they never rebuild the scene
      cloudCover: 40, cloudScale: 1, cloudSoft: 30, cloudShade: 60, cloudStyle: 'puffy', cloudDark: 'grey',
      skyPalette: 'clear', skyHaze: 50, skyGlow: 40, shadowTint: 'blue', shadowTintAmt: 0,
      windowVariety: 60, facadeStyles: 60, facadeOpenings: 50, windowCurtains: 30, windowReflection: 60, windowFrames: 50, wallWeathering: 40, paveJoints: 60, paveSlab: 0.6, roadWear: 35, // window look and ground surface, a uniform (no rebuild)
      foliageSat: 100, foliageHue: 0, foliageLight: 100, // global grading of crown colours (needs a rebuild)
      straightVerticals: false,
      twoSidedShadows: false,
    };
    // Tone (lines-tone / sky) and air (AO, haze, sky) settings; applied per frame.
    this.tone = {
      shadow: 1,
      base: 1,
      pattern: 'dots',
      size: 0.4,
      seed: 1,
      opacity: 1,
      grayFill: false,
      blackRange: 0.4,
      whiteLines: false,
    };
    this.air = { shade: 0, haze: 1, sky: false, inkTint: 0, inkFade: 0, lineThin: 0.8 };
    this.lensMM = 35;
    this._cssW = canvas.clientWidth || 800;
    this._cssH = canvas.clientHeight || 600;

    // Data
    this._city = null;
    this._elev = null;
    this._surfaces = null;
    this._surr = null;
    this._meshes = []; // { mesh, role }
    this._pickables = [];
    this._segs = []; // flat world-space segment list (x,y,z, x,y,z, ...)
    this._sunDist = 600;
    this._shadowHalf = 300;
    this._winDistU = { value: 1 }; // distantWindows flag for the Lambert window grid (0 / 1)
    this._focalU = { value: 1 }; // focal length in target px, set per frame
    this._mats = null; // created lazily in _createPassResources
    this._targets = null; // cached on-screen targets { w, h, color, nd, alb }
    this._skyTex = null;
    this._ray = new THREE.Raycaster();
    this._disposables = []; // extra geometries/materials/textures to dispose on dispose()

    // World effects (night, particles) and the post-effect stack. See setEffects().
    this._time = performance.now() / 1000; // seconds, advanced by render() (particles, grain)
    this._fx = new EffectStack(this.renderer);
    this._world = { night: null, rain: null, snow: null, petals: null };
    this._nightS = 0; // night strength 0..1 (0 = off)
    this._nightLamps = false;
    this._nightU = {
      uNightI: { value: 0 },
      uNightShare: { value: 0 },
      uNightCol: { value: new THREE.Vector3(WARM_WINDOW_COL.r, WARM_WINDOW_COL.g, WARM_WINDOW_COL.b) },
    };
    this._fogCol = new THREE.Color();
    this._skyNightTex = null;
    this._lampPts = []; // [x, y, lift] of utility-pole tops and signal heads (local metres)
    this._lampObjs = []; // bulbs + glow, rebuilt by _syncLamps()
    this._lampMat = null;
    this._glowMat = null;
    this._fxScene = new THREE.Scene(); // particle objects only; drawn over the composite
    this._parts = {}; // kind -> { obj, mat, max }
    this._partObjs = []; // visible particle objects this frame
    this._pu = {
      uTime: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(BOX_M[0], BOX_M[1], BOX_M[2]) },
      uFocal: { value: 1 },
      uRes: { value: new THREE.Vector2(1, 1) },
      tDepth: { value: null },
      uFar: { value: 1200 },
      uLine: { value: 0 },
    };

    this._createLights();
    this._createPassResources();
    this.setLens(this.lensMM);
    this._updateDepthRange();
    this.resize(this._cssW, this._cssH);
    this._applyStyleBackground();
  }

  // ----- lights & sky -------------------------------------------------------

  _createLights() {
    this.hemi = new THREE.HemisphereLight(0xdfeeff, 0xb8ab90, 1.2);
    this.sun = new THREE.DirectionalLight(0xfff3dc, 2.4);
    this._sunI0 = this.sun.intensity; // day values, scaled by the night strength
    this._sunC0 = this.sun.color.clone();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.5;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this._applyLightColors();
    this.setLight(this.light);
  }

  /**
   * Hemisphere (ambient) colour. Colour / clay: sky on = cool skylight (blue-tinted shadows),
   * sky off = neutral grey ambient. Line styles keep a fixed baseline, so their tones do not depend on sky.
   */
  _applyLightColors() {
    if (!this.hemi) return;
    let sky;
    let ground;
    if (this.style === 'color' || this.style === 'clay' || this.style === 'color-lines') {
      if (this.air.sky) {
        sky = 0xc3dcf5;
        ground = 0xb9ae98;
        // coloured shadows: the ambient light (which is all that reaches shaded surfaces) leans toward the tint
        const tint = SHADOW_TINTS[this.options.shadowTint];
        const amt = clamp((this.options.shadowTintAmt ?? 0) / 100, 0, 1);
        if (tint && amt > 0) {
          sky = new THREE.Color(mixHex('#c3dcf5', tint.sky, amt)).getHex();
          ground = new THREE.Color(mixHex('#b9ae98', tint.ground, amt)).getHex();
        }
      } else {
        sky = 0xe6e6e6;
        ground = 0xa19f9b;
      }
    } else {
      sky = 0xdfeeff;
      ground = 0xb8ab90;
    }
    // night: the ambient moves towards dark navy
    const s = this._nightS || 0;
    this.hemi.color.set(sky).lerp(NIGHT_SKY_COL, s);
    this.hemi.groundColor.set(ground).lerp(NIGHT_GROUND_COL, s);
  }

  /** Sun direction: azimuth in compass degrees (0 = north, clockwise), elevation above horizon. */
  setLight({ azimuth = this.light.azimuth, elevation = this.light.elevation } = {}) {
    this.light = { azimuth, elevation };
    const az = azimuth * DEG;
    const el = clamp(elevation, 5, 89) * DEG;
    // direction towards the sun in world space (X east, Z = -north)
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    this.sunDir = dir;
    this.sun.position.copy(dir).multiplyScalar(this._sunDist);
    this.sun.target.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();
    this._fitShadowCamera();
    // The sky follows the sun: refresh it only when its blend step changed (colour styles, daytime).
    if (this.scene && this._skyTex && !(this._nightS > 0) && this._skyKey !== this._skyBlend()) this._applyStyleBackground();
  }

  /** Shadow frustum covers the whole area (side = 2 * _shadowHalf). */
  _fitShadowCamera() {
    const sc = this.sun.shadow.camera;
    const s = this._shadowHalf;
    sc.left = -s;
    sc.right = s;
    sc.top = s;
    sc.bottom = -s;
    sc.near = 1;
    sc.far = this._sunDist * 2.5;
    sc.updateProjectionMatrix();
  }

  /** 0 = dusk, 1 = day, from the sun elevation (quantised so the texture is rebuilt only when it visibly changes). */
  _skyBlend() {
    const e = this.light ? this.light.elevation : 45;
    const x = clamp((e - 10) / 22, 0, 1);
    return Math.round(x * x * (3 - 2 * x) * 10) / 10;
  }

  /** Vertical gradient sky texture (color style). */
  _makeSkyTexture(top, bottom) {
    const cv = document.createElement('canvas');
    cv.width = 4;
    cv.height = 256;
    const ctx = cv.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  _applyStyleBackground() {
    // Both colour styles get the gradient sky (colour + lines used to fall through to white paper).
    if (this.style === 'color' || this.style === 'color-lines') {
      if (this._nightS > 0) {
        if (!this._skyNightTex) this._skyNightTex = this._makeSkyTexture('#060a1c', '#1b2440');
        this.scene.background = this._skyNightTex;
      } else {
        const t = this._skyBlend();
        if (!this._skyTex || this._skyKey !== t) {
          if (this._skyTex) this._skyTex.dispose();
          this._skyTex = this._makeSkyTexture(mixHex('#6b7fb8', '#8fcaf0', t), mixHex('#f7b585', '#fdf6ea', t));
          this._skyKey = t;
        }
        this.scene.background = this._skyTex;
      }
    } else if (this.style === 'clay') {
      this.scene.background = new THREE.Color('#ecebe8');
    } else {
      // white paper for the line styles
      this.scene.background = new THREE.Color(PAPER);
    }
    this._applyFog();
  }

  /** Distance fog for the colour styles only; haze scales the range (haze 0 = no fog). */
  _applyFog() {
    const colored = this.style === 'color' || this.style === 'clay';
    const haze = this.air.haze;
    if (!colored || !(haze > 0) || this._fogFar === undefined) {
      this.scene.fog = null;
      return;
    }
    const k = Math.max(haze, 0.05);
    // night: the haze turns navy
    const color = this._fogCol.set(this.style === 'clay' ? 0xecebe8 : 0xf3ecde).lerp(NIGHT_FOG_COL, this._nightS || 0);
    const near = this._fogNear / k;
    const far = this._fogFar / k;
    if (this.scene.fog) {
      this.scene.fog.color.set(color);
      this.scene.fog.near = near;
      this.scene.fog.far = far;
    } else {
      this.scene.fog = new THREE.Fog(color, near, far);
    }
  }

  // ----- camera -------------------------------------------------------------

  /** 35mm-equivalent focal length -> vertical fov (24 mm film height). */
  setLens(mm) {
    this.lensMM = mm;
    this.camera.fov = (2 * Math.atan(12 / mm)) / DEG;
    this.camera.updateProjectionMatrix();
    this._applyPose();
  }

  /**
   * Set the camera pose. position: THREE.Vector3 in three.js world space.
   * yaw: radians, 0 = looking north (-Z), positive = turning right (east).
   * pitch: radians, positive = looking up. Stored on camera.userData for controls.js.
   */
  applyCameraPose({ position, yaw, pitch, distance }) {
    if (position) this.camera.position.copy(position);
    if (yaw !== undefined) this.camera.userData.yaw = yaw;
    if (pitch !== undefined) this.camera.userData.pitch = pitch;
    // Depth planes follow the eye's real distance to the scene. The orbit distance is not that once
    // the target is panned off the scene, and a near plane sized from it would clip close geometry.
    this._viewDistance = this._sceneCenter ? this.camera.position.distanceTo(this._sceneCenter)
      : Number.isFinite(distance) ? distance : 0;
    this._updateDepthRange();
  }

  _applyPose() {
    const cam = this.camera;
    const yaw = cam.userData.yaw || 0;
    const pitch = clamp(cam.userData.pitch || 0, -Math.PI / 2 + 1e-3, Math.PI / 2 - 0.02);
    cam.updateProjectionMatrix();
    if (this.options.straightVerticals) {
      // Camera stays level; aiming up/down is done with a lens shift so verticals stay parallel.
      cam.rotation.set(0, -yaw, 0, 'YXZ');
      const e = cam.projectionMatrix.elements;
      e[9] = e[5] * Math.tan(pitch);
    } else {
      cam.rotation.set(pitch, -yaw, 0, 'YXZ');
    }
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.updateMatrixWorld(true);
  }

  /** Keep the framed scene inside the far plane and ahead of the fog, including tall landmarks. */
  _updateDepthRange() {
    const { near, far, fogNear, fogFar } = viewDepthRange(this._viewDistance, this._sceneRadius, this.options.detailDistance ?? 1);
    this.camera.near = near;
    this.camera.far = far;
    this._fogFar = fogFar;
    this._fogNear = fogNear;
    this.camera.updateProjectionMatrix();
    this._applyFog();
    if (this._mats) this._mats.ndMat.uniforms.uFar.value = far;
    this._applyPose();
  }

  // ----- sizing ---------------------------------------------------------------

  resize(w, h) {
    this._cssW = Math.max(1, Math.floor(w));
    this._cssH = Math.max(1, Math.floor(h));
    this.renderer.setPixelRatio(this._pixelRatio());
    this.renderer.setSize(this._cssW, this._cssH, false);
    this.camera.aspect = this._cssW / this._cssH;
    this.camera.updateProjectionMatrix();
    this._applyPose();
  }

  /**
   * On-screen quality. light: draw at 1x device pixels (for slow computers); moving: the camera is being
   * dragged, so with light on drop to half resolution and keep the last shadow map instead of re-rendering
   * it every frame. Exported images (renderImage) are not affected.
   */
  setDisplayQuality({ light = this._lightDisplay, moving = this._moving } = {}) {
    const changed = light !== this._lightDisplay || moving !== this._moving;
    this._lightDisplay = !!light;
    this._moving = !!moving;
    this.renderer.shadowMap.autoUpdate = !(this._lightDisplay && this._moving);
    if (!this.renderer.shadowMap.autoUpdate) this.renderer.shadowMap.needsUpdate = false;
    else if (changed) this.renderer.shadowMap.needsUpdate = true;
    if (changed && this._cssW) {
      this.renderer.setPixelRatio(this._pixelRatio());
      this.renderer.setSize(this._cssW, this._cssH, false);
    }
  }

  _pixelRatio() {
    const full = Math.min(window.devicePixelRatio || 1, 2);
    if (!this._lightDisplay) return full;
    return this._moving ? 0.5 : 1;
  }

  // ----- ground helpers -------------------------------------------------------

  /** Terrain height at a local point (metres relative to the centre elevation). */
  groundHeight(x, y) {
    if (this._surfaces) return this._surfaces.groundAt(x, y);
    return this._terrainHeight(x, y);
  }

  _terrainHeight(x, y) {
    if (!this.options.terrain || !this._elev) return 0;
    const nearSize=this._city?.size || this._elev.size;
    const size=this._surr && Math.max(Math.abs(x),Math.abs(y))>nearSize/2 ? this._surr.farSize || this._elev.size : nearSize;
    const segments=Math.max(8,Math.min(128,this._elev.n-1));
    return groundGridHeight(x,y,size,segments,(px,py)=>this._cornerHeight(px,py));
  }

  /** Elevation at a ground-grid corner. Corners are shared by many queries, so memoise them. */
  _cornerHeight(px, py) {
    const key = gridKey(px, py);
    this._terrainSamples ??= new Map();
    let h = this._terrainSamples.get(key);
    if (h === undefined) this._terrainSamples.set(key, h = sampleHeight(this._elev, px, py));
    return h;
  }

  /**
   * Ground-mesh height (with water carved in) at a grid corner of a mesh whose cells are `step` metres,
   * memoised for the current build. Land cover drapes over the same corners, so it stays on the mesh.
   */
  _groundCorner(x, y, step) {
    const key = gridKey(x, y);
    const samples = this._groundSamples.get(step) ?? this._groundSamples.set(step, new Map()).get(step);
    let h = samples.get(key);
    if (h === undefined) samples.set(key, h = this._surfaces.meshGroundAt(x, y, step));
    return h;
  }

  /** Top walkable surface for pin placement; ordinary terrain remains below a bridge. */
  surfaceHeight(x, y) {
    return this._surfaces?.surfaceAt(x, y) ?? this.groundHeight(x, y);
  }

  /** Near-area bounds only: distant buildings must not shrink the initial view. */
  nearBounds() {
    const box = new THREE.Box3();
    for (const { mesh } of this._meshes) {
      if (mesh.userData.surroundings || !['ground', 'walls', 'roofs', 'asphalt', 'footways', 'mapped-objects'].includes(mesh.name)) continue;
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox);
    }
    return box.isEmpty() ? { min: [-150, 0, -150], max: [150, 10, 150] } : { min: box.min.toArray(), max: box.max.toArray() };
  }

  /** Local [x, y] under a normalised device coordinate, or null. */
  pickGround(ndcX, ndcY) {
    this._ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this._ray.intersectObjects(this._pickables, false)[0];
    if (!hit) return null;
    return [hit.point.x, -hit.point.z];
  }

  // ----- geometry helpers -----------------------------------------------------

  /** Add a mesh for a geometry to a sub-group and register it for styling / picking. */
  _addMesh(geometry, role, groupName, { pickable = false, name = role, cast = true, receive = true, layer = 0 } = {}) {
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, this._materialFor(role));
    mesh.name = name;
    mesh.castShadow = cast && this.options.shadows;
    mesh.receiveShadow = receive && this.options.shadows;
    mesh.layers.set(layer);
    this.groups[groupName].add(mesh);
    this._meshes.push({ mesh, role, cast, receive });
    if (pickable) this._pickables.push(mesh);
    // Flat, coplanar surfaces (road vs sidewalk vs markings…) have no depth/normal break, so in the
    // edge pass each one gets its own fake normal tilt; the crease detector then inks their borders.
    const tilt = FLAT_TILTS[name] || FLAT_TILTS[role];
    if (tilt) {
      mesh.onBeforeRender = (_r, _s, _c, _g, material) => {
        if (material.uniforms && material.uniforms.uTilt) { material.uniforms.uTilt.value.copy(tilt); material.uniformsNeedUpdate = true; }
      };
      mesh.onAfterRender = (_r, _s, _c, _g, material) => {
        if (material.uniforms && material.uniforms.uTilt) { material.uniforms.uTilt.value.set(0, 0, 0); material.uniformsNeedUpdate = true; }
      };
    }
    return mesh;
  }

  /** Flat-shaded ribbon along a polyline (ground-following). Optionally records its outline. */
  _ribbon(batch, path, w, yOff, col, outline = false, heightAt = null) {
    const n = path.length;
    if (n < 2) return;
    const segN = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = path[i + 1][0] - path[i][0];
      const dy = path[i + 1][1] - path[i][1];
      const len = Math.hypot(dx, dy) || 1;
      segN.push([-dy / len, dx / len]);
    }
    const L = [];
    const R = [];
    for (let i = 0; i < n; i++) {
      let nx;
      let ny;
      let s = 1;
      if (i === 0) {
        nx = segN[0][0];
        ny = segN[0][1];
      } else if (i === n - 1) {
        nx = segN[n - 2][0];
        ny = segN[n - 2][1];
      } else {
        // miter join, clamped so sharp corners do not spike
        const a = segN[i - 1];
        const b = segN[i];
        let mx = a[0] + b[0];
        let my = a[1] + b[1];
        const ml = Math.hypot(mx, my);
        if (ml < 1e-9) {
          nx = a[0];
          ny = a[1];
        } else {
          mx /= ml;
          my /= ml;
          nx = mx;
          ny = my;
          s = 1 / Math.max(mx * a[0] + my * a[1], 0.5);
        }
      }
      const hw = (w / 2) * s;
      const px = path[i][0];
      const py = path[i][1];
      L.push([px + nx * hw, py + ny * hw]);
      R.push([px - nx * hw, py - ny * hw]);
    }
    const V = (p) => [p[0], (heightAt ? heightAt(p[0], p[1]) : this.groundHeight(p[0], p[1])) + yOff, -p[1]];
    for (let i = 0; i < n - 1; i++) {
      batch.quad(V(L[i]), V(R[i]), V(R[i + 1]), V(L[i + 1]), UP, col);
      if (outline) {
        this._pushSeg(V(L[i]), V(L[i + 1]));
        this._pushSeg(V(R[i]), V(R[i + 1]));
      }
    }
    if (outline) {
      // end caps
      this._pushSeg(V(L[0]), V(R[0]));
      this._pushSeg(V(L[n - 1]), V(R[n - 1]));
    }
  }

  _pushSeg(a, b) {
    this._segs.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }

  /** Flat polygon (with holes) lying on the ground. */
  _flatPoly(batch, outer, holes, yOff, col, outline = false, heightAt = null, bounds = { half: this._landHalf, exclude: 0 }) {
    const { pts, tris } = triangulate(outer, holes);
    const H = heightAt || ((x, y) => this.groundHeight(x, y));
    const V = (p) => [p[0], H(p[0], p[1]) + yOff, -p[1]];
    for (const t of tris) {
      const triangle = t.map(i => [pts[i].x, pts[i].y]);
      for (const clipped of clipTriangle(triangle, bounds.half, bounds.exclude)) {
        if (heightAt || !this.options.terrain || !this._elev) {
          batch.tri(V(clipped[0]),V(clipped[1]),V(clipped[2]),UP,col);
          continue;
        }
        const seg=Math.max(8,Math.min(128,this._elev.n-1)), nearSize=this._city.size;
        const regions=[{size:nearSize,exclude:0}];
        if(this._surr)regions.push({size:this._surr.farSize || this._elev.size,exclude:nearSize/2});
        for(const region of regions)for(const part of clipTriangle(clipped,region.size/2,region.exclude)) {
          for(const piece of drapeTriangle(part,region.size,seg,(x,y)=>this._groundCorner(x,y,region.size/seg))) {
            const point=p=>[p[0],p[2]+yOff,-p[1]];
            batch.tri(point(piece[0]),point(piece[1]),point(piece[2]),UP,col);
          }
        }
      }
    }
    if (outline) {
      const rings = [outer, ...(holes || [])];
      for (const ring of rings) {
        if (!ring || ring.length < 2) continue;
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i];
          const q = ring[(i + 1) % ring.length];
          for (const [a,b] of clipSegment(p,q,bounds.half,bounds.exclude)) {
            this._pushSeg([a[0],H(...a)+yOff+0.01,-a[1]],[b[0],H(...b)+yOff+0.01,-b[1]]);
          }
        }
      }
    }
  }

  /** Merge a list of BufferGeometry (already batchable) into one, or null. */
  _mergeList(list) {
    if (!list.length) return null;
    return mergeGeometries(list, false);
  }

  // OSM supplies a location and sometimes a footprint/height, but no sculpted mesh.
  // Use restrained abstract proxies rather than inventing a specific statue or artwork.
  _buildMappedObjects(objects, replacements = []) {
    const lists = [[], []], buildingIDs = new Set([
      ...(this._city.buildings || []), ...(this._surr?.buildings || []),
    ].filter(b => b.height > 0).map(b => b.id));
    const selected = (objects || []).filter(p => {
      const [x,y] = p.position || [];
      return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= this._landHalf && Math.abs(y) <= this._landHalf
        && !buildingIDs.has(p.id) && !replacements.some(([cx,cy]) => Math.hypot(x-cx,y-cy) < 25);
    }).sort((a,b) => Math.hypot(...a.position)-Math.hypot(...b.position) || String(a.id).localeCompare(String(b.id))).slice(0,512);
    this.mappedObjectCount = selected.length;
    for (const p of selected) {
      const [x,y] = p.position, h = Math.max(0.1, Number(p.height) || 4);
      const list = lists[Math.max(Math.abs(x),Math.abs(y)) > this._city.size * 0.6 ? 1 : 0];
      const bronze = /bronze|copper/.test(p.material || '');
      const color = colArr(bronze ? '#6b796c' : '#a4a099');
      const base = this.groundHeight(x,y), plinth = Math.min(1, h * 0.2), width = Math.min(5,Math.max(0.7,h*0.24));
      const add = (geo, height, col = color) => {
        geo.translate(x,base+height,-y);
        const batchable = toBatchable(geo,col);
        if (batchable !== geo) geo.dispose();
        list.push(batchable);
      };
      if (p.kind === 'fountain') {
        // A polygon fountain already has its mapped basin drawn as water.
        if (!p.outer?.length) {
          add(new THREE.CylinderGeometry(width,width,0.3,16),0.15);
          add(new THREE.CircleGeometry(width*0.86,16).rotateX(-Math.PI/2),0.31,colArr(PAL.water));
        }
        continue;
      }
      const foot = new Batch();
      const outer = p.outer?.length >= 3 ? p.outer : [[x-width/2,y-width/2],[x+width/2,y-width/2],[x+width/2,y+width/2],[x-width/2,y+width/2]];
      if (outer.every(p => Math.max(Math.abs(p[0]),Math.abs(p[1])) <= this._landHalf)) {
        addWalls(foot,outer,[],base,base+plinth,color); addCap(foot,outer,[],base+plinth,color);
      } else {
        const {pts,tris}=triangulate(outer,[]),sign=signedArea(outer)>=0?1:-1;
        for(const t of tris)for(const piece of clipTriangle(t.map(i=>[pts[i].x,pts[i].y]),this._landHalf)) {
          const point=p=>[p[0],base+plinth,-p[1]];
          foot.tri(point(piece[0]),point(piece[1]),point(piece[2]),UP,color);
        }
        for(let i=0;i<outer.length;i++)for(const [a,b]of clipSegment(outer[i],outer[(i+1)%outer.length],this._landHalf)) {
          foot.quad([a[0],base,-a[1]],[b[0],base,-b[1]],[b[0],base+plinth,-b[1]],[a[0],base+plinth,-a[1]],[sign*(b[1]-a[1]),0,sign*(b[0]-a[0])],color);
        }
      }
      list.push(foot.toGeometry());
      if (p.kind === 'statue') {
        add(new THREE.IcosahedronGeometry(1,0).scale(width*0.38,(h-plinth)/2,width*0.38),plinth+(h-plinth)/2);
      } else if (p.kind === 'monument') {
        add(new THREE.CylinderGeometry(width*0.16,width*0.32,h-plinth,8),plinth+(h-plinth)/2);
      } else {
        add(new THREE.BoxGeometry(width*0.75,h-plinth,width*0.3),plinth+(h-plinth)/2);
      }
    }
    lists.forEach((list,i) => {
      const geometry = this._mergeList(list);
      for (const geo of list) geo.dispose();
      const mesh = this._addMesh(geometry,'detail',i ? 'surroundings' : 'buildings',{name:'mapped-objects',pickable:!i});
      if (mesh && i) mesh.userData.surroundings = true;
    });
  }

  // ----- barriers and street furniture ---------------------------------------

  /**
   * Fences, walls and hedges along mapped lines. A fence is posts and two rails (so it can be seen
   * through), the rest are solid. Every barrier has an opening wherever a road crosses it. Barriers
   * outside the detailed square go to the surroundings group.
   */
  _buildBarriers(barriers, roads) {
    const batches = [new Batch(), new Batch()]; // detailed square, surroundings
    const half = this._landHalf;
    const segmentQuad = (a, b, t, extend = 0) => {
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len, nx = -uy * t, ny = ux * t;
      const ax = a[0] - ux * extend, ay = a[1] - uy * extend, bx = b[0] + ux * extend, by = b[1] + uy * extend;
      return [[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny]];
    };
    for (const bar of barriers || []) {
      const style = BARRIER_STYLES[bar.kind];
      if (!style || !bar.points || bar.points.length < 2) continue;
      if (this.options[BARRIER_GROUPS[bar.kind]] === false) continue;
      const H = barrierHeight(bar) * clamp(Number(this.options.barrierScale) || 1, 0.3, 3), col = colArr(style.color);
      const batch = batches[bar.context ? 1 : 0];
      // the ground only exists out to `half`: trim each run to it
      const inside = ([x, y]) => Math.abs(x) <= half && Math.abs(y) <= half;
      const trimmed = barrierRuns(bar.points, roads.insideRoad).flatMap((run) => {
        const parts = [];
        let part = [];
        for (const p of run) {
          if (inside(p)) part.push(p);
          else { if (part.length > 1) parts.push(part); part = []; }
        }
        if (part.length > 1) parts.push(part);
        return parts;
      });
      for (const run of trimmed) {
        if (style.form === 'solid') {
          for (let i = 1; i < run.length; i++) this._prism(batch, segmentQuad(run[i - 1], run[i], style.thickness / 2, style.thickness / 4), -0.3, H, col);
          continue;
        }
        let sincePost = Infinity;
        for (let i = 0; i < run.length; i++) {
          if (i > 0) {
            this._prism(batch, segmentQuad(run[i - 1], run[i], 0.025), H - 0.08, H, col);
            if (bar.kind !== 'guard_rail') this._prism(batch, segmentQuad(run[i - 1], run[i], 0.025), H * 0.2, H * 0.2 + 0.07, col);
            sincePost += Math.hypot(run[i][0] - run[i - 1][0], run[i][1] - run[i - 1][1]);
          }
          if (sincePost >= 3 || i === 0 || i === run.length - 1) {
            const [x, y] = run[i];
            this._prism(batch, [[x - 0.04, y - 0.04], [x + 0.04, y - 0.04], [x + 0.04, y + 0.04], [x - 0.04, y + 0.04]], -0.2, H, col);
            sincePost = 0;
          }
        }
      }
    }
    batches.forEach((batch, i) => {
      const geometry = batch.toGeometry();
      if (!geometry) return;
      const mesh = this._addMesh(geometry, 'detail', i ? 'surroundings' : 'details', { name: i ? 'context-barriers' : 'barriers', cast: !i });
      if (mesh && i) mesh.userData.surroundings = true;
    });
  }

  /** Benches, waste baskets and bus stops from mapped nodes, facing the nearest road unless tagged. */
  _buildFixtures(fixtures, roads) {
    const batch = new Batch();
    const half = this._landHalf;
    const o = this.options;
    const shown = { bench: o.furnBenches, waste_basket: o.furnBins, bus_stop: o.furnStops };
    const seat = benchColor(o.benchColor);
    const benchHex = { seat, frame: PAL.benchFrame, stone: '#bdb7aa' };
    const parts = benchParts(o.benchStyle);
    for (const f of fixtures || []) {
      if (shown[f.kind] === false) continue;
      const [x, y] = f.position || [];
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > half || Math.abs(y) > half) continue;
      const yaw = fixtureFacing(f, roads), c = Math.cos(yaw), s = Math.sin(yaw);
      // u runs the way the fixture faces, v across it (to its left)
      const box = (u0, u1, v0, v1, h0, h1, hex) => this._prism(
        batch, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]), h0, h1, colArr(hex));
      if (f.kind === 'bench') {
        // condition: the seat gets lighter or darker, the frame rusts, and dark stains mark the seat
        const wear = benchWear(o.benchWear, rng(hashStr(`bench:${x.toFixed(1)}:${y.toFixed(1)}`)));
        const seatHex = wear.seatShift >= 0 ? mixHex(seat, '#ffffff', wear.seatShift) : mixHex(seat, '#000000', -wear.seatShift);
        const frameHex = mixHex(PAL.benchFrame, '#8a5a3a', wear.rust);
        const slat = rng(hashStr(`slat:${x.toFixed(1)}:${y.toFixed(1)}`));
        const jitter = 0.05 + 0.18 * (Math.max(0, Math.min(100, Number(o.benchWear) || 0)) / 100); // every board a little different
        for (const p of parts) {
          let hex = p.role === 'frame' ? frameHex : benchHex[p.role];
          if (p.role === 'seat') {
            const j = (slat() - 0.5) * jitter;
            hex = j >= 0 ? mixHex(seatHex, '#ffffff', j) : mixHex(seatHex, '#000000', -j);
          }
          box(p.u0, p.u1, p.v0, p.v1, p.h0, p.h1, hex);
        }
        // stains: dark patches on the boards of the seat (the boards below 0.5 m, not the back or a table top)
        const boards = parts.filter((p) => p.role === 'seat' && p.h1 <= 0.5);
        for (const st of boards.length ? wear.stains : []) {
          const board = boards[Math.min(boards.length - 1, Math.floor((st.u * 0.5 + 0.5) * boards.length))];
          const half = (board.v1 - board.v0) / 2;
          const cv = (board.v0 + board.v1) / 2 + st.v * half * 0.9;
          const hl = Math.min(st.w, 0.3) * half / 2;
          const um = (board.u1 - board.u0) * 0.15;
          box(board.u0 + um, board.u1 - um, Math.max(board.v0, cv - hl), Math.min(board.v1, cv + hl), board.h1, board.h1 + 0.006, mixHex(seat, '#241a10', 0.7));
        }
      } else if (f.kind === 'waste_basket') {
        if (o.binStyle === 'round') {
          const ring = (r) => Array.from({ length: 8 }, (_, i) => [r * Math.cos((i + 0.5) * Math.PI / 4), r * Math.sin((i + 0.5) * Math.PI / 4)]);
          this._prism(batch, ring(0.23).map(([u, v]) => [x + u, y + v]), 0, 0.85, colArr(PAL.bin));
          this._prism(batch, ring(0.26).map(([u, v]) => [x + u, y + v]), 0.85, 0.91, colArr(PAL.binLid));
        } else {
          box(-0.2, 0.2, -0.2, 0.2, 0, 0.8, PAL.bin);
          box(-0.23, 0.23, -0.23, 0.23, 0.8, 0.86, PAL.binLid);
        }
      } else if (f.kind === 'bus_stop') {
        box(-0.05, 0.05, -0.05, 0.05, 0, 2.8, PAL.stopPole);
        box(-0.2, 0.2, -0.02, 0.02, 2.2, 2.75, PAL.stopSign); // the sign plate faces along the road
        if (f.shelter) {
          box(-0.9, 0.9, -1.7, 1.7, 2.3, 2.42, PAL.shelterRoof);
          for (const [u, v] of [[-0.85, -1.65], [-0.85, 1.65], [0.85, -1.65], [0.85, 1.65]]) box(u - 0.04, u + 0.04, v - 0.04, v + 0.04, 0, 2.3, PAL.stopPole);
          box(-0.9, -0.84, -1.7, 1.7, 0.3, 2.3, PAL.shelterGlass); // back panel, away from the road
        }
      }
    }
    const geometry = batch.toGeometry();
    if (geometry) this._addMesh(geometry, 'detail', 'details', { name: 'street-fixtures' });
  }

  // ----- buildings ------------------------------------------------------------

  /**
   * Ground under a footprint: the height the building stands at (`groundC`, from the centroid, raised towards the high
   * side on a slope so no corner is buried, capped so one noisy elevation cell cannot lift it far) and the lowest corner
   * (`groundMin`), which the walls reach down to.
   */
  _footGround(outer, c = polyCentroid(outer)) {
    let groundC = this.groundHeight(c[0], c[1]);
    let groundMin = Infinity;
    let groundMax = -Infinity;
    for (const p of outer) {
      const g = this.groundHeight(p[0], p[1]);
      if (g < groundMin) groundMin = g;
      if (g > groundMax) groundMax = g;
    }
    groundC = Math.max(groundC, Math.min(groundMax, groundC + 3));
    return { groundC, groundMin };
  }

  /**
   * The facade the shader draws on a building, as facadefit.js wants it: { seed, base, variety, openings }. Furniture
   * is placed before the buildings are built, so this repeats the ground level they will be given.
   */
  _facadeOf(b) {
    const cache = (this._facCache ||= new WeakMap());
    let own = cache.get(b);
    if (!own) {
      const minH = Math.max(0, Number.isFinite(b.minHeight) ? b.minHeight : 0);
      own = { seed: facadeSeedOf(b), base: minH > 0 ? 1e4 : this._footGround(b.outer).groundC };
      cache.set(b, own);
    }
    // the two sliders are live uniforms, so they are read fresh
    return { ...own, variety: clamp((this.options.facadeStyles ?? 60) / 100, 0, 1), openings: clamp((this.options.facadeOpenings ?? 50) / 100, 0, 1) };
  }

  _buildBuildings(list, surroundings, extra = null) {
    const lowPoly = this.options.lowPoly;
    const wallsB = new Batch();
    const roofsB = new Batch();
    const plain = []; // vertex ranges of walls that get no window grid
    const facades = []; // [first vertex, end vertex, seed, ground level] of the walls that get a facade
    for (const b of list) {
      const outer = b.outer;
      if (!outer || outer.length < 3) continue;
      // Zero is a valid mapped top height (often an underground structure), not a missing value.
      const mappedHeight = Number.isFinite(b.height) ? b.height : 6;
      if (mappedHeight <= 0) continue;
      const holes = (b.holes || []).filter((h) => h && h.length > 2);
      const r = rng(hashStr(String(b.id ?? outer.length)));

      // ground under the footprint: centre drives the base, lowest corner extends the walls down
      const c = polyCentroid(outer);
      const { groundC, groundMin } = this._footGround(outer, c);
      const minH = Math.max(0, Number.isFinite(b.minHeight) ? b.minHeight : 0);
      const height = Math.max(mappedHeight, minH + 0.05);
      // Procedural roof primitives cannot preserve courtyards. Unknown shapes such as OSM
      // "many" must keep the mapped cap rather than becoming a bounding-box gable.
      // monuments, steps, sheds and landmark bases are solid: no window grid on their walls
      const solid = b.noWindows || NO_WINDOW_KINDS.has(b.kind);
      const shape = roofShapeFor({ mapped: b.roofShape, style: this.options.roofStyle, height, plain: surroundings || lowPoly || holes.length > 0, solid });
      const flat = !shape;
      const roofH = flat ? 0 : clamp(b.roofHeight ?? 3, 0.5, Math.max(0.5, height - minH - 1.5));
      const base = groundC + minH;
      const bottom = minH > 0 ? base : Math.min(base, groundMin);
      const topAbs = groundC + height;
      const wallTop = topAbs - roofH;

      // colours: wall hue from the palette (or building:colour), slight brightness jitter
      const hex = b.color || this._wallPick(b, r);
      const mult = 0.95 + 0.1 * r();
      // floor the brightness: a mapped "black" would otherwise render as a flat hole with no shading
      const wc = colArr(hex).map((v) => clamp(v * mult, 0.12, 1));
      // A solid terrace or plinth is one stone surface: its top matches its walls instead of a random roof tile.
      const roofSet = roofColors(this._palette, this.options.roofColor);
      const roofPick = colArr(roofSet[Math.floor(r() * roofSet.length)]);
      const rc = solid ? wc.map((v) => clamp(v * 1.03, 0, 1)) : roofPick;
      const v0 = wallsB.p.length / 3;
      addWalls(wallsB, outer, holes, bottom, wallTop, wc);
      if (solid) plain.push([v0, wallsB.p.length / 3]);
      else facades.push([v0, wallsB.p.length / 3, facadeSeedOf(b), minH > 0 ? 1e4 : base]);
      // trim: plinth, string courses and cornice as thin bands round the footprint (no window grid on them)
      if (!surroundings && !solid && holes.length === 0 && hasTrim(this.options.trimShare ?? 0, rng(hashStr(`trim:${b.id ?? outer.length}`))())) {
        const t0 = wallsB.p.length / 3;
        const tc = wc.map((v) => clamp(v * trimTone(this.options.trimTone), 0.1, 1));
        const g0 = this.groundHeight(c[0], c[1]);
        for (const band of trimBands(bottom, wallTop, this.options.trimDepth, Math.max(groundC, g0))) {
          const bc = band.role === 'plinth' ? tc.map((v) => v * 0.9) : tc;
          for (const q of outwardStrips(outer, band.out)) this._prism(wallsB, q, band.h0, band.h1, bc, () => 0);
        }
        plain.push([t0, wallsB.p.length / 3]);
      }
      else if (!surroundings && this._segs) addWindowSegs(this._segs, outer, bottom, wallTop, { seed: facadeSeedOf(b), base: minH > 0 ? 1e4 : base, variety: clamp((this.options.facadeStyles ?? 60) / 100, 0, 1), openings: clamp((this.options.facadeOpenings ?? 50) / 100, 0, 1) });
      if (flat) {
        addCap(roofsB, outer, holes, topAbs, rc);
        if (!surroundings && !solid && holes.length === 0) this._roofTop(roofsB, outer, topAbs, height, wc, r);
      } else {
        addRoof(roofsB, outer, wallTop, roofH, shape, rc);
      }
    }
    // hand-built landmark models go in with the roofs (no window grid on a lattice tower)
    if (extra) extra(roofsB, (x, y) => this.groundHeight(x, y));
    const walls = wallsB.toGeometry();
    // inner city walls get the window grid in the edge and lit / colour passes (aWin = 1 per vertex)
    const winOn = !surroundings || this.options.surroundWindows !== false; // distant buildings get the window grid too
    if (walls && winOn) {
      const win = new Float32Array(walls.attributes.position.count).fill(1);
      for (const [a, z] of plain) win.fill(0, a, z);
      walls.setAttribute('aWin', new THREE.Float32BufferAttribute(win, 1));
      const fac = new Float32Array(walls.attributes.position.count * 2);
      for (const [a, z, seed, ground] of facades) for (let i = a; i < z; i++) { fac[i * 2] = seed; fac[i * 2 + 1] = ground; }
      walls.setAttribute('aFac', new THREE.Float32BufferAttribute(fac, 2));
    }
    // roofs (and the landmark models drawn with them) carry an explicit 0, so the window grid never
    // shows on them whatever the GPU still holds from the walls mesh
    const roofs = roofsB.toGeometry();
    if (roofs && winOn) roofs.setAttribute('aWin', new THREE.Float32BufferAttribute(new Float32Array(roofs.attributes.position.count), 1));
    return { walls, roofs };
  }

  /**
   * Parapet and plant on a flat roof: a low wall round the edge, air-conditioner units, a water tank on legs,
   * a stairwell box and an antenna mast (amounts from the "Rooftop clutter" slider, see rooftop.js).
   */
  _roofTop(batch, outer, topAbs, height, wallCol, r) {
    const o = this.options;
    const flatY = () => topAbs;
    const parapet = clamp(Number(o.roofParapet ?? 0.45) || 0, 0, 1.4);
    if (parapet > 0.05) {
      const col = wallCol.map((v) => clamp(v * 1.06, 0, 1));
      for (const q of parapetStrips(outer, 0.25)) this._prism(batch, q, 0, parapet, col, flatY);
    }
    const plan = rooftopPlan(r, { area: Math.abs(signedArea(outer)), height, amount: o.roofClutter ?? 60 });
    if (!plan.ac && !plan.tank && !plan.stair && !plan.mast) return;
    const { ux, uy } = roofAxis(outer);
    const vx = -uy;
    const vy = ux;
    const placed = [];
    const box = (cx, cy, w, d, h0, h1, col) => this._prism(batch, [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [cx + ux * a * w / 2 + vx * b * d / 2, cy + uy * a * w / 2 + vy * b * d / 2]), h0, h1, col, flatY);
    const put = (kind, fn) => {
      const sz = itemSize(kind, r);
      const at = placeOnRoof(outer, r, sz.w, sz.d, placed, { margin: parapet + 0.7 });
      if (at) fn(at.x, at.y, sz);
    };
    if (plan.stair) put('stair', (x, y, sz) => {
      const c = wallCol.map((v) => clamp(v * 0.97, 0, 1));
      box(x, y, sz.w, sz.d, 0, sz.h, c);
      box(x, y, sz.w + 0.3, sz.d + 0.3, sz.h, sz.h + 0.12, wallCol.map((v) => clamp(v * 1.12, 0, 1))); // slab roof
      box(x + vx * (sz.d / 2 + 0.02), y + vy * (sz.d / 2 + 0.02), 0.9, 0.06, 0, 2, colArr('#4a4f57')); // door
    });
    if (plan.tank) put('tank', (x, y, sz) => {
      const col = colArr(tankColour(o.roofTank, r()));
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box(x + ux * a * sz.w * 0.3 + vx * b * sz.d * 0.3, y + uy * a * sz.w * 0.3 + vy * b * sz.d * 0.3, 0.1, 0.1, 0, 0.6, colArr('#555a60'));
      this._cylinder(batch, x, y, sz.w / 2, topAbs + 0.6, topAbs + sz.h, col);
      this._cylinder(batch, x, y, sz.w / 2 + 0.05, topAbs + sz.h, topAbs + sz.h + 0.1, col.map((v) => v * 0.8)); // lid rim
    });
    for (let i = 0; i < plan.ac; i++) put('ac', (x, y, sz) => {
      box(x, y, sz.w, sz.d, 0.15, sz.h, colArr('#c9cbcd'));
      box(x + vx * (sz.d / 2 + 0.015), y + vy * (sz.d / 2 + 0.015), sz.w * 0.72, 0.03, 0.25, sz.h - 0.1, colArr('#4c5158')); // fan grille
      box(x, y, sz.w * 0.8, sz.d * 0.8, 0, 0.15, colArr('#6b6f75')); // feet
    });
    if (plan.mast) put('mast', (x, y, sz) => {
      const dark = colArr('#4a4d52');
      box(x, y, 0.08, 0.08, 0, sz.h, dark);
      for (const [f, w] of [[0.9, 1.2], [0.75, 0.9], [0.6, 0.6]]) box(x, y, w, 0.04, sz.h * f, sz.h * f + 0.04, dark);
    });
  }

  /** Upright cylinder (n-sided prism) at local (x, y) between absolute heights y0 and y1. */
  _cylinder(batch, x, y, rad, y0, y1, col, n = 10) {
    const P = (k, h) => [x + Math.cos((k / n) * Math.PI * 2) * rad, h, -(y + Math.sin((k / n) * Math.PI * 2) * rad)];
    for (let k = 0; k < n; k++) {
      const m = ((k + 0.5) / n) * Math.PI * 2;
      batch.quad(P(k, y0), P(k + 1, y0), P(k + 1, y1), P(k, y1), [Math.cos(m), 0, -Math.sin(m)], col);
      batch.tri([x, y1, -y], P(k, y1), P(k + 1, y1), UP, col);
    }
  }

  _wallPick(b, r) {
    const list = wallColors(this._palette, b.kind, this.options.wallTone);
    return list[Math.floor(r() * list.length)];
  }

  // ----- ground ----------------------------------------------------------------

  /** Ground plane covering the area (subdivided and displaced when terrain is on). */
  _buildGround(size, withTerrain) {
    const useTerrain = withTerrain && this._elev;
    const seg = useTerrain ? Math.max(8, Math.min(128, this._elev.n - 1)) : 1;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2); // (x, y, 0) -> (x, 0, -y)
    const pos = geo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const gc = colArr(PAL.ground);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, useTerrain ? this._groundCorner(x, -z, size / seg) : this.groundHeight(x, -z));
      cols[i * 3] = gc[0];
      cols[i * 3 + 1] = gc[1];
      cols[i * 3 + 2] = gc[2];
    }
    pos.needsUpdate = true;
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    return geo;
  }

  /** Surroundings ground: larger, slightly below the inner ground to avoid z-fighting. */
  _buildSurroundGround(size, withTerrain) {
    const geo = this._buildGround(size, withTerrain);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) - 0.3);
    pos.needsUpdate = true;
    const sc = colArr(PAL.surr);
    const cols = geo.attributes.color.array;
    for (let i = 0; i < pos.count; i++) {
      cols[i * 3] = sc[0];
      cols[i * 3 + 1] = sc[1];
      cols[i * 3 + 2] = sc[2];
    }
    geo.attributes.color.needsUpdate = true;
    return geo;
  }

  // ----- roads, markings, street furniture -------------------------------------

  /**
   * Roads (asphalt ribbons), sidewalks under them, footways, and optional details:
   * dashed centre lanes, zebra crosswalks at junctions, utility poles, traffic signals.
   */
  _buildRoads(roads, details, japan = false, context = false) {
    const asphalt = new Batch();
    const sidewalks = new Batch();
    const walk = new Batch();
    const marks = new Batch();
    const rails = new Batch(); // guard railings (details)
    const tact = new Batch(); // tactile paving strips (details, Japan only)
    const yellow = colArr(PAL.tactile);
    const furniture = []; // merged later: poles and signals
    const poleB = new Batch(); // utility poles (cross-arms, insulators, transformers)
    const wireB = new Batch(); // overhead wires between poles
    const vendB = new Batch(); // drink vending machines on the pavement
    const shopB = new Batch(); // shop awnings and blade signs on the walls
    const bikeB = new Batch(); // parked bicycles, scooters and motorbikes
    const birdB = new Batch(); // pigeons and crows
    const adB = new Batch(); // poster columns and ad panels
    const junkB = new Batch(); // bins and bags
    const plateB = new Batch(); // street-name plates
    const shutB = new Batch(); // window shutters
    const cafeB = new Batch(); // cafe terraces
    const hydB = new Batch(); // fire hydrants
    const signB = new Batch(); // traffic signs and curve mirrors on poles
    const lampB = new Batch(); // street lamps
    const plantB = new Batch(); // potted plants and flower boxes
    const balcB = new Batch(); // balconies and laundry
    const lightB = new Batch(); // paper lanterns and door curtains
    const postB = new Batch(); // post boxes
    if (details && !context) { this.vendingSpots = []; this.shopSpots = []; this.bikeSpots = []; this.signSpots = []; this.plantSpots = []; this.balcSpots = []; this.acSpots = []; this.lightSpots = []; this.postSpots = []; this.scooterSpots = []; this.birdSpots = []; this.adSpots = []; this.rubbishSpots = []; this.plateSpots = []; this.shutterSpots = []; this.cafeSpots = []; this.hydrantSpots = []; }
    const entries = [];
    const juncPts = []; // junctions shared by two or more drawn roads (for railing gaps)

    const white = colArr(PAL.lane);
    for (const r of roads) {
      const pts = r.points;
      if (!pts || pts.length < 2) continue;
      if (r.tunnel) continue; // underground: not visible at street level
      const kind = r.kind || 'residential';
      const foot = FOOT_KINDS.has(kind);
      const major = MAJOR_KINDS.has(kind);
      const w = r.width || (foot ? 2 : 6);
      const path = resamplePolyline(pts, 4);
      const heightAt = (x, y) => this._surfaces.heightFor(r.sourceRoad || r, x, y);
      entries.push({ pts, kind, foot, major, w, lanes: r.lanes || 0, bridge: r.bridge, layer: r.layer || 0, heightAt });

      if (foot) {
        this._ribbon(walk, path, Math.max(w, 1.5), 0.06, colArr(PAL.sidewalk), false, heightAt);
        continue;
      }
      // sidewalk strip underneath the carriageway
      if (!context) this._ribbon(sidewalks, path, w + 5, 0.04, colArr(PAL.sidewalk), false, heightAt);
      this._ribbon(asphalt, path, w, 0.07, colArr(major ? PAL.road : PAL.roadMinor), true, heightAt);
    }

    const junctions = details ? findJunctions(entries) : [];
    if (details) {
      for (const e of entries) {
        if (e.foot) continue;
        const path = resamplePolyline(e.pts, 4);

        // dashed centre line on wider / multi-lane roads
        if ((e.major || e.lanes >= 2) && e.w >= 7) {
          for (const dash of polyDashes(path, 3, 6)) {
            this._ribbon(marks, dash, 0.22, 0.09, white, false, e.heightAt);
          }
        }

        // white edge lines along the carriageway, stopping short of every junction
        if (this.options.edgeLines !== 'off') this._edgeLines(marks, e, path, junctions, white);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._roadCovers(marks, path, e);
        if (!e.bridge && e.layer <= 0) this._roadPatches(marks, path, e);

        // utility poles (default every 30 m) along residential-type streets, with wires between them
        if (!e.bridge && e.layer <= 0 && RESIDENTIAL_KINDS.has(e.kind) && this.options.detailPoles !== false) {
          const spacing = clamp(Number(this.options.poleSpacing ?? 30) || 30, 12, 80);
          const poles = [];
          for (const s of samplePoly(path, spacing, spacing / 2)) {
            const o = e.w / 2 + 0.8;
            const x = s.x + s.nx * o;
            const y = s.y + s.ny * o;
            if (this._clearOf(x, y)) {
              poles.push({ x, y, nx: s.nx, ny: s.ny, tx: s.tx, ty: s.ty });
              this._lampPts.push([x, y, POLE_HEIGHT + 0.2]); // lamp bulb on top of the pole (night, lamps on)
            }
          }
          this._utilityPoles(poleB, wireB, poles, spacing);
        }
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._vendingMachines(vendB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._shopFronts(shopB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._bicycles(bikeB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._scooters(bikeB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._birds(birdB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk' && e.w >= 5) this._posters(adB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._rubbish(junkB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._streetPlates(plateB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._shutters(shutB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._cafes(cafeB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._hydrants(hydB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._roadSigns(signB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk' && e.w >= 5) this._streetLamps(lampB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._planters(plantB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._balconies(balcB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._acUnits(balcB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._shopLights(lightB, path, e);
        if (!e.bridge && e.layer <= 0 && e.kind !== 'motorway' && e.kind !== 'trunk') this._postBoxes(postB, path, e);
      }

      // junctions: signals where a major road meets, a zebra crossing on every leg
      for (const j of junctions) {
        juncPts.push([j.x, j.y]);
        if (j.signal && this.options.detailSignals !== false) {
          const spot = this._signalSpot(j, j.roads, entries);
          furniture.push(...this._signalAt(spot.x, spot.y, spot.ax, spot.ay));
          this._lampPts.push([spot.x, spot.y, 5.5]); // junction lamp on the signal pole (night, lamps on)
        }
        for (const leg of j.legs) {
          if (this.options.detailCrosswalks !== false) this._crosswalk(marks, leg.cx, leg.cy, leg.ux, leg.uy, leg.w, white);
          if (japan && this.options.detailTactile !== false) this._tactile(tact, leg.cx, leg.cy, leg.ux, leg.uy, leg.w, yellow);
        }
      }
    }

    if (details) this._curveMirrors(signB, junctions, entries);
    if (details && this.options.detailRails !== false) this._guardRails(entries, juncPts, rails);

    const out = [];
    out.push({ geo: sidewalks.toGeometry(), role: 'sidewalk', name: 'sidewalks' });
    out.push({ geo: walk.toGeometry(), role: 'sidewalk', name: 'footways' });
    out.push({ geo: asphalt.toGeometry(), role: 'road', name: 'asphalt' });
    out.push({ geo: marks.toGeometry(), role: 'lane', name: 'markings' });
    if (!poleB.empty) furniture.push(poleB.toGeometry());
    if (!vendB.empty) furniture.push(vendB.toGeometry());
    if (!shopB.empty) furniture.push(shopB.toGeometry());
    if (!bikeB.empty) furniture.push(bikeB.toGeometry());
    if (!birdB.empty) furniture.push(birdB.toGeometry());
    if (!adB.empty) furniture.push(adB.toGeometry());
    if (!junkB.empty) furniture.push(junkB.toGeometry());
    if (!plateB.empty) furniture.push(plateB.toGeometry());
    if (!shutB.empty) furniture.push(shutB.toGeometry());
    if (!cafeB.empty) furniture.push(cafeB.toGeometry());
    if (!hydB.empty) furniture.push(hydB.toGeometry());
    if (!signB.empty) furniture.push(signB.toGeometry());
    if (!lampB.empty) furniture.push(lampB.toGeometry());
    if (!plantB.empty) furniture.push(plantB.toGeometry());
    if (!balcB.empty) furniture.push(balcB.toGeometry());
    if (!lightB.empty) furniture.push(lightB.toGeometry());
    if (!postB.empty) furniture.push(postB.toGeometry());
    out.push({ geo: this._mergeList(furniture), role: 'detail', name: 'street-furniture' });
    out.push({ geo: wireB.toGeometry(), role: 'detail', name: 'wires' });
    out.push({ geo: rails.toGeometry(), role: 'detail', name: 'guard-rails' });
    out.push({ geo: tact.toGeometry(), role: 'lane', name: 'tactile' });
    return out;
  }

  /** Japan only (area centre inside lat 24..46, lon 122..146). */
  _inJapan(c) {
    return !!c && c.lat >= 24 && c.lat <= 46 && c.lon >= 122 && c.lon <= 146;
  }

  /**
   * Yellow tactile paving (0.3 m wide, 2 m long, parallel to the curb) on the sidewalk at both
   * ends of a zebra crossing centred at (cx, cy); (ux, uy) is the road direction, w the road width.
   */
  _tactile(batch, cx, cy, ux, uy, w, col) {
    const px = -uy;
    const py = ux;
    const TACTILE_Y = 0.085;
    for (const s of [-1, 1]) {
      const ox = cx + px * s * (w / 2 + 0.6);
      const oy = cy + py * s * (w / 2 + 0.6);
      const corner = (a, b) => [ox + ux * a + px * b, oy + uy * a + py * b];
      const q = [corner(-1.0, -0.15), corner(1.0, -0.15), corner(1.0, 0.15), corner(-1.0, 0.15)];
      const V = (p) => [p[0], this.groundHeight(p[0], p[1]) + TACTILE_Y, -p[1]];
      batch.quad(V(q[0]), V(q[1]), V(q[2]), V(q[3]), UP, col);
      for (let i = 0; i < 4; i++) {
        const a = q[i];
        const b = q[(i + 1) % 4];
        this._pushSeg(V(a), V(b));
      }
    }
  }

  /**
   * Guard railings on the sidewalk edge of primary / secondary / tertiary roads: posts every 2 m,
   * two horizontal bars at 0.5 m and 0.9 m. Posts within 8 m of a junction are left out.
   */
  _guardRails(entries, junctions, batch) {
    const col = colArr(PAL.guard);
    const POST_H = 1.0;
    for (const e of entries) {
      if ((!RAIL_KINDS.has(e.kind) && !e.bridge) || !e.pts || e.pts.length < 2) continue;
      for (const side of [-1, 1]) {
        const off = side * (e.w / 2 + (e.bridge && e.foot ? -0.1 : 2.3));
        const posts = [];
        for (const s of samplePoly(e.pts, 2, 1)) {
          const x = s.x + s.nx * off;
          const y = s.y + s.ny * off;
          let near = false;
          for (const j of junctions) {
            if (Math.hypot(j[0] - x, j[1] - y) < 8) {
              near = true;
              break;
            }
          }
          posts.push(near || !this._clearOf(x, y) ? null : [x, y]);
        }
        for (let i = 0; i < posts.length; i++) {
          const a = posts[i];
          if (!a) continue;
          const q = [[-0.05, -0.05], [0.05, -0.05], [0.05, 0.05], [-0.05, 0.05]].map(([dx, dy]) => [a[0] + dx, a[1] + dy]);
          this._prism(batch, q, 0, POST_H, col, e.heightAt);
          const b = posts[i + 1];
          if (!b) continue;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const L = Math.hypot(dx, dy);
          if (L < 1e-6 || L > 2.5) continue;
          // thickness-0.05 bar between the two posts, perpendicular direction (-uy, ux)
          const nx = (-dy / L) * 0.025;
          const ny = (dx / L) * 0.025;
          const bar = [[a[0] - nx, a[1] - ny], [b[0] - nx, b[1] - ny], [b[0] + nx, b[1] + ny], [a[0] + nx, a[1] + ny]];
          for (const hz of [0.5, 0.9]) this._prism(batch, bar, hz - 0.025, hz + 0.025, col, e.heightAt);
        }
      }
    }
  }

  /** Axis-aligned prism over a quad (local [x, y] corners in order) from h0 to h1 above the ground. */
  _prism(batch, quad, h0, h1, col, heightAt = null) {
    const V = (p, h) => [p[0], (heightAt ? heightAt(p[0], p[1]) : this.groundHeight(p[0], p[1])) + h, -p[1]];
    let cx = 0;
    let cy = 0;
    for (const p of quad) {
      cx += p[0];
      cy += p[1];
    }
    cx /= quad.length;
    cy /= quad.length;
    for (let i = 0; i < 4; i++) {
      const a = quad[i];
      const b = quad[(i + 1) % 4];
      const mx = (a[0] + b[0]) / 2 - cx;
      const my = (a[1] + b[1]) / 2 - cy;
      batch.quad(V(a, h0), V(b, h0), V(b, h1), V(a, h1), [mx, 0, -my], col);
    }
    batch.quad(V(quad[0], h1), V(quad[1], h1), V(quad[2], h1), V(quad[3], h1), UP, col);
  }

  /** Zebra crossing centred at (cx, cy), crossing a road whose unit direction is (ux, uy). */
  _crosswalk(batch, cx, cy, ux, uy, w, col) {
    const px = -uy; // across the road
    const py = ux;
    const N = Math.max(3, Math.floor(w) - 1);
    for (let k = 0; k < N; k++) {
      const o = (k - (N - 1) / 2) * 1.0;
      const corners = [
        [-1.6, o - 0.25],
        [1.6, o - 0.25],
        [1.6, o + 0.25],
        [-1.6, o + 0.25],
      ].map(([a, b]) => {
        const x = cx + ux * a + px * b;
        const y = cy + uy * a + py * b;
        return [x, this.groundHeight(x, y) + 0.095, -y];
      });
      batch.quad(corners[0], corners[1], corners[2], corners[3], UP, col);
    }
  }

  /**
   * Signal position for a junction: 6-8 m from the junction centre along a diagonal, on the quadrant
   * farthest from the incident road centrelines (the sidewalk corner, not the carriageway).
   * Returns the pole position and the unit direction (ax, ay) from the pole towards the junction.
   */
  _signalSpot(j, roadIds, entries) {
    const r = rng(hashStr(`sig:${j.x.toFixed(1)}:${j.y.toFixed(1)}`));
    const d = 6 + 2 * r();
    const k = Math.SQRT1_2;
    let best = null;
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      const px = j.x + sx * d * k;
      const py = j.y + sy * d * k;
      let clear = Infinity;
      for (const ei of roadIds) {
        const pts = entries[ei].pts;
        for (let i = 0; i < pts.length - 1; i++) {
          clear = Math.min(clear, distToSegment(px, py, pts[i], pts[i + 1]));
        }
      }
      const score = clear + 0.01 * r(); // small random tie-break between equal corners
      if (!best || score > best.score) best = { x: px, y: py, score, ax: -sx * k, ay: -sy * k };
    }
    return best;
  }

  /**
   * Traffic signal at local (x, y): 0.2 m pole up to 5.2 m, a 1.4 m arm towards the junction (ax, ay),
   * and a 1.2 x 0.35 x 0.3 m housing hanging at the arm end (about 5 m up).
   * Returns a list of batchable geometries.
   */
  _signalAt(x, y, ax, ay) {
    const h = this.groundHeight(x, y);
    const phi = Math.atan2(ay, ax);
    const armL = 1.4;
    const pole = new THREE.BoxGeometry(0.2, 5.2, 0.2);
    pole.translate(x, h + 2.6, -y);
    const arm = new THREE.BoxGeometry(armL, 0.12, 0.12);
    arm.rotateY(phi);
    arm.translate(x + (ax * armL) / 2, h + 5.1, -(y + (ay * armL) / 2));
    const head = new THREE.BoxGeometry(1.2, 0.35, 0.3);
    head.rotateY(phi + Math.PI / 2); // long side across the arm, facing the road
    head.translate(x + ax * armL, h + 4.95, -(y + ay * armL));
    const metal = colArr('#6b6e74');
    return [toBatchable(pole, metal), toBatchable(arm, metal), toBatchable(head, colArr(PAL.signal))];
  }

  /**
   * Solid white edge lines 0.35 m in from the kerb on roads 4.5 m or wider, on both sides or one (the
   * "Edge lines" setting). They stop `w / 2 + 4` m short of any junction so they never run across a side road.
   */
  _edgeLines(batch, e, path, junctions, col) {
    if (e.w < 4.5 || e.bridge || e.layer > 0 || e.kind === 'motorway' || e.kind === 'trunk') return;
    const sides = this.options.edgeLines === 'one' ? [e.w % 2 < 1 ? 1 : -1] : [-1, 1]; // one side: a fixed but varied choice per road
    const clear = e.w / 2 + 4;
    const samples = samplePoly(path, 1.5, 0.5);
    for (const side of sides) {
      let run = [];
      const flush = () => {
        if (run.length > 1) this._ribbon(batch, run, 0.13, 0.092, col, false, e.heightAt);
        run = [];
      };
      for (const p of samples) {
        const o = (e.w / 2 - 0.35) * side;
        const near = junctions.some((j) => Math.abs(j.x - p.x) < clear && Math.abs(j.y - p.y) < clear && Math.hypot(j.x - p.x, j.y - p.y) < clear);
        if (near) flush();
        else run.push([p.x + p.nx * o, p.y + p.ny * o]);
      }
      flush();
    }
  }

  /**
   * Utility poles at `poles` ({ x, y, nx, ny, tx, ty }: local position, the street-side normal and the road
   * direction) and the wires between neighbours. Style, wire count, sag and transformers come from the
   * world settings (see wires.js).
   */
  _utilityPoles(poleB, wireB, poles, spacing) {
    const o = this.options;
    const look = POLE_LOOK[poleStyleFor(o.poleStyle, this._city && this._city.center)];
    const H = POLE_HEIGHT;
    const pole = colArr(look.colour);
    const arm = colArr(look.arm);
    const white = colArr(INSULATOR_COLOUR);
    const slots = wireSlots(o.wireCount ?? 3);
    const ground = poles.map((p) => this.groundHeight(p.x, p.y));
    poles.forEach((p, i) => {
      const g = ground[i];
      const flat = () => g; // keep arms level on a slope
      // box in the pole's frame: n across the road (positive = away from the street), t along it
      const box = (n0, n1, t0, t1, h0, h1, col) => this._prism(poleB, [
        [p.x + p.nx * n0 + p.tx * t0, p.y + p.ny * n0 + p.ty * t0], [p.x + p.nx * n1 + p.tx * t0, p.y + p.ny * n1 + p.ty * t0],
        [p.x + p.nx * n1 + p.tx * t1, p.y + p.ny * n1 + p.ty * t1], [p.x + p.nx * n0 + p.tx * t1, p.y + p.ny * n0 + p.ty * t1],
      ], h0, h1, col, flat);
      const hw = look.width / 2;
      box(-hw, hw, -hw, hw, 0, H, pole);
      // cross-arm across the street side, with a porcelain insulator at each power wire
      box(-0.95, 0.95, -0.05, 0.05, H - 0.5, H - 0.38, arm);
      if (slots.length) {
        for (const s of slots.slice(0, 3)) box(s.across - 0.05, s.across + 0.05, -0.05, 0.05, H - 0.38, H - 0.24, white);
      }
      // a lower bracket for the telephone / cable wires
      if (slots.length > 3) box(-0.6, 0.6, -0.04, 0.04, H - 1.32, H - 1.24, arm);
      const u = rng(hashStr(`pole:${p.x.toFixed(1)}:${p.y.toFixed(1)}`))();
      if (hasTransformer(o.poleTransformers ?? 20, u)) box(hw, hw + 0.5, -0.25, 0.25, H - 2.1, H - 1.15, colArr(TRANSFORMER_COLOUR));
    });
    if (!slots.length) return;
    const wire = colArr(WIRE_COLOUR);
    const r = Math.max(0.01, Number(o.wireThickness ?? 0.035));
    for (const [a, b] of wireSpans(poles, spacing * 1.6)) {
      const A = poles[a];
      const B = poles[b];
      const len = Math.hypot(B.x - A.x, B.y - A.y);
      const sag = spanSag(o.wireSag ?? 0.5, len);
      for (const s of slots) {
        const pa = [A.x - A.nx * s.across, ground[a] + H - s.down, -(A.y - A.ny * s.across)];
        const pb = [B.x - B.nx * s.across, ground[b] + H - s.down, -(B.y - B.ny * s.across)];
        const pts = catenary(pa, pb, sag, Math.ceil(len / 2.5));
        for (let i = 0; i + 1 < pts.length; i++) this._tube(wireB, pts[i], pts[i + 1], r, wire);
      }
    }
  }

  /**
   * Drink vending machines along a street: groups of one to three, facing the road from the building side of
   * the pavement. How many comes from the place (vendingSpacing) and the "Vending machines" slider.
   */
  _vendingMachines(batch, path, e) {
    const o = this.options;
    const spacing = vendingSpacing(this._city && this._city.center);
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 10;
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`vend:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= vendingChance(o.vendingDensity ?? 30, spacing, every) / 2) continue; // half the chance on each side
      // stand against the nearest wall on the chosen side of the street, facing away from it
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall) continue;
      const fx = wall.nx;
      const fy = wall.ny;
      const cx = wall.qx + fx * 0.36;
      const cy = wall.qy + fy * 0.36;
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
      if (gap < e.w / 2 + 0.7 || !this._clearOf(cx, cy, 1.5)) continue;
      const tx = -fy;
      const ty = fx;
      const colour = vendingColour(o.vendingColour, r());
      const count = vendingGroupSize(r());
      const g = this.groundHeight(cx, cy);
      this.vendingSpots?.push([cx, cy, fx, fy]); // where the groups stand (local metres) and which way they face
      for (let k = 0; k < count; k++) {
        const along = (k - (count - 1) / 2) * (VENDING_WIDTH + 0.06);
        const mx = cx + tx * along;
        const my = cy + ty * along;
        if (insideBuilding(walls, mx, my)) continue;
        const body = k && o.vendingColour === 'mixed' ? vendingColour('mixed', r()) : colour;
        const hex = { body, trim: mixHex(body, '#000000', 0.45), panel: '#f6f2dd', slot: '#17181b' };
        for (const p of vendingParts(r)) {
          const col = colArr(p.role === 'drink' ? DRINK_COLOURS[p.slot] : hex[p.role]);
          this._prism(batch, [[p.u0, p.v0], [p.u1, p.v0], [p.u1, p.v1], [p.u0, p.v1]].map(([u, v]) => [mx + u * fx + v * tx, my + u * fy + v * ty]), p.h0, p.h1, col, () => g);
        }
      }
    }
  }

  /**
   * Shop awnings and blade signs on the walls that face a street. How many comes from the place
   * (awningSpacing / signSpacing) and the two density sliders; awnings keep to wall runs wide enough for them.
   */
  _shopFronts(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 8;
    const aChance = shopChance(o.awningDensity ?? 35, awningSpacing(centre), every) / 2; // per side
    const sChance = shopChance(o.signDensity ?? 30, signSpacing(centre), every) / 2;
    if (aChance <= 0 && sChance <= 0) return;
    const depth = clamp(Number(o.awningDepth ?? 1.2) || 1.2, 0.6, 2.4);
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`shop:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      const wantAwning = r() < aChance;
      const wantSign = r() < sChance;
      const uA = r();
      const uC = r();
      const uS = r();
      if (!wantAwning && !wantSign) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall || wall.height < 4.5) continue;
      const fx = wall.nx;
      const fy = wall.ny;
      const tx = -fy;
      const ty = fx;
      // the wall must run straight on both sides of the spot, or the awning would hang past a corner
      const run = (dir) => {
        let n = 0;
        while (n < 2.5) {
          const w2 = nearestWall(walls, wall.qx + fx * 0.15 + tx * dir * (n + 0.5), wall.qy + fy * 0.15 + ty * dir * (n + 0.5), 0.35);
          if (!w2 || w2.nx * fx + w2.ny * fy < 0.97) break;
          n += 0.5;
        }
        return n;
      };
      const room = Math.min(run(1), run(-1)) * 2;
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(wall.qx, wall.qy, path[i], path[i + 1]));
      gap -= e.w / 2;
      if (gap < 0.9) continue;
      const g = this.groundHeight(wall.qx, wall.qy);
      const place = (u, v, h) => [wall.qx + fx * v + tx * u, g + h, -(wall.qy + fy * v + ty * u)];
      const emit = (parts, colours) => {
        for (const p of parts) {
          const q = p.quad.map(([u, v, h]) => place(u, v, h));
          const nrm = p.role === 'under' ? [0, -1, 0] : [fx, 0.4, -fy];
          const both = p.role === 'board' || p.role === 'frame' || p.role === 'arm' || p.role === 'text';
          const hint = both ? [tx, 0, -ty] : nrm;
          batch.quad(q[0], q[1], q[2], q[3], hint, colArr(colours[p.role]));
          if (both) batch.quad(q[0], q[1], q[2], q[3], [-hint[0], 0, -hint[2]], colArr(colours[p.role])); // seen from both sides
        }
      };
      if (wantAwning) {
        const width = awningWidth(uA, room);
        const d = Math.min(depth, gap - 0.4);
        if (width && d >= 0.6) {
          const base = awningColour(o.awningColour, uC);
          this.shopSpots?.push([wall.qx, wall.qy, fx, fy, 'awning']);
          emit(awningParts({ width, depth: d, top: 3.1, stripes: Math.max(2, Math.round(width * 2)) }), {
            cloth: base, alt: mixHex(base, '#f6f1e4', 0.82), under: mixHex(base, '#000000', 0.55),
          });
          continue; // an awning takes the shop front; the sign goes on the neighbouring spots
        }
      }
      if (wantSign && room >= 1 && wall.height >= 6 && gap >= 1.6) {
        const board = signColour(uS);
        this.shopSpots?.push([wall.qx, wall.qy, fx, fy, 'sign']);
        emit(signParts({ width: 0.7, height: 0.9 + 1.0 * uC, out: 0.85, top: 3.7 + 1.1 * uA }), {
          arm: '#3a3d42', frame: '#3a3d42', board, text: mixHex(board, '#14161a', 0.78),
        });
      }
    }
  }

  /**
   * Flat painted shapes (a sign face, a mirror) facing (fx, fy): `shapes` are { pts, col } in the sign's own plane,
   * scaled by `rad` and centred at local (x, y), `h` metres up. Layers are lifted a hair apart so they never fight.
   */
  _flatShapes(batch, shapes, x, y, h, fx, fy, rad) {
    const px = -fy;
    const py = fx;
    const hint = [fx, 0, -fy];
    shapes.forEach((sh, layer) => {
      const lift = 0.004 * layer;
      const at = ([a, b]) => [x + px * a * rad + fx * lift, h + b * rad, -(y + py * a * rad + fy * lift)];
      const { pts, tris } = triangulate(sh.pts, []);
      const col = colArr(sh.col);
      for (const t of tris) {
        const A = pts[t[0]];
        const B = pts[t[1]];
        const C = pts[t[2]];
        batch.tri(at([A.x, A.y]), at([B.x, B.y]), at([C.x, C.y]), hint, col);
      }
    });
  }

  /** A traffic sign on a pole: the pole, a grey back and the painted face turned to oncoming traffic. */
  _signOnPole(batch, x, y, fx, fy, kind, style, rad = 0.3) {
    const g = this.groundHeight(x, y);
    this.signSpots?.push([x, y, fx, fy, kind]);
    const top = 2.5 + rad;
    this._tube(batch, [x, g, -y], [x, g + top, -y], 0.04, colArr(SIGN_POLE));
    const shapes = signShapes(kind, style);
    this._flatShapes(batch, [{ pts: shapes[0].pts, col: SIGN_POLE }], x - fx * 0.05, y - fy * 0.05, g + 2.5, -fx, -fy, rad * 1.02); // the back
    this._flatShapes(batch, shapes, x + fx * 0.05, y + fy * 0.05, g + 2.5, fx, fy, rad);
  }

  /**
   * Flat painted shapes lying on the ground at local (x, y), `h` metres above the ground, turned so the shape's y runs
   * along the unit vector (ax, ay). Each { pts, shade } is drawn in `tone` scaled by its shade, a hair above the last.
   */
  _groundShapes(batch, shapes, x, y, ax, ay, h, tone, heightAt) {
    const g = heightAt ? heightAt(x, y) : this.groundHeight(x, y);
    const bx = ay; // the shape's x runs across
    const by = -ax;
    const base = Array.isArray(tone) ? tone : colArr(tone);
    shapes.forEach((sh, layer) => {
      const col = base.map((v) => clamp(v * sh.shade, 0, 1));
      const at = ([u, v]) => [x + bx * u + ax * v, g + h + 0.002 * layer, -(y + by * u + ay * v)];
      const { pts, tris } = triangulate(sh.pts, []);
      for (const t of tris) batch.tri(at([pts[t[0]].x, pts[t[0]].y]), at([pts[t[1]].x, pts[t[1]].y]), at([pts[t[2]].x, pts[t[2]].y]), UP, col);
    });
  }

  /**
   * Manhole covers in the lanes, drain grates at the kerb and utility plates on the pavement along a street (the
   * "Manholes and drains" slider, size and colour; see roadcovers.js).
   */
  _roadCovers(batch, path, e) {
    const o = this.options;
    const density = o.coverDensity ?? 50;
    if (!(density > 0)) return;
    const every = 8;
    const size = Number(o.coverSize ?? 1) || 1;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    for (const s of samplePoly(path, every, every / 2)) {
      const r = rng(hashStr(`cover:${s.x.toFixed(1)}:${s.y.toFixed(1)}`));
      const tone = coverTone(o.coverTone, r());
      if (r() < coverChance(density, COVER_SPACING.manhole, every)) {
        const off = manholeOffset(r(), e.w);
        const x = s.x + s.nx * off;
        const y = s.y + s.ny * off;
        this._groundShapes(batch, coverShapes('manhole', size), x, y, s.tx, s.ty, 0.1, tone, e.heightAt);
      }
      const side = r() < 0.5 ? 1 : -1;
      if (e.w >= 5 && r() < coverChance(density, COVER_SPACING.drain, every)) {
        const off = e.w / 2 - 0.3; // in the gutter, long side along the kerb
        this._groundShapes(batch, coverShapes('drain', size), s.x + s.nx * off * side, s.y + s.ny * off * side, s.tx, s.ty, 0.1, tone, e.heightAt);
      }
      if (r() < coverChance(density, COVER_SPACING.plate, every)) {
        const off = e.w / 2 + 1.6;
        const x = s.x + s.nx * off * -side;
        const y = s.y + s.ny * off * -side;
        if (!insideBuilding(walls, x, y)) this._groundShapes(batch, coverShapes('plate', size), x, y, s.tx, s.ty, 0.075, tone, e.heightAt);
      }
    }
  }

  /**
   * Repair patches and cracks in the carriageway: thin raised geometry, so the line pass inks round them (a texture
   * would vanish in the cel pass). Amounts from the "Road patches" and "Road cracks" sliders.
   */
  _roadPatches(batch, path, e) {
    const o = this.options;
    const pd = o.patchDensity ?? 40;
    const cd = o.crackDensity ?? 40;
    if (!(pd > 0) && !(cd > 0) && !((o.wetStreets ?? 0) > 0)) return;
    const every = 8;
    const road = colArr(e.major ? PAL.road : PAL.roadMinor);
    for (const s of samplePoly(path, every, every / 2)) {
      const r = rng(hashStr(`patch:${s.x.toFixed(1)}:${s.y.toFixed(1)}`));
      const half = Math.max(0.5, e.w / 2 - 0.9);
      if (r() < patchChance(pd, PATCH_SPACING, every)) {
        const { w, d } = patchSize(r(), r(), o.patchSize);
        const off = (r() * 2 - 1) * Math.max(0, half - w / 2);
        const turn = (r() - 0.5) * 0.5;
        const ax = s.tx * Math.cos(turn) - s.ty * Math.sin(turn);
        const ay = s.tx * Math.sin(turn) + s.ty * Math.cos(turn);
        const shade = patchShade(r());
        const tone = road.map((v) => clamp(v * shade, 0, 1));
        this._groundShapes(batch, [{ pts: patchPolygon(r, w, d), shade: 1 }], s.x + s.nx * off, s.y + s.ny * off, ax, ay, 0.082, tone, e.heightAt);
      }
      if (r() < patchChance(cd, CRACK_SPACING, every)) {
        const off = (r() * 2 - 1) * half;
        const pts = crackPoints(r, 1.5 + r() * 3.5).map(([u, v]) => [s.x + s.nx * (off + u) + s.tx * (v - 1.5), s.y + s.ny * (off + u) + s.ty * (v - 1.5)]);
        this._ribbon(batch, pts, 0.05, 0.086, road.map((v) => v * 0.4), false, e.heightAt);
      }
      if (r() < puddleChance(o.wetStreets ?? 0, every)) {
        const { w, d } = puddleSize(r(), r(), o.puddleSize);
        const side = r() < 0.5 ? 1 : -1;
        const off = side * Math.max(0, half - 0.2 - r() * Math.min(1.8, half));
        const sky = colArr(r() < 0.5 ? '#a8c6de' : '#bfd4e6');
        this._groundShapes(batch, [{ pts: puddlePolygon(r, w, d), shade: 1 }], s.x + s.nx * off, s.y + s.ny * off, s.tx, s.ty, 0.088, sky, e.heightAt);
      }
    }
  }

  /**
   * Street lamps along a street, alternating sides: how many from the "Street lamps" slider, the design from the
   * style (see lamps.js). Each also gets a night glow point.
   */
  _streetLamps(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const style = lampStyleFor(o.lampStyle, centre);
    const every = 10;
    const chance = lampChance(o.lampDensity ?? 40, lampSpacing(style), every) / 2;
    if (chance <= 0) return;
    const top = lampHeight(style, o.lampHeight);
    const parts = lampParts(style, top);
    const pole = colArr(LAMP_POLE[style]);
    const cols = { pole, head: pole.map((v) => v * 0.8), glass: colArr(LAMP_GLASS) };
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`lamp:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 0.6;
      const x = s.x + s.nx * off * side;
      const y = s.y + s.ny * off * side;
      if (!this._clearOf(x, y, 1.5) || insideBuilding(walls, x, y)) continue;
      const ux = -s.nx * side; // from the pole towards the street
      const uy = -s.ny * side;
      const vx = -uy;
      const vy = ux;
      const g = this.groundHeight(x, y);
      const P = (u, h, v) => [x + ux * u + vx * v, g + h, -(y + uy * u + vy * v)];
      for (const t of parts.tubes) this._tube(batch, P(...t.a), P(...t.b), t.r, cols[t.role]);
      for (const b of parts.boxes) {
        const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [x + ux * u + vx * v, y + uy * u + vy * v]);
        this._prism(batch, q, b.h0, b.h1, cols[b.role], () => g);
      }
      this._lampPts.push([x + ux * parts.bulb[0], y + uy * parts.bulb[0], parts.bulb[1]]); // the lamp glows at night
    }
  }

  /** A squashed icosahedron blob (leaves, flowers) centred at a world point, radius `rad`, vertical scale `sy`. */
  _blob(batch, cx, cy, cz, rad, sy, col) {
    const base = (this._blobBase ||= new THREE.IcosahedronGeometry(1, 1).toNonIndexed().attributes.position.array);
    for (let i = 0; i < base.length; i += 9) {
      const v = [0, 1, 2].map((k) => [cx + base[i + k * 3] * rad, cy + base[i + k * 3 + 1] * rad * sy, cz + base[i + k * 3 + 2] * rad]);
      const mx = (base[i] + base[i + 3] + base[i + 6]) / 3;
      const my = (base[i + 1] + base[i + 4] + base[i + 7]) / 3;
      const mz = (base[i + 2] + base[i + 5] + base[i + 8]) / 3;
      batch.tri(v[0], v[1], v[2], [mx, my, mz], col);
    }
  }

  /**
   * Potted plants, flower boxes and tubs standing against the building fronts, singly or in a row. How many comes from
   * the place (planterSpacing) and the "Potted plants" slider; type, flower colour and size have their own controls.
   */
  _planters(batch, path, e) {
    const o = this.options;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 8;
    const chance = planterChance(o.planterDensity ?? 30, planterSpacing(this._city && this._city.center), every) / 2;
    if (chance <= 0) return;
    const size = Number(o.planterSize ?? 1) || 1;
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`plant:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall || wall.height < 3) continue;
      const fx = wall.nx;
      const fy = wall.ny;
      const tx = -fy;
      const ty = fx;
      const kind = planterKind(o.planterStyle, r());
      const count = planterCount(kind, r());
      const flower = flowerColour(o.planterColour, r());
      const step = planterWidth(kind) * size + 0.1;
      const cx = wall.qx + fx * 0.3 * size;
      const cy = wall.qy + fy * 0.3 * size;
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
      if (gap - e.w / 2 < 0.8 || !this._clearOf(cx, cy, 1.5)) continue;
      for (let k = 0; k < count; k++) {
        const along = (k - (count - 1) / 2) * step;
        const bx = cx + tx * along;
        const by = cy + ty * along;
        if (insideBuilding(walls, bx, by)) continue;
        const g = this.groundHeight(bx, by);
        this.plantSpots?.push([bx, by, fx, fy, kind]);
        const parts = planterParts(kind, size, r);
        const frame = (u, v) => [bx + tx * u + fx * v, by + ty * u + fy * v];
        for (const b of parts.boxes) {
          const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => frame(u, v));
          this._prism(batch, q, b.h0, b.h1, colArr(POT_COLOURS[b.role]), () => g);
        }
        const leaf = LEAF_COLOURS[Math.floor(r() * LEAF_COLOURS.length)];
        for (const bl of parts.blobs) {
          const [px, py] = frame(bl.u, bl.v);
          const col = colArr(bl.role === 'flower' ? flower : leaf);
          this._blob(batch, px, g + bl.h, -py, bl.r, bl.sy, col);
        }
      }
    }
  }

  /**
   * Balconies stacked on street-facing walls (Japanese apartment blocks have the most), each with a railing or a solid
   * parapet and, by the laundry slider, a drying pole with washing and the odd futon over the rail. Only walls that run
   * along the world axes get them, so they line up with the window grid of the building shader.
   */
  _balconies(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 12;
    const chance = balconyChance(o.balconyDensity ?? 35, balconySpacing(centre), every) / 2;
    if (chance <= 0) return;
    const style = balconyStyleFor(o.balconyStyle, centre);
    const width = clamp(Number(o.balconyWidth ?? 2) || 2, 1.2, 3);
    const cols = Object.fromEntries(Object.entries(BALCONY_COLOURS).map(([k, v]) => [k, colArr(v)]));
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`balc:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 10);
      if (!wall || wall.height < 9) continue;
      const alongX = Math.abs(wall.ny) > 0.97; // wall runs along x, its windows are numbered by world x
      const alongY = Math.abs(wall.nx) > 0.97; // wall runs along y, numbered by world z (= -y)
      if (!alongX && !alongY) continue;
      // centre of the window column nearest the wall point
      const cx = alongX ? columnCentre(wall.qx) : wall.qx;
      const cy = alongY ? -columnCentre(-wall.qy) : wall.qy;
      const fx = alongX ? 0 : Math.sign(wall.nx);
      const fy = alongX ? Math.sign(wall.ny) : 0;
      const tx = -fy;
      const ty = fx;
      // the wall has to run straight on both sides of the balcony, and the street has to be clear below it
      const straight = [-1, 1].every((dir) => {
        const w2 = nearestWall(walls, cx + fx * 0.15 + tx * dir * (width / 2 + 0.2), cy + fy * 0.15 + ty * dir * (width / 2 + 0.2), 0.35);
        return w2 && w2.nx * fx + w2.ny * fy > 0.97;
      });
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
      if (!straight || gap - e.w / 2 < 0.8) continue;
      const g = this.groundHeight(cx, cy);
      const frame = (u, v) => [cx + tx * u + fx * v, cy + ty * u + fy * v];
      const flat = () => g;
      this.balcSpots?.push([cx, cy, fx, fy]);
      const fac = wall.building && this._facadeOf(wall.building);
      const col = columnOf(alongX ? cx : -cy);
      for (const slab of slabHeights(g, wall.height, r, 0.7)) {
        if (fac && !windowBox(fac, col, rowOf(slab - 0.8))) continue; // blank column, door or shop window: no balcony door there
        const base = slab - g;
        for (const b of balconyParts(style, width)) {
          const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => frame(u, v));
          this._prism(batch, q, base + b.h0, base + b.h1, cols[b.role], flat);
        }
        for (const it of laundryItems(o.laundryAmount ?? 50, width, r)) {
          const v0 = it.role === 'pole' ? 0.5 : it.v - 0.02;
          const v1 = it.role === 'pole' ? 0.55 : it.v + 0.02;
          const q = [[it.u0, v0], [it.u1, v0], [it.u1, v1], [it.u0, v1]].map(([u, v]) => frame(u, v));
          this._prism(batch, q, base + it.h0, base + it.h1, colArr(it.colour), flat);
        }
      }
    }
  }

  /**
   * Air-conditioner outdoor units hung on the walls between the windows (the "Wall air-conditioners" slider; Asian
   * apartment blocks are covered in them). Like the balconies they only go on walls that run along the world axes.
   */
  _acUnits(batch, path, e) {
    const o = this.options;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 9;
    const chance = acChance(o.acDensity ?? 30, acSpacing(this._city && this._city.center), every) / 2;
    if (chance <= 0) return;
    const size = Number(o.acSize ?? 1) || 1;
    const dark = colArr('#33363b');
    const metal = colArr('#6f7378');
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`ac:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 10);
      if (!wall || wall.height < 7) continue;
      const alongX = Math.abs(wall.ny) > 0.97;
      const alongY = Math.abs(wall.nx) > 0.97;
      if (!alongX && !alongY) continue;
      const cx = alongX ? gapCentre(wall.qx) : wall.qx;
      const cy = alongY ? -gapCentre(-wall.qy) : wall.qy;
      const fx = alongX ? 0 : Math.sign(wall.nx);
      const fy = alongX ? Math.sign(wall.ny) : 0;
      const tx = -fy;
      const ty = fx;
      const straight = [-1, 1].every((dir) => {
        const w2 = nearestWall(walls, cx + fx * 0.15 + tx * dir * 0.6, cy + fy * 0.15 + ty * dir * 0.6, 0.35);
        return w2 && w2.nx * fx + w2.ny * fy > 0.97;
      });
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
      if (!straight || gap - e.w / 2 < 0.8) continue;
      const g = this.groundHeight(cx, cy);
      const casing = colArr(acTone(o.acTone, r()));
      const cols = { casing, grille: dark, bracket: metal, pipe: metal };
      const frame = (u, v) => [cx + tx * u + fx * v, cy + ty * u + fy * v];
      const fac = wall.building && this._facadeOf(wall.building);
      const gapIdx = Math.round((alongX ? cx : -cy) / 3); // the unit hangs between columns gapIdx - 1 and gapIdx
      for (const base of unitHeights(g, wall.height, r, 0.6)) {
        if (fac && !gapFits(fac, gapIdx, rowOf(base - 1.0), 0.8 * size)) continue; // it would cover glass or a door
        this.acSpots?.push([cx, cy, fx, fy, base]);
        for (const b of acParts(size)) {
          const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => frame(u, v));
          this._prism(batch, q, base - g + b.h0, base - g + b.h1, cols[b.role], () => g);
        }
      }
    }
  }

  /**
   * Paper lanterns hung beside shop doors and noren curtains over them, on street-facing walls (the "Paper lanterns" and
   * "Door curtains" sliders; Japanese shopping alleys are strung with them, see lanterns.js).
   */
  _shopLights(batch, path, e) {
    const o = this.options;
    const spacing = lanternSpacing(this._city && this._city.center);
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 8;
    const pL = lanternChance(o.lanternDensity ?? 30, spacing, every) / 2;
    const pN = lanternChance(o.norenDensity ?? 30, spacing * 1.2, every) / 2;
    if (pL <= 0 && pN <= 0) return;
    const size = Number(o.lanternSize ?? 1) || 1;
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`lant:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      const wantL = r() < pL;
      const wantN = r() < pN;
      if (!wantL && !wantN) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall || wall.height < 3.5) continue;
      const fx = wall.nx;
      const fy = wall.ny;
      const tx = -fy;
      const ty = fx;
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(wall.qx, wall.qy, path[i], path[i + 1]));
      if (gap - e.w / 2 < 0.8) continue;
      // the wall has to run straight for the width of the doorway
      const straight = [-1, 1].every((dir) => {
        const w2 = nearestWall(walls, wall.qx + fx * 0.15 + tx * dir * 1.2, wall.qy + fy * 0.15 + ty * dir * 1.2, 0.35);
        return w2 && w2.nx * fx + w2.ny * fy > 0.97;
      });
      if (!straight) continue;
      const g = this.groundHeight(wall.qx, wall.qy);
      this.lightSpots?.push([wall.qx, wall.qy, fx, fy, wantL, wantN]);
      const frame = (u, v) => [wall.qx + tx * u + fx * v, wall.qy + ty * u + fy * v];
      const box = (b, col) => this._prism(batch, [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => frame(u, v)), b.h0, b.h1, col, () => g);
      if (wantN) {
        const cloth = colArr(NOREN_COLOURS[Math.floor(r() * NOREN_COLOURS.length)]);
        const cols = { cloth, band: colArr('#ece7d8'), rod: colArr('#3a3430') };
        for (const b of norenParts(1.2, 2.15, 0.7, 3)) box(b, cols[b.role]);
      }
      if (wantL) {
        const n = lanternCount(r());
        const tone = colArr(lanternColour(o.lanternColour, r()));
        const p = lanternParts(size);
        for (let k = 0; k < n; k++) {
          const u = wantN ? 1.0 + k * 0.5 : (k - (n - 1) / 2) * 0.55; // beside a doorway curtain, else a row on its own
          const cols = { dark: colArr('#2b2724'), arm: colArr('#3a3d42'), label: colArr(tone[0] > 0.6 && tone[1] > 0.6 ? '#2b2724' : '#f1ece0') };
          for (const b of p.boxes) box({ ...b, u0: b.u0 + u, u1: b.u1 + u }, cols[b.role]);
          const [bx, by] = frame(u, p.blob.v);
          this._blob(batch, bx, g + p.blob.h, -by, p.blob.r, p.blob.sy, tone);
        }
      }
    }
  }

  /**
   * Post boxes on the pavement: a red cylinder in Japan and Korea, a yellow box in France, a pillar box elsewhere
   * (the "Post boxes" slider, design and size; see postboxes.js). They stand by the kerb with the slot facing away from the road.
   */
  _postBoxes(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const every = 10;
    const chance = postboxChance(o.postboxDensity ?? 20, postboxSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const style = postboxStyleFor(o.postboxStyle, centre);
    const hex = postboxColour(style, centre);
    const size = Number(o.postboxSize ?? 1) || 1;
    const parts = postboxParts(style, size);
    const cols = { body: colArr(hex), trim: colArr('#2b2d31'), slot: colArr('#101114'), plate: colArr('#f1efe6') };
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`post:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 0.9;
      const x = s.x + s.nx * off * side;
      const y = s.y + s.ny * off * side;
      if (!this._clearOf(x, y, 1.5) || insideBuilding(walls, x, y)) continue;
      const fx = s.nx * side; // the slot faces the pavement, away from the road
      const fy = s.ny * side;
      const tx = -fy;
      const ty = fx;
      const g = this.groundHeight(x, y);
      this.postSpots?.push([x, y, fx, fy, style]);
      if (parts.cyl) this._cylinder(batch, x, y, parts.cyl.r, g + parts.cyl.h0, g + parts.cyl.h1, cols.body, 14);
      for (const b of parts.boxes) {
        const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [x + tx * u + fx * v, y + ty * u + fy * v]);
        this._prism(batch, q, b.h0, b.h1, cols[b.role], () => g);
      }
    }
  }

  /** Traffic signs along a street: one side at a time, facing oncoming traffic. How many: the "Traffic signs" slider. */
  _roadSigns(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const every = 10;
    const chance = roadSignChance(o.roadSignDensity ?? 35, roadSignSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const style = roadSignStyle(o.roadSignStyle, centre);
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`rsign:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 0.7;
      const x = s.x + s.nx * off * side;
      const y = s.y + s.ny * off * side;
      if (!this._clearOf(x, y, 1.5) || insideBuilding(walls, x, y)) continue;
      const dir = r() < 0.5 ? 1 : -1;
      this._signOnPole(batch, x, y, s.tx * dir, s.ty * dir, roadSignKind(style, r()), style);
    }
  }

  /** Orange-poled curve mirrors at junctions (Japan and Korea): two round mirrors on a pole at a corner, turned to the junction. */
  _curveMirrors(batch, junctions, entries) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const rim = { pts: Array.from({ length: 16 }, (_, i) => [Math.cos((i / 16) * 6.2832), Math.sin((i / 16) * 6.2832)]), col: MIRROR_POLE };
    const glass = { pts: rim.pts.map(([a, b]) => [a * 0.84, b * 0.84]), col: '#a9cfe2' };
    for (const j of junctions) {
      const r = rng(hashStr(`mirror:${j.x.toFixed(1)}:${j.y.toFixed(1)}`));
      if (!hasCurveMirror(o.mirrorDensity ?? 60, centre, r()) || j.legs.length < 3) continue;
      const leg = j.legs[Math.floor(r() * j.legs.length)];
      const sgn = r() < 0.5 ? 1 : -1;
      const x = leg.px + leg.ux * (leg.w / 2 + 2.5) - leg.uy * sgn * (leg.w / 2 + 0.8);
      const y = leg.py + leg.uy * (leg.w / 2 + 2.5) + leg.ux * sgn * (leg.w / 2 + 0.8);
      if (!this._clearOf(x, y, 1.5) || insideBuilding(walls, x, y)) continue;
      let fx = j.x - x;
      let fy = j.y - y;
      const L = Math.hypot(fx, fy) || 1;
      fx /= L;
      fy /= L;
      const g = this.groundHeight(x, y);
      this.signSpots?.push([x, y, fx, fy, 'mirror']);
      this._tube(batch, [x, g, -y], [x, g + 3.7, -y], 0.05, colArr(MIRROR_POLE));
      for (const dh of [2.4, 3.15]) {
        this._flatShapes(batch, [{ pts: rim.pts, col: MIRROR_POLE }], x - fx * 0.05, y - fy * 0.05, g + dh, -fx, -fy, 0.36); // back
        this._flatShapes(batch, [rim, glass], x + fx * 0.05, y + fy * 0.05, g + dh, fx, fy, 0.36);
      }
    }
  }

  /**
   * Parked bicycles on the pavement: one leaning along a wall, or a row or rack of them nose-in. How many comes
   * from the place (bikeSpacing) and the "Parked bicycles" slider.
   */
  _bicycles(batch, path, e) {
    const o = this.options;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 10;
    const chance = bikeChance(o.bikeDensity ?? 30, bikeSpacing(this._city && this._city.center), every) / 2;
    if (chance <= 0) return;
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`bike:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall) continue;
      const fx = wall.nx;
      const fy = wall.ny;
      const grp = bikeGroup(r());
      const style = bikeStyle(o.bikeStyle, r());
      const colour = bikeColour(o.bikeColour, r());
      const sx = r() < 0.5 ? 1 : -1; // which way a lone bike points along the wall
      const cx = wall.qx + fx * (grp.row ? 0.95 : 0.55);
      const cy = wall.qy + fy * (grp.row ? 0.95 : 0.55);
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
      if (gap - e.w / 2 < (grp.row ? 1.5 : 1) || !this._clearOf(cx, cy, 1.5)) continue;
      const tx = -fy;
      const ty = fx;
      for (let k = 0; k < grp.count; k++) {
        const along = (k - (grp.count - 1) / 2) * 0.62;
        const bx = cx + (grp.row ? tx * along : 0);
        const by = cy + (grp.row ? ty * along : 0);
        if (insideBuilding(walls, bx, by)) continue;
        // a lone bike lies along the wall; in a row each stands nose to the wall, front towards the street or the wall by turns
        const ax = grp.row ? fx * (k % 2 ? -1 : 1) : tx * sx;
        const ay = grp.row ? fy * (k % 2 ? -1 : 1) : ty * sx;
        this._bicycle(batch, bx, by, ax, ay, style, o.bikeColour === 'mixed' && k ? bikeColour('mixed', r()) : colour);
      }
    }
  }

  /**
   * Parked scooters and motorbikes: one beside a wall, or a tight row or crowd of them side by side with their
   * fronts to the street. How many comes from the place (scooterSpacing) and the "Parked scooters" slider.
   */
  _scooters(batch, path, e) {
    const o = this.options;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 10;
    const chance = scooterChance(o.scooterDensity ?? 20, scooterSpacing(this._city && this._city.center), every) / 2;
    if (chance <= 0) return;
    const size = Number(o.scooterSize ?? 1) || 1;
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`scooter:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.6;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall) continue;
      const fx = wall.nx;
      const fy = wall.ny;
      const grp = scooterGroup(r());
      const style = scooterStyle(o.scooterStyle, r());
      const sx = r() < 0.5 ? 1 : -1; // which way a lone machine points along the wall
      const reach = grp.row ? 1.2 : 0.55;
      const cx = wall.qx + fx * reach;
      const cy = wall.qy + fy * reach;
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
      if (gap - e.w / 2 < (grp.row ? 1.4 : 0.9) || !this._clearOf(cx, cy, 1.6)) continue;
      const tx = -fy;
      const ty = fx;
      for (let k = 0; k < grp.count; k++) {
        const along = (k - (grp.count - 1) / 2) * 0.72 * size;
        const bx = cx + (grp.row ? tx * along : 0);
        const by = cy + (grp.row ? ty * along : 0);
        if (insideBuilding(walls, bx, by)) continue;
        // a lone machine lies along the wall; in a row each stands nose to the street, side by side
        const ax = grp.row ? fx : tx * sx;
        const ay = grp.row ? fy : ty * sx;
        this._scooter(batch, bx, by, ax, ay, style, size, o.scooterColour === 'mixed' ? scooterColour('mixed', r()) : scooterColour(o.scooterColour, 0));
      }
    }
  }

  /** One scooter or motorbike at local (x, y) pointing along the unit vector (ax, ay), built from scooterParts. */
  _scooter(batch, x, y, ax, ay, style, size, bodyHex) {
    const g = this.groundHeight(x, y);
    this.scooterSpots?.push([x, y, ax, ay, style]);
    const sx = -ay;
    const sy = ax;
    const P = (u, h, v) => [x + ax * u + sx * v, g + h, -(y + ay * u + sy * v)];
    const parts = scooterParts(style, size);
    const cols = { body: colArr(bodyHex), dark: colArr('#2a2c30'), seat: colArr('#1b1c1f'), metal: colArr('#9aa0a6'), light: colArr('#f2edd0'), tail: colArr('#c3302b') };
    for (const t of parts.tubes) this._tube(batch, P(...t.a), P(...t.b), 0.02, cols[t.role]);
    const tyre = colArr('#1f2023');
    const hub = colArr('#aeb3b8');
    for (const w of parts.wheels) {
      const n = 12;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        this._tube(batch, P(w.u + Math.cos(a0) * w.r, w.h + Math.sin(a0) * w.r, 0), P(w.u + Math.cos(a1) * w.r, w.h + Math.sin(a1) * w.r, 0), 0.05, tyre);
      }
      this._tube(batch, P(w.u, w.h, -0.06), P(w.u, w.h, 0.06), 0.045, hub); // the hub
    }
    for (const b of parts.boxes) {
      const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [x + ax * u + sx * v, y + ay * u + sy * v]);
      this._prism(batch, q, b.h0, b.h1, cols[b.role], () => g);
    }
  }

  /**
   * Flocks of pigeons (or crows in Japan) on the pavement, some pecking at the ground, all facing every which way.
   * How many comes from the place (birdSpacing) and the "Birds" slider.
   */
  _birds(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const every = 10;
    const chance = birdChance(o.birdDensity ?? 25, birdSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const size = Number(o.birdSize ?? 1) || 1;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const cols = { body: null, wing: null, head: null, beak: colArr('#d8a84a'), leg: colArr('#b4585a'), tail: null };
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`bird:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const kind = birdKind(o.birdKind, centre, r());
      const n = flockSize(kind, r());
      const off = e.w / 2 + 1.2 + r() * 1.6;
      const cx = s.x + s.nx * off * side;
      const cy = s.y + s.ny * off * side;
      if (!this._clearOf(cx, cy, 1.5) || insideBuilding(walls, cx, cy)) continue;
      const body = colArr(BIRD_COLOURS[kind]);
      const dark = colArr(kind === 'crow' ? '#101114' : '#5b616b');
      const palette = { ...cols, body, wing: dark, head: kind === 'crow' ? body : colArr('#6d7a8f'), tail: dark };
      if (kind === 'crow') palette.leg = colArr('#16171a');
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * 1.1;
        const x = cx + Math.cos(a) * d;
        const y = cy + Math.sin(a) * d;
        if (insideBuilding(walls, x, y)) continue;
        const yaw = r() * Math.PI * 2;
        const ax = Math.cos(yaw);
        const ay = Math.sin(yaw);
        const sx = -ay;
        const sy = ax;
        const g = this.groundHeight(x, y);
        this.birdSpots?.push([x, y, ax, ay, kind]);
        for (const b of birdParts(kind, size, r() < 0.4)) {
          const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [x + ax * u + sx * v, y + ay * u + sy * v]);
          this._prism(batch, q, b.h0, b.h1, palette[b.role], () => g);
        }
      }
    }
  }

  /**
   * Poster columns (a ring of posters under a green cap, as in Paris) and two-sided advertising panels on the pavement
   * (the "Poster columns" slider, design, poster colours and size; see posters.js).
   */
  _posters(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const every = 10;
    const chance = adChance(o.adDensity ?? 15, adSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const kind = adKind(o.adStyle, centre);
    const size = Number(o.adSize ?? 1) || 1;
    const parts = posterParts(kind, size);
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const cols = { base: colArr('#2f5a45'), cap: colArr('#2f5a45'), top: colArr('#244a38'), frame: colArr('#3a3d42') };
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`ad:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.1;
      const x = s.x + s.nx * off * side;
      const y = s.y + s.ny * off * side;
      if (!this._clearOf(x, y, 2) || insideBuilding(walls, x, y)) continue;
      const g = this.groundHeight(x, y);
      this.adSpots?.push([x, y, kind]);
      for (const ring of parts.rings) {
        if (ring.role !== 'band') { this._cylinder(batch, x, y, ring.r, g + ring.h0, g + ring.h1, cols[ring.role], 12); continue; }
        const n = parts.sectors;
        const P = (k, rad, h) => [x + Math.cos((k / n) * Math.PI * 2) * rad, g + h, -(y + Math.sin((k / n) * Math.PI * 2) * rad)];
        for (let k = 0; k < n; k++) {
          const col = colArr(posterColour(o.posterColour, r()));
          const m = ((k + 0.5) / n) * Math.PI * 2;
          batch.quad(P(k, ring.r, ring.h0), P(k + 1, ring.r, ring.h0), P(k + 1, ring.r, ring.h1), P(k, ring.r, ring.h1), [Math.cos(m), 0, -Math.sin(m)], col);
          // a bright strip across each poster, like a headline
          const mid = (ring.h0 + ring.h1) / 2 + (r() - 0.5) * 0.5;
          const strip = colArr(posterColour(o.posterColour, r()));
          batch.quad(P(k, ring.r + 0.01, mid - 0.12), P(k + 1, ring.r + 0.01, mid - 0.12), P(k + 1, ring.r + 0.01, mid + 0.12), P(k, ring.r + 0.01, mid + 0.12), [Math.cos(m), 0, -Math.sin(m)], strip);
        }
        this._cylinder(batch, x, y, ring.r * 0.9, g + ring.h0, g + ring.h1, cols.top, 12);
      }
      if (parts.boxes.length) {
        const fx = s.nx * side; // one poster faces the road, the other the pavement
        const fy = s.ny * side;
        const tx = -fy;
        const ty = fx;
        const poster = [colArr(posterColour(o.posterColour, r())), colArr(posterColour(o.posterColour, r()))];
        let pi = 0;
        for (const b of parts.boxes) {
          const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [x + tx * u + fx * v, y + ty * u + fy * v]);
          this._prism(batch, q, b.h0, b.h1, b.role === 'poster' ? poster[pi++] : cols.frame, () => g);
        }
      }
    }
  }

  /**
   * Rubbish on the pavement: heaps of bin bags and wheelie bins against walls, round litter bins by the kerb. What goes
   * where follows the place (rubbishSpacing, rubbishKind) and the "Rubbish" sliders.
   */
  _rubbish(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const every = 8;
    const chance = rubbishChance(o.rubbishDensity ?? 25, rubbishSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const size = Number(o.rubbishSize ?? 1) || 1;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`rubbish:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const kind = rubbishKind(o.rubbishKind, centre, r());
      const hex = binColour(o.binColour, r());
      const count = 2 + Math.floor(r() * 6);
      if (kind === 'litter') {
        const off = e.w / 2 + 0.9;
        const x = s.x + s.nx * off * side;
        const y = s.y + s.ny * off * side;
        if (!this._clearOf(x, y, 1.5) || insideBuilding(walls, x, y)) continue;
        this._binAt(batch, x, y, s.nx * side, s.ny * side, kind, size, hex);
        continue;
      }
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall) continue;
      const cx = wall.qx + wall.nx * 0.4;
      const cy = wall.qy + wall.ny * 0.4;
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
      if (gap - e.w / 2 < 0.9 || !this._clearOf(cx, cy, 1.5) || insideBuilding(walls, cx, cy)) continue;
      if (kind === 'wheelie') {
        const n = 1 + Math.floor(r() * 3);
        const tx = -wall.ny;
        const ty = wall.nx;
        for (let k = 0; k < n; k++) {
          const along = (k - (n - 1) / 2) * 0.75 * size;
          this._binAt(batch, cx + tx * along, cy + ty * along, wall.nx, wall.ny, kind, size, o.binColour === 'mixed' ? binColour('mixed', r()) : hex);
        }
        continue;
      }
      // a heap of bags
      const g = this.groundHeight(cx, cy);
      const tx = -wall.ny;
      const ty = wall.nx;
      this.rubbishSpots?.push([cx, cy, wall.nx, wall.ny, kind]);
      for (const b of bagPile(count, r, size)) {
        const bx = cx + tx * b.u + wall.nx * b.v;
        const by = cy + ty * b.u + wall.ny * b.v;
        this._blob(batch, bx, g + b.h, -by, b.r, b.sy, colArr(bagColour(r())));
      }
    }
  }

  /** One wheelie or litter bin standing at local (x, y) with its front towards (fx, fy), built from binParts. */
  _binAt(batch, x, y, fx, fy, kind, size, bodyHex) {
    const g = this.groundHeight(x, y);
    this.rubbishSpots?.push([x, y, fx, fy, kind]);
    const tx = -fy;
    const ty = fx;
    const parts = binParts(kind, size);
    const cols = { body: colArr(bodyHex), lid: colArr(kind === 'litter' ? '#2b2d31' : bodyHex === BIN_COLOURS.black ? '#3a3d42' : '#e0b92e'), wheel: colArr('#1f2023'), band: colArr('#c8ccd0') };
    if (parts.cyl) this._cylinder(batch, x, y, parts.cyl.r, g + parts.cyl.h0, g + parts.cyl.h1, cols.body, 12);
    for (const b of parts.boxes) {
      const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [x + tx * u + fx * v, y + ty * u + fy * v]);
      this._prism(batch, q, b.h0, b.h1, cols[b.role], () => g);
    }
  }

  /**
   * Street-name plates screwed to street-facing walls between the ground-floor and first-floor windows (the "Street
   * name plates" slider, colour and size; see streetnames.js).
   */
  _streetPlates(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const every = 12;
    const chance = plateChance(o.plateDensity ?? 25, plateSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const hex = plateColour(o.plateColour, centre);
    const ink = colArr(plateInk(hex));
    const cols = { border: ink, plate: colArr(hex), text: ink };
    const size = Number(o.plateSize ?? 1) || 1;
    const parts = plateParts(size);
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`plate:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall) continue;
      const fx = wall.nx;
      const fy = wall.ny;
      const tx = -fy;
      const ty = fx;
      const straight = [-1, 1].every((dir) => {
        const w2 = nearestWall(walls, wall.qx + fx * 0.15 + tx * dir * 0.5 * size, wall.qy + fy * 0.15 + ty * dir * 0.5 * size, 0.35);
        return w2 && w2.nx * fx + w2.ny * fy > 0.97;
      });
      if (!straight) continue;
      const g = this.groundHeight(wall.qx, wall.qy);
      const mid = plateCentre(g, wall.height);
      if (mid === null) continue;
      this.plateSpots?.push([wall.qx, wall.qy, fx, fy]);
      for (const b of parts) {
        const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [wall.qx + tx * u + fx * v, wall.qy + ty * u + fy * v]);
        this._prism(batch, q, mid - g + b.h0, mid - g + b.h1, cols[b.role], () => g);
      }
    }
  }

  /**
   * Fallen leaves or petals under the street trees (the "Fallen leaves" slider, colour and size; see litter.js): small
   * flat diamonds lying a few centimetres above the ground within a few metres of each trunk.
   */
  _leafLitter(pts, season) {
    const o = this.options;
    const density = Number(o.litterDensity ?? 0);
    if (!(density > 0)) return;
    const kind = litterKind(o.litterColour, season);
    if (!kind) return;
    const size = Number(o.litterSize ?? 1) || 1;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const batch = new Batch();
    let total = 0;
    for (let i = 0; i < pts.length && total < 60000; i++) {
      const [tx, ty] = pts[i];
      const r = rng(hashStr(`litter:${i}`));
      const n = litterCount(density, r());
      for (const p of litterScatter(n, 3.2, r)) {
        const x = tx + p.dx;
        const y = ty + p.dy;
        if (insideBuilding(walls, x, y) || this._surfaces.waterHeightAt(x, y) !== null) continue;
        const g = this.groundHeight(x, y) + 0.04;
        const col = colArr(litterColour(kind, r()));
        const c = litterShape(size, p.k, p.rot).map(([u, v]) => [x + u, g, -(y + v)]);
        batch.tri(c[0], c[1], c[2], UP, col);
        batch.tri(c[0], c[2], c[3], UP, col);
        total++;
      }
    }
    if (!batch.empty) this._addMesh(batch.toGeometry(), 'detail', 'details', { name: 'leaf-litter', cast: false });
  }

  /**
   * Window shutters on street walls: runs of one to five neighbouring windows, on several floors, with open shutters
   * either side or closed ones across (the "Window shutters" slider, colour and share closed; see shutters.js). Like the
   * balconies they only go on walls that run along the world axes, so they line up with the shader's window grid.
   */
  _shutters(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 10;
    const chance = shutterChance(o.shutterDensity ?? 30, shutterSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const closedShare = Number(o.shutterClosed ?? 15);
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`shut:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 10);
      if (!wall || wall.height < 3.5) continue;
      const alongX = Math.abs(wall.ny) > 0.97;
      const alongY = Math.abs(wall.nx) > 0.97;
      if (!alongX && !alongY) continue;
      const fx = alongX ? 0 : Math.sign(wall.nx);
      const fy = alongX ? Math.sign(wall.ny) : 0;
      const tx = -fy;
      const ty = fx;
      const x0 = alongX ? columnCentre(wall.qx) : wall.qx;
      const y0 = alongY ? -columnCentre(-wall.qy) : wall.qy;
      const hex = shutterColour(o.shutterColour, centre, r());
      const panel = colArr(hex);
      const slat = colArr(hex).map((v) => clamp(v * 0.82, 0, 1));
      const cols = { panel, slat };
      const run = shutterRun(r());
      const dir = r() < 0.5 ? 1 : -1;
      const g = this.groundHeight(x0, y0);
      const fac = wall.building && this._facadeOf(wall.building);
      const rows = shutterRows(g, wall.height, r, 0.85);
      for (let k = 0; k < run; k++) {
        // the window's centre; the wall has to run straight past both of its shutters and the street be clear in front
        const cx = x0 + (alongX ? dir * 3 * k : 0);
        const cy = y0 + (alongY ? -dir * 3 * k : 0);
        const straight = [-1, 1].every((d) => {
          const w2 = nearestWall(walls, cx + fx * 0.15 + tx * d * 1.3, cy + fy * 0.15 + ty * d * 1.3, 0.35);
          return w2 && w2.nx * fx + w2.ny * fy > 0.97;
        });
        let gap = Infinity; // distance to the carriageway edge
        for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
        if (!straight || gap - e.w / 2 < 0.8) continue;
        const frame = (u, v) => [cx + tx * u + fx * v, cy + ty * u + fy * v];
        const gk = this.groundHeight(cx, cy);
        this.shutterSpots?.push([cx, cy, fx, fy]);
        const col = columnOf(alongX ? cx : -cy);
        for (const row of rows) {
          const fit = fac ? windowBox(fac, col, rowOf(row)) : DEFAULT_WINDOW;
          if (!fit) continue; // blank column, door or shop window
          const base = row - gk;
          for (const b of shutterParts(isClosed(closedShare, r()) || !canOpen(fit.half), fit)) {
            const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => frame(u, v));
            this._prism(batch, q, base + b.h0, base + b.h1, cols[b.role], () => gk);
          }
        }
      }
    }
  }

  /**
   * Cafe terraces on the pavement in front of walls: a row of one to four small tables with chairs round them, some under a
   * parasol (the "Cafe terraces" slider, chair colour, parasol share and size; see cafe.js).
   */
  _cafes(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    const every = 10;
    const chance = cafeChance(o.cafeDensity ?? 20, cafeSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const size = Number(o.cafeSize ?? 1) || 1;
    const cols = { top: colArr('#d9d4c6'), stem: colArr('#3a3d42'), seat: null, back: null, leg: colArr('#2a2c30') };
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`cafe:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 1.4;
      const wall = nearestWall(walls, s.x + s.nx * off * side, s.y + s.ny * off * side, 9);
      if (!wall) continue;
      const fx = wall.nx;
      const fy = wall.ny;
      const tx = -fy;
      const ty = fx;
      const layout = terraceLayout(r, size);
      const reach = 1.1 * size;
      const cx = wall.qx + fx * reach;
      const cy = wall.qy + fy * reach;
      const half = layout.tables.length * 0.85 * size + 0.6;
      let gap = Infinity; // distance to the carriageway edge
      for (let i = 0; i + 1 < path.length; i++) gap = Math.min(gap, distToSegment(cx, cy, path[i], path[i + 1]));
      // the wall has to run straight along the whole terrace and the pavement be wide enough for it
      const straight = [-1, 1].every((dir) => {
        const w2 = nearestWall(walls, wall.qx + fx * 0.15 + tx * dir * half, wall.qy + fy * 0.15 + ty * dir * half, 0.35);
        return w2 && w2.nx * fx + w2.ny * fy > 0.97;
      });
      if (!straight || gap - e.w / 2 < 1.2 + 0.6 * size || !this._clearOf(cx, cy, 2)) continue;
      const hex = chairColour(o.cafeColour, centre, r());
      const chairCol = colArr(hex);
      const colours = { ...cols, seat: chairCol, back: chairCol };
      const parasolHex = parasolColour(r());
      const g = this.groundHeight(cx, cy);
      this.cafeSpots?.push([cx, cy, fx, fy, layout.tables.length]);
      const world = (u, v) => [cx + tx * u + fx * v, cy + ty * u + fy * v];
      // a piece at (u, v) turned to look along angle `face` (from +u): its own frame is rotated by that angle
      const put = (parts, u, v, face) => {
        const c = Math.cos(face - Math.PI / 2);
        const sn = Math.sin(face - Math.PI / 2);
        for (const b of parts) {
          const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([pu, pv]) => world(u + pu * c - pv * sn, v + pu * sn + pv * c));
          this._prism(batch, q, b.h0, b.h1, colours[b.role], () => g);
        }
      };
      for (const t of layout.tables) {
        put(tableParts(size), t.u, t.v, Math.PI / 2);
        for (const c of t.chairs) put(chairParts(size), c.u, c.v, c.face);
        if (hasParasol(o.cafeParasol ?? 40, r())) {
          const pp = parasolParts(size);
          const [px, py] = world(t.u, t.v);
          this._cylinder(batch, px, py, pp.pole.r, g + pp.pole.h0, g + pp.pole.h1, colArr('#d8d4c8'), 6);
          const rim = colArr(parasolHex);
          const n = 14;
          const P = (k, h) => [px + Math.cos((k / n) * Math.PI * 2) * pp.canopy.r, g + h, -(py + Math.sin((k / n) * Math.PI * 2) * pp.canopy.r)];
          for (let k = 0; k < n; k++) {
            const apex = [px, g + pp.canopy.h1, -py];
            const m = ((k + 0.5) / n) * Math.PI * 2;
            batch.tri(apex, P(k, pp.canopy.h0), P(k + 1, pp.canopy.h0), [Math.cos(m) * 0.4, 0.9, -Math.sin(m) * 0.4], rim);
            batch.tri(apex, P(k + 1, pp.canopy.h0), P(k, pp.canopy.h0), [-Math.cos(m) * 0.4, -0.9, Math.sin(m) * 0.4], rim); // underside
          }
        }
      }
    }
  }

  /**
   * Fire hydrants by the kerb (the "Fire hydrants" slider, colour and size; see hydrants.js): a painted body with side
   * nozzles and a big one facing the street.
   */
  _hydrants(batch, path, e) {
    const o = this.options;
    const centre = this._city && this._city.center;
    const every = 10;
    const chance = hydrantChance(o.hydrantDensity ?? 30, hydrantSpacing(centre), every) / 2;
    if (chance <= 0) return;
    const parts = hydrantParts(Number(o.hydrantSize ?? 1) || 1);
    const hex = hydrantColour(o.hydrantColour, centre);
    const cols = { paint: colArr(hex), cap: colArr(hex).map((v) => v * 0.7) };
    const walls = (this._wallIdx ||= buildWallIndex(this._city && this._city.buildings));
    for (const s of samplePoly(path, every, every / 2)) for (const side of [-1, 1]) {
      const r = rng(hashStr(`hydrant:${s.x.toFixed(1)}:${s.y.toFixed(1)}:${side}`));
      if (r() >= chance) continue;
      const off = e.w / 2 + 0.75;
      const x = s.x + s.nx * off * side;
      const y = s.y + s.ny * off * side;
      if (!this._clearOf(x, y, 1.5) || insideBuilding(walls, x, y)) continue;
      const fx = -s.nx * side; // the big nozzle faces the road
      const fy = -s.ny * side;
      const tx = -fy;
      const ty = fx;
      const g = this.groundHeight(x, y);
      this.hydrantSpots?.push([x, y, fx, fy]);
      for (const c of parts.cyls) this._cylinder(batch, x, y, c.r, g + c.h0, g + c.h1, cols[c.role], 10);
      for (const b of parts.boxes) {
        const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [x + tx * u + fx * v, y + ty * u + fy * v]);
        this._prism(batch, q, b.h0, b.h1, cols[b.role], () => g);
      }
    }
  }

  /** One bicycle at local (x, y) pointing along the unit vector (ax, ay), built from bicycleParts. */
  _bicycle(batch, x, y, ax, ay, style, frameHex) {
    const g = this.groundHeight(x, y);
    this.bikeSpots?.push([x, y, ax, ay]);
    const sx = -ay;
    const sy = ax;
    const P = (u, h, v) => [x + ax * u + sx * v, g + h, -(y + ay * u + sy * v)];
    const parts = bicycleParts(style);
    const cols = { frame: colArr(frameHex), dark: colArr('#2a2c30'), seat: colArr('#1d1e21'), basket: colArr('#9a9ea4') };
    for (const t of parts.tubes) this._tube(batch, P(...t.a), P(...t.b), 0.017, cols[t.role]);
    const tyre = colArr('#25262a');
    const rim = colArr('#b9bdc2');
    for (const w of parts.wheels) {
      const n = 14;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        this._tube(batch, P(w.u + Math.cos(a0) * w.r, w.h + Math.sin(a0) * w.r, 0), P(w.u + Math.cos(a1) * w.r, w.h + Math.sin(a1) * w.r, 0), 0.022, tyre);
        if (i % 2 === 0) this._tube(batch, P(w.u, w.h, 0), P(w.u + Math.cos(a0) * (w.r - 0.02), w.h + Math.sin(a0) * (w.r - 0.02), 0), 0.006, rim); // spoke
      }
    }
    for (const b of parts.boxes) {
      const q = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => [x + ax * u + sx * v, y + ay * u + sy * v]);
      this._prism(batch, q, b.h0, b.h1, cols[b.role], () => g);
    }
  }

  /** A thin square-section tube from p to q (3-vectors, world axes). */
  _tube(batch, p, q, r, col) {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const dz = q[2] - p[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return;
    // u = d x up (horizontal, perpendicular to the wire), v = d x u
    let ux = dz;
    let uy = 0;
    let uz = -dx;
    if (Math.hypot(ux, uz) < 1e-9) ux = 1; // a vertical tube has no horizontal direction to be perpendicular to
    const ul = Math.hypot(ux, uz) || 1;
    ux = (ux / ul) * r;
    uz = (uz / ul) * r;
    let vx = dy * uz - dz * uy;
    let vy = dz * ux - dx * uz;
    let vz = dx * uy - dy * ux;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx = (vx / vl) * r;
    vy = (vy / vl) * r;
    vz = (vz / vl) * r;
    const corner = (pt, su, sv) => [pt[0] + su * ux + sv * vx, pt[1] + sv * vy, pt[2] + su * uz + sv * vz];
    const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < 4; i++) {
      const [s0, t0] = ring[i];
      const [s1, t1] = ring[(i + 1) % 4];
      batch.quad(corner(p, s0, t0), corner(p, s1, t1), corner(q, s1, t1), corner(q, s0, t0), [(s0 + s1) * ux + (t0 + t1) * vx, (t0 + t1) * vy, (s0 + s1) * uz + (t0 + t1) * vz], col);
    }
  }

  /** Vertical box standing on the ground at local (x, y); returns a batchable geometry. */
  _boxAt(x, y, sx, sy, sz, lift, hex) {
    const h = this.groundHeight(x, y);
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, h + lift, -y);
    return toBatchable(g, colArr(hex));
  }

  // ----- railways, water, green, plazas ---------------------------------------

  _buildRailways(railways) {
    const b = new Batch();
    for (const rw of railways || []) {
      if (!rw.points || rw.points.length < 2 || rw.tunnel || rw.kind === 'subway') continue;
      const path = resamplePolyline(rw.points, 4);
      this._ribbon(b, path, 2.4, 0.08, colArr(PAL.rail), true, (x,y) => this._surfaces.heightFor(rw.sourceRoad || rw,x,y));
    }
    return b.toGeometry();
  }

  /** Keep paths and paving above park/grass layers. */
  _buildAreas(water, green, areas, bounds) {
    const wb = new Batch();
    const gb = new Batch();
    const ab = new Batch();
    for (const a of water || []) {
      if (a.outer && a.outer.length >= 3) this._flatPoly(wb, a.outer, a.holes, 0, colArr(PAL.water), true, () => this._surfaces.water.get(a), bounds);
    }
    const courtLines = new Batch();
    const courtGear = new Batch();
    for (const a of green || []) {
      if (!a.outer || a.outer.length < 3) continue;
      const pitchSurface = a.kind === 'pitch' ? courtSurface(a.sport, a.surface) : null;
      const hex = pitchSurface || (a.kind === 'forest' || a.kind === 'wood' ? '#7fae6b' : PAL.green);
      const layer = ['park','recreation_ground'].includes(a.kind) ? 0.012 : ['forest','wood','orchard'].includes(a.kind) ? 0.032 : 0.022;
      this._flatPoly(gb, a.outer, a.holes, layer, colArr(hex), true, null, bounds);
      if (a.kind === 'pitch' && a.sport) this._buildCourt(courtLines, courtGear, a, bounds);
    }
    for (const a of areas || []) {
      if (!a.outer || a.outer.length < 3) continue;
      const hex = a.kind === 'parking' ? PAL.parking : PAL.area;
      this._flatPoly(ab, a.outer, a.holes, 0.04, colArr(hex), true, null, bounds);
    }
    return [
      { geo: wb.toGeometry(), role: 'water', name: 'water', group: 'water' },
      { geo: gb.toGeometry(), role: 'green', name: 'green', group: 'green' },
      { geo: ab.toGeometry(), role: 'area', name: 'areas', group: 'ground' },
      { geo: courtLines.toGeometry(), role: 'lane', name: 'markings', group: 'details' },
      { geo: courtGear.toGeometry(), role: 'detail', name: 'court-equipment', group: 'details' },
    ];
  }

  /**
   * Line markings and equipment (hoops, goals, nets) for a mapped sport pitch. The court is placed in the
   * smallest rectangle around the outline; a pitch is built only by the region its centre falls in, so the
   * inner and surrounding passes never draw it twice.
   */
  _buildCourt(lines, gear, a, bounds) {
    const frame = pitchFrame(a.outer);
    const reach = Math.max(Math.abs(frame.cx), Math.abs(frame.cy));
    if (reach > bounds.half || reach <= bounds.exclude || frame.length < 8 || frame.width < 4) return;
    const layout = courtLayout(courtKind(a.sport), frame.length, frame.width);
    const P = (u, v) => courtToLocal(frame, u, v);
    const lineCol = colArr(PAL.courtLine);
    for (const line of layout.lines) this._ribbon(lines, resamplePolyline(line.map(([u, v]) => P(u, v)), 2), 0.14, 0.09, lineCol);
    // an axis-aligned (in court coordinates) box, from h0 to h1 above the ground
    const box = (u0, u1, v0, v1, h0, h1, col) => this._prism(gear, [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)], h0, h1, colArr(col));
    for (const p of layout.props) {
      if (p.type === 'hoop') {
        // pole behind the baseline, an arm out to the backboard, and the rim as a ring
        const d = p.dir;
        const span = (a0, a1) => [Math.min(p.u + d * a0, p.u + d * a1), Math.max(p.u + d * a0, p.u + d * a1)];
        const [pu0, pu1] = span(-0.7, -0.5), [au0, au1] = span(-0.6, 1.2), [bu0, bu1] = span(1.2, 1.26);
        box(pu0, pu1, p.v - 0.1, p.v + 0.1, 0, 3.5, PAL.hoopPole);
        box(au0, au1, p.v - 0.05, p.v + 0.05, 3.35, 3.45, PAL.hoopPole);
        box(bu0, bu1, p.v - 0.9, p.v + 0.9, 2.9, 3.95, PAL.backboard);
        const rim = [];
        for (let k = 0; k <= 16; k++) rim.push(P(p.u + d * 1.58 + 0.23 * Math.cos((k / 16) * Math.PI * 2), p.v + 0.23 * Math.sin((k / 16) * Math.PI * 2)));
        this._ribbon(gear, rim, 0.05, 3.05, colArr(PAL.rim));
      } else if (p.type === 'goal') {
        const [g0, g1] = [p.u - 0.06, p.u + 0.06], half = p.width / 2;
        box(g0, g1, p.v - half - 0.06, p.v - half + 0.06, 0, p.height, PAL.goal);
        box(g0, g1, p.v + half - 0.06, p.v + half + 0.06, 0, p.height, PAL.goal);
        box(g0, g1, p.v - half, p.v + half, p.height - 0.12, p.height, PAL.goal);
      } else if (p.type === 'net') {
        // two posts and the net's top tape; the net itself is too fine to draw
        const half = p.span / 2;
        box(p.u - 0.05, p.u + 0.05, p.v - half - 0.05, p.v - half + 0.05, 0, p.height + 0.1, PAL.netPost);
        box(p.u - 0.05, p.u + 0.05, p.v + half - 0.05, p.v + half + 0.05, 0, p.height + 0.1, PAL.netPost);
        box(p.u - 0.02, p.u + 0.02, p.v - half, p.v + half, p.height - 0.08, p.height, PAL.netTape);
      }
    }
  }

  // ----- trees ----------------------------------------------------------------

  /**
   * Crown geometry for one tree (unit size, white vertex colour so instance colour applies).
   * Cloudy crown: a cluster of 4-7 overlapping lobes around the centre, each a displaced icosahedron.
   * smooth = few lobes, low noise; bumpy = medium; fluffy = more lobes, high noise. lowPoly = cone.
   * Built once and shared by all trees (instance matrices vary the size and yaw).
   */
  _crownGeometry(edge, lowPoly, season = 'summer', variant = 0) {
    if (lowPoly) {
      const g = new THREE.ConeGeometry(1, 2, 6);
      g.translate(0, 1, 0); // base at y = 0
      return toBatchable(g, [1, 1, 1]);
    }
    const P = CROWN_LOBES[edge] || CROWN_LOBES.smooth;
    const r = rng(hashStr(variant ? `crown:${edge}:${variant}` : `crown:${edge}`));
    const nLobes = P.lobes[0] + Math.floor(r() * (P.lobes[1] - P.lobes[0] + 1));
    const parts = [crownLobe(0, 0.02, 0, 0.6, P.detail, P.disp)];
    for (let k = 1; k < nLobes; k++) {
      const th = ((k - 1) / (nLobes - 1)) * Math.PI * 2 + (r() - 0.5) * 0.8;
      const d = 0.3 + 0.12 * r();
      const rad = P.rad[0] + (P.rad[1] - P.rad[0]) * r();
      parts.push(crownLobe(Math.cos(th) * d, (r() - 0.5) * 0.2, Math.sin(th) * d, rad, P.detail, P.disp));
    }
    const g = tintGeometry(mergeGeometries(parts, false), CROWN_TINT[season]);
    // crown variants: round, tall and slim, wide and low (instances scale on top of this)
    if (variant === 1) g.scale(0.88, 1.18, 0.88);
    else if (variant === 2) g.scale(1.14, 0.82, 1.14);
    return g;
  }

  /** Bare-winter branch cluster at unit scale: eight forking twigs. */
  _branchGeometry() {
    const r = rng(hashStr('bare-branches'));
    const parts = [];
    const twig = (a, b, r0, r1) => parts.push(this._limbPiece(a, b, r0, r1));
    for (let k = 0; k < 8; k++) {
      const th = k * 0.785 + r() * 0.4;
      const out = 0.55 + 0.35 * r();
      const tip = [Math.cos(th) * out, 0.9 + 0.5 * r(), Math.sin(th) * out];
      twig([0, 0, 0], tip, 0.07, 0.025);
      const mid = tip.map((v) => v * 0.55);
      for (const side of [-1, 1]) {
        const a2 = th + side * (0.5 + 0.3 * r());
        twig(mid, [mid[0] + Math.cos(a2) * 0.4, mid[1] + 0.35 + 0.2 * r(), mid[2] + Math.sin(a2) * 0.4], 0.035, 0.012);
      }
    }
    return mergeGeometries(parts, false);
  }

  /** One tapered branch segment from a to b (white vertex colour, 4 sides). */
  _limbPiece(a, b, r0, r1, colour = [1, 1, 1]) {
    const dir = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r1, r0, len, 4, 1, true);
    g.translate(0, len / 2, 0);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
    g.translate(a[0], a[1], a[2]);
    return toBatchable(g, colour);
  }

  /**
   * Limbs under a crown, origin at the trunk top. fork = five limbs rising and forking into a broadleaf
   * crown; spread = a rain tree's wide, low limbs reaching out under a flat canopy (unit crown radius 4.7 m).
   * White vertex colour so the trunk material colours them like the trunk.
   */
  _limbGeometry(shape) {
    const parts = [];
    const thick = shape === 'spread' ? 0.2 : 0.15;
    const bark = colArr(PAL.trunk); // baked in, like the trunk's colour
    for (const { base, knee, tip, fork } of limbSpecs(shape)) {
      parts.push(this._limbPiece(base, knee, thick, thick * 0.7, bark));
      parts.push(this._limbPiece(knee, tip, thick * 0.7, thick * 0.35, bark));
      parts.push(this._limbPiece(knee, fork, thick * 0.5, thick * 0.22, bark));
    }
    return mergeGeometries(parts, false);
  }

  /**
   * Leaves for the limbs: a clump at the end of every limb and fork (and a small one along the limb),
   * so branches are not bare in leaf seasons. Coarse lobes keep it cheap; white vertex colour.
   */
  _limbLeavesGeometry(shape, edge, season = 'summer') {
    const P = CROWN_LOBES[edge] || CROWN_LOBES.smooth;
    const r = rng(hashStr(`limbleaves:${shape}`));
    const big = shape === 'spread' ? 1.5 : 1.0;
    const parts = [];
    const lobe = (c, rad) => parts.push(crownLobe(c[0], c[1], c[2], rad * big, 1, P.disp));
    for (const { knee, tip, fork } of limbSpecs(shape)) {
      lobe(tip, 0.95 + 0.3 * r());
      lobe(fork, 0.75 + 0.25 * r());
      lobe([knee[0] * 1.1, knee[1] + 0.35, knee[2] * 1.1], 0.6 + 0.2 * r());
    }
    return tintGeometry(mergeGeometries(parts, false), CROWN_TINT[season]);
  }

  /** Conifer crown: four stacked cone tiers, base at y = 0, top at y = 1, unit radius. lowPoly = one cone. */
  _coniferGeometry(lowPoly) {
    if (lowPoly) {
      const g = new THREE.ConeGeometry(1, 1, 6);
      g.translate(0, 0.5, 0);
      return toBatchable(g, [1, 1, 1]);
    }
    const parts = [];
    for (let k = 0; k < 4; k++) {
      const g = new THREE.ConeGeometry(1 - k * 0.22, 0.4, 9);
      g.rotateY(k * 0.7);
      g.translate(0, k * 0.2 + 0.2, 0);
      parts.push(toBatchable(g, [1, 1, 1]));
    }
    return tintGeometry(mergeGeometries(parts, false), CONIFER_TINT, 0.1);
  }

  /** Palm crown: eight arching fronds (thin diamond-section strips) from the trunk top at the origin, unit length. */
  _palmGeometry() {
    const seg = 6;
    const pos = [];
    for (let f = 0; f < 8; f++) {
      const th = (f / 8) * Math.PI * 2 + (f % 2) * 0.25;
      const ux = Math.cos(th), uz = Math.sin(th); // outward
      const sx = -uz, sz = ux; // sideways
      const lift = 0.5 + 0.25 * ((f * 5) % 3) / 2;
      const ring = [];
      for (let i = 0; i <= seg; i++) {
        const t = i / seg;
        const cx = ux * t, cz = uz * t, cy = lift * t - 0.95 * t * t;
        const w = 0.2 * Math.sin(Math.PI * Math.min(1, t * 1.1)) + 0.01;
        const h = 0.03;
        ring.push([
          [cx - sx * w, cy - 0.04 * t, cz - sz * w],
          [cx, cy + h, cz],
          [cx + sx * w, cy - 0.04 * t, cz + sz * w],
          [cx, cy - h, cz],
        ]);
      }
      for (let i = 0; i < seg; i++) {
        for (let k = 0; k < 4; k++) {
          const a = ring[i][k], b = ring[i][(k + 1) % 4], c = ring[i + 1][(k + 1) % 4], d = ring[i + 1][k];
          pos.push(...a, ...c, ...b, ...a, ...d, ...c);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return toBatchable(g, [1, 1, 1]);
  }

  /**
   * Trees as instanced meshes: one trunk mesh plus a crown mesh per shape (round, conifer, palm).
   * options.treeType picks the species mix, options.treeSize scales them. Round crowns (broadleaf and
   * columnar) use the detail distance LOD; in winter they become bare branches, conifers and palms stay green.
   */
  _buildTrees(trees, surroundings = false) {
    const opt = this.options;
    const firstMesh = this._meshes.length;
    const season = Object.prototype.hasOwnProperty.call(SEASON_CROWN, opt.season) ? opt.season : 'summer';
    const palette = SEASON_CROWN[season];
    // trunks: tone -> always visible, tone-noline -> colour pass only, lines -> edge pass only
    const trunkLayer = opt.treeStyle === 'tone' ? 0 : opt.treeStyle === 'tone-noline' ? 1 : 2;
    // crowns: tone styles use the tone-crown layer (see LAYER_TONE_CROWN), lines uses the edge layer
    const crownLayer = opt.treeStyle === 'tone' || opt.treeStyle === 'tone-noline' ? LAYER_TONE_CROWN : 2;
    // density: thin out the map's trees, or add street trees on top of them
    const dens = Math.max(0, Math.min(3, Number(opt.treeDensity ?? 100) / 100));
    let pool = trees || [];
    if (dens < 1) pool = pool.filter((_, i) => rng(hashStr(`treethin:${i}`))() < dens);
    const pts = pool.filter((t) => this._clearOf(t[0], t[1], 4.5) && this._surfaces.waterHeightAt(t[0], t[1]) === null);
    if (dens > 1 && !surroundings) pts.push(...this._streetTrees((dens - 1) / 2));
    pts.length = Math.min(pts.length, 40000);
    const n = pts.length;
    if (!n) return;
    if (!surroundings) this._leafLitter(pts, season);

    const mix = parseTreeMix(opt.treeMix, this._city && this._city.center);
    const k0 = Number.isFinite(Number(opt.treeSizeMin)) ? Number(opt.treeSizeMin) : 0.95;
    const k1 = Math.max(k0, Number.isFinite(Number(opt.treeSizeMax)) ? Number(opt.treeSizeMax) : 1.05);
    const pick = (u) => {
      let acc = 0;
      for (const [kind, w] of mix) if (u < (acc += w)) return kind;
      return mix[mix.length - 1][0];
    };

    const trunkGeo = (() => {
      const g = new THREE.CylinderGeometry(0.16, 0.22, 1, 6);
      g.translate(0, 0.5, 0); // base at 0, unit height
      return toBatchable(g, colArr(PAL.trunk));
    })();
    const trunk = new THREE.InstancedMesh(trunkGeo, this._materialFor('tree-trunk'), n);
    this._registerMesh(trunk, 'tree-trunk', 'trees', trunkLayer);

    const m4 = new THREE.Matrix4();
    const qI = new THREE.Quaternion();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    // per crown shape: instance matrices, colours and positions
    const sets = { round: [], roundB: [], roundC: [], conifer: [], palm: [] };
    // lean: tilt the trunk and carry the crown with it
    const qT = new THREE.Quaternion();
    const leanAxis = new THREE.Vector3();
    // colour: palette pick with hue / saturation / lightness jitter, a slow drift between neighbourhoods
    // and a few accent trees
    const tmpC = new THREE.Color();
    const hsl = {};
    // global foliage grading from the world settings: saturation %, hue shift in degrees, lightness %
    const fSat = clamp(Number(opt.foliageSat ?? 100) / 100, 0, 2);
    const fHue = Number(opt.foliageHue ?? 0) / 360;
    const fLit = clamp(Number(opt.foliageLight ?? 100) / 100, 0.4, 1.6);
    const foliage = (hex) => {
      if (fSat === 1 && !fHue && fLit === 1) return hex;
      tmpC.set(hex).getHSL(hsl);
      tmpC.setHSL((hsl.h + fHue + 1) % 1, clamp(hsl.s * fSat, 0, 1), clamp(hsl.l * fLit, 0, 0.95));
      return '#' + tmpC.getHexString();
    };
    const leafColour = (r, x, y) => {
      let hex = palette[Math.floor(r() * palette.length)];
      const accents = ACCENT_CROWN[season];
      if (accents && r() < 0.07) hex = accents[Math.floor(r() * accents.length)];
      const drift = rng(hashStr(`treehue:${Math.floor(x / 60)}:${Math.floor(y / 60)}`))() - 0.5;
      tmpC.set(hex).getHSL(hsl);
      tmpC.setHSL((hsl.h + (r() - 0.5) * 0.05 + drift * 0.04 + 1) % 1, clamp(hsl.s * (0.88 + 0.24 * r()), 0, 1), clamp(hsl.l * (0.86 + 0.28 * r()), 0, 0.95));
      return foliage('#' + tmpC.getHexString());
    };
    // limbs (branches under the crown): per tree matrix, in two shapes
    const limbs = { fork: [], spread: [] };
    const leaves = { fork: [], spread: [] }; // limb matrix + crown colour, in leaf seasons
    const bare = !palette; // winter: the branches are the tree
    const add = (kind, pt, colour) => sets[kind].push({ m: m4.clone(), c: colour, pt });

    for (let i = 0; i < n; i++) {
      const x = pts[i][0];
      const y = pts[i][1];
      const r = rng(hashStr(`tree:${i}`));
      // neighbours tend to share a species (street rows, groves): 70% follow a 40 m cell, 30% pick freely
      const cellU = rng(hashStr(`treecell:${Math.floor(x / 40)}:${Math.floor(y / 40)}`))();
      const kind = pick(r() < 0.7 ? cellU : r());
      const k = k0 + (k1 - k0) * r();
      const g = this.groundHeight(x, y);
      q.setFromAxisAngle(up, r() * Math.PI * 2);
      const pt = [x, -y];

      if (kind === 'conifer') {
        const trunkH = (1.2 + 0.8 * r()) * k;
        const h = (7 + 4 * r()) * k;
        const rad = (1.9 + 0.8 * r()) * k;
        p.set(x, g, -y);
        s.set(1.2 * k, trunkH + h * 0.4, 1.2 * k);
        m4.compose(p, qI, s);
        trunk.setMatrixAt(i, m4);
        p.set(x, g + trunkH, -y);
        s.set(rad, h, rad);
        m4.compose(p, q, s);
        add('conifer', pt, foliage(CONIFER_CROWN[Math.floor(r() * CONIFER_CROWN.length)]));
        continue;
      }
      if (kind === 'palm') {
        const trunkH = (6 + 4 * r()) * k;
        const rad = (2.6 + 0.9 * r()) * k;
        p.set(x, g, -y);
        s.set(0.8 * k, trunkH, 0.8 * k);
        m4.compose(p, qI, s);
        trunk.setMatrixAt(i, m4);
        p.set(x, g + trunkH, -y);
        s.set(rad, rad, rad);
        m4.compose(p, q, s);
        add('palm', pt, foliage(PALM_CROWN[Math.floor(r() * PALM_CROWN.length)]));
        continue;
      }

      // round crowns: broadleaf (wide), umbrella (rain tree: flat and spreading) or columnar (poplar / cypress)
      const columnar = kind === 'columnar';
      const umbrella = kind === 'umbrella';
      const trunkH = (columnar ? 1.2 + 0.8 * r() : umbrella ? 3.2 + 1.6 * r() : 4 + 2 * r()) * k; // 4-6 m trunk for broadleaf
      const cr = (columnar ? 1.3 + 0.5 * r() : umbrella ? 4 + 1.4 * r() : 2.6 + 1.2 * r()) * k; // broadleaf crown 5-8 m across
      const ch = columnar ? (4 + 1.5 * r()) * k : umbrella ? cr * 0.4 : cr * 0.85; // crown vertical scale
      // about half the broadleaf trees show their limbs under a lifted crown; umbrella trees always do
      const branchy = !columnar && !opt.lowPoly && (umbrella || bare || r() < 0.45);
      const wx = cr * (0.9 + 0.2 * r()); // per-tree width jitter (shared crown geometry)
      const wz = cr * (0.9 + 0.2 * r());
      const rk = bare ? 'round' : ['round', 'roundB', 'roundC'][Math.floor(r() * 3)]; // crown shape variant
      // most broadleaf trees lean a little; the crown follows the trunk top
      const lean = columnar ? 0 : (r() - 0.5) * 0.2;
      const lth = r() * Math.PI * 2;
      const lx = Math.cos(lth), lz = Math.sin(lth);
      const sway = Math.tan(Math.abs(lean)) * trunkH; // how far the trunk top moves sideways
      const ox = lx * sway, oz = lz * sway;
      if (lean) qT.setFromAxisAngle(leanAxis.set(lz, 0, -lx), Math.abs(lean));
      else qT.identity();

      // trunk: unit cylinder stretched to trunkH
      p.set(x, g, -y);
      s.set(k, columnar ? trunkH + ch : trunkH, k);
      m4.compose(p, qT, s);
      trunk.setMatrixAt(i, m4);

      let limbM = null;
      if (branchy) {
        // limbs rise from the trunk top (their base sits 0.6 m below it) into the crown
        p.set(x + ox, g + trunkH, -y + oz);
        const w = umbrella ? cr / 4.7 : k; // rain tree limbs scale with the wide crown
        s.set(w, k, w);
        limbM = m4.clone().compose(p, q, s);
        limbs[umbrella ? 'spread' : 'fork'].push(limbM);
      }

      if (palette) {
        if (opt.lowPoly) {
          p.set(x + ox, g + trunkH * 0.8, -y + oz);
          s.set(cr, columnar ? ch * 1.4 : cr * 1.5, cr);
        } else {
          const lift = columnar ? ch * 0.8 : umbrella ? ch * 0.9 + 1.2 * k : branchy ? cr * 0.5 : cr * 0.25;
          p.set(x + ox, g + trunkH + lift, -y + oz);
          s.set(wx, ch, wz);
        }
        m4.compose(p, q, s);
        const leafCol = leafColour(r, x, y);
        if (limbM) leaves[umbrella ? 'spread' : 'fork'].push({ m: limbM, c: leafCol });
        add(rk, pt, leafCol);
      } else {
        // winter: bare branches at the top of the trunk
        p.set(x + ox, g + trunkH * 0.85, -y + oz);
        if (columnar) s.set(cr * 0.7, ch * 0.8, cr * 0.7);
        else s.set(cr * 0.9, cr * 0.9, cr * 0.9);
        m4.compose(p, q, s);
        add('round', pt, '#5c5550');
      }
    }
    trunk.instanceMatrix.needsUpdate = true;
    trunk.computeBoundingSphere();

    for (const [shape, list] of Object.entries(limbs)) {
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(this._limbGeometry(shape), this._materialFor('tree-trunk'), list.length);
      list.forEach((m, j) => im.setMatrixAt(j, m));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this._registerMesh(im, 'tree-trunk', 'trees', trunkLayer, { name: `tree-limbs-${shape}` });
    }

    const crownFor = (v) => () => (palette ? this._crownGeometry(opt.leafEdge, opt.lowPoly, season, v) : this._branchGeometry());
    const geos = {
      round: crownFor(0),
      roundB: crownFor(1),
      roundC: crownFor(2),
      conifer: () => this._coniferGeometry(opt.lowPoly),
      palm: () => this._palmGeometry(),
    };
    const meshes = {};
    for (const kind of Object.keys(sets)) {
      const list = sets[kind];
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(geos[kind](), this._materialFor('tree-crown'), list.length);
      list.forEach((e, j) => {
        im.setMatrixAt(j, e.m);
        im.setColorAt(j, col.set(e.c));
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      this._registerMesh(im, 'tree-crown', 'trees', crownLayer, { name: kind === 'round' ? 'tree-crown' : `tree-crown-${kind}` });
      meshes[kind] = im;
    }

    // leaf clumps on the limbs (same material, layer and colours as the crowns)
    for (const [shape, list] of Object.entries(leaves)) {
      if (!list.length || !palette) continue;
      const im = new THREE.InstancedMesh(this._limbLeavesGeometry(shape, opt.leafEdge, season), this._materialFor('tree-crown'), list.length);
      list.forEach((e, j) => {
        im.setMatrixAt(j, e.m);
        im.setColorAt(j, col.set(e.c));
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      this._registerMesh(im, 'tree-crown', 'trees', crownLayer, { name: `tree-leaves-${shape}` });
    }

    // Tree picture distance: beyond it, round crowns switch to a cheap low-detail stand-in (0 = off).
    const farGeo = palette && !opt.lowPoly ? tintGeometry(toBatchable(new THREE.IcosahedronGeometry(1, 1), colArr('#ffffff')), CROWN_TINT[season], 0.08) : null;
    for (const key of ['round', 'roundB', 'roundC']) {
      const crown = meshes[key];
      if (!crown || !farGeo) continue;
      const m = crown.count;
      const far = new THREE.InstancedMesh(farGeo, this._materialFor('tree-crown'), m);
      this._registerMesh(far, 'tree-crown', 'trees', crownLayer, { name: `tree-crown-far${key.slice(5)}` });
      for (let i = 0; i < m; i++) {
        crown.getColorAt(i, col);
        far.setColorAt(i, col);
      }
      if (far.instanceColor) far.instanceColor.needsUpdate = true;
      this._treeLOD.push({
        crown, far,
        mats: Float32Array.from(crown.instanceMatrix.array),
        pts: sets[key].map((e) => e.pt),
        last: null, lastDist: -1,
      });
    }
    this._updateTreeLOD(true);
    if (surroundings) for (const { mesh } of this._meshes.slice(firstMesh)) mesh.userData.surroundings = true;
  }

  /** Extra trees along the sidewalks of drivable roads: one candidate per side every 8 m, kept with probability `share` (0..1). */
  _streetTrees(share) {
    const out = [];
    const c = this._city.center || { lat: 0, lon: 0 };
    for (const rd of this._city.roads || []) {
      if (!rd.points || rd.points.length < 2 || rd.tunnel || rd.bridge || rd.layer > 0) continue;
      const foot = FOOT_KINDS.has(rd.kind || 'residential');
      if (foot) continue;
      const w = rd.width || 6;
      if (w < 4) continue;
      const r = rng(hashStr(`streettree:${c.lat}:${c.lon}:${rd.points[0][0].toFixed(1)}:${rd.points[0][1].toFixed(1)}`));
      for (const s of samplePoly(resamplePolyline(rd.points, 2), 8, r() * 8)) {
        for (const side of [-1, 1]) {
          if (r() > share) continue;
          const off = side * (w / 2 + 1.6 + 0.4 * r());
          const x = s.x + s.nx * off, y = s.y + s.ny * off;
          if (this._clearOf(x, y, 4.5)) out.push([x, y]);
        }
      }
    }
    return out;
  }

  /** Swap crowns between the detailed and far meshes by distance from the camera. */
  _updateTreeLOD(force = false) {
    for (const L of this._treeLOD || []) this._updateTreeLODOne(L, force);
  }

  _updateTreeLODOne(L, force) {
    const dist = Math.max(0, Number(this.options.treeDistance ?? 100));
    const cp = this.camera.position;
    if (!force && L.last && L.lastDist === dist && Math.hypot(cp.x - L.last[0], cp.z - L.last[1]) < 2) return;
    L.last = [cp.x, cp.z];
    L.lastDist = dist;
    const near = L.crown.instanceMatrix.array, far = L.far.instanceMatrix.array;
    for (let i = 0; i < L.pts.length; i++) {
      const o = i * 16;
      const d = Math.hypot(L.pts[i][0] - cp.x, L.pts[i][1] - cp.z);
      const isNear = dist === 0 || d <= dist;
      for (let k = 0; k < 16; k++) {
        near[o + k] = isNear ? L.mats[o + k] : 0;
        far[o + k] = isNear ? 0 : L.mats[o + k];
      }
    }
    L.crown.instanceMatrix.needsUpdate = true;
    L.far.instanceMatrix.needsUpdate = true;
    L.crown.computeBoundingSphere();
    L.far.computeBoundingSphere();
  }

  /** Register an instanced or plain mesh: sub-group, layer, shadows, picking, style role. */
  _registerMesh(mesh, role, groupName, layer = 0, { cast = true, receive = true, name } = {}) {
    mesh.name = name || role;
    mesh.castShadow = cast && this.options.shadows;
    mesh.receiveShadow = receive && this.options.shadows;
    mesh.layers.set(layer);
    this.groups[groupName].add(mesh);
    this._meshes.push({ mesh, role, cast, receive });
    return mesh;
  }

  // ----- people and cars --------------------------------------------------------

  /**
   * Manga "mob" figures: rounded tapered limbs, a smooth torso and a hair silhouette, no face, feet at
   * y = 0, about 1.7 m tall, facing local +Z. One set of four merged parts per variant (FIGURE_VARIANTS):
   * top (shirt or coat, instance colour), bottom (trousers or skirt, instance colour), hair (instance
   * colour) and fixed (skin, shoes, bags: vertex colours only).
   */
  _figureGeometries(v) {
    const W = [1, 1, 1];
    const SKIN = colArr('#e8bf9c');
    const DARK = colArr('#2a2a2e');
    const top = [], bottom = [], hair = [], fixed = [];
    const skirt = v.bottom === 'skirt';

    // legs: hips at y 0.88, feet stepping forward / back when walking
    const feet = v.pose === 'walk' ? [[-0.085, 0.07, 0.24], [0.085, 0.08, -0.2]] : [[-0.09, 0.07, 0.01], [0.09, 0.07, -0.01]];
    feet.forEach((f, i) => {
      const hip = [i ? 0.08 : -0.08, 0.88, 0];
      if (skirt) {
        // skirt to the knee, bare legs below
        const t = (0.88 - 0.55) / (0.88 - f[1]);
        fixed.push(limb([hip[0] + (f[0] - hip[0]) * t, 0.55, hip[2] + (f[2] - hip[2]) * t], f, 0.05, 0.04, SKIN));
      } else {
        bottom.push(limb(hip, f, 0.075, 0.048, W));
      }
      fixed.push(limb([f[0], 0.045, f[2] - 0.03], [f[0], 0.04, f[2] + 0.12], 0.048, 0.045, DARK)); // shoe
    });
    {
      const g = skirt ? new THREE.CylinderGeometry(0.14, 0.25, 0.42, 14) : new THREE.SphereGeometry(0.15, 12, 8);
      if (skirt) g.scale(1, 1, 0.8);
      else g.scale(1, 0.6, 0.72);
      g.translate(0, skirt ? 0.72 : 0.9, 0);
      bottom.push(toBatchable(g, W));
    }

    // torso (a coat runs down over the thighs) and rounded shoulders
    {
      const g = v.coat ? new THREE.CylinderGeometry(0.17, 0.22, 0.95, 14) : new THREE.CylinderGeometry(0.17, 0.135, 0.54, 14);
      g.scale(1, 1, 0.62);
      g.translate(0, v.coat ? 0.94 : 1.13, 0);
      top.push(toBatchable(g, W));
      for (const x of [-0.165, 0.165]) {
        const sh = new THREE.SphereGeometry(0.068, 10, 8);
        sh.translate(x, 1.36, 0);
        top.push(toBatchable(sh, W));
      }
    }

    // arms: upper arm + forearm (sleeves) and a hand; they swing against the legs when walking
    const arms = {
      stand: [[[-0.22, 1.09, -0.01], [-0.24, 0.82, 0.03]], [[0.22, 1.09, -0.01], [0.24, 0.82, 0.03]]],
      walk: [[[-0.22, 1.09, -0.07], [-0.23, 0.83, -0.14]], [[0.22, 1.09, 0.07], [0.22, 0.85, 0.18]]],
      phone: [[[-0.22, 1.09, -0.01], [-0.24, 0.82, 0.03]], [[0.2, 1.1, 0.02], [0.09, 1.27, 0.2]]],
      // conversation gestures: one hand up explaining, both palms open, hands on hips, arms crossed,
      // pointing ahead, waving high
      talk: [[[-0.22, 1.09, -0.01], [-0.24, 0.82, 0.03]], [[0.25, 1.1, 0.06], [0.22, 1.24, 0.3]]],
      open: [[[-0.25, 1.1, 0.05], [-0.33, 1.08, 0.3]], [[0.25, 1.1, 0.05], [0.33, 1.08, 0.3]]],
      hips: [[[-0.37, 1.1, -0.03], [-0.19, 0.93, 0.03]], [[0.37, 1.1, -0.03], [0.19, 0.93, 0.03]]],
      crossed: [[[-0.24, 1.12, 0.13], [0.11, 1.2, 0.17]], [[0.24, 1.14, 0.13], [-0.11, 1.22, 0.15]]],
      point: [[[-0.22, 1.09, -0.01], [-0.24, 0.82, 0.03]], [[0.24, 1.3, 0.22], [0.26, 1.36, 0.5]]],
      wave: [[[-0.22, 1.09, -0.01], [-0.24, 0.82, 0.03]], [[0.36, 1.55, 0.04], [0.4, 1.82, 0.08]]],
    }[v.pose];
    arms.forEach(([elbow, hand], i) => {
      top.push(limb([i ? 0.2 : -0.2, 1.36, 0], elbow, 0.058, 0.05, W));
      top.push(limb(elbow, hand, 0.047, 0.04, W));
      const h = new THREE.SphereGeometry(0.043, 8, 6);
      h.translate(...hand);
      fixed.push(toBatchable(h, SKIN));
    });
    if (v.pose === 'phone') {
      const g = new THREE.BoxGeometry(0.07, 0.13, 0.02);
      g.rotateX(-0.5);
      g.translate(0.09, 1.32, 0.22);
      fixed.push(toBatchable(g, DARK));
    }

    // neck, head (slightly oval) and hair: a cap over the back of the head, plus long hair or a bun
    fixed.push(limb([0, 1.38, 0], [0, 1.49, 0.005], 0.048, 0.045, SKIN));
    {
      const g = new THREE.SphereGeometry(0.1, 14, 10);
      g.scale(0.92, 1.12, 1);
      g.translate(0, 1.585, 0.01);
      fixed.push(toBatchable(g, SKIN));
      const cap = new THREE.SphereGeometry(0.109, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.56);
      cap.scale(0.94, 1.12, 1.02);
      cap.rotateX(-0.42); // leaves the face open
      cap.translate(0, 1.6, 0);
      hair.push(toBatchable(cap, W));
      if (v.hair === 'long') {
        const g2 = new THREE.CylinderGeometry(0.1, 0.125, 0.34, 12);
        g2.scale(1, 1, 0.5);
        g2.translate(0, 1.44, -0.055);
        hair.push(toBatchable(g2, W));
      } else if (v.hair === 'bun') {
        const g2 = new THREE.SphereGeometry(0.052, 10, 8);
        g2.translate(0, 1.69, -0.08);
        hair.push(toBatchable(g2, W));
      }
    }

    if (v.bag) {
      const BAG = colArr('#4a3b30');
      const g = new THREE.BoxGeometry(0.08, 0.24, 0.3);
      g.translate(0.27, 0.95, 0);
      fixed.push(toBatchable(g, BAG));
      fixed.push(limb([0.16, 1.4, 0], [0.27, 1.06, 0], 0.014, 0.014, BAG));
    }
    const merge = (list) => mergeGeometries(list, false);
    return { top: merge(top), bottom: merge(bottom), hair: merge(hair), fixed: merge(fixed) };
  }

  /**
   * Headlamps, tail lamps, number plates and wheel hubs for one car type (the dimensions are in CAR_TRIM), in their own
   * colours. Local +Z = heading, like _carGeometry.
   */
  _carTrimGeometry(type, lamps) {
    const t = CAR_TRIM[type] || CAR_TRIM.sedan;
    const parts = [this._carGeometry(type, true)];
    if (!lamps) return parts[0];
    const box = (w, h, d, x, y, z, hex) => {
      const g = new THREE.BoxGeometry(w, h, d);
      g.translate(x, y, z);
      parts.push(toBatchable(g, colArr(hex)));
    };
    for (const sx of [-1, 1]) {
      box(t.lamp, 0.12, 0.06, sx * (t.w / 2 - t.lamp / 2 - 0.1), t.lampY, t.front + 0.01, '#f7f3d4'); // headlamp
      box(t.lamp, 0.1, 0.06, sx * (t.w / 2 - t.lamp / 2 - 0.08), t.lampY + 0.04, t.rear - 0.01, '#c4282a'); // tail lamp
      const hub = new THREE.CylinderGeometry(t.wr * 0.58, t.wr * 0.58, 0.02, 10);
      hub.rotateZ(Math.PI / 2);
      for (const sz of [-1, 1]) {
        const h = hub.clone();
        h.translate(sx * (t.track / 2 + 0.115), t.wr, (sz * t.base) / 2);
        parts.push(toBatchable(h, colArr('#a9aeb5')));
      }
    }
    box(0.46, 0.11, 0.03, 0, t.lampY - 0.1, t.front + 0.01, '#ecebe3'); // front plate
    box(0.46, 0.11, 0.03, 0, t.lampY - 0.1, t.rear - 0.01, '#ecebe3'); // rear plate
    box(t.w * 0.5, 0.07, 0.05, 0, t.lampY - 0.2, t.front + 0.015, '#25262a'); // grille
    return mergeGeometries(parts, false);
  }

  /** Car body for one CAR_TYPES entry: tapered body and cabin (windows and wheels with `dark`, untinted). Local +Z = heading. */
  _carGeometry(type, dark = false) {
    const W = [1, 1, 1];
    const GLASS = colArr('#434b55');
    const parts = [];
    const darkParts = []; // windows and tyres: they must not take the body tint, so they are drawn as a second mesh
    // box(w, h, d, centre y, centre z, colour, top width, top depth, top shift in z)
    const box = (w, h, d, y, z, col, topW = w, topD = d, shift = 0) => {
      if (col === GLASS) {
        // windows go to the untinted mesh; the roof slab and one pillar stay in the body colour
        const gh = Math.max(0.1, h - 0.08);
        const gl = taperBox(w, gh, d, topW, topD, shift, col);
        gl.translate(0, y - 0.04, z);
        darkParts.push(gl);
        const roof = taperBox(topW + 0.02, 0.08, topD + 0.02, topW + 0.02, topD + 0.02, 0, W);
        roof.translate(0, y + h / 2 - 0.04, z + shift);
        parts.push(roof);
        const pw = (w + topW) / 2 + 0.02;
        const pillar = taperBox(pw, gh, 0.1, pw, 0.1, 0, W);
        pillar.translate(0, y - 0.04, z + shift * 0.5);
        parts.push(pillar);
        return gl;
      }
      const g = taperBox(w, h, d, topW, topD, shift, col);
      g.translate(0, y, z);
      parts.push(g);
      return g;
    };
    let wheel = [0.32, 2.6, 1.5]; // radius, wheelbase, track
    switch (type) {
      case 'compact':
        box(1.68, 0.6, 3.8, 0.58, 0, W, 1.62, 3.6);
        box(1.56, 0.56, 2.4, 1.16, -0.3, GLASS, 1.32, 1.8, -0.15);
        wheel = [0.3, 2.4, 1.42];
        break;
      case 'kei':
        box(1.47, 0.55, 3.4, 0.56, 0, W, 1.44, 3.3);
        box(1.45, 0.92, 2.7, 1.29, -0.3, GLASS, 1.34, 2.35, -0.12);
        wheel = [0.28, 2.3, 1.28];
        break;
      case 'suv':
        box(1.86, 0.74, 4.7, 0.72, 0, W, 1.8, 4.5);
        box(1.74, 0.62, 2.9, 1.4, -0.3, GLASS, 1.56, 2.4, -0.1);
        wheel = [0.38, 2.8, 1.6];
        break;
      case 'van':
        box(1.9, 1.75, 3.8, 1.2, -0.55, W, 1.86, 3.76);
        box(1.88, 0.6, 1.1, 0.62, 1.9, W, 1.8, 0.8, -0.1);
        box(1.86, 0.62, 0.4, 1.38, 1.4, GLASS, 1.8, 0.2, -0.1);
        wheel = [0.34, 3.1, 1.62];
        break;
      case 'pickup':
        box(1.5, 1.1, 1.5, 0.95, 1.0, W, 1.42, 1.2, -0.1);
        box(1.5, 0.5, 0.6, 0.62, 1.95, W, 1.46, 0.5);
        box(1.48, 0.38, 0.9, 1.25, 0.95, GLASS, 1.4, 0.7, -0.1);
        box(1.5, 0.14, 2.0, 0.62, -0.78, W);
        box(0.06, 0.32, 2.0, 0.85, -0.78, W).translate(0.72, 0, 0);
        box(0.06, 0.32, 2.0, 0.85, -0.78, W).translate(-0.72, 0, 0);
        box(1.5, 0.32, 0.06, 0.85, -1.75, W);
        wheel = [0.3, 2.4, 1.3];
        break;
      case 'bus':
        box(2.5, 2.6, 10.5, 1.7, 0, W, 2.42, 10.3);
        box(2.53, 0.85, 9.8, 2.25, 0.1, GLASS);
        wheel = [0.5, 6.0, 2.0];
        break;
      default: // sedan
        box(1.76, 0.62, 4.5, 0.6, 0, W, 1.7, 4.3);
        box(1.6, 0.52, 2.5, 1.17, -0.25, GLASS, 1.36, 1.5, -0.12);
    }
    const [wr, wb, tr] = wheel;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const g = new THREE.CylinderGeometry(wr, wr, 0.22, 12);
        g.rotateZ(Math.PI / 2);
        g.translate((sx * tr) / 2, wr, (sz * wb) / 2);
        darkParts.push(toBatchable(g, colArr('#1d1d22')));
      }
    }
    return mergeGeometries(dark ? darkParts : parts, false);
  }

  /**
   * Grid lookup (20 m cells) for crowd placement: building footprints (not ones raised over the street,
   * like arcades), water and carriageways (road centrelines with their half widths).
   */
  _placementIndex(entries) {
    const C = 20;
    const city = this._city || {};
    const lim = (city.size || 600) + 100; // clamp huge areas (sea, lakes) to the built square
    const cells = new Map();
    const add = (minx, miny, maxx, maxy, item) => {
      const i0 = Math.floor(clamp(minx, -lim, lim) / C), i1 = Math.floor(clamp(maxx, -lim, lim) / C);
      const j0 = Math.floor(clamp(miny, -lim, lim) / C), j1 = Math.floor(clamp(maxy, -lim, lim) / C);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const k = `${i},${j}`;
          let l = cells.get(k);
          if (!l) cells.set(k, (l = []));
          l.push(item);
        }
      }
    };
    const addArea = (a, kind) => {
      if (!a.outer || a.outer.length < 3) return;
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
      for (const [x, y] of a.outer) {
        minx = Math.min(minx, x); maxx = Math.max(maxx, x);
        miny = Math.min(miny, y); maxy = Math.max(maxy, y);
      }
      add(minx, miny, maxx, maxy, { kind, ring: a.outer, holes: a.holes });
    };
    for (const b of city.buildings || []) if (!(b.minHeight > 2)) addArea(b, 'b');
    for (const a of city.water || []) addArea(a, 'w');
    for (const e of entries) {
      if (e.foot) continue;
      const hw = e.w / 2;
      for (let i = 0; i < e.pts.length - 1; i++) {
        const a = e.pts[i], b = e.pts[i + 1];
        add(Math.min(a[0], b[0]) - hw, Math.min(a[1], b[1]) - hw, Math.max(a[0], b[0]) + hw, Math.max(a[1], b[1]) + hw, { kind: 'r', a, b, hw });
      }
    }
    const at = (x, y) => cells.get(`${Math.floor(x / C)},${Math.floor(y / C)}`) || [];
    const inArea = (it, x, y) => inRing(x, y, it.ring) && !(it.holes || []).some((h) => h && h.length > 2 && inRing(x, y, h));
    return {
      inBuilding: (x, y) => at(x, y).some((it) => it.kind === 'b' && inArea(it, x, y)),
      inWater: (x, y) => at(x, y).some((it) => it.kind === 'w' && inArea(it, x, y)),
      onRoad: (x, y, m = 0) => at(x, y).some((it) => it.kind === 'r' && distToSegment(x, y, it.a, it.b) < it.hw + m),
    };
  }

  /**
   * Deterministic instanced people and cars; densities, shares and seed come from the world options (WORLD_KEYS).
   * - Every spot is checked against buildings, water and carriageways, so people stay on sidewalks,
   *   footways and zebra crossings, and cars stay out of buildings and off each other.
   * - Each junction gets a light phase: one road is red (people walk its zebra crossings, cars queue
   *   behind the stop line), the others are green (cars drive through; at signals people wait at the curb).
   * - Along the streets people walk (either way, sometimes in pairs), stand around, or talk in small
   *   circles with hand gestures. Moving cars keep to the local traffic side, parked ones line the curb.
   */
  _buildCrowd(roads) {
    const o = this.options;
    const num = (v, d, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
    const pd = num(o.peopleDensity, 0, 0, 100);
    const cd = num(o.carDensity, 0, 0, 100);
    // spots per metre of street, from the density slider (anchors: the old "a few" at 35 and "many" at 80)
    const pRate = lerpAnchors(pd, [[0, 0], [35, 0.022], [80, 0.14], [100, 0.2]]);
    const cRate = lerpAnchors(cd, [[0, 0], [35, 0.0133], [80, 0.083], [100, 0.12]]);
    const pMode = pRate > 0;
    const cMode = cRate > 0;
    if (!pMode && !cMode) return;
    const pT = num((pd - 35) / 45, 0, 0, 1); // 0 at "a few", 1 at "many"
    const cT = num((cd - 35) / 45, 0, 0, 1);
    const walkW = num(o.walkShare, 75, 0, 100), standW = num(o.standShare, 15, 0, 100), talkW = num(o.talkShare, 10, 0, 100);
    const shareSum = walkW + standW + talkW || 1;
    const talkP = talkW / shareSum;
    const standP = standW / shareSum;
    const groupMax = Math.round(num(o.groupSize, 4, 2, 6));
    const kidsP = num(o.kidsShare, 6, 0, 100) / 100;
    const crossP = num(o.crossing, 50, 0, 100) / 100;
    const gest = num(o.gesture, 70, 0, 100) / 100;
    const parkedP = num(o.carParked, 40, 0, 100) / 100;
    const queueMax = Math.round(num(o.carQueue, 3, 1, 8));
    const allowed = new Set(String(o.carTypes ?? '').split(','));
    const palette = o.carPalette === 'mono' ? MONO_CAR_COLORS : o.carPalette === 'colorful' ? COLORFUL_CAR_COLORS : CAR_COLORS;
    const c = this._city.center || { lat: 0, lon: 0 };
    const seed = o.worldSeed ? `:s${o.worldSeed}` : '';
    const rp = rng(hashStr(`people:${c.lat}:${c.lon}${seed}`));
    const rc = rng(hashStr(`cars:${c.lat}:${c.lon}${seed}`));
    const hand = o.trafficSide === 'left' ? -1 : o.trafficSide === 'right' ? 1 : leftHandTraffic(c.lat, c.lon) ? -1 : 1;
    const pick = (list, u) => list[Math.floor(u * list.length)];
    const yawOf = (hx, hy) => Math.atan2(hx, -hy); // heading (local east, north) -> rotation about +Y

    const entries = [];
    for (const rd of roads) {
      if (!rd.points || rd.points.length < 2 || rd.tunnel) continue;
      const kind = rd.kind || 'residential';
      const foot = FOOT_KINDS.has(kind);
      entries.push({ pts: rd.points, kind, foot, major: MAJOR_KINDS.has(kind), w: rd.width || (foot ? 2 : 6), lanes: rd.lanes || 0, name: rd.name || '', bridge: rd.bridge, layer: rd.layer || 0, heightAt: (x, y) => this._surfaces.heightFor(rd, x, y) });
    }
    // OSM splits a street into many short ways; sample each chain of connected ways as one street so
    // people and cars are spread evenly instead of restarting at every way.
    chainEntries(entries, rp() * 5, rc() * 6);
    const idx = this._placementIndex(entries);
    const drivable = (e) => !e.foot && e.w >= 5 && !(e.lanes === 1 && e.w < 6);

    const people = [];
    const cars = [];
    const addPerson = (x, y, yaw, v, onRoad = false, heightAt = null) => {
      const height = heightAt ? heightAt(x, y) : this.groundHeight(x, y);
      if (!this._clearOf(x, y, 2.5) || idx.inBuilding(x, y) || (idx.inWater(x, y) && height <= this.groundHeight(x, y) + 0.3)) return;
      if (!onRoad && idx.onRoad(x, y, 0.3)) return;
      const scale = rp() < kidsP ? 0.62 + 0.1 * rp() : 0.93 + 0.13 * rp(); // a few children
      people.push({ x, y, yaw, v, scale, height, cols: [rp(), rp(), rp()] });
    };
    const addCar = (x, y, yaw, type, col, heightAt = null) => {
      const big = type === 'bus';
      if (cars.some((e) => Math.hypot(e.x - x, e.y - y) < (big || e.type === 'bus' ? 7.5 : 4.8))) return;
      if (!this._clearOf(x, y, big ? 7 : 5)) return;
      const half = big ? 5 : 2.1; // nose and tail must stay out of buildings too
      const hx = Math.sin(yaw), hy = -Math.cos(yaw);
      for (const k of [-1, 0, 1]) if (idx.inBuilding(x + hx * half * k, y + hy * half * k)) return;
      cars.push({ x, y, yaw, type, col, height: heightAt ? heightAt(x, y) + 0.07 : this.groundHeight(x, y) });
    };
    // a circle of 2+ people facing each other, most of them gesturing
    const addGroup = (cx, cy, heightAt = null) => {
      const n = 2 + Math.floor(rp() * (groupMax - 1));
      const R = 0.45 + 0.12 * n;
      const a0 = rp() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const a = a0 + (k * Math.PI * 2) / n + (rp() - 0.5) * 0.4;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
        const v = (k === 0 && gest > 0) || rp() < gest ? pick(TALK_VARIANTS, rp()) : pick(IDLE_VARIANTS, rp());
        addPerson(x, y, yawOf(cx - x, cy - y) + (rp() - 0.5) * 0.5, v, false, heightAt);
      }
    };
    const carType = (e, u, allowBus) => {
      const busOk = allowBus && e.w >= 8 && BUS_KINDS.has(e.kind);
      const weight = (t) => (!allowed.has(t[0]) || (t[0] === 'bus' && !busOk) ? 0 : t[1]);
      return CAR_TYPES.some((t) => weight(t) > 0) ? pickWeighted(CAR_TYPES, u, weight) : null;
    };
    const busColors = o.carPalette === 'mono' ? MONO_BUS_COLORS : BUS_COLORS;
    const carColour = (type, u) => (type === 'bus' ? busColors[Math.floor(u * busColors.length)] : pickWeighted(palette, u));

    // ----- junctions: light phase, zebra crossings, queues -----
    const junctions = findJunctions(entries);
    const byRoad = entries.map(() => []);
    for (const j of junctions) {
      const r = rng(hashStr(`phase:${j.x.toFixed(1)}:${j.y.toFixed(1)}`));
      const ids = [...j.roads];
      j.red = ids[Math.floor(r() * ids.length)]; // the road whose traffic is stopped
      j.busy = r() < crossP; // people crossing here right now
      j.carBusy = r() < 0.4 + 0.4 * cT; // cars waiting here right now
      j.r = r;
      for (const ei of ids) byRoad[ei].push(j);
    }
    for (const j of junctions) {
      const r = j.r;
      for (const leg of j.legs) {
        const e = entries[leg.ei];
        const px = -leg.uy, py = leg.ux; // across the road
        if (leg.ei === j.red) {
          // people on the zebra crossing, walking across either way
          if (pMode && j.busy) {
            const n = 1 + Math.floor(r() * (2 + Math.round(2 * pT)));
            for (let k = 0; k < n; k++) {
              const s = (r() - 0.5) * Math.max(0, leg.w - 1);
              const a = (r() - 0.5) * 2 * (CROSS_HALF - 0.4);
              const dir = r() < 0.5 ? 1 : -1;
              addPerson(leg.cx + px * s + leg.ux * a, leg.cy + py * s + leg.uy * a, yawOf(dir * px, dir * py) + (r() - 0.5) * 0.2, pick(WALK_VARIANTS, r()), true, e.heightAt);
            }
          }
          // cars waiting behind the stop line, in the lane heading into the junction
          if (cMode && drivable(e) && (j.signal || j.carBusy)) {
            // one queue per lane heading into the junction (wide roads have two or three)
            const lanesIn = e.lanes >= 4 ? Math.min(3, Math.floor(e.lanes / 2)) : e.w >= 11 ? 2 : 1;
            for (let m = 0; m < lanesIn; m++) {
              const lat = hand * (leg.w / 2 / lanesIn) * (m + 0.5);
              const n = 1 + Math.floor(r() * queueMax);
              let d = CROSS_AT + CROSS_HALF + 1.5 + 2.3 + 1.5 * r() * (m > 0);
              for (let k = 0; k < n; k++, d += 5.4 + 0.8 * r()) {
                if (!pointAlong(leg.path, d + 2.3)) break;
                const s = pointAlong(leg.path, d);
                const hx = -s.tx, hy = -s.ty; // facing the junction
                const type = carType(e, r(), k > 0);
                if (!type) break;
                addCar(s.x + hy * lat, s.y - hx * lat, yawOf(hx, hy) + (r() - 0.5) * 0.03, type, carColour(type, r()), e.heightAt);
              }
            }
          }
        } else if (pMode && j.signal) {
          // green road: people wait at the curb at both ends of its crossing, facing across
          for (const side of [-1, 1]) {
            if (r() > 0.35 + 0.35 * pT) continue;
            const n = 1 + Math.floor(r() * (2 + Math.round(pT)));
            for (let k = 0; k < n; k++) {
              const s = side * (leg.w / 2 + 0.7 + 0.6 * r());
              const a = (r() - 0.5) * 2.4;
              const v = r() < 0.29 * gest ? pick(TALK_VARIANTS, r()) : pick(IDLE_VARIANTS, r());
              addPerson(leg.cx + px * s + leg.ux * a, leg.cy + py * s + leg.uy * a, yawOf(-side * px, -side * py) + (r() - 0.5) * 0.5, v, false, e.heightAt);
            }
          }
        }
      }
    }
    // distances from (x, y) to the junctions on road ei: any junction, red ones, and red ones the car
    // heads into (heading (hx, hy)). Cars that turned out of the green road may still drive away.
    const nearJunction = (ei, x, y, hx, hy) => {
      let red = Infinity, redIn = Infinity, any = Infinity;
      for (const j of byRoad[ei]) {
        const d = Math.hypot(x - j.x, y - j.y);
        any = Math.min(any, d);
        if (j.red !== ei) continue;
        red = Math.min(red, d);
        if ((j.x - x) * hx + (j.y - y) * hy > 0) redIn = Math.min(redIn, d);
      }
      return { red, redIn, any };
    };

    entries.forEach((e, ei) => {
      const path = resamplePolyline(e.spts, 2);

      // ----- people along the street: walkers, people standing around, talking groups -----
      if (pMode) {
        for (const s of samplePoly(path, 5, e.pOff)) {
          if (rp() > Math.min(1, pRate * 5)) continue;
          const side = rp() < 0.5 ? -1 : 1;
          const roll = rp();
          if (roll < talkP) {
            const off = e.foot ? 0 : side * (e.w / 2 + 1.3);
            addGroup(s.x + s.nx * off, s.y + s.ny * off, e.heightAt);
            continue;
          }
          // sidewalk band: 0.5-2.1 m from the curb (sidewalks are 2.5 m wide); footways: on the path
          const off = e.foot ? (rp() - 0.5) * Math.max(0, e.w - 0.8) : side * (e.w / 2 + 0.6 + 1.5 * rp());
          if (roll < talkP + standP) {
            // standing alone: waiting, on the phone, or calling out to someone
            const v = rp() < 0.36 * gest ? pick(TALK_VARIANTS, rp()) : pick(IDLE_VARIANTS, rp());
            addPerson(s.x + s.nx * off, s.y + s.ny * off, rp() * Math.PI * 2, v, false, e.heightAt);
            continue;
          }
          // walking along the street, sometimes side by side
          const dir = rp() < 0.5 ? 1 : -1;
          const heading = yawOf(dir * s.tx, dir * s.ty);
          const pair = rp() < 0.12 + 0.13 * pT;
          for (const o of pair ? [-0.33, 0.33] : [0]) {
            addPerson(s.x + s.nx * (off + o), s.y + s.ny * (off + o), heading + (rp() - 0.5) * 0.3, pick(WALK_VARIANTS, rp()), false, e.heightAt);
          }
        }
      }

      // ----- cars along the carriageway: moving in lane, or parked at the curb -----
      if (cMode && drivable(e)) {
        const every = 6;
        const parkable = PARK_KINDS.has(e.kind);
        for (const s of samplePoly(path, every, e.cOff)) {
          if (rc() > Math.min(1, cRate * every)) continue;
          const parked = parkable && rc() < parkedP;
          const sideSign = rc() < 0.5 ? -1 : 1;
          const lateral = parked ? sideSign * (e.w / 2 - 1.1) : sideSign * (e.w / 4) + (rc() - 0.5) * 0.5;
          // moving cars drive on the local traffic side; a few parked ones face against it
          const dir = parked && rc() < 0.25 ? -sideSign * hand : sideSign * hand;
          const yawJit = (rc() - 0.5) * (parked ? 0.1 : 0.04);
          const n = parked && rc() < 0.2 + 0.3 * cT ? 2 + Math.floor(rc() * 2) : 1; // a short row at the curb
          let along = (rc() - 0.5) * every * 0.4;
          for (let k = 0; k < n; k++, along += 5.2 + rc()) {
            const type = carType(e, rc(), !parked);
            if (!type) break;
            const col = carColour(type, rc());
            const x = s.x + s.tx * along + s.nx * lateral;
            const y = s.y + s.ty * along + s.ny * lateral;
            // no parking near junctions; the red road's approach is left to the queue built above
            const nj = nearJunction(ei, x, y, dir * s.tx, dir * s.ty);
            if (parked ? nj.any < 15 : nj.red < CROSS_AT + CROSS_HALF + 3 || nj.redIn < 36) continue;
            addCar(x, y, yawOf(dir * s.tx, dir * s.ty) + yawJit + (k ? (rc() - 0.5) * 0.06 : 0), type, col, e.heightAt);
          }
        }
      }
    });

    // ----- plazas: people anywhere on the paving, about 1 per 80 m2 at full density -----
    if (pMode) {
      for (const a of this._city.areas || []) {
        if (a.kind !== 'plaza' || !a.outer || a.outer.length < 3) continue;
        let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
        for (const [x, y] of a.outer) {
          minx = Math.min(minx, x); maxx = Math.max(maxx, x);
          miny = Math.min(miny, y); maxy = Math.max(maxy, y);
        }
        const box = (maxx - minx) * (maxy - miny);
        if (!(box > 150) || box > 60000) continue;
        const rz = rng(hashStr(`plaza:${a.outer[0][0].toFixed(1)}:${a.outer[0][1].toFixed(1)}${seed}`));
        const inside = (x, y) => inRing(x, y, a.outer) && !(a.holes || []).some((h) => h && h.length > 2 && inRing(x, y, h));
        const want = Math.min(150, Math.round(box * (pd / 100) * 0.0125 * 0.6)); // the box overstates the area a bit
        for (let k = 0; k < want; k++) {
          const x = minx + (maxx - minx) * rz(), y = miny + (maxy - miny) * rz();
          if (!inside(x, y)) continue;
          const roll = rz();
          if (roll < talkP) { addGroup(x, y); continue; }
          if (roll < talkP + standP) {
            addPerson(x, y, rz() * Math.PI * 2, rz() < 0.36 * gest ? pick(TALK_VARIANTS, rz()) : pick(IDLE_VARIANTS, rz()), true);
            continue;
          }
          addPerson(x, y, rz() * Math.PI * 2, pick(WALK_VARIANTS, rz()), true);
        }
      }
    }

    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const place = (x, y, yaw, s, height) => {
      q.setFromAxisAngle(up, yaw);
      p.set(x, height ?? this.groundHeight(x, y), -y);
      sc.set(s, s, s);
      return m4.compose(p, q, sc);
    };

    // people: per variant four instanced parts sharing the matrices
    FIGURE_VARIANTS.forEach((variant, vi) => {
      const list = people.filter((e) => e.v === vi);
      if (!list.length) return;
      const geos = this._figureGeometries(variant);
      const palettes = {
        top: variant.coat ? COAT_COLORS : SHIRT_COLORS,
        bottom: variant.bottom === 'skirt' ? SKIRT_COLORS : PANTS_COLORS,
        hair: HAIR_COLORS,
      };
      ['top', 'bottom', 'hair', 'fixed'].forEach((part, pi) => {
        const im = new THREE.InstancedMesh(geos[part], this._materialFor('people'), list.length);
        list.forEach((e, i) => {
          im.setMatrixAt(i, place(e.x, e.y, e.yaw, e.scale, e.height));
          if (palettes[part]) im.setColorAt(i, col.set(pickWeighted(palettes[part], e.cols[pi])));
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        this._registerMesh(im, 'people', 'people', 0, { name: `people-${part}` });
      });
    });

    // umbrellas: a canopy (instance colour) and a pole, on the same matrices as the figure holding it
    const umb = people.filter((e) => hasUmbrella(o.umbrellaShare ?? 0, rng(hashStr(`umb:${e.x.toFixed(2)}:${e.y.toFixed(2)}`))()));
    if (umb.length) {
      const up = umbrellaParts(Number(o.umbrellaSize ?? 1) || 1);
      const c = up.canopy;
      const cone = new THREE.ConeGeometry(c.r, c.h, 16);
      cone.translate(c.x, c.y + c.h / 2, c.z);
      const canopyGeo = toBatchable(cone, [1, 1, 1]);
      const poleGeo = limb(up.pole.from, up.pole.to, 0.012, 0.012, colArr('#2a2a2e'));
      [canopyGeo, poleGeo].forEach((geo, pi) => {
        const im = new THREE.InstancedMesh(geo, this._materialFor('people'), umb.length);
        umb.forEach((e, i) => {
          im.setMatrixAt(i, place(e.x, e.y, e.yaw, e.scale, e.height));
          if (pi === 0) im.setColorAt(i, col.set(umbrellaColour(o.umbrellaColour, rng(hashStr(`umbc:${e.x.toFixed(2)}:${e.y.toFixed(2)}`))())));
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        this._registerMesh(im, 'people', 'people', 0, { name: pi === 0 ? 'umbrella-canopy' : 'umbrella-pole' });
      });
    }

    // taxis: some ordinary cars take the place's cab colour and get a roof light
    const taxiP = taxiChance(o.taxiShare ?? 0, c);
    const taxis = [];
    if (taxiP > 0) {
      for (const e of cars) {
        if (!canBeTaxi(e.type) || rng(hashStr(`taxi:${e.x.toFixed(1)}:${e.y.toFixed(1)}`))() >= taxiP) continue;
        e.col = taxiColour(o.taxiColour, c, rng(hashStr(`taxic:${e.x.toFixed(1)}:${e.y.toFixed(1)}`))());
        taxis.push(e);
      }
    }
    if (taxis.length) {
      const l = roofLight(1.44);
      const box = new THREE.BoxGeometry(l.x1 - l.x0, l.y1 - l.y0, l.z1 - l.z0);
      box.translate((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2, (l.z0 + l.z1) / 2 - 0.3); // over the cabin, behind the car's middle
      const im = new THREE.InstancedMesh(toBatchable(box, colArr('#f3eecf')), this._materialFor('people'), taxis.length);
      taxis.forEach((e, i) => im.setMatrixAt(i, place(e.x, e.y, e.yaw, 1, e.height)));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this._registerMesh(im, 'people', 'people', 0, { name: 'taxi-lights' });
    }

    // cars: one instanced mesh per body type
    for (const [type] of CAR_TYPES) {
      const list = cars.filter((e) => e.type === type);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(this._carGeometry(type), this._materialFor('people'), list.length);
      list.forEach((e, i) => {
        im.setMatrixAt(i, place(e.x, e.y, e.yaw, 1, e.height));
        im.setColorAt(i, col.set(e.col));
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      this._registerMesh(im, 'people', 'people', 0, { name: `cars-${type}` });
      // windows, tyres, lamps, plates and hubs keep their own colours, so they are a second mesh the body tint does not touch
      const trim = new THREE.InstancedMesh(this._carTrimGeometry(type, this.options.carTrim !== false), this._materialFor('people'), list.length);
      const white = new THREE.Color(1, 1, 1);
      list.forEach((e, i) => {
        trim.setMatrixAt(i, place(e.x, e.y, e.yaw, 1, e.height));
        trim.setColorAt(i, white);
      });
      trim.instanceMatrix.needsUpdate = true;
      if (trim.instanceColor) trim.instanceColor.needsUpdate = true;
      trim.computeBoundingSphere();
      this._registerMesh(trim, 'people', 'people', 0, { name: `cars-trim-${type}` });
    }
  }

  // ----- build orchestration ----------------------------------------------------

  /**
   * (Re)build city meshes, elevation, and mapped surroundings.
   * Disposes previous meshes first.
   */
  /** True when local (x, y) is at least r meters from every camera keep-clear point (cityData.keepClear). */
  _clearOf(x, y, r = 3.5) {
    const pts = this._city && this._city.keepClear;
    if (!pts) return true;
    for (const p of pts) if (Math.abs(p[0] - x) < r && Math.abs(p[1] - y) < r && Math.hypot(p[0] - x, p[1] - y) < r) return false;
    return true;
  }

  setCity(cityData, elevation, surroundings = null) {
    this._city = cityData || null;
    this._elev = elevation || null;
    this._surr = surroundings || null;
    this._buildAll();
  }

  _buildAll() {
    this._disposeMeshes();
    const city = this._city;
    if (!city) return;
    this._terrainSamples = new Map();
    if (this._contextCity !== city || this._contextSurroundings !== this._surr) {
      this._context = composeContext(city, this._surr);
      this._contextCity = city; this._contextSurroundings = this._surr;
    }
    const context = this._context;
    this._landHalf = Math.max(city.size, this._surr?.contextSize || 0) / 2;
    this._palette = paletteFor(city.center);
    if (this._surfaceCity !== context || this._surfaceElevation !== this._elev || this._surfaceTerrain !== this.options.terrain) {
      this._surfaces = makeSurfaces(context, this.options.terrain ? this._elev : null, (x, y) => this._terrainHeight(x, y));
      this._surfaceCity = context; this._surfaceElevation = this._elev; this._surfaceTerrain = this.options.terrain;
    }
    const opt = this.options;
    const size = city.size || 1000;
    this._sunDist = Math.max(400, size * 3);
    this._shadowHalf = Math.max(200, size * 0.75);
    this.setLight(this.light);
    this._segs = [];
    this._lampPts = [];
    this._wallIdx = null; // building wall index, built on first use (see walls.js)
    this._facCache = null;
    this._groundSamples = new Map();

    // ground (inner, terrain-following) and surroundings ground
    this._addMesh(this._buildGround(size, opt.terrain), 'ground', 'ground', {
      pickable: true,
      cast: false,
      name: 'ground',
    });
    if (this._surr) {
      const surrGeo = this._buildSurroundGround(this._surr.farSize || this._elev?.size || size * 3, opt.terrain);
      const m = this._addMesh(surrGeo, 'surr-ground', 'surroundings', { cast: false, name: 'surroundings-ground' });
      if (m) m.userData.surroundings = true;
    }

    // roads and their markings
    const roadParts = this._buildRoads(city.roads || [], opt.details, this._inJapan(city.center));
    for (const part of roadParts) {
      if (!part.geo) continue;
      const group = DETAIL_PARTS.has(part.name) ? 'details' : 'roads';
      this._addMesh(part.geo, part.role, group, { name: part.name, pickable: part.name === 'asphalt' || part.name === 'footways' });
    }
    const rail = this._buildRailways(city.railways || []);
    if (rail) this._addMesh(rail, 'rail', 'roads', { name: 'railways' });

    for (const part of this._buildRoads(context.contextRoads, false, false, true)) {
      const mesh = this._addMesh(part.geo, part.role, 'surroundings', { name: `context-${part.name}`, cast: false });
      if (mesh) mesh.userData.surroundings = true;
    }
    const contextRail = this._buildRailways(context.contextRailways);
    if (contextRail) this._addMesh(contextRail,'rail','surroundings',{name:'context-railways',cast:false}).userData.surroundings = true;

    // water / green / plazas
    const innerHalf = this._surr ? city.size * 0.6 : city.size / 2;
    for (const part of this._buildAreas(context.water, context.green, context.areas, { half: innerHalf, exclude: 0 })) {
      if (!part.geo) continue;
      this._addMesh(part.geo, part.role, part.group, { name: part.name });
    }
    if (this._surr && this._landHalf > innerHalf) for (const part of this._buildAreas(context.water,context.green,context.areas,{half:this._landHalf,exclude:innerHalf})) {
      const mesh = this._addMesh(part.geo,part.role,'surroundings',{name:`context-${part.name}`,cast:false});
      if (mesh) mesh.userData.surroundings = true;
    }

    // buildings: walls and roofs as two merged meshes
    const lm = landmarksFor(city, this.options.landmarks !== false);
    const bl = this._buildBuildings(lm.buildings, false, lm.draw);
    if (bl.walls) this._addMesh(bl.walls, 'building', 'buildings', { pickable: true, name: 'walls' });
    if (bl.roofs) this._addMesh(bl.roofs, 'building', 'buildings', { pickable: true, name: 'roofs' });

    // surroundings: simple extruded footprints, lower detail
    if (this._surr && this._surr.buildings && this._surr.buildings.length) {
      const sb = this._buildBuildings(context.contextBuildings, true);
      const sRole = this.options.surroundWindows !== false ? 'building' : 'surr';
      if (sb.walls) this._addMesh(sb.walls, sRole, 'surroundings', { name: 'surr-walls' }).userData.surroundings = true;
      if (sb.roofs) this._addMesh(sb.roofs, sRole, 'surroundings', { name: 'surr-roofs' }).userData.surroundings = true;
    }

    this._buildMappedObjects(context.props, lm.replacements);
    const roadIdx = roadIndex(context.roads);
    this._buildBarriers(context.barriers, roadIdx);
    this._buildFixtures(context.fixtures, roadIdx);
    this._treeLOD = [];
    if (opt.trees) {
      const near = [], far = [];
      for (const p of context.trees) (Math.max(Math.abs(p[0]),Math.abs(p[1])) <= city.size*0.6 ? near : far).push(p);
      this._buildTrees(near);
      this._buildTrees(far,true);
    }
    this._buildCrowd(city.roads || []);

    // edges of buildings for SVG export / feature lines (world space)
    for (const { mesh } of this._meshes) {
      if (mesh.userData.surroundings || mesh.name !== 'walls' && mesh.name !== 'roofs') continue;
      const e = new THREE.EdgesGeometry(mesh.geometry, 30);
      const arr = e.attributes.position.array;
      for (let i = 0; i < arr.length; i++) this._segs.push(arr[i]);
      e.dispose();
    }

    this._updateShadowFlags();
    const bounds = this.nearBounds();
    this._sceneRadius = Math.hypot(...bounds.min.map((v, i) => bounds.max[i] - v)) / 2;
    this._sceneCenter = new THREE.Vector3(...bounds.min.map((v, i) => (v + bounds.max[i]) / 2));
    this._viewDistance = this.camera.position.distanceTo(this._sceneCenter);
    this._updateDepthRange();
    this._syncLamps();
  }

  /** Remove and dispose the meshes built by the previous setCity call. */
  _disposeMeshes() {
    for (const { mesh } of this._meshes) {
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.parent) mesh.parent.remove(mesh);
      if (mesh.dispose) mesh.dispose(); // InstancedMesh releases its instance buffers
    }
    this._meshes = [];
    this._pickables = [];
    this._segs = [];
  }

  /** Apply shadow flags to every registered mesh and the sun. */
  _updateShadowFlags() {
    const on = !!this.options.shadows;
    this.sun.castShadow = on;
    for (const entry of this._meshes) {
      entry.mesh.castShadow = on && entry.cast !== false;
      entry.mesh.receiveShadow = on && entry.receive !== false;
    }
  }

  /** Partial option update. Geometry-affecting keys trigger a rebuild. */
  setOptions(partial = {}) {
    const prev = { ...this.options };
    // legacy single 'crowd' option: one density for both people and cars
    if ('crowd' in partial) {
      partial = { people: partial.crowd, cars: partial.crowd, ...partial };
      delete partial.crowd;
    }
    // older names ('few' / 'many' densities, tree type and size presets) map onto the numeric options
    partial = { ...partial };
    if ('people' in partial) partial.peopleDensity ??= LEGACY_DENSITY[partial.people] ?? 0;
    if ('cars' in partial) partial.carDensity ??= LEGACY_DENSITY[partial.cars] ?? 0;
    delete partial.people;
    delete partial.cars;
    if ('treeType' in partial) {
      const preset = TREE_MIX[partial.treeType];
      if (preset) partial.treeMix ??= preset === 'auto' ? 'auto' : preset.map(([k, w]) => `${k}:${Math.round(w * 100)}`).join(',');
      delete partial.treeType;
    }
    if ('treeSize' in partial) {
      if (TREE_SIZE[partial.treeSize]) [partial.treeSizeMin, partial.treeSizeMax] = TREE_SIZE[partial.treeSize];
      delete partial.treeSize;
    }
    Object.assign(this.options, partial);
    const geometryKeys = ['terrain', 'trees', 'details', 'lowPoly', 'leafEdge', 'season', 'treeStyle', ...WORLD_KEYS];
    const rebuild = geometryKeys.some((k) => k in partial && partial[k] !== prev[k]);
    if (rebuild) {
      if (this._city) this._buildAll();
    } else {
      this._updateShadowFlags();
    }
    if ('detailDistance' in partial) this._updateDepthRange();
    if ('straightVerticals' in partial) this._applyPose();
    if ('twoSidedShadows' in partial) this._applyShadowSides();
    if ('shadowTint' in partial || 'shadowTintAmt' in partial) this._applyLightColors();
    const w = this.options;
    WALL_WEATHER.value = clamp(w.wallWeathering / 100, 0, 1);
    GROUND_OPT.value.set(clamp(w.paveJoints / 100, 0, 1), clamp(w.paveSlab, 0.2, 2), clamp(w.roadWear / 100, 0, 1), wetDarkening(w.wetStreets));
    FACADE_OPT.value.set(clamp(w.facadeStyles / 100, 0, 1), clamp(w.facadeOpenings / 100, 0, 1));
    WIN_OPT.value.set(clamp(w.windowVariety / 100, 0, 1), clamp(w.windowCurtains / 100, 0, 1), clamp(w.windowReflection / 100, 0, 1), clamp(w.windowFrames / 100, 0, 1));
  }

  /**
   * Tone settings for 'lines-tone'. Stored only; applied per frame.
   * shadow 0..2.5, base 0..2.5, pattern (TONE_PATTERNS), size 0.1..3 (cell = 9 px * size at 1x for dots
   * and gradient, 15 px * size for the other patterns),
   * seed integer, opacity 0..1, grayFill bool, blackRange 0..1 (0 = no solid black),
   * whiteLines bool (ink lines drawn white inside solid black).
   */
  setTone(opts) {
    const o = opts || {};
    const t = this.tone;
    const num = (v, lo, hi, def) => {
      const x = Number(v);
      return Number.isFinite(x) ? clamp(x, lo, hi) : def;
    };
    if (o.shadow !== undefined) t.shadow = num(o.shadow, 0, 2.5, t.shadow);
    if (o.base !== undefined) t.base = num(o.base, 0, 2.5, t.base);
    if (o.pattern !== undefined && TONE_PATTERNS.includes(o.pattern)) t.pattern = o.pattern;
    if (o.size !== undefined) t.size = num(o.size, 0.1, 3, t.size);
    if (o.seed !== undefined) t.seed = Math.round(num(o.seed, -1e9, 1e9, t.seed));
    if (o.opacity !== undefined) t.opacity = num(o.opacity, 0, 1, t.opacity);
    if (o.grayFill !== undefined) t.grayFill = !!o.grayFill;
    if (o.blackRange !== undefined) t.blackRange = num(o.blackRange, 0, 1, t.blackRange);
    if (o.whiteLines !== undefined) t.whiteLines = !!o.whiteLines;
  }

  /**
   * Air settings: shade 0..1.5 (screen-space AO: darkens colour styles, adds tone in nooks of
   * lines-tone), haze 0..1.5 (colour styles: fog range / haze, 0 = no fog), sky bool (skylight:
   * bluish ambient so colour / clay shadows take a cool tint; off = neutral grey ambient). Line styles unaffected.
   */
  setAir(opts) {
    const o = opts || {};
    const a = this.air;
    const num = (v, lo, hi, def) => {
      const x = Number(v);
      return Number.isFinite(x) ? clamp(x, lo, hi) : def;
    };
    if (o.shade !== undefined) a.shade = num(o.shade, 0, 1.5, a.shade);
    if (o.haze !== undefined) a.haze = num(o.haze, 0, 1.5, a.haze);
    if (o.sky !== undefined) a.sky = !!o.sky;
    if (o.inkTint !== undefined) a.inkTint = num(o.inkTint, 0, 1, a.inkTint);
    if (o.inkFade !== undefined) a.inkFade = num(o.inkFade, 0, 1, a.inkFade);
    if (o.lineThin !== undefined) a.lineThin = num(o.lineThin, 0, 1, a.lineThin);
    this._applyFog();
    this._applyLightColors();
  }

  setStyle(style) {
    const valid = ['color', 'color-lines', 'lineart', 'lines-tone', 'clay'];
    this.style = valid.includes(style) ? style : 'color';
    this._applyStyleBackground();
    this._applyLightColors();
    for (const entry of this._meshes) entry.mesh.material = this._materialFor(entry.role);
  }

  setLineWidth(w) {
    this.lineWidth = clamp(Number(w) || 1, 0.2, 5);
  }

  setOutlineWidth(w) {
    this.outlineWidth = clamp(Number(w) || 1, 0.2, 5);
  }

  /** World-space edge segments as pairs (x,y,z,x,y,z,...) for SVG export. */
  getLineSegments() {
    return { positions: Float32Array.from(this._segs) };
  }

  // ----- post effects and world effects -------------------------------------------

  /**
   * Effect list: post effects go to the EffectStack; the world effects (night, rain,
   * snow, petals) are applied here. strength 0 or disabled = off. Changing the list does not rebuild the city,
   * except that lamp geometry is added or removed.
   */
  setEffects(list) {
    const arr = Array.isArray(list) ? list : [];
    this._fx.setEffects(arr);
    this._parseWorld(arr);
    this._applyNight();
    this._syncParticles();
  }

  /** Per-frame animation is needed while particles or the stack's animated effects run. */
  isAnimating() {
    const W = this._world;
    return !!(W.rain || W.snow || W.petals) || this._fx.isAnimated();
  }

  /** Reads the enabled world effects from the list into this._world (strength > 0 only). */
  _parseWorld(list) {
    const W = { night: null, rain: null, snow: null, petals: null };
    const num = (v, d) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? d : Number(v));
    for (const e of list) {
      if (!e || !e.enabled) continue;
      const s = clamp(num(e.strength, 0), 0, 1);
      if (!(s > 0)) continue;
      const p = e.params || {};
      if (e.id === 'night') {
        W.night = { s, lights: clamp(num(p.lights, 0.8), 0, 1), lamps: num(p.lamps, 1) >= 0.5 };
      } else if (e.id === 'rain') {
        W.rain = { s, density: clamp(num(p.density, 0.5), 0, 1), wind: clamp(num(p.wind, 0.2), -1, 1) };
      } else if (e.id === 'snow') {
        W.snow = { s, density: clamp(num(p.density, 0.5), 0, 1), size: clamp(num(p.size, 1), 0.5, 3) };
      } else if (e.id === 'petals') {
        W.petals = { s, density: clamp(num(p.density, 0.4), 0, 1) };
      }
    }
    this._world = W;
  }

  /** Night: sun dimmed and cooled, ambient and sky towards navy, emissive windows, lamp lights. */
  _applyNight() {
    const n = this._world.night;
    const s = n ? n.s : 0;
    this._nightS = s;
    this._nightLamps = !!(n && n.lamps);
    if (this.sun) {
      this.sun.intensity = this._sunI0 * (1 - 0.9 * s);
      this.sun.color.copy(this._sunC0).lerp(MOON_COL, s);
    }
    this._nightU.uNightI.value = s;
    this._nightU.uNightShare.value = n ? n.lights : 0;
    this._applyLightColors();
    this._applyStyleBackground(); // sky texture and fog colour
    this._syncLamps();
  }

  /**
   * Lamp bulbs (instanced emissive spheres) and glow points for the lamp positions in _lampPts.
   * Only lamp geometry is added or removed here; the city is not rebuilt.
   */
  _syncLamps() {
    for (const o of this._lampObjs) {
      if (o.parent) o.parent.remove(o);
      o.geometry.dispose();
      if (o.dispose) o.dispose();
    }
    this._lampObjs = [];
    if (!(this._nightS > 0 && this._nightLamps) || !this._lampPts.length) return;

    if (!this._lampMat) {
      this._lampMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
      this._glowMat = new THREE.ShaderMaterial({
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        uniforms: {
          uFocal: this._pu.uFocal,
          uGlowOp: { value: 1 },
          uGlowCol: { value: new THREE.Vector3(WARM_WINDOW_COL.r, WARM_WINDOW_COL.g, WARM_WINDOW_COL.b) },
        },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    }
    this._glowMat.uniforms.uGlowOp.value = this._nightS;

    const pts = this._lampPts;
    const n = pts.length;
    const pos = new Float32Array(n * 3);
    const m4 = new THREE.Matrix4();
    const bulbGeo = new THREE.SphereGeometry(0.22, 8, 6);
    const bulbs = new THREE.InstancedMesh(bulbGeo, this._lampMat, n);
    for (let i = 0; i < n; i++) {
      const [x, y, lift] = pts[i];
      const h = this.groundHeight(x, y) + lift;
      pos[i * 3] = x;
      pos[i * 3 + 1] = h;
      pos[i * 3 + 2] = -y;
      m4.makeTranslation(x, h, -y);
      bulbs.setMatrixAt(i, m4);
    }
    bulbs.instanceMatrix.needsUpdate = true;
    bulbs.computeBoundingSphere();
    bulbs.name = 'lamps';
    bulbs.castShadow = false;
    bulbs.receiveShadow = false;
    this.groups.details.add(bulbs);

    const glowGeo = new THREE.BufferGeometry();
    glowGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const glow = new THREE.Points(glowGeo, this._glowMat);
    glow.name = 'lamp-glow';
    glow.frustumCulled = false;
    glow.layers.set(LAYER_GLOW);
    this.groups.details.add(glow);

    this._lampObjs = [bulbs, glow];
  }

  /** Uniform set shared by the particle materials (the entries are shared, so one value update reaches all). */
  _puFor(extra) {
    return Object.assign({}, this._pu, extra);
  }

  /** Create one particle system (GPU buffers sized for the maximum count). */
  _makeParticles(kind) {
    const max = { rain: 20000, snow: 8000, petals: 3000 }[kind];
    const r = rng(hashStr(`fx:${kind}`));
    const extra = { uOpacity: { value: 1 } };
    // Snow and petals are sparser and bigger than rain: keep them in a tighter box so they fill the
    // foreground instead of spreading 60 m away (where they shrink to a pixel).
    if (kind !== 'rain') extra.uBox = { value: new THREE.Vector3(50, 30, 50) };
    let obj;
    let mat;
    if (kind === 'petals') {
      mat = new THREE.ShaderMaterial({
        vertexShader: PETAL_VERT,
        fragmentShader: PETAL_FRAG,
        uniforms: this._puFor(extra),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      obj = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1, 6, 6), mat, max);
    } else if (kind === 'rain') {
      // two vertices per drop with the same seed; aEnd tells head from tail
      const pos = new Float32Array(max * 2 * 3);
      const end = new Float32Array(max * 2);
      for (let i = 0; i < max; i++) {
        const sx = r();
        const sy = r();
        const sz = r();
        for (let k = 0; k < 2; k++) {
          const o = (i * 2 + k) * 3;
          pos[o] = sx;
          pos[o + 1] = sy;
          pos[o + 2] = sz;
          end[i * 2 + k] = k;
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
      mat = new THREE.ShaderMaterial({
        vertexShader: RAIN_VERT,
        fragmentShader: RAIN_FRAG,
        uniforms: this._puFor({ ...extra, uWind: { value: 0.2 } }),
        transparent: true,
        depthWrite: false,
      });
      obj = new THREE.LineSegments(geo, mat);
    } else {
      const pos = new Float32Array(max * 3);
      for (let i = 0; i < max * 3; i++) pos[i] = r();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      mat = new THREE.ShaderMaterial({
        vertexShader: SNOW_VERT,
        fragmentShader: SNOW_FRAG,
        uniforms: this._puFor({ ...extra, uSnowSize: { value: 1 } }),
        transparent: true,
        depthWrite: false,
      });
      obj = new THREE.Points(geo, mat);
    }
    obj.name = `fx-${kind}`;
    obj.frustumCulled = false;
    obj.visible = false;
    this._fxScene.add(obj);
    return { obj, mat, max };
  }

  /** Apply the particle settings: create systems on first use, set counts and per-effect uniforms. */
  _syncParticles() {
    const W = this._world;
    this._partObjs = [];
    for (const kind of ['rain', 'snow', 'petals']) {
      const on = W[kind];
      let sys = this._parts[kind];
      if (!on) {
        if (sys) sys.obj.visible = false;
        continue;
      }
      if (!sys) sys = this._parts[kind] = this._makeParticles(kind);
      const n = Math.round(sys.max * on.density);
      sys.mat.uniforms.uOpacity.value = on.s;
      if (kind === 'rain') {
        sys.mat.uniforms.uWind.value = on.wind;
        sys.obj.geometry.setDrawRange(0, n * 2);
      } else if (kind === 'snow') {
        sys.mat.uniforms.uSnowSize.value = on.size;
        sys.obj.geometry.setDrawRange(0, n);
      } else {
        sys.obj.count = n;
      }
      sys.obj.visible = n > 0;
      if (n > 0) this._partObjs.push(sys.obj);
    }
  }

  // ----- materials and passes -----------------------------------------------------

  _createPassResources() {
    // view-space normal (rgb) + normalised linear depth (a) for the edge pass
    const ndMat = new THREE.ShaderMaterial({
      vertexShader: ND_VERT,
      fragmentShader: ND_FRAG,
      uniforms: {
        uFar: { value: this.camera.far },
        uTilt: { value: new THREE.Vector3() },
        uFocalPx: { value: 1 },
        uWinDist: { value: 1 },
        uFacade: FACADE_OPT,
      },
    });
    // white Lambert for the lit grayscale pass used by lines-tone; window glass is a little darker
    // so it tones on shaded walls and stays white-ish on sunlit ones
    const litMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    litMat.onBeforeCompile = (shader) => {
      windowPatch(shader, this._winDistU, this._focalU, 'diffuseColor.rgb *= windowShade(vWPos, vWNrm, wf, vFac);', this._nightU);
      // Upward-facing surfaces get most of the sky light, which kept shadowed ground above the tone
      // threshold. Cut the sky (indirect) term there so cast shadows on the ground read as tone,
      // while walls keep their ambient and stay light.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#if defined( RE_IndirectDiffuse ) && NUM_HEMI_LIGHTS > 0
          irradiance *= mix(1.0, 0.4, smoothstep(0.55, 0.9, dot(geometryNormal, hemisphereLights[0].direction)));
        #endif
        #include <lights_fragment_end>`
      );
    };
    litMat.customProgramCacheKey = () => 'manga-lit-windows-v4';
    // flat anime colours from vertex colours
    const vc = new THREE.MeshLambertMaterial({ vertexColors: true });
    // same, plus the distant window grid on walls (world-space, no extra geometry)
    const building = new THREE.MeshLambertMaterial({ vertexColors: true });
    building.onBeforeCompile = (shader) =>
      windowPatch(shader, this._winDistU, this._focalU, 'diffuseColor.rgb = windowColor(diffuseColor.rgb, vWPos, vWNrm, wf, vFac); diffuseColor.rgb *= wallWeather(vWPos, vWNrm, wf);', this._nightU);
    building.customProgramCacheKey = () => 'manga-windows-v4';
    // matte light grey for the clay style
    const clay = new THREE.MeshStandardMaterial({ color: 0xd9d8d4, roughness: 0.95, metalness: 0 });
    // unlit albedo from vertex colours (base-colour tone term)
    const albMat = new THREE.ShaderMaterial({
      vertexShader: ALB_VERT,
      fragmentShader: ALB_FRAG,
      vertexColors: true,
    });
    // fullscreen composite (edges, tone, AO, sky, output encoding)
    const compMat = new THREE.ShaderMaterial({
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tColor: { value: null },
        tND: { value: null },
        tAlb: { value: null },
        tTree: { value: null },
        uMode: { value: 0 },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uRes: { value: new THREE.Vector2(1, 1) },
        uInner: { value: 1 },
        uOuter: { value: 1 },
        uCell: { value: 6 },
        uTransparent: { value: 0 },
        uPat: { value: 0 },
        uSeed: { value: 1 },
        uOpacity: { value: 1 },
        uGray: { value: 0 },
        uBlack: { value: 0.22 },
        uWhite: { value: 0 },
        uShadow: { value: 1 },
        uBase: { value: 0 },
        uShade: { value: 0 },
        uTree: { value: 0 },
        uTreeOutline: { value: 0 },
        uFar: { value: this.camera.far },
        uFocal: { value: 1 },
        uAoR: { value: AO_RADIUS_M },
        uCamRot: { value: new THREE.Matrix3() },
        uCamTan: { value: new THREE.Vector2(1, 1) },
        uCloud: { value: new THREE.Vector4(0, 1, 0.3, 0.6) },
        uCloudSun: { value: new THREE.Vector3(0, 1, 0) },
        uCloudLit: { value: new THREE.Vector3(1, 1, 1) },
        uCloudDark: { value: new THREE.Vector3(0.75, 0.82, 0.92) },
        uCloudOpt: { value: new THREE.Vector3(0, 0, 0) },
        uSkyTop: { value: new THREE.Vector3(0.3, 0.6, 0.9) },
        uSkyHor: { value: new THREE.Vector3(0.9, 0.95, 1) },
        uSkyGlow: { value: new THREE.Vector3(1, 0.95, 0.8) },
        uSkyOpt: { value: new THREE.Vector4(0.5, 24, 0.3, 0) },
        uSkyTone: { value: new THREE.Vector2(0, 0.5) },
        uInk: { value: new THREE.Vector2(0, 0) },
        uThin: { value: new THREE.Vector2(0, 1) },
        uHaze: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    // tone crowns: tree mask, normal.y and underside noise, depth (lines-tone only)
    const treeMat = new THREE.ShaderMaterial({
      vertexShader: TREE_VERT,
      fragmentShader: TREE_FRAG,
      uniforms: { uFar: { value: this.camera.far } },
    });
    const walkMat = groundMaterial('walk');
    const roadMat = groundMaterial('road');
    this._mats = { ndMat, litMat, vc, building, clay, albMat, compMat, treeMat, walkMat, roadMat };
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compMat);
    this._quad.frustumCulled = false;
    this._quadScene = new THREE.Scene();
    this._quadScene.add(this._quad);
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._applyShadowSides();
  }

  /** Two-sided shadow casting on the lit / colour materials (and the pass overrides). */
  _applyShadowSides() {
    if (!this._mats) return;
    const side = this.options.twoSidedShadows ? THREE.DoubleSide : null;
    for (const key of ['litMat', 'vc', 'building', 'clay', 'ndMat', 'albMat', 'walkMat', 'roadMat']) {
      const m = this._mats[key];
      if (m && m.shadowSide !== side) {
        m.shadowSide = side;
        m.needsUpdate = true;
      }
    }
  }

  /** Material for a mesh role under the current style. */
  _materialFor(role) {
    const M = this._mats;
    if (this.style === 'clay') return M.clay;
    return role === 'building' ? M.building : role === 'sidewalk' ? M.walkMat : role === 'road' ? M.roadMat : M.vc;
  }

  /** Offscreen targets for a given pixel size (reused while the size is unchanged). */
  _newTargets(w, h) {
    return {
      w,
      h,
      color: new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 }),
      nd: new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0 }),
      alb: new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0 }),
      tree: new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 0 }),
      // composite result before the post-effect stack (sRGB-encoded RGBA8, no depth)
      post: new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, samples: 0, depthBuffer: false }),
    };
  }

  _disposeTargets(T) {
    T.color.dispose();
    T.nd.dispose();
    T.alb.dispose();
    T.tree.dispose();
    T.post.dispose();
  }

  _targetsFor(w, h) {
    const T = this._targets;
    if (T && T.w === w && T.h === h) return T;
    if (T) this._disposeTargets(T);
    this._targets = this._newTargets(w, h);
    return this._targets;
  }

  /**
   * One complete frame at w x h into dst (null = screen).
   * Line styles: normal/depth pass, optional colour or lit pass, optional albedo pass, then the composite.
   * Colour / clay: colour pass (+ normal/depth pass when AO is on), then the composite.
   */
  _renderFrame(w, h, dst, transparent, T) {
    const r = this.renderer;
    const scene = this.scene;
    const cam = this.camera;
    const M = this._mats;
    const style = this.style;
    const tone = this.tone;
    const air = this.air;
    const edges = style === 'lineart' || style === 'lines-tone' || style === 'color-lines';
    const lit = style === 'lines-tone';
    const colorPass = style === 'color' || style === 'clay' || style === 'color-lines';
    // post effects that read depth (fog, dof), and particles (depth-tested against the ND target),
    // need the ND pass in every style, including colour and clay
    const fxOn = this._fx.active;
    const fxDepth = this._fx.needsDepth();
    const partsOn = this._partObjs.length > 0;
    const cloudsOn = this.options.cloudCover > 0 && style !== 'clay';
    const needND = edges || (colorPass && air.shade > 0) || fxDepth || partsOn || cloudsOn || style === 'color';
    const needAlb = lit && tone.base > 0;
    const treeStyle = this.options.treeStyle;
    // tone crowns: lines-tone with treeStyle tone / tone-noline (their own mask + normal pass)
    const treeTone = lit && !!this.options.trees && (treeStyle === 'tone' || treeStyle === 'tone-noline');
    // crowns join the edge pass for lines-tone (depth for occlusion) and for the tone tree styles; without
    // this, colour + lines with 'tone-noline' lets building outlines show through the crowns
    const edgeMask = LAYER_EDGE_MASK | (lit || treeStyle === 'tone' || treeStyle === 'tone-noline' ? LAYER_TREE_MASK : 0);
    // Depth-only users (fx depth, particles) in the colour / clay styles see every layer (trunks included)
    // except the glow sprites. The edge styles keep their edge layers, so the ink does not change.
    const needFullDepth = !edges && (fxDepth || partsOn);
    const ndMask = needFullDepth ? LAYER_ALL_NO_GLOW : edgeMask;
    // lamp glow is part of the colour pass only (colorPass styles, lamps on)
    const glowOn = colorPass && this._lampObjs.length > 0;
    const colorMask = LAYER_BASE_MASK | (glowOn ? LAYER_GLOW_BIT : 0);
    // the composite goes to the post target when the effect stack runs, otherwise straight to dst
    const compTarget = fxOn ? T.post : dst;
    // target pixels per CSS pixel: keeps line/cell sizes relative to the image for hi-res export
    const scale = h / this._cssH;

    this._applyPose();
    // window grid uniforms (edge pass, lit and colour building materials)
    const focal = (0.5 * h) / Math.tan((cam.fov * DEG) / 2);
    const winDist = this.options.distantWindows ? 1 : 0;
    // the window fade counts CSS pixels, so a hi-res export or a hi-DPI screen keeps the same windows as the preview
    this._focalU.value = focal / scale;
    this._winDistU.value = winDist;
    M.ndMat.uniforms.uFocalPx.value = focal / scale;
    M.ndMat.uniforms.uWinDist.value = winDist;
    this._setPartUniforms(w, h, focal, T);
    const saved = { bg: scene.background, fog: scene.fog, ov: scene.overrideMaterial, mask: cam.layers.mask };
    const clearColor = new THREE.Color();
    r.getClearColor(clearColor);
    const clearAlpha = r.getClearAlpha();

    try {
      // 1. normal + depth (trees on layer 2 / 3 are included or excluded by treeStyle)
      if (needND) {
        cam.layers.mask = ndMask;
        scene.overrideMaterial = M.ndMat;
        scene.background = null;
        scene.fog = null;
        // background encodes "normal = +Z, depth = 1" (far)
        r.setClearColor(new THREE.Color(0.5, 0.5, 1.0), 1);
        r.setRenderTarget(T.nd);
        r.clear(true, true, true);
        r.render(scene, cam);
      }

      // 2. colour pass or lit grayscale pass
      if (colorPass || lit) {
        cam.layers.mask = colorMask;
        if (lit) {
          scene.overrideMaterial = M.litMat;
          scene.background = null;
          scene.fog = null;
          r.setClearColor(new THREE.Color(1, 1, 1), 1);
        } else {
          scene.overrideMaterial = null;
          scene.background = saved.bg;
          scene.fog = saved.fog;
          r.setClearColor(new THREE.Color(0.99, 0.98, 0.95), 1);
        }
        r.setRenderTarget(T.color);
        r.clear(true, true, true);
        r.render(scene, cam);
      }

      // 2b. albedo (unlit vertex colour) for the base-colour tone term
      if (needAlb) {
        cam.layers.mask = LAYER_BASE_MASK;
        scene.overrideMaterial = M.albMat;
        scene.background = null;
        scene.fog = null;
        r.setClearColor(new THREE.Color(1, 1, 1), 1);
        r.setRenderTarget(T.alb);
        r.clear(true, true, true);
        r.render(scene, cam);
      }

      // 2c. tone crowns only: crown mask, normal.y and underside noise, depth (lines-tone)
      if (treeTone) {
        cam.layers.mask = LAYER_TREE_MASK;
        scene.overrideMaterial = M.treeMat;
        scene.background = null;
        scene.fog = null;
        M.treeMat.uniforms.uFar.value = cam.far;
        r.setClearColor(new THREE.Color(0, 0, 0), 0);
        r.setRenderTarget(T.tree);
        r.clear(true, true, true);
        r.render(scene, cam);
      }

      // 3. composite to dst
      const u = M.compMat.uniforms;
      u.tColor.value = T.color.texture;
      u.tND.value = T.nd.texture;
      u.tAlb.value = T.alb.texture;
      u.tTree.value = T.tree.texture;
      u.uTree.value = treeTone ? 1 : 0;
      u.uTreeOutline.value = treeTone && treeStyle === 'tone' ? 1 : 0;
      u.uMode.value = style === 'lineart' ? 0 : style === 'lines-tone' ? 1 : style === 'color-lines' ? 2 : 3;
      u.uTexel.value.set(1 / w, 1 / h);
      u.uRes.value.set(w, h);
      u.uInner.value = 1.2 * this.lineWidth * scale;
      u.uOuter.value = 1.6 * this.outlineWidth * scale;
      const cellPx = tone.pattern === 'dots' || tone.pattern === 'gradient' ? 9 : 15;
      u.uCell.value = cellPx * tone.size * scale;
      u.uTransparent.value = transparent && (style === 'lineart' || style === 'lines-tone') ? 1 : 0;
      u.uPat.value = Math.max(0, TONE_PATTERNS.indexOf(tone.pattern));
      u.uSeed.value = tone.seed;
      u.uOpacity.value = tone.opacity;
      u.uGray.value = tone.grayFill ? 1 : 0;
      u.uBlack.value = tone.blackRange * BLACK_RANGE_SCALE;
      u.uWhite.value = tone.whiteLines ? 1 : 0;
      u.uShadow.value = tone.shadow;
      u.uBase.value = needAlb ? tone.base : 0;
      u.uShade.value = air.shade;
      u.uFar.value = cam.far;
      u.uFocal.value = focal;
      u.uAoR.value = AO_RADIUS_M;
      this._setCloudUniforms(u, cloudsOn, style === 'color' || style === 'color-lines');
      u.uInk.value.set(air.inkTint, air.inkFade);
      u.uThin.value.set(air.lineThin, scale);
      u.uHaze.value = air.haze;
      r.setRenderTarget(compTarget);
      r.clear(true, true, true);
      r.render(this._quadScene, this._quadCam);

      // 4. particles over the composite (occluded through the ND depth), into the same target
      if (partsOn) this._drawParticles(compTarget);
      // 5. post-effect stack: reads the composite (+ ND depth) and writes dst
      if (fxOn) {
        this._fx.render({
          input: T.post.texture,
          depth: needND ? T.nd.texture : null,
          output: dst,
          width: w,
          height: h,
          scale,
          time: this._time,
          near: cam.near,
          far: cam.far,
        });
      }
    } finally {
      scene.background = saved.bg;
      scene.fog = saved.fog;
      scene.overrideMaterial = saved.ov;
      cam.layers.mask = saved.mask;
      r.setClearColor(clearColor, clearAlpha);
      r.setRenderTarget(null);
    }
  }

  /** Sky and cloud uniforms for the composite pass (see skyGradient / cloudSample in COMPOSITE_FRAG). */
  _setCloudUniforms(u, on, colored) {
    const o = this.options;
    u.uCloud.value.set(on ? clamp(o.cloudCover / 100, 0, 1) : 0, clamp(o.cloudScale, 0.3, 3), clamp(o.cloudSoft / 100, 0, 1), clamp(o.cloudShade / 100, 0, 1));
    const cam = this.camera;
    cam.updateMatrixWorld();
    u.uCamRot.value.setFromMatrix4(cam.matrixWorld);
    const ty = Math.tan((cam.fov * DEG) / 2);
    u.uCamTan.value.set(ty * cam.aspect, ty);
    u.uCloudSun.value.copy(this.sunDir || UP_VEC);
    const day = this._skyBlend();
    const night = this._nightS || 0;
    const vec = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    // colour styles: the gradient follows the view direction (the background texture only follows the screen)
    const pal = SKY_PALETTES[o.skyPalette] || SKY_PALETTES.clear;
    const top = mixHex(mixHex(pal.top[0], pal.top[1], day), '#060a1c', night);
    const hor = mixHex(mixHex(pal.hor[0], pal.hor[1], day), '#1b2440', night);
    u.uSkyTop.value.set(...vec(top));
    u.uSkyHor.value.set(...vec(hor));
    u.uSkyGlow.value.set(...vec(mixHex(mixHex('#ff9a5a', pal.glow, day), '#3a4a8a', night)));
    const hazeK = clamp(o.skyHaze / 100, 0, 1);
    u.uSkyOpt.value.set(mix(1.1, 0.3, hazeK), 18, (clamp(o.skyGlow / 100, 0, 1) * 0.55) * (1 - night * 0.8), colored ? 1 : 0);
    u.uSkyTone.value.set(clamp((o.skyScreentone ?? 0) / 100, 0, 1) * 0.8, clamp((o.skyScreentoneReach ?? 50) / 100, 0.1, 1));
    if (!on) return;
    // cloud colours follow the sun height: white and cool grey by day, peach and mauve near the horizon, navy at night
    const lit = mixHex(mixHex('#ffc79a', '#ffffff', day), '#5a6aa0', night);
    const dark = mixHex(mixHex('#b7869f', o.cloudDark === 'blue' ? '#98b0dc' : '#b4c0d8', day), '#1c2547', night);
    u.uCloudLit.value.set(...vec(lit));
    u.uCloudDark.value.set(...vec(dark));
    const style = { puffy: 0, wispy: 1, layered: 2 }[o.cloudStyle] ?? 0;
    const seed = (o.worldSeed || 0) * 7.31;
    u.uCloudOpt.value.set(style, 3.7 + seed, 11.3 + seed * 0.43);
  }

  /** Set the per-frame uniforms shared by the particle and glow materials. */
  _setPartUniforms(w, h, focal, T) {
    const P = this._pu;
    const cam = this.camera;
    P.uTime.value = this._time;
    P.uCam.value.copy(cam.position);
    P.uFocal.value = focal;
    P.uRes.value.set(w, h);
    P.tDepth.value = T.nd.texture;
    P.uFar.value = cam.far;
    P.uLine.value = this.style === 'lineart' || this.style === 'lines-tone' || this.style === 'color-lines' ? 1 : 0;
  }

  /** Draw the particle objects over `target` (already holding the composite). Depth comes from the ND target. */
  _drawParticles(target) {
    const r = this.renderer;
    const cam = this.camera;
    const prevAuto = r.autoClear;
    const prevMask = cam.layers.mask;
    try {
      cam.layers.mask = 1; // particles are on layer 0
      r.autoClear = false;
      r.setRenderTarget(target);
      r.render(this._fxScene, cam);
    } finally {
      r.autoClear = prevAuto;
      cam.layers.mask = prevMask;
    }
  }

  /** Draw one on-screen frame. */
  render() {
    if (!this._mats) return;
    this._time = performance.now() / 1000;
    this._updateTreeLOD();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, Math.round(size.x));
    const h = Math.max(1, Math.round(size.y));
    this._renderFrame(w, h, null, false, this._targetsFor(w, h));
  }

  /**
   * Offscreen hi-res render of the current view. longSide in pixels (capped at 8192).
   * transparent: in line styles alpha = ink coverage (paper becomes transparent).
   * Returns a 2D canvas.
   */
  renderImage(longSide = 3000, { transparent = false } = {}) {
    this._time = performance.now() / 1000;
    this._updateTreeLOD();
    const cap = 8192;
    const L = clamp(Math.round(longSide), 256, cap);
    const aspect = this._cssW / this._cssH;
    let W;
    let H;
    if (aspect >= 1) {
      W = L;
      H = Math.round(L / aspect);
    } else {
      H = L;
      W = Math.round(L * aspect);
    }
    W = Math.min(cap, Math.max(1, W));
    H = Math.min(cap, Math.max(1, H));

    const out = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, samples: 0 });
    const T = this._newTargets(W, H);
    try {
      this._renderFrame(W, H, out, transparent, T);
      const buf = new Uint8Array(W * H * 4);
      this.renderer.readRenderTargetPixels(out, 0, 0, W, H, buf);
      // GL rows are bottom-up: flip while copying into the canvas
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(W, H);
      const row = W * 4;
      for (let y = 0; y < H; y++) {
        img.data.set(buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);
      }
      ctx.putImageData(img, 0, 0);
      return cv;
    } finally {
      out.dispose();
      this._disposeTargets(T);
    }
  }

  /** Release geometries, materials, render targets and the GL context. */
  dispose() {
    this._disposeMeshes();
    this._fx.dispose();
    for (const sys of Object.values(this._parts)) {
      sys.obj.geometry.dispose();
      sys.mat.dispose();
      this._fxScene.remove(sys.obj);
    }
    this._parts = {};
    this._partObjs = [];
    for (const o of this._lampObjs) {
      if (o.parent) o.parent.remove(o);
      o.geometry.dispose();
      if (o.dispose) o.dispose();
    }
    this._lampObjs = [];
    if (this._lampMat) this._lampMat.dispose();
    if (this._glowMat) this._glowMat.dispose();
    this._lampMat = null;
    this._glowMat = null;
    if (this._targets) {
      this._disposeTargets(this._targets);
      this._targets = null;
    }
    if (this._mats) {
      for (const m of Object.values(this._mats)) if (m && m.dispose) m.dispose();
      this._mats = null;
    }
    if (this._quad) this._quad.geometry.dispose();
    if (this._skyTex) this._skyTex.dispose();
    if (this._skyNightTex) this._skyNightTex.dispose();
    if (this.sun && this.sun.shadow.map) this.sun.shadow.map.dispose();
    this.renderer.dispose();
  }
}

// ---------------------------------------------------------------------------
// Module-level geometry helpers (used by CityRenderer)
// ---------------------------------------------------------------------------

export const FOOT_KINDS = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor']);
const MAJOR_KINDS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
]);
// Roads that get guard railings along the sidewalk edge
const RAIL_KINDS = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);
// Parts of the road build that belong to the 'details' group
const DETAIL_PARTS = new Set(['markings', 'street-furniture', 'guard-rails', 'tactile', 'wires']);
const RESIDENTIAL_KINDS = new Set(['residential', 'unclassified', 'living_street', 'service', 'tertiary']);

/**
 * Adds the window grid to a Lambert material. Only vertices with aWin = 1 (inner building walls) get
 * windows. glassExpr is a GLSL statement that darkens diffuseColor by the window weight wf.
 * night = { uNightI, uNightShare, uNightCol } uniforms: at night a hashed share of the window cells
 * glows warm. The glow is added after the lighting (outgoingLight), so it is not shaded.
 */
// Ground surface detail for the colour styles: paving joints on sidewalks, speckle / repair patches / cracks
// on asphalt. World-space patterns, so no extra geometry; they fade out by themselves with distance.
const GROUND_GLSL = `
  float gHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float gNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // 1 on a grid line of width w (metres) with cell size T; filtered by the pixel footprint so it fades, not shimmers
  float gGrid(vec2 p, float T, float w) {
    vec2 q = p / T;
    vec2 fw = max(fwidth(q), vec2(1e-4));
    vec2 d = abs(fract(q - 0.5) - 0.5);
    vec2 e0 = vec2(w / T * 0.5);
    vec2 line = 1.0 - smoothstep(e0, e0 + fw, d);
    float fade = 1.0 - smoothstep(0.25, 0.6, max(fw.x, fw.y));
    return max(line.x, line.y) * fade;
  }
  // sidewalk: paving slabs with joints, a different tone per slab, and a few stained slabs. x = joint strength,
  // y = slab size (m), z = unused
  vec3 walkDetail(vec3 col, vec3 wp) {
    float T = max(uGroundA.y, 0.1);
    vec2 cell = floor(wp.xz / T);
    float h = gHash(cell);
    col *= 1.0 + (h - 0.5) * 0.1 * uGroundA.x;
    col *= 1.0 - 0.1 * step(0.93, gHash(cell + 17.0)) * uGroundA.x; // a stained slab
    float joint = gGrid(wp.xz, T, 0.025);
    return col * (1.0 - 0.2 * joint * uGroundA.x) * (1.0 - uGroundA.w) * mix(vec3(1.0), vec3(0.93, 0.97, 1.06), uGroundA.w * 3.0);
  }
  // asphalt: fine grain, repair patches, a few cracks. x = wear 0..1
  vec3 roadDetail(vec3 col, vec3 wp) {
    float w = uGroundA.z;
    vec2 fw = fwidth(wp.xz);
    float px = max(fw.x, fw.y);
    float grain = (gNoise(wp.xz * 9.0) - 0.5) * 0.09 * (1.0 - smoothstep(0.03, 0.12, px));
    vec2 cell = floor(wp.xz / 2.4);
    float repair = step(1.0 - 0.16 * w, gHash(cell + 5.0));
    vec2 inCell = fract(wp.xz / 2.4);
    float patchMask = repair * step(0.08, inCell.x) * step(inCell.x, 0.92) * step(0.08, inCell.y) * step(inCell.y, 0.92);
    float crackN = gNoise(wp.xz * vec2(0.9, 2.3) + 3.1);
    float crack = (1.0 - smoothstep(0.0, 0.025, abs(crackN - 0.5))) * step(0.55, gNoise(wp.xz * 0.12 + 9.0)) * w;
    float k = 1.0 + grain * (0.4 + w) - 0.09 * patchMask * w - 0.2 * crack;
    return col * k * (1.0 - uGroundA.w * 1.2) * mix(vec3(1.0), vec3(0.9, 0.96, 1.1), uGroundA.w * 3.0);
  }
`;
const GROUND_OPT = { value: new THREE.Vector4(0.6, 0.6, 0.35, 0) }; // x: paving joints 0..1, y: slab size in metres, z: road wear 0..1, w: wet darkening 0..0.3

/** Lambert material with a world-space surface pattern; kind 'walk' (paving) or 'road' (asphalt). */
function groundMaterial(kind) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uGroundA = GROUND_OPT;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vGPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec4 uGroundA;\nvarying vec3 vGPos;\n' + GROUND_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = ' + (kind === 'walk' ? 'walkDetail' : 'roadDetail') + '(diffuseColor.rgb, vGPos);');
  };
  m.customProgramCacheKey = () => `ground-${kind}-v1`;
  return m;
}

// Per-window look for the Lambert building materials only (the edge pass needs just the mask above).
const WINDOW_LOOK_GLSL = `
  // Per-window look. uWinOpt: x variety, y curtains, z sky reflection, w frames and sills (all 0..1).
  // position inside the window rectangle r (see fcWindowAt), 0..1 across and up
  vec2 windowUV(vec3 p, vec3 n, vec4 r) {
    vec2 q = fcCellUV(p, n);
    return vec2((q.x - r.x) / max(r.y - r.x, 0.01), (q.y - r.z) / max(r.w - r.z, 0.01));
  }
  float windowHash(vec3 p, vec3 n) {
    float u = abs(n.x) > 0.5 ? p.z : p.x;
    vec3 wk = vec3(floor(u / 3.0), floor(p.y / 3.2), floor(p.x / 9.0) * 37.0 + floor(p.z / 9.0));
    return fract(sin(dot(wk, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }
  // Colour of a door or passage (op from fcOpeningAt): painted doors in four dark colours with two panels, passages
  // near black and a little lighter at the foot.
  vec3 doorColour(vec3 wall, vec3 p, vec3 n, vec3 op) {
    if (op.x > 1.5) return vec3(0.07, 0.07, 0.08) * (1.0 + 0.8 * (1.0 - op.z));
    float u = abs(n.x) > 0.5 ? p.z : p.x;
    float k = fcDoorColour(floor(vFac.x + 0.5), floor(u / 3.0));
    vec3 c = k < 0.5 ? vec3(0.30, 0.17, 0.11) : k < 1.5 ? vec3(0.13, 0.27, 0.22) : k < 2.5 ? vec3(0.14, 0.20, 0.34) : vec3(0.33, 0.12, 0.13);
    float panel = step(0.15, op.y) * step(op.y, 0.85) * (step(0.08, op.z) * step(op.z, 0.46) + step(0.54, op.z) * step(op.z, 0.92));
    return c * (1.0 - 0.22 * panel);
  }
  // Glass colour: a sky reflection brightening toward the top, a different brightness per window, some
  // with curtains or blinds, a mullion on some, and a light sill under every window.
  vec3 windowColor(vec3 wall, vec3 p, vec3 n, float wf, vec2 fac) {
    vec3 op = fcOpeningAt(p, n, fac);
    float ow = vWin * step(0.5, op.x) * windowFade(uFocalPx, vWDepth, uWinDist);
    if (wf <= 0.0 && uWinOpt.w <= 0.0 && ow <= 0.0) return wall;
    if (ow > 0.0) wall = mix(wall, doorColour(wall, p, n, op), ow);
    float h = windowHash(p, n);
    float h2 = fract(h * 7.13);
    float h3 = fract(h * 13.71);
    vec4 wr = fcWindowAt(p, n, fac);
    vec2 w = windowUV(p, n, wr);
    vec3 glass = mix(vec3(0.20, 0.30, 0.40), vec3(0.52, 0.68, 0.82), smoothstep(0.0, 1.0, w.y) * uWinOpt.z);
    glass = mix(vec3(0.30, 0.40, 0.50), glass, step(0.001, uWinOpt.z));
    glass *= 1.0 + (h - 0.5) * 0.7 * uWinOpt.x;
    // curtains cover the upper part and one side; blinds are horizontal slats
    if (h2 < uWinOpt.y * 0.55) {
      vec3 cloth = h3 < 0.25 ? vec3(0.92, 0.88, 0.74) : h3 < 0.5 ? vec3(0.90, 0.72, 0.74) : h3 < 0.75 ? vec3(0.76, 0.86, 0.74) : vec3(0.72, 0.80, 0.92);
      float side = 0.25 + 0.4 * fract(h * 3.3);
      float cover = max(step(w.y, 0.55) * 0.0 + step(0.72, w.y), step(h3 < 0.5 ? w.x : 1.0 - w.x, side));
      glass = mix(glass, cloth, cover * 0.9);
    } else if (h2 < uWinOpt.y * 0.8) {
      float slat = step(0.5, fract(w.y * 9.0));
      float down = step(w.y, 0.35 + 0.5 * h3);
      glass = mix(glass, mix(vec3(0.78, 0.76, 0.70), vec3(0.62, 0.60, 0.55), slat), 0.9 * (1.0 - down));
    }
    // a vertical mullion on some windows
    if (h3 < 0.4 * uWinOpt.w) glass = mix(glass, vec3(0.13, 0.16, 0.2), step(abs(w.x - 0.5), 0.03));
    vec3 col = mix(wall, glass, wf * 0.9);
    // sill: a light strip just under each window, a little wider than it (not under shop windows)
    vec4 ra;
    vec4 rb;
    float cell = fcCell(p, n, fac, ra, rb);
    vec2 q = fcCellUV(p, n);
    float sill = 0.0;
    if (cell > 0.5 && cell < 1.5) {
      sill = max(
        (ra.y > ra.x && q.y >= ra.z - 0.1 && q.y < ra.z && q.x >= ra.x - 0.1 && q.x < ra.y + 0.1) ? 1.0 : 0.0,
        (rb.y > rb.x && q.y >= rb.z - 0.1 && q.y < rb.z && q.x >= rb.x - 0.1 && q.x < rb.y + 0.1) ? 1.0 : 0.0);
    }
    float fade = windowFade(uFocalPx, vWDepth, uWinDist);
    return mix(col, mix(wall, vec3(0.9, 0.88, 0.83), 0.8), sill * vWin * uWinOpt.w * fade);
  }
  float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = fract(sin(dot(i, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n100 = fract(sin(dot(i + vec3(1.0, 0.0, 0.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n010 = fract(sin(dot(i + vec3(0.0, 1.0, 0.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n110 = fract(sin(dot(i + vec3(1.0, 1.0, 0.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n001 = fract(sin(dot(i + vec3(0.0, 0.0, 1.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n101 = fract(sin(dot(i + vec3(1.0, 0.0, 1.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n011 = fract(sin(dot(i + vec3(0.0, 1.0, 1.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    float n111 = fract(sin(dot(i + vec3(1.0, 1.0, 1.0), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }
  // Weathering of the wall itself: darker toward the ground (splash and dirt), a mottled stain pattern, and
  // streaks under the windows. Returns a multiplier; windows themselves are left alone.
  float wallWeather(vec3 p, vec3 n, float wf) {
    if (uWallWeather <= 0.0 || abs(n.y) > 0.5) return 1.0;
    float u = abs(n.x) > 0.5 ? p.z : p.x;
    float low = 1.0 - smoothstep(0.0, 4.5, p.y);
    float mott = vnoise3(vec3(u * 0.45, p.y * 0.35, (abs(n.x) > 0.5 ? p.x : p.z) * 0.45)) - 0.5;
    // drip stains under some windows: a darker band below the sill, fading as it runs down the wall
    float fy = mod(p.y, 3.2);
    float col = abs(mod(u, 3.0) - 1.5);
    float h = windowHash(p, n);
    float streak = step(0.5, h) * (1.0 - smoothstep(0.55, 0.85, col)) * smoothstep(0.0, 0.78, fy) * step(fy, 0.8) * step(2.0, p.y);
    float k = 1.0 - uWallWeather * (0.4 * low + 0.34 * mott + 0.18 * streak);
    return mix(clamp(k, 0.55, 1.05), 1.0, wf);
  }
  // Lit grayscale pass (lines + tone): the same variety as a darker or lighter window.
  float windowShade(vec3 p, vec3 n, float wf, vec2 fac) {
    float h = windowHash(p, n);
    float h2 = fract(h * 7.13);
    float k = 0.8 * (1.0 + (h - 0.5) * 0.7 * uWinOpt.x);
    if (h2 < uWinOpt.y * 0.55) k = mix(k, 1.0, 0.7); // curtains read light
    float shade = mix(1.0, clamp(k, 0.35, 1.0), wf);
    // doors read mid grey, passages (alley openings) dark
    vec3 op = fcOpeningAt(p, n, fac);
    float ow = vWin * step(0.5, op.x) * windowFade(uFocalPx, vWDepth, uWinDist);
    return mix(shade, op.x > 1.5 ? 0.06 : 0.5, ow);
  }
`;

// window look uniform shared by every building material: variety, curtains, sky reflection, frames and sills (0..1)
const FACADE_OPT = { value: new THREE.Vector2(0.6, 0.5) }; // x: share of buildings with a non-classic window style 0..1, y: doors / passages / shop windows 0..1
const WIN_OPT = { value: new THREE.Vector4(0.6, 0.3, 0.6, 0.5) };
const WALL_WEATHER = { value: 0.4 }; // wall weathering 0..1
function windowPatch(shader, winDistU, focalU, glassExpr, night) {
  shader.uniforms.uWinDist = winDistU;
  shader.uniforms.uFacade = FACADE_OPT;
  shader.uniforms.uFocalPx = focalU;
  shader.uniforms.uWinOpt = WIN_OPT;
  shader.uniforms.uWallWeather = WALL_WEATHER;
  shader.uniforms.uNightI = night.uNightI;
  shader.uniforms.uNightShare = night.uNightShare;
  shader.uniforms.uNightCol = night.uNightCol;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aWin;\nattribute vec2 aFac;\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nvarying float vWin;\nvarying vec2 vFac;\nvarying float vWDepth;')
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vec4 wpW = modelMatrix * vec4(transformed, 1.0);\n  vWPos = wpW.xyz;\n  vWNrm = normalize(mat3(modelMatrix) * objectNormal);\n  vWin = aWin;\n  vFac = aFac;\n  vWDepth = -(viewMatrix * wpW).z;'
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform float uWinDist;\nuniform float uFocalPx;\nuniform vec4 uWinOpt;\nuniform float uWallWeather;\nuniform float uNightI;\nuniform float uNightShare;\nuniform vec3 uNightCol;\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nvarying float vWin;\nvarying vec2 vFac;\nvarying float vWDepth;\n' + WINDOW_GLSL + WINDOW_LOOK_GLSL
    )
    .replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  float wf = vWin * windowMask(vWPos, vWNrm, vFac) * windowFade(uFocalPx, vWDepth, uWinDist);\n  ' + glassExpr
    )
    .replace(
      '#include <opaque_fragment>',
      `{
    // night: each window cell is lit when its hash is under the share (uNightShare); emissive, unshaded
    float uu = abs(vWNrm.x) > 0.5 ? vWPos.z : vWPos.x;
    vec3 wk = vec3(floor(uu / 3.0), floor(vWPos.y / 3.2), floor(vWPos.x / 9.0) * 37.0 + floor(vWPos.z / 9.0));
    float hl = fract(sin(dot(wk, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    outgoingLight += uNightCol * (uNightI * step(hl, uNightShare) * wf);
  }
  #include <opaque_fragment>`
    );
}

/** Hash of a 3D point -> [0, 1). Same input gives the same value, so shared vertices move together. */
function hash3(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Distance from (px, py) to the segment a-b (both [x, y]). */
function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / L2, 0, 1) : 0;
  return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
}

// Crown lobes per leafEdge: lobe count (incl. the centre lobe), lobe radius range (unit crown),
// icosahedron detail, and per-vertex noise displacement (fraction of the lobe radius).
const CROWN_LOBES = {
  smooth: { lobes: [4, 5], rad: [0.34, 0.44], detail: 2, disp: 0.05 },
  bumpy: { lobes: [5, 6], rad: [0.36, 0.5], detail: 2, disp: 0.14 },
  fluffy: { lobes: [6, 7], rad: [0.32, 0.5], detail: 3, disp: 0.24 },
};

// Tree species mix per options.treeType ([crown kind, weight]) and size range per options.treeSize.
const TREE_MIX = {
  mixed: [['round', 0.6], ['columnar', 0.15], ['conifer', 0.25]],
  broadleaf: [['round', 1]],
  conifer: [['conifer', 1]],
  columnar: [['columnar', 1]],
  palm: [['palm', 1]],
  tropical: [['palm', 0.35], ['umbrella', 0.35], ['round', 0.3]],
  auto: 'auto',
};
// Building kinds (OSM building=*) whose walls get no window grid
const NO_WINDOW_KINDS = new Set(['steps', 'roof', 'shed', 'carport', 'kiosk', 'hut', 'bridge', 'ruins', 'monument', 'memorial', 'tomb', 'gazebo', 'pavilion', 'stadium', 'service']);
const LEGACY_DENSITY = { none: 0, few: 35, many: 80 };
// Options that change what is in the scene and so rebuild it
const WORLD_KEYS = [
  'peopleDensity', 'walkShare', 'standShare', 'talkShare', 'groupSize', 'kidsShare', 'crossing', 'gesture',
  'carDensity', 'carParked', 'carQueue', 'carTypes', 'carPalette', 'trafficSide', 'worldSeed',
  'treeDensity', 'treeMix', 'treeSizeMin', 'treeSizeMax',
  'landmarks', 'detailPoles', 'detailSignals', 'detailRails', 'detailCrosswalks', 'detailTactile',
  'roofStyle', 'roofColor', 'wallTone', 'furnBenches', 'furnBins', 'furnStops', 'benchStyle', 'benchColor', 'binStyle', 'benchWear',
  'barrierFences', 'barrierWalls', 'barrierHedges', 'barrierScale',
  'foliageSat', 'foliageHue', 'foliageLight',
  'edgeLines', 'hydrantDensity', 'hydrantColour', 'hydrantSize', 'taxiShare', 'taxiColour', 'cafeDensity', 'cafeColour', 'cafeParasol', 'cafeSize', 'shutterDensity', 'shutterColour', 'shutterClosed', 'trimShare', 'trimTone', 'trimDepth', 'litterDensity', 'litterColour', 'litterSize', 'umbrellaShare', 'umbrellaColour', 'umbrellaSize', 'plateDensity', 'plateColour', 'plateSize', 'rubbishDensity', 'rubbishKind', 'binColour', 'rubbishSize', 'adDensity', 'adStyle', 'adSize', 'posterColour', 'birdDensity', 'birdKind', 'birdSize', 'scooterDensity', 'scooterColour', 'scooterStyle', 'scooterSize', 'postboxDensity', 'postboxStyle', 'postboxSize', 'lanternDensity', 'lanternColour', 'lanternSize', 'norenDensity', 'acDensity', 'acTone', 'acSize', 'balconyDensity', 'balconyStyle', 'balconyWidth', 'laundryAmount', 'wetStreets', 'puddleSize', 'planterDensity', 'planterStyle', 'planterColour', 'planterSize', 'surroundWindows', 'lampDensity', 'lampStyle', 'lampHeight', 'patchDensity', 'crackDensity', 'patchSize', 'coverDensity', 'coverTone', 'coverSize', 'carTrim', 'roadSignDensity', 'roadSignStyle', 'mirrorDensity', 'bikeDensity', 'bikeColour', 'bikeStyle', 'roofClutter', 'roofParapet', 'roofTank', 'awningDensity', 'awningColour', 'awningDepth', 'signDensity', 'vendingDensity', 'vendingColour', 'poleSpacing', 'poleStyle', 'poleTransformers', 'wireCount', 'wireSag', 'wireThickness',
];
/**
 * Species mix for a place from its latitude / longitude, so the tropics get spreading rain trees and
 * palms instead of northern conifers. Weights are [crown kind, share].
 */
function autoTreeMix(c) {
  const lat = c ? Math.abs(c.lat) : 45;
  const eastAsia = !!c && c.lon >= 100 && c.lon <= 146 && c.lat >= 20 && c.lat <= 46;
  const south = !!c && c.lat < 0;
  let w;
  if (lat < 15) w = { umbrella: 38, round: 34, palm: 22, columnar: 6 };
  else if (lat < 25) w = { round: 46, umbrella: 22, palm: 18, columnar: 9, conifer: 5 };
  else if (lat < 35) w = { round: 62, columnar: 12, conifer: 10, umbrella: 8, palm: 8 };
  else if (lat < 52) w = { round: 60, columnar: 15, conifer: 25 };
  else w = { round: 45, conifer: 40, columnar: 15 };
  if (eastAsia && lat >= 25) w = { round: 72, columnar: 14, conifer: 10, umbrella: 4 }; // Japan, Korea, north China
  else if (south && lat >= 25) w = { round: 72, columnar: 10, conifer: 8, palm: 6, umbrella: 4 };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.entries(w).map(([k, v]) => [k, v / total]);
}

/**
 * Shapes of the limbs under a crown, origin at the trunk top (metres at tree size 1): { base, knee, tip, fork }.
 * fork = five limbs rising into a broadleaf crown; spread = six wide, low limbs of a rain tree.
 */
function limbSpecs(shape) {
  const r = rng(hashStr(`limbs:${shape}`));
  const n = shape === 'spread' ? 6 : 5;
  const out = [];
  for (let k = 0; k < n; k++) {
    const th = (k / n) * Math.PI * 2 + (r() - 0.5) * 0.5;
    const dx = Math.cos(th), dz = Math.sin(th);
    const reach = shape === 'spread' ? 3.4 + 0.9 * r() : 1.5 + 0.6 * r();
    const rise = shape === 'spread' ? 1.5 + 0.5 * r() : 2.2 + 0.8 * r();
    const knee = [dx * reach * 0.45, rise * 0.55, dz * reach * 0.45];
    // a fork off the knee
    const a2 = th + (r() < 0.5 ? -1 : 1) * (0.6 + 0.4 * r());
    const f = shape === 'spread' ? 1.8 : 1.0;
    out.push({
      base: [0, -0.6, 0],
      knee,
      tip: [dx * reach, rise, dz * reach],
      fork: [knee[0] + Math.cos(a2) * f, knee[1] + 0.8 + 0.5 * r(), knee[2] + Math.sin(a2) * f],
    });
  }
  return out;
}

/** 'round:60,conifer:25' -> [['round', 0.6], ['conifer', 0.25]]; unknown kinds and zero weights are dropped. */
function parseTreeMix(str, center) {
  if (str === 'auto') return autoTreeMix(center);
  const kinds = new Set(['round', 'columnar', 'conifer', 'palm', 'umbrella']);
  const out = [];
  for (const part of String(str || '').split(',')) {
    const [k, w] = part.split(':');
    if (kinds.has(k) && Number(w) > 0) out.push([k, Number(w)]);
  }
  if (!out.length) return TREE_MIX.mixed;
  const total = out.reduce((a, e) => a + e[1], 0);
  return out.map(([k, w]) => [k, w / total]);
}
const TREE_SIZE = { small: [0.7, 0.75], normal: [0.95, 1.05], large: [1.25, 1.4], varied: [0.6, 1.45] };
// Evergreen crowns: the same in every season.
const CONIFER_CROWN = ['#2f5d3a', '#35683f', '#29523a', '#3d6f45'];
const PALM_CROWN = ['#4f8f3a', '#5e9c40', '#467f35'];

// Background figures (see _figureGeometries): pose, lower body, hair, coat, shoulder bag.
const FIGURE_VARIANTS = [
  { pose: 'walk', bottom: 'pants', hair: 'short' },
  { pose: 'walk', bottom: 'skirt', hair: 'long' },
  { pose: 'stand', bottom: 'pants', hair: 'short', bag: true },
  { pose: 'walk', bottom: 'pants', hair: 'bun', coat: true },
  { pose: 'phone', bottom: 'skirt', hair: 'long' },
  { pose: 'stand', bottom: 'pants', hair: 'short', coat: true },
  { pose: 'walk', bottom: 'pants', hair: 'short', bag: true },
  { pose: 'phone', bottom: 'pants', hair: 'bun' },
  // conversation poses (talking groups; also mixed in among people standing around)
  { pose: 'talk', bottom: 'pants', hair: 'short', talk: true },
  { pose: 'open', bottom: 'skirt', hair: 'long', talk: true },
  { pose: 'hips', bottom: 'pants', hair: 'bun', coat: true, talk: true },
  { pose: 'crossed', bottom: 'pants', hair: 'short', talk: true },
  { pose: 'point', bottom: 'skirt', hair: 'bun', bag: true, talk: true },
  { pose: 'talk', bottom: 'skirt', hair: 'long', coat: true, talk: true },
  { pose: 'wave', bottom: 'pants', hair: 'short', bag: true, talk: true },
];
// variant indices by role
const WALK_VARIANTS = FIGURE_VARIANTS.flatMap((v, i) => (v.pose === 'walk' ? [i] : []));
const IDLE_VARIANTS = FIGURE_VARIANTS.flatMap((v, i) => (v.pose === 'stand' || v.pose === 'phone' ? [i] : []));
const TALK_VARIANTS = FIGURE_VARIANTS.flatMap((v, i) => (v.talk ? [i] : []));
// [colour, weight] palettes for pickWeighted
const SHIRT_COLORS = [['#f4f4f2', 5], ['#2b2f3a', 3], ['#5d7896', 2], ['#c9b48f', 2], ['#9a3b35', 1], ['#6f8a5a', 1], ['#d9a441', 1], ['#8c8f96', 2]];
const COAT_COLORS = [['#2a2c33', 4], ['#a68a64', 3], ['#56606e', 2], ['#7a3b34', 1], ['#d8d2c4', 1]];
const PANTS_COLORS = [['#2f3a52', 4], ['#26262b', 4], ['#6b6f78', 2], ['#b9a98a', 2], ['#47556e', 2]];
const SKIRT_COLORS = [['#2a2c38', 3], ['#7d8fa8', 2], ['#9c4a4a', 1], ['#c9bc9f', 2], ['#4d5a43', 1]];
const HAIR_COLORS = [['#1c1a1a', 6], ['#3a2a22', 4], ['#6a4a32', 2], ['#b08a55', 1], ['#9a9a9a', 1]];

// Car body types [name, weight]; buses only on wide main roads. Colours lean white / silver / black like real traffic.
// per car type: body width, front and rear z, lamp height and width, wheel radius, wheelbase and track (see _carGeometry)
const CAR_TRIM = {
  sedan: { w: 1.76, front: 2.25, rear: -2.25, lampY: 0.68, lamp: 0.3, wr: 0.32, base: 2.6, track: 1.5 },
  compact: { w: 1.68, front: 1.9, rear: -1.9, lampY: 0.64, lamp: 0.26, wr: 0.3, base: 2.4, track: 1.42 },
  kei: { w: 1.47, front: 1.7, rear: -1.7, lampY: 0.62, lamp: 0.24, wr: 0.28, base: 2.3, track: 1.28 },
  suv: { w: 1.86, front: 2.35, rear: -2.35, lampY: 0.82, lamp: 0.32, wr: 0.38, base: 2.8, track: 1.6 },
  van: { w: 1.9, front: 2.45, rear: -2.45, lampY: 0.7, lamp: 0.3, wr: 0.34, base: 3.1, track: 1.62 },
  pickup: { w: 1.5, front: 2.25, rear: -1.78, lampY: 0.68, lamp: 0.26, wr: 0.3, base: 2.4, track: 1.3 },
  bus: { w: 2.5, front: 5.25, rear: -5.25, lampY: 0.8, lamp: 0.4, wr: 0.5, base: 6.0, track: 2.0 },
};
const CAR_TYPES = [['sedan', 30], ['compact', 22], ['kei', 14], ['suv', 14], ['van', 8], ['pickup', 7], ['bus', 5]];
const CAR_COLORS = [
  ['#f2f2f4', 25], ['#c3c7cc', 15], ['#26262b', 15], ['#7c8189', 10], ['#2e3f63', 8], ['#b8352b', 8],
  ['#3a6ea5', 6], ['#d8c9a8', 5], ['#3f5d45', 4], ['#e5b93a', 2], ['#8a2433', 2],
];
const MONO_CAR_COLORS = [['#f2f2f4', 30], ['#c3c7cc', 20], ['#7c8189', 14], ['#26262b', 28]];
const MONO_BUS_COLORS = ['#f2f2f4', '#c3c7cc', '#7c8189'];
const COLORFUL_CAR_COLORS = [
  ['#d33a2f', 3], ['#e5b93a', 3], ['#2f7fd0', 3], ['#2f9a5c', 3], ['#e57a2f', 2], ['#8a4fc0', 2], ['#e56fa0', 2], ['#33b5b0', 2], ['#f2f2f4', 2],
];
const BUS_COLORS = ['#f2f2f4', '#3a6ea5', '#2f8a5c', '#e5b93a'];
const PARK_KINDS = new Set(['residential', 'unclassified', 'living_street', 'service', 'tertiary']);
const BUS_KINDS = new Set(['primary', 'secondary', 'trunk', 'tertiary', 'primary_link', 'secondary_link']);

// Zebra crossings sit CROSS_AT m out along each junction leg and are 2 * CROSS_HALF m wide (see _crosswalk).
const CROSS_AT = 7;
const CROSS_HALF = 1.6;

/**
 * Junctions of drawn roads: vertices shared by two or more non-foot roads (matched to 0.5 m).
 * entries: [{ pts, foot, major, w }]. Each leg (a road leaving the junction with at least 10 m to its
 * next vertex) carries a zebra crossing centred at (cx, cy); (ux, uy) points away from the junction and
 * path is the road's polyline from the junction outward (for queues that follow bends).
 * Returns [{ x, y, roads: Set of entry indices, signal, legs: [{ ei, ux, uy, w, len, px, py, cx, cy, path }] }].
 */
function findJunctions(entries) {
  const junc = new Map();
  entries.forEach((e, ei) => {
    if (e.foot || e.bridge || e.layer > 0) return;
    e.pts.forEach((p, vi) => {
      const key = `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
      let j = junc.get(key);
      if (!j) {
        j = { x: p[0], y: p[1], refs: [] };
        junc.set(key, j);
      }
      j.refs.push({ ei, vi });
    });
  });
  const out = [];
  for (const j of junc.values()) {
    const roads = new Set(j.refs.map((rf) => rf.ei));
    if (roads.size < 2) continue;
    const legs = [];
    for (const rf of j.refs) {
      const e = entries[rf.ei];
      const p = e.pts[rf.vi];
      for (const step of [-1, 1]) {
        const nb = e.pts[rf.vi + step];
        if (!nb) continue;
        const dx = nb[0] - p[0];
        const dy = nb[1] - p[1];
        const L = Math.hypot(dx, dy);
        if (L < 10) continue; // too short for a crossing on this leg
        const ux = dx / L;
        const uy = dy / L;
        const path = step > 0 ? e.pts.slice(rf.vi) : e.pts.slice(0, rf.vi + 1).reverse();
        legs.push({ ei: rf.ei, ux, uy, w: e.w, len: L, px: p[0], py: p[1], cx: p[0] + ux * CROSS_AT, cy: p[1] + uy * CROSS_AT, path });
      }
    }
    out.push({ x: j.x, y: j.y, roads, signal: [...roads].some((ei) => entries[ei].major), legs });
  }
  return out;
}

/** Point d metres along a polyline with the unit tangent there: { x, y, tx, ty }, or null past its end. */
function pointAlong(pts, d) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    if (d <= L) {
      const tx = (b[0] - a[0]) / L;
      const ty = (b[1] - a[1]) / L;
      return { x: a[0] + tx * d, y: a[1] + ty * d, tx, ty };
    }
    d -= L;
  }
  return null;
}

/** Even-odd point-in-polygon test for a ring of [x, y] points. */
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, k = ring.length - 1; i < ring.length; k = i++) {
    const a = ring[i];
    const b = ring[k];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Weighted pick from [[value, weight], ...] with u in [0, 1); weightOf may override the weights. */
function pickWeighted(list, u, weightOf = (e) => e[1]) {
  let total = 0;
  for (const e of list) total += weightOf(e);
  let acc = 0;
  for (const e of list) {
    acc += weightOf(e);
    if (u * total < acc) return e[0];
  }
  return list[list.length - 1][0];
}

/**
 * Links entries (roads) that continue each other end to end (same kind and name, exactly two ways meeting
 * at the vertex) and gives each one `spts` (its points, reversed if the chain runs the other way) and the
 * sampling phases `pOff` / `cOff`: where the first sample falls so that spacing stays even across the chain
 * (people every 5 m, cars every 6 m). `shiftP` / `shiftC` are the random starting shifts for each chain.
 */
function chainEntries(entries, shiftP, shiftC) {
  const key = (p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
  const at = new Map();
  entries.forEach((e, i) => {
    for (const end of [0, 1]) {
      const k = key(end ? e.pts[e.pts.length - 1] : e.pts[0]);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push({ i, end });
    }
  });
  // the neighbour of entry i at one of its ends, or null
  const next = (i, end) => {
    const e = entries[i];
    const refs = at.get(key(end ? e.pts[e.pts.length - 1] : e.pts[0]));
    if (refs.length !== 2) return null;
    const o = refs.find((r) => r.i !== i);
    if (!o) return null;
    const f = entries[o.i];
    return f.kind === e.kind && f.name === e.name && f.foot === e.foot ? o : null;
  };
  const len = (pts) => pts.reduce((a, p, k) => (k ? a + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0);
  const mod = (v, m) => ((v % m) + m) % m;
  const seen = new Set();
  const walk = (start, end0) => {
    // follow the chain from entry `start`, leaving through its `end0` end; returns [{ i, rev }]
    const out = [];
    let i = start, leave = end0;
    while (i !== null && !seen.has(i)) {
      seen.add(i);
      out.push({ i, rev: leave === 0 });
      const nb = next(i, leave);
      if (!nb) break;
      i = nb.i;
      leave = nb.end === 0 ? 1 : 0; // entered at nb.end, so leave by the other end
    }
    return out;
  };
  const chains = [];
  // chains starting at a loose end first, then closed loops
  entries.forEach((e, i) => {
    if (seen.has(i)) return;
    if (!next(i, 0)) chains.push(walk(i, 1));
    else if (!next(i, 1)) chains.push(walk(i, 0));
  });
  entries.forEach((e, i) => { if (!seen.has(i)) chains.push(walk(i, 1)); });
  for (const chain of chains) {
    let dist = 0;
    for (const { i, rev } of chain) {
      const e = entries[i];
      e.spts = rev ? e.pts.slice().reverse() : e.pts;
      e.pOff = mod(shiftP - dist, 5);
      e.cOff = mod(shiftC - dist, 6);
      dist += len(e.pts);
    }
  }
}

/** Piecewise-linear value of `x` through [[x0, y0], [x1, y1], ...] (x ascending); clamped at both ends. */
function lerpAnchors(x, anchors) {
  if (x <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [x1, y1] = anchors[i];
    if (x <= x1) {
      const [x0, y0] = anchors[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return anchors[anchors.length - 1][1];
}

/** Rough check for the countries that drive on the left (Japan, UK and Ireland, South and Southeast Asia, Oceania, southern Africa). */
function leftHandTraffic(lat, lon) {
  const boxes = [
    [24, 46, 122, 146], // Japan
    [49.8, 61, -11, 2], // UK, Ireland
    [-44, -10, 112, 154], // Australia
    [-48, -34, 166, 179], // New Zealand
    [6, 36, 68, 92], // India
    [5.5, 20.5, 97.5, 105.7], // Thailand
    [-11, 7, 95, 141.5], // Indonesia, Malaysia, Singapore
    [22.1, 22.6, 113.8, 114.5], // Hong Kong
    [-35, -22, 16, 33], // South Africa
  ];
  return boxes.some(([a, b, c, d]) => lat >= a && lat <= b && lon >= c && lon <= d);
}

/** Rounded limb from a to b ([x, y, z]): a cylinder tapering from radius ra to rb with ball ends. */
function limb(a, b, ra, rb, col) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length() || 1e-3;
  const g = new THREE.CylinderGeometry(rb, ra, len, 10, 1, true); // top (+Y) end is b
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  const ea = new THREE.SphereGeometry(ra, 10, 6);
  ea.translate(...a);
  const eb = new THREE.SphereGeometry(rb, 10, 6);
  eb.translate(...b);
  return mergeGeometries([toBatchable(g, col), toBatchable(ea, col), toBatchable(eb, col)], false);
}

/** Box w x h x d centred at the origin whose top face is topW x topD and shifted by shift in z (car hoods, cabins). */
function taperBox(w, h, d, topW, topD, shift, col) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) pos.setXYZ(i, (pos.getX(i) * topW) / w, pos.getY(i), (pos.getZ(i) * topD) / d + shift);
  }
  g.deleteAttribute('normal');
  return toBatchable(g, col);
}

/** One crown lobe: icosahedron at (cx, cy, cz) with per-vertex noise displacement and smooth normals. */
function crownLobe(cx, cy, cz, rad, detail, disp) {
  const g = new THREE.IcosahedronGeometry(rad, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g.translate(cx, cy, cz);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const dx = x - cx;
    const dy = y - cy;
    const dz = z - cz;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const a = (hash3(x, y, z) * 2 - 1) * disp * rad;
    pos.setXYZ(i, x + (dx / dl) * a, y + (dy / dl) * a, z + (dz / dl) * a);
  }
  const m = mergeVertices(g); // weld shared vertices so the normals come out smooth
  m.computeVertexNormals();
  return toBatchable(m, [1, 1, 1]);
}

/**
 * Wall quads for every ring (outer + holes) from yb to yt.
 * Normals face away from the solid: outer rings outward, hole rings into the hole.
 */
function addWalls(batch, outer, holes, yb, yt, col) {
  const rings = [outer, ...(holes || []).filter((h) => h && h.length > 2)];
  for (let k = 0; k < rings.length; k++) {
    const ring = rings[k];
    const s = signedArea(ring) >= 0 ? 1 : -1;
    const sgn = k === 0 ? s : -s;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % n];
      const dx = q[0] - p[0];
      const dy = q[1] - p[1];
      if (dx * dx + dy * dy < 1e-6) continue;
      // local normal = sgn * (dy, -dx); world (x, y, z = -y) -> (nx, 0, -ny)
      const hint = [sgn * dy, 0, sgn * dx];
      const a = [p[0], yb, -p[1]];
      const b = [q[0], yb, -q[1]];
      const c = [q[0], yt, -q[1]];
      const d = [p[0], yt, -p[1]];
      batch.quad(a, b, c, d, hint, col);
    }
  }
}

/** Flat cap (triangulated footprint with holes) at height y. */
function addCap(batch, outer, holes, y, col) {
  const { pts, tris } = triangulate(outer, holes);
  for (const t of tris) {
    const a = pts[t[0]];
    const b = pts[t[1]];
    const c = pts[t[2]];
    batch.tri([a.x, y, -a.y], [b.x, y, -b.y], [c.x, y, -c.y], UP, col);
  }
}

/**
 * Simple roof on top of the wall ring.
 * shape 'pyramidal' -> pyramid to the centroid; 'hipped' -> hip roof; anything else -> gable
 * along the footprint's major axis. Heights rise by roofH above wallTop.
 */
function addRoof(batch, outer, wallTop, roofH, shape, col) {
  const { c, e1, e2 } = principalAxes(outer);
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const p of outer) {
    const dx = p[0] - c[0];
    const dy = p[1] - c[1];
    const u = dx * e1[0] + dy * e1[1];
    const v = dx * e2[0] + dy * e2[1];
    if (u < umin) umin = u;
    if (u > umax) umax = u;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
  }
  const apexH = wallTop + roofH;
  const cen = [c[0], wallTop, -c[1]];
  // outward hint: from roof centre towards the face centroid
  const hintOf = (pts) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const p of pts) {
      x += p[0];
      y += p[1];
      z += p[2];
    }
    const k = 1 / pts.length;
    return [x * k - cen[0], y * k - cen[1], z * k - cen[2]];
  };
  // local (u, v) on the footprint's axes at height h -> world [x, h, -y]
  const P = (u, v, h) => [c[0] + e1[0] * u + e2[0] * v, h, -(c[1] + e1[1] * u + e2[1] * v)];

  if (shape === 'pyramidal') {
    const apex = [c[0], apexH, -c[1]];
    const n = outer.length;
    for (let i = 0; i < n; i++) {
      const p = outer[i];
      const q = outer[(i + 1) % n];
      const a = [p[0], wallTop, -p[1]];
      const b = [q[0], wallTop, -q[1]];
      batch.tri(a, b, apex, hintOf([a, b, apex]), col);
    }
    return;
  }

  const hipped = shape === 'hipped';
  const ins = hipped ? Math.max(0, Math.min((umax - umin) / 2, (vmax - vmin) / 2)) : 0;
  const vm = (vmin + vmax) / 2;
  const p00 = P(umin, vmin, wallTop);
  const p10 = P(umax, vmin, wallTop);
  const p11 = P(umax, vmax, wallTop);
  const p01 = P(umin, vmax, wallTop);
  const ra = P(umin + ins, vm, apexH);
  const rb = P(umax - ins, vm, apexH);
  batch.quad(p00, p10, rb, ra, hintOf([p00, p10, rb, ra]), col); // south slope
  batch.quad(p11, p01, ra, rb, hintOf([p11, p01, ra, rb]), col); // north slope
  batch.tri(p01, p00, ra, hintOf([p01, p00, ra]), col); // west end (gable or hip)
  batch.tri(p10, p11, rb, hintOf([p10, p11, rb]), col); // east end (gable or hip)
}

/**
 * Sample points every `every` metres along a polyline, starting at `offset0`.
 * Each sample carries the unit tangent (tx, ty) and the right-hand normal (nx, ny).
 */
function samplePoly(points, every, offset0) {
  const out = [];
  let next = offset0;
  let run = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    while (run + L >= next) {
      const t = (next - run) / L;
      out.push({ x: a[0] + dx * t, y: a[1] + dy * t, nx: dy / L, ny: -dx / L, tx: dx / L, ty: dy / L });
      next += every;
    }
    run += L;
  }
  return out;
}

/** Split a polyline into dashes: `on` metres drawn, `off` metres skipped. */
function polyDashes(points, on, off) {
  const out = [];
  let cur = null;
  let drawing = true;
  let remain = on;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i][0];
    const ay = points[i][1];
    const bx = points[i + 1][0];
    const by = points[i + 1][1];
    const segLen = Math.hypot(bx - ax, by - ay);
    if (segLen < 1e-9) continue;
    let t0 = 0;
    while (segLen - t0 > 1e-9) {
      const step = Math.min(remain, segLen - t0);
      const f0 = t0 / segLen;
      const f1 = (t0 + step) / segLen;
      const p0 = [ax + (bx - ax) * f0, ay + (by - ay) * f0];
      const p1 = [ax + (bx - ax) * f1, ay + (by - ay) * f1];
      if (drawing) {
        if (!cur) cur = [p0];
        cur.push(p1);
      }
      t0 += step;
      remain -= step;
      if (remain <= 1e-9) {
        if (drawing && cur) {
          out.push(cur);
          cur = null;
        }
        drawing = !drawing;
        remain = drawing ? on : off;
      }
    }
  }
  if (cur && cur.length > 1) out.push(cur);
  return out;
}

/**
 * Window and door outlines for the SVG line set, matching WINDOW_GLSL's world-aligned grid exactly (the shapes come
 * from facade.js, which the shader mirrors), so the vector export lines up with the raster windows. Pushes segment
 * pairs (world xyz) onto segs. `facade` = { seed, base, variety, openings }.
 */
function addWindowSegs(segs, ring, bottom, wallTop, facade) {
  const OUT = 0.03; // lift off the wall so the SVG depth test does not hide them
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1.6) continue;
    // outward normal of a CCW ring in local 2D is (dy, -dx); world normal = (nx, 0, -ny)
    const nx = dy / len;
    const ny = -dx / len;
    // u follows the shader: world z (= -local y) when |n.x| > 0.5, else world x (= local x)
    const useZ = Math.abs(nx) > 0.5;
    const ua = useZ ? -a[1] : a[0];
    const ub = useZ ? -b[1] : b[0];
    if (Math.abs(ub - ua) < 0.5) continue; // wall almost perpendicular to its u axis: no clean windows
    const uMin = Math.min(ua, ub);
    const uMax = Math.max(ua, ub);
    const at = (u) => {
      const t = (u - ua) / (ub - ua);
      return [a[0] + dx * t + nx * OUT, a[1] + dy * t + ny * OUT];
    };
    const { windows, doors } = facadeShapes(facade.seed, facade.base, uMin, uMax, bottom, wallTop, facade);
    for (const w of [...windows, ...doors]) {
      const p0 = at(w.u0);
      const p1 = at(w.u1);
      const A = [p0[0], w.y0, -p0[1]], B = [p1[0], w.y0, -p1[1]];
      const C = [p1[0], w.y1, -p1[1]], D = [p0[0], w.y1, -p0[1]];
      segs.push(...A, ...B, ...B, ...C, ...C, ...D, ...D, ...A);
    }
  }
}
