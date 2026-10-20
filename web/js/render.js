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
import { landmarksFor } from './landmarks.js';

const DEG = Math.PI / 180;
const UP = [0, 1, 0];
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
  pole: '#5a4a3c',
  signal: '#3d3d3d',
  trunk: '#7b5a3e',
  surr: '#ddd6c7',
  person: '#c58f6a',
  car: ['#e9e9ee', '#c94a3b', '#3d5a80', '#f0c040', '#2f2f36', '#8fa3b0'],
};

const WALLS = {
  house: ['#f3e2c7', '#e9d4b5', '#f5ebd9', '#dcc7a6'],
  residential: ['#f3e2c7', '#e9d4b5', '#f5ebd9', '#dcc7a6'],
  apartments: ['#ece4d6', '#e3d7c4', '#d9d4c8'],
  commercial: ['#e7e2da', '#d6d0c5', '#efe8dd', '#cfc8ba'],
  retail: ['#e7e2da', '#d6d0c5', '#efe8dd', '#cfc8ba'],
  office: ['#d9dee3', '#cfd6dc', '#e4e8ec'],
  industrial: ['#b7b4ac', '#a9a69d', '#c4c1b8'],
  temple: ['#d9c48f', '#c7b07b'],
  school: ['#f0dfb8', '#e8d3a3'],
  default: ['#eee6d6', '#e3d6c0', '#d9cbb4', '#f3ede2', '#cfd7d8'],
};
const ROOFS = ['#8e5a48', '#6f6a68', '#5d6f8a', '#a4614a', '#5f5a55'];

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
// colour / lit materials so all of them agree: floors every 3.2 m, columns every 3 m, window 1.6 m
// wide x 1.7 m tall. Only inner building walls carry the aWin attribute (see _buildBuildings).
const WINDOW_GLSL = `
  // 1 inside a window rectangle on a wall (|n.y| < 0.5), 0 elsewhere
  float windowMask(vec3 p, vec3 n) {
    if (abs(n.y) > 0.5) return 0.0;
    float u = abs(n.x) > 0.5 ? p.z : p.x;                // coordinate along the wall
    float fy = mod(p.y, 3.2);
    float fu = mod(u, 3.0);
    float inY = step(0.8, fy) * (1.0 - step(2.5, fy));   // 0.8..2.5 m in the floor
    float inU = step(0.7, fu) * (1.0 - step(2.3, fu));   // 1.6 m wide, centred in the column
    return inY * inU;
  }
  // Visibility by projected width: focalPx * 1.6 m / depth. distant = 1 keeps windows down to ~1.5 px,
  // distant = 0 fades them out below ~6 px.
  float windowFade(float focalPx, float depth, float distant) {
    float px = focalPx * 1.6 / max(depth, 0.5);
    return mix(smoothstep(5.0, 7.0, px), smoothstep(1.2, 2.0, px), distant);
  }
`;

// Normal + depth output for the edge pass: rgb = view-space normal * 0.5 + 0.5, a = linear depth / far.
// Building walls (aWin = 1) get window rectangles: inside a window the normal is tilted across the wall,
// so the crease detector inks the window outline.
const ND_VERT = `
  uniform float uFar;
  uniform vec3 uTilt;
  attribute float aWin;
  varying vec3 vN;
  varying float vDepth;
  varying vec3 vWPos;
  varying vec3 vWNrm;
  varying float vWin;
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
    gl_Position = projectionMatrix * mv;
  }
`;
const ND_FRAG = `
  uniform float uFar;
  uniform float uFocalPx;   // focal length in target px
  uniform float uWinDist;   // 1 = keep distant windows, 0 = fade them out below ~6 px
  varying vec3 vN;
  varying float vDepth;
  varying vec3 vWPos;
  varying vec3 vWNrm;
  varying float vWin;
  ${WINDOW_GLSL}
  void main() {
    vec3 nv = normalize(vN);
    float win = vWin * windowMask(vWPos, vWNrm) * windowFade(uFocalPx, vDepth, uWinDist);
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

  // Silhouette / depth discontinuity, relative (scale invariant), 0..1
  float depthEdge(vec2 uv, float r) {
    float d0 = texture2D(tND, uv).a;
    float e = 0.0;
    for (int k = 0; k < 8; k++) {
      float dn = texture2D(tND, uv + DIRS[k] * uTexel * r).a;
      float rel = abs(dn - d0) / max(min(dn, d0), 1e-4);
      e = max(e, smoothstep(0.03, 0.07, rel));
    }
    return e;
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

  void main() {
    gUV = vUv;
    float ink = max(depthEdge(vUv, uOuter), creaseEdge(vUv, uInner));
    vec2 pix = gl_FragCoord.xy;
    float dN = texture2D(tND, vUv).a;
    bool sky = dN >= 0.999;

    float ao = 0.0;
    if (uMode >= 1 && uShade > 0.0 && !sky) ao = aoOcc(vUv, pix, dN * uFar);

    if (uMode == 3) {
      vec3 c = texture2D(tColor, vUv).rgb * (1.0 - clamp(uShade * ao * 0.55, 0.0, 0.85));
      gl_FragColor = vec4(toSRGB(c), 1.0);
      return;
    }
    if (uMode == 2) {
      vec3 c = texture2D(tColor, vUv).rgb * (1.0 - clamp(uShade * ao * 0.55, 0.0, 0.85));
      gl_FragColor = vec4(mix(toSRGB(c), vec3(0.05, 0.045, 0.05), ink), 1.0);
      return;
    }

    // Tone: paper everywhere except the toned (shade / cast shadow) regions. The sky is always paper.
    float tone = 1.0;
    bool blk = false;
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
      } else if (uBlack > 0.0 && L < uBlack) {
        blk = true;                                       // solid cast-shadow black
        tone = (uPat == 3 || uPat == 12) ? toneVal(1.0, pix) : 0.14;   // blackflash / blackedge keep their pattern
      } else {
        float C = 0.0;
        if (L <= 0.62) {                                  // toned region only: shadow, base tone and AO
          float lightBand = 1.0 - smoothstep(0.45, 0.62, L);
          float deepBand = 1.0 - smoothstep(0.30, 0.45, L);
          C = (TONE_LIGHT * lightBand + TONE_DEEP * deepBand) * uShadow;
          if (uBase > 0.0) {
            float al = toSRGB(vec3(dot(texture2D(tAlb, vUv).rgb, LUMA3))).x;
            C += uBase * 0.5 * clamp((0.45 - al) / 0.45, 0.0, 1.0);
          }
          C += uShade * ao * 0.25;
        }
        tone = toneVal(clamp(C, 0.0, 0.9), pix);
      }
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
    this.air = { shade: 0, haze: 1, sky: false };
    this.lensMM = 35;
    this._cssW = canvas.clientWidth || 800;
    this._cssH = canvas.clientHeight || 600;

    // Data
    this._city = null;
    this._elev = null;
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
    if (this.style === 'color' || this.style === 'clay') {
      if (this.air.sky) {
        sky = 0xc3dcf5;
        ground = 0xb9ae98;
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
  applyCameraPose({ position, yaw, pitch }) {
    if (position) this.camera.position.copy(position);
    if (yaw !== undefined) this.camera.userData.yaw = yaw;
    if (pitch !== undefined) this.camera.userData.pitch = pitch;
    this._applyPose();
  }

  _applyPose() {
    const cam = this.camera;
    const yaw = cam.userData.yaw || 0;
    const pitch = clamp(cam.userData.pitch || 0, -1.45, 1.45);
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

  /** Far plane and fog scale with detailDistance (0.25..3, i.e. 25%..300%): far = 1200 m * dd. */
  _updateDepthRange() {
    const dd = clamp(this.options.detailDistance ?? 1, 0.25, 3);
    const far = 1200 * dd;
    this.camera.far = far;
    this._fogFar = far * 0.95;
    this._fogNear = far * 0.55;
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
    if (!this.options.terrain || !this._elev) return 0;
    return sampleHeight(this._elev, x, y);
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
  _ribbon(batch, path, w, yOff, col, outline = false) {
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
    const V = (p) => [p[0], this.groundHeight(p[0], p[1]) + yOff, -p[1]];
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
  _flatPoly(batch, outer, holes, yOff, col, outline = false) {
    const { pts, tris } = triangulate(outer, holes);
    const V = (p) => [p.x, this.groundHeight(p.x, p.y) + yOff, -p.y];
    for (const t of tris) {
      batch.tri(V(pts[t[0]]), V(pts[t[1]]), V(pts[t[2]]), UP, col);
    }
    if (outline) {
      const rings = [outer, ...(holes || [])];
      for (const ring of rings) {
        if (!ring || ring.length < 2) continue;
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i];
          const q = ring[(i + 1) % ring.length];
          const a = [p[0], this.groundHeight(p[0], p[1]) + yOff + 0.01, -p[1]];
          const b = [q[0], this.groundHeight(q[0], q[1]) + yOff + 0.01, -q[1]];
          this._pushSeg(a, b);
        }
      }
    }
  }

  /** Merge a list of BufferGeometry (already batchable) into one, or null. */
  _mergeList(list) {
    if (!list.length) return null;
    return mergeGeometries(list, false);
  }

  // ----- buildings ------------------------------------------------------------

  /**
   * Build extruded buildings. Walls and caps are generated directly as triangles
   * (no per-building meshes), then merged into two batches (walls / roofs).
   */
  _buildBuildings(list, surroundings, extra = null) {
    const lowPoly = this.options.lowPoly;
    const wallsB = new Batch();
    const roofsB = new Batch();
    const plain = []; // vertex ranges of walls that get no window grid
    for (const b of list) {
      const outer = b.outer;
      if (!outer || outer.length < 3) continue;
      const holes = (b.holes || []).filter((h) => h && h.length > 2);
      const r = rng(hashStr(String(b.id ?? outer.length)));

      // ground under the footprint: centre drives the base, lowest corner extends the walls down
      const c = polyCentroid(outer);
      let groundC = this.groundHeight(c[0], c[1]);
      let groundMin = Infinity;
      let groundMax = -Infinity;
      for (const p of outer) {
        const g = this.groundHeight(p[0], p[1]);
        if (g < groundMin) groundMin = g;
        if (g > groundMax) groundMax = g;
      }
      // on a slope the building stands on the high side (walls reach down to the low side), so no corner
      // ends up buried; capped so one noisy elevation cell cannot lift it far
      groundC = Math.max(groundC, Math.min(groundMax, groundC + 3));
      const minH = Math.max(0, b.minHeight || 0);
      const height = Math.max(b.height || 6, minH + 2);
      const flat = surroundings || lowPoly || !b.roofShape || b.roofShape === 'flat';
      const roofH = flat ? 0 : clamp(b.roofHeight ?? 3, 0.5, Math.max(0.5, height - minH - 1.5));
      const base = groundC + minH;
      const bottom = Math.min(base, groundMin + minH);
      const topAbs = groundC + height;
      const wallTop = topAbs - roofH;

      // colours: wall hue from the palette (or building:colour), slight brightness jitter
      const hex = b.color || this._wallPick(b, r);
      const mult = 0.95 + 0.1 * r();
      const wc = colArr(hex).map((v) => clamp(v * mult, 0, 1));
      const rc = colArr(ROOFS[Math.floor(r() * ROOFS.length)]);

      // monuments, steps, sheds and landmark bases are solid: no window grid on their walls
      const solid = b.noWindows || NO_WINDOW_KINDS.has(b.kind);
      const v0 = wallsB.p.length / 3;
      addWalls(wallsB, outer, holes, bottom, wallTop, wc);
      if (solid) plain.push([v0, wallsB.p.length / 3]);
      else if (!surroundings && this._segs) addWindowSegs(this._segs, outer, bottom, wallTop);
      if (flat) {
        addCap(roofsB, outer, holes, topAbs, rc);
      } else {
        addRoof(roofsB, outer, wallTop, roofH, b.roofShape, rc);
      }
    }
    // hand-built landmark models go in with the roofs (no window grid on a lattice tower)
    if (extra) extra(roofsB, (x, y) => this.groundHeight(x, y));
    const walls = wallsB.toGeometry();
    // inner city walls get the window grid in the edge and lit / colour passes (aWin = 1 per vertex)
    if (walls && !surroundings) {
      const win = new Float32Array(walls.attributes.position.count).fill(1);
      for (const [a, z] of plain) win.fill(0, a, z);
      walls.setAttribute('aWin', new THREE.Float32BufferAttribute(win, 1));
    }
    // roofs (and the landmark models drawn with them) carry an explicit 0, so the window grid never
    // shows on them whatever the GPU still holds from the walls mesh
    const roofs = roofsB.toGeometry();
    if (roofs && !surroundings) roofs.setAttribute('aWin', new THREE.Float32BufferAttribute(new Float32Array(roofs.attributes.position.count), 1));
    return { walls, roofs };
  }

  _wallPick(b, r) {
    const list = WALLS[b.kind] || WALLS.default;
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
      pos.setY(i, useTerrain ? sampleHeight(this._elev, x, -z) : 0);
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
  _buildRoads(roads, details, japan = false) {
    const asphalt = new Batch();
    const sidewalks = new Batch();
    const walk = new Batch();
    const marks = new Batch();
    const rails = new Batch(); // guard railings (details)
    const tact = new Batch(); // tactile paving strips (details, Japan only)
    const yellow = colArr(PAL.tactile);
    const furniture = []; // merged later: poles and signals
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
      entries.push({ pts, kind, foot, major, w, lanes: r.lanes || 0 });

      if (foot) {
        this._ribbon(walk, path, Math.max(w, 1.5), 0.06, colArr(PAL.sidewalk));
        continue;
      }
      // sidewalk strip underneath the carriageway
      this._ribbon(sidewalks, path, w + 5, 0.04, colArr(PAL.sidewalk));
      this._ribbon(asphalt, path, w, 0.07, colArr(major ? PAL.road : PAL.roadMinor), true);
    }

    if (details) {
      for (const e of entries) {
        if (e.foot) continue;
        const path = resamplePolyline(e.pts, 4);

        // dashed centre line on wider / multi-lane roads
        if ((e.major || e.lanes >= 2) && e.w >= 7) {
          for (const dash of polyDashes(path, 3, 6)) {
            this._ribbon(marks, dash, 0.22, 0.09, white);
          }
        }

        // utility poles every ~30 m along residential-type streets
        if (RESIDENTIAL_KINDS.has(e.kind) && this.options.detailPoles !== false) {
          for (const s of samplePoly(path, 30, 15)) {
            const o = e.w / 2 + 0.8;
            const x = s.x + s.nx * o;
            const y = s.y + s.ny * o;
            if (this._clearOf(x, y)) {
              furniture.push(this._boxAt(x, y, 0.25, 8, 0.25, 4, PAL.pole));
              this._lampPts.push([x, y, 8.2]); // lamp bulb on top of the pole (night, lamps on)
            }
          }
        }
      }

      // junctions: signals where a major road meets, a zebra crossing on every leg
      for (const j of findJunctions(entries)) {
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

    if (details && this.options.detailRails !== false) this._guardRails(entries, juncPts, rails);

    const out = [];
    out.push({ geo: sidewalks.toGeometry(), role: 'sidewalk', name: 'sidewalks' });
    out.push({ geo: walk.toGeometry(), role: 'sidewalk', name: 'footways' });
    out.push({ geo: asphalt.toGeometry(), role: 'road', name: 'asphalt' });
    out.push({ geo: marks.toGeometry(), role: 'lane', name: 'markings' });
    out.push({ geo: this._mergeList(furniture), role: 'detail', name: 'street-furniture' });
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
      if (!RAIL_KINDS.has(e.kind) || !e.pts || e.pts.length < 2) continue;
      for (const side of [-1, 1]) {
        const off = side * (e.w / 2 + 2.3);
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
          this._prism(batch, q, 0, POST_H, col);
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
          for (const hz of [0.5, 0.9]) this._prism(batch, bar, hz - 0.025, hz + 0.025, col);
        }
      }
    }
  }

  /** Axis-aligned prism over a quad (local [x, y] corners in order) from h0 to h1 above the ground. */
  _prism(batch, quad, h0, h1, col) {
    const V = (p, h) => [p[0], this.groundHeight(p[0], p[1]) + h, -p[1]];
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
      if (!rw.points || rw.points.length < 2) continue;
      const path = resamplePolyline(rw.points, 4);
      this._ribbon(b, path, 2.4, 0.08, colArr(PAL.rail), true);
    }
    return b.toGeometry();
  }

  /** Flat area layers: water (+0.05), green (+0.08), plazas / parking (+0.06). */
  _buildAreas(water, green, areas) {
    const wb = new Batch();
    const gb = new Batch();
    const ab = new Batch();
    for (const a of water || []) {
      if (a.outer && a.outer.length >= 3) this._flatPoly(wb, a.outer, a.holes, 0.05, colArr(PAL.water), true);
    }
    for (const a of green || []) {
      if (!a.outer || a.outer.length < 3) continue;
      const hex = a.kind === 'forest' || a.kind === 'wood' ? '#7fae6b' : PAL.green;
      this._flatPoly(gb, a.outer, a.holes, 0.08, colArr(hex), true);
    }
    for (const a of areas || []) {
      if (!a.outer || a.outer.length < 3) continue;
      const hex = a.kind === 'parking' ? PAL.parking : PAL.area;
      this._flatPoly(ab, a.outer, a.holes, 0.06, colArr(hex), true);
    }
    return [
      { geo: wb.toGeometry(), role: 'water', name: 'water', group: 'water' },
      { geo: gb.toGeometry(), role: 'green', name: 'green', group: 'green' },
      { geo: ab.toGeometry(), role: 'area', name: 'areas', group: 'ground' },
    ];
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
  _buildTrees(trees) {
    const opt = this.options;
    this._treeLOD = []; // crown / far-crown pairs for the picture distance
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
    const pts = pool.filter((t) => this._clearOf(t[0], t[1], 4.5));
    if (dens > 1) pts.push(...this._streetTrees((dens - 1) / 2));
    pts.length = Math.min(pts.length, 40000);
    const n = pts.length;
    if (!n) return;

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
    const leafColour = (r, x, y) => {
      let hex = palette[Math.floor(r() * palette.length)];
      const accents = ACCENT_CROWN[season];
      if (accents && r() < 0.07) hex = accents[Math.floor(r() * accents.length)];
      const drift = rng(hashStr(`treehue:${Math.floor(x / 60)}:${Math.floor(y / 60)}`))() - 0.5;
      tmpC.set(hex).getHSL(hsl);
      tmpC.setHSL((hsl.h + (r() - 0.5) * 0.05 + drift * 0.04 + 1) % 1, clamp(hsl.s * (0.88 + 0.24 * r()), 0, 1), clamp(hsl.l * (0.86 + 0.28 * r()), 0, 0.95));
      return '#' + tmpC.getHexString();
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
        add('conifer', pt, CONIFER_CROWN[Math.floor(r() * CONIFER_CROWN.length)]);
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
        add('palm', pt, PALM_CROWN[Math.floor(r() * PALM_CROWN.length)]);
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
  }

  /** Extra trees along the sidewalks of drivable roads: one candidate per side every 8 m, kept with probability `share` (0..1). */
  _streetTrees(share) {
    const out = [];
    const c = this._city.center || { lat: 0, lon: 0 };
    for (const rd of this._city.roads || []) {
      if (!rd.points || rd.points.length < 2 || rd.tunnel) continue;
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

  /** Car body for one CAR_TYPES entry: tapered body, cabin with a darker glass tint, four wheels. Local +Z = heading. */
  _carGeometry(type) {
    const W = [1, 1, 1];
    const GLASS = colArr('#6a737d');
    const parts = [];
    // box(w, h, d, centre y, centre z, colour, top width, top depth, top shift in z)
    const box = (w, h, d, y, z, col, topW = w, topD = d, shift = 0) => {
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
        parts.push(toBatchable(g, colArr('#1d1d22')));
      }
    }
    return mergeGeometries(parts, false);
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
      entries.push({ pts: rd.points, kind, foot, major: MAJOR_KINDS.has(kind), w: rd.width || (foot ? 2 : 6), lanes: rd.lanes || 0, name: rd.name || '' });
    }
    // OSM splits a street into many short ways; sample each chain of connected ways as one street so
    // people and cars are spread evenly instead of restarting at every way.
    chainEntries(entries, rp() * 5, rc() * 6);
    const idx = this._placementIndex(entries);
    const drivable = (e) => !e.foot && e.w >= 5 && !(e.lanes === 1 && e.w < 6);

    const people = [];
    const cars = [];
    const addPerson = (x, y, yaw, v, onRoad = false) => {
      if (!this._clearOf(x, y, 2.5) || idx.inBuilding(x, y) || idx.inWater(x, y)) return;
      if (!onRoad && idx.onRoad(x, y, 0.3)) return;
      const scale = rp() < kidsP ? 0.62 + 0.1 * rp() : 0.93 + 0.13 * rp(); // a few children
      people.push({ x, y, yaw, v, scale, cols: [rp(), rp(), rp()] });
    };
    const addCar = (x, y, yaw, type, col) => {
      const big = type === 'bus';
      if (cars.some((e) => Math.hypot(e.x - x, e.y - y) < (big || e.type === 'bus' ? 7.5 : 4.8))) return;
      if (!this._clearOf(x, y, big ? 7 : 5)) return;
      const half = big ? 5 : 2.1; // nose and tail must stay out of buildings too
      const hx = Math.sin(yaw), hy = -Math.cos(yaw);
      for (const k of [-1, 0, 1]) if (idx.inBuilding(x + hx * half * k, y + hy * half * k)) return;
      cars.push({ x, y, yaw, type, col });
    };
    // a circle of 2+ people facing each other, most of them gesturing
    const addGroup = (cx, cy) => {
      const n = 2 + Math.floor(rp() * (groupMax - 1));
      const R = 0.45 + 0.12 * n;
      const a0 = rp() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const a = a0 + (k * Math.PI * 2) / n + (rp() - 0.5) * 0.4;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
        const v = (k === 0 && gest > 0) || rp() < gest ? pick(TALK_VARIANTS, rp()) : pick(IDLE_VARIANTS, rp());
        addPerson(x, y, yawOf(cx - x, cy - y) + (rp() - 0.5) * 0.5, v);
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
              addPerson(leg.cx + px * s + leg.ux * a, leg.cy + py * s + leg.uy * a, yawOf(dir * px, dir * py) + (r() - 0.5) * 0.2, pick(WALK_VARIANTS, r()), true);
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
                addCar(s.x + hy * lat, s.y - hx * lat, yawOf(hx, hy) + (r() - 0.5) * 0.03, type, carColour(type, r()));
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
              addPerson(leg.cx + px * s + leg.ux * a, leg.cy + py * s + leg.uy * a, yawOf(-side * px, -side * py) + (r() - 0.5) * 0.5, v);
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
            addGroup(s.x + s.nx * off, s.y + s.ny * off);
            continue;
          }
          // sidewalk band: 0.5-2.1 m from the curb (sidewalks are 2.5 m wide); footways: on the path
          const off = e.foot ? (rp() - 0.5) * Math.max(0, e.w - 0.8) : side * (e.w / 2 + 0.6 + 1.5 * rp());
          if (roll < talkP + standP) {
            // standing alone: waiting, on the phone, or calling out to someone
            const v = rp() < 0.36 * gest ? pick(TALK_VARIANTS, rp()) : pick(IDLE_VARIANTS, rp());
            addPerson(s.x + s.nx * off, s.y + s.ny * off, rp() * Math.PI * 2, v);
            continue;
          }
          // walking along the street, sometimes side by side
          const dir = rp() < 0.5 ? 1 : -1;
          const heading = yawOf(dir * s.tx, dir * s.ty);
          const pair = rp() < 0.12 + 0.13 * pT;
          for (const o of pair ? [-0.33, 0.33] : [0]) {
            addPerson(s.x + s.nx * (off + o), s.y + s.ny * (off + o), heading + (rp() - 0.5) * 0.3, pick(WALK_VARIANTS, rp()));
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
            addCar(x, y, yawOf(dir * s.tx, dir * s.ty) + yawJit + (k ? (rc() - 0.5) * 0.06 : 0), type, col);
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
    const place = (x, y, yaw, s) => {
      q.setFromAxisAngle(up, yaw);
      p.set(x, this.groundHeight(x, y), -y); // feet / wheels on the ground
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
          im.setMatrixAt(i, place(e.x, e.y, e.yaw, e.scale));
          if (palettes[part]) im.setColorAt(i, col.set(pickWeighted(palettes[part], e.cols[pi])));
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.computeBoundingSphere();
        this._registerMesh(im, 'people', 'people', 0, { name: `people-${part}` });
      });
    });

    // cars: one instanced mesh per body type
    for (const [type] of CAR_TYPES) {
      const list = cars.filter((e) => e.type === type);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(this._carGeometry(type), this._materialFor('people'), list.length);
      list.forEach((e, i) => {
        im.setMatrixAt(i, place(e.x, e.y, e.yaw, 1));
        im.setColorAt(i, col.set(e.col));
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      this._registerMesh(im, 'people', 'people', 0, { name: `cars-${type}` });
    }
  }

  // ----- build orchestration ----------------------------------------------------

  /**
   * (Re)build all city meshes from cityData (+ elevation grid, + surroundings {buildings}).
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
    const opt = this.options;
    const size = city.size || 1000;
    this._sunDist = Math.max(400, size * 3);
    this._shadowHalf = Math.max(200, size * 0.75);
    this.setLight(this.light);
    this._segs = [];
    this._lampPts = [];

    // ground (inner, terrain-following) and surroundings ground
    this._addMesh(this._buildGround(size, opt.terrain), 'ground', 'ground', {
      pickable: true,
      cast: false,
      name: 'ground',
    });
    if (this._surr) {
      const surrGeo = this._buildSurroundGround(size * 3, opt.terrain);
      const m = this._addMesh(surrGeo, 'surr-ground', 'surroundings', { cast: false, name: 'surroundings-ground' });
      if (m) m.userData.surroundings = true;
    }

    // roads and their markings
    const roadParts = this._buildRoads(city.roads || [], opt.details, this._inJapan(city.center));
    for (const part of roadParts) {
      if (!part.geo) continue;
      const group = DETAIL_PARTS.has(part.name) ? 'details' : 'roads';
      this._addMesh(part.geo, part.role, group, { name: part.name });
    }
    const rail = this._buildRailways(city.railways || []);
    if (rail) this._addMesh(rail, 'rail', 'roads', { name: 'railways' });

    // water / green / plazas
    for (const part of this._buildAreas(city.water, city.green, city.areas)) {
      if (!part.geo) continue;
      this._addMesh(part.geo, part.role, part.group, { name: part.name });
    }

    // buildings: walls and roofs as two merged meshes
    const lm = landmarksFor(city, this.options.landmarks !== false);
    const bl = this._buildBuildings(lm.buildings, false, lm.draw);
    if (bl.walls) this._addMesh(bl.walls, 'building', 'buildings', { pickable: true, name: 'walls' });
    if (bl.roofs) this._addMesh(bl.roofs, 'building', 'buildings', { pickable: true, name: 'roofs' });

    // surroundings: simple extruded footprints, lower detail
    if (this._surr && this._surr.buildings && this._surr.buildings.length) {
      const sb = this._buildBuildings(this._surr.buildings, true);
      if (sb.walls) this._addMesh(sb.walls, 'surr', 'surroundings', { name: 'surr-walls' }).userData.surroundings = true;
      if (sb.roofs) this._addMesh(sb.roofs, 'surr', 'surroundings', { name: 'surr-roofs' }).userData.surroundings = true;
    }

    if (opt.trees) this._buildTrees(city.trees || []);
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
      },
    });
    // white Lambert for the lit grayscale pass used by lines-tone; window glass is a little darker
    // so it tones on shaded walls and stays white-ish on sunlit ones
    const litMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    litMat.onBeforeCompile = (shader) => {
      windowPatch(shader, this._winDistU, this._focalU, 'diffuseColor.rgb *= mix(1.0, 0.8, wf);', this._nightU);
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
    litMat.customProgramCacheKey = () => 'manga-lit-windows-v2';
    // flat anime colours from vertex colours
    const vc = new THREE.MeshLambertMaterial({ vertexColors: true });
    // same, plus the distant window grid on walls (world-space, no extra geometry)
    const building = new THREE.MeshLambertMaterial({ vertexColors: true });
    building.onBeforeCompile = (shader) =>
      windowPatch(shader, this._winDistU, this._focalU, 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.40, 0.50), wf * 0.85);', this._nightU);
    building.customProgramCacheKey = () => 'manga-windows-v2';
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
    this._mats = { ndMat, litMat, vc, building, clay, albMat, compMat, treeMat };
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
    for (const key of ['litMat', 'vc', 'building', 'clay', 'ndMat', 'albMat']) {
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
    return role === 'building' ? M.building : M.vc;
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
    const needND = edges || (colorPass && air.shade > 0) || fxDepth || partsOn;
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
    this._focalU.value = focal;
    this._winDistU.value = winDist;
    M.ndMat.uniforms.uFocalPx.value = focal;
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

const FOOT_KINDS = new Set(['footway', 'path', 'cycleway', 'steps', 'pedestrian', 'bridleway', 'corridor']);
const MAJOR_KINDS = new Set([
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
]);
// Roads that get guard railings along the sidewalk edge
const RAIL_KINDS = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);
// Parts of the road build that belong to the 'details' group
const DETAIL_PARTS = new Set(['markings', 'street-furniture', 'guard-rails', 'tactile']);
const RESIDENTIAL_KINDS = new Set(['residential', 'unclassified', 'living_street', 'service', 'tertiary']);

/**
 * Adds the window grid to a Lambert material. Only vertices with aWin = 1 (inner building walls) get
 * windows. glassExpr is a GLSL statement that darkens diffuseColor by the window weight wf.
 * night = { uNightI, uNightShare, uNightCol } uniforms: at night a hashed share of the window cells
 * glows warm. The glow is added after the lighting (outgoingLight), so it is not shaded.
 */
function windowPatch(shader, winDistU, focalU, glassExpr, night) {
  shader.uniforms.uWinDist = winDistU;
  shader.uniforms.uFocalPx = focalU;
  shader.uniforms.uNightI = night.uNightI;
  shader.uniforms.uNightShare = night.uNightShare;
  shader.uniforms.uNightCol = night.uNightCol;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aWin;\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nvarying float vWin;\nvarying float vWDepth;')
    .replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vec4 wpW = modelMatrix * vec4(transformed, 1.0);\n  vWPos = wpW.xyz;\n  vWNrm = normalize(mat3(modelMatrix) * objectNormal);\n  vWin = aWin;\n  vWDepth = -(viewMatrix * wpW).z;'
    );
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      '#include <common>\nuniform float uWinDist;\nuniform float uFocalPx;\nuniform float uNightI;\nuniform float uNightShare;\nuniform vec3 uNightCol;\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nvarying float vWin;\nvarying float vWDepth;\n' + WINDOW_GLSL
    )
    .replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n  float wf = vWin * windowMask(vWPos, vWNrm) * windowFade(uFocalPx, vWDepth, uWinDist);\n  ' + glassExpr
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
    if (e.foot) return;
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
 * Window outlines for the SVG line set, matching WINDOW_GLSL's world-aligned grid exactly
 * (floors every 3.2 m with glass at 0.8..2.5 m, columns every 3 m with glass at 0.7..2.3 m), so the
 * vector export lines up with the raster windows. Pushes segment pairs (world xyz) onto segs.
 */
function addWindowSegs(segs, ring, bottom, wallTop) {
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
    for (let k = Math.ceil((uMin - 2.3) / 3); k * 3 + 0.7 <= uMax; k++) {
      const u0 = k * 3 + 0.7;
      const u1 = k * 3 + 2.3;
      if (u0 < uMin || u1 > uMax) continue; // only whole windows
      const p0 = at(u0);
      const p1 = at(u1);
      for (let f = Math.ceil((bottom - 0.8) / 3.2); f * 3.2 + 0.8 < wallTop; f++) {
        const y0 = f * 3.2 + 0.8;
        const y1 = f * 3.2 + 2.5;
        if (y0 < bottom + 0.3 || y1 > wallTop - 0.2) continue;
        const A = [p0[0], y0, -p0[1]], B = [p1[0], y0, -p1[1]];
        const C = [p1[0], y1, -p1[1]], D = [p0[0], y1, -p0[1]];
        segs.push(...A, ...B, ...B, ...C, ...C, ...D, ...D, ...A);
      }
    }
  }
}
