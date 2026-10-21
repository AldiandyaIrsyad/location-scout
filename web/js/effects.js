/**
 * Full-screen post-processing effects for the city renderer (three.js r160, WebGL2).
 *
 * Post effects are GLSL passes over the finished composite. Everything works directly on the
 * sRGB-encoded values: colour params ('#rrggbb') are converted to sRGB 0..1 (not linearised) and
 * the shaders write gl_FragColor without a colour-space chunk, so three does not re-encode them.
 *
 * World effects (night, rain, snow, petals) are listed here for the UI and params only;
 * render.js applies them to the scene.
 *
 * `time` is in seconds (performance.now() / 1000). Grain and glitch step with it.
 */
import * as THREE from 'three';

// ---------------------------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------------------------

const range = (id, min, max, step, def) => ({ id, type: 'range', min, max, step, default: def });
const color = (id, def) => ({ id, type: 'color', default: def });
const select = (id, options, def) => ({ id, type: 'select', options, default: def });
const post = (id, needsDepth, params = []) => ({ id, kind: 'post', needsDepth, params });
const world = (id, params = []) => ({ id, kind: 'world', needsDepth: false, params });

export const EFFECTS = [
  post('mosaic', false, [range('size', 2, 64, 1, 12)]),
  post('posterize', false, [range('levels', 2, 16, 1, 5)]),
  post('duotone', false, [color('shadow', '#1d1b3a'), color('highlight', '#f6d7a7')]),
  post('sepia', false),
  post('grade', false, [
    range('brightness', -1, 1, 0.01, 0),
    range('contrast', 0, 2, 0.01, 1),
    range('saturation', 0, 2, 0.01, 1),
    range('temperature', -1, 1, 0.01, 0),
    range('tint', -1, 1, 0.01, 0),
  ]),
  post('scanlines', false, [range('density', 1, 8, 0.5, 3), range('curvature', 0, 1, 0.01, 0.2)]),
  post('vignette', false, [range('radius', 0.2, 1, 0.01, 0.85), range('softness', 0.05, 1, 0.01, 0.45)]),
  post('grain', false, [range('amount', 0, 1, 0.01, 0.25), range('size', 0.5, 4, 0.1, 1.5)]),
  post('paper', false, [range('amount', 0, 1, 0.01, 0.5), range('scale', 0.5, 4, 0.1, 1)]),
  post('chroma', false, [range('offset', 0, 20, 0.5, 4)]),
  post('glitch', false, [range('amount', 0, 1, 0.01, 0.4), range('seed', 0, 100, 1, 1)]),
  post('halftone', false, [range('size', 2, 24, 0.5, 6), range('angle', 0, 90, 1, 15)]),
  post('dither', false, [
    select('palette', ['bw', 'gameboy', 'cga', 'sepia4'], 'gameboy'),
    range('scale', 1, 8, 0.5, 2),
  ]),
  post('kuwahara', false, [range('radius', 2, 8, 1, 4)]),
  post('watercolor', false, [range('wetness', 0, 1, 0.01, 0.6), range('granulation', 0, 1, 0.01, 0.5)]),
  post('pencil', false, [range('density', 0.5, 3, 0.05, 1), range('angle', 0, 90, 1, 45)]),
  post('dof', true, [
    range('focus', 0, 1, 0.01, 0.15),
    range('range', 0.01, 0.5, 0.01, 0.08),
    range('blur', 0, 24, 0.5, 8),
    range('tiltshift', 0, 1, 1, 0),
  ]),
  post('fog', true, [range('density', 0, 1, 0.01, 0.5), color('color', '#d9dde4')]),
  post('bloom', false, [
    range('threshold', 0, 1, 0.01, 0.7),
    range('intensity', 0, 3, 0.05, 1),
    range('radius', 1, 16, 0.5, 6),
  ]),
  // Webtoon / manhwa helpers
  post('cel', false, [range('bands', 2, 6, 1, 3), range('softness', 0, 1, 0.01, 0.3), range('lift', 0, 0.7, 0.01, 0.12)]),
  post('glow', false, [range('radius', 1, 24, 0.5, 8), range('amount', 0, 1, 0.01, 0.5)]),
  post('linecolor', false, [color('color', '#3a2a2e'), range('threshold', 0.05, 0.5, 0.01, 0.22)]),
  post('focus', false, [
    range('amount', 0, 1, 0.01, 0.7),
    range('count', 24, 160, 1, 72),
    range('inner', 0.2, 0.95, 0.01, 0.55),
    range('cx', 0, 1, 0.01, 0.5),
    range('cy', 0, 1, 0.01, 0.5),
    select('tone', ['ink', 'white'], 'ink'),
  ]),
  post('rays', false, [
    range('amount', 0, 1, 0.01, 0.4),
    range('threshold', 0.3, 0.95, 0.01, 0.7),
    range('length', 0.1, 1, 0.01, 0.6),
    range('lx', -0.5, 1.5, 0.01, 0.8),
    range('ly', -0.5, 1.5, 0.01, 1.15),
    color('color', '#fff0c8'),
  ]),
  post('frame', false, [
    range('margin', 0, 0.15, 0.005, 0.04),
    range('border', 0, 16, 0.5, 4),
    select('tone', ['paper', 'dark'], 'paper'),
  ]),
  world('night', [range('lights', 0, 1, 0.01, 0.8), range('lamps', 0, 1, 1, 1)]),
  world('rain', [range('density', 0, 1, 0.01, 0.5), range('wind', -1, 1, 0.01, 0.2)]),
  world('snow', [range('density', 0, 1, 0.01, 0.5), range('size', 0.5, 3, 0.1, 1)]),
  world('petals', [range('density', 0, 1, 0.01, 0.4)]),
];

const BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));

// ---------------------------------------------------------------------------------------------
// Param helpers
// ---------------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Uniform name for a param: 'size' -> 'pSize'. The prefix keeps params clear of uScale etc.
const uName = (id) => 'p' + id.charAt(0).toUpperCase() + id.slice(1);

const colorCache = new Map();
function parseHex(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
// sRGB 0..1 vector for a '#rrggbb' string (cached; callers copy it, never mutate it)
function hexToVec3(hex, fallback) {
  const key = String(hex);
  let v = colorCache.get(key);
  if (!v) {
    v = parseHex(hex) || parseHex(fallback) || new THREE.Vector3();
    colorCache.set(key, v);
  }
  return v;
}

// Writes one param value into its uniform, clamped to the catalogue range.
function setParamUniform(uniform, def, params) {
  const raw = params && params[def.id] !== undefined && params[def.id] !== null ? params[def.id] : def.default;
  if (def.type === 'color') {
    uniform.value.copy(hexToVec3(raw, def.default));
  } else if (def.type === 'select') {
    const i = def.options.indexOf(raw);
    uniform.value = i < 0 ? Math.max(0, def.options.indexOf(def.default)) : i;
  } else {
    const n = Number(raw);
    uniform.value = Number.isFinite(n) ? clamp(n, def.min, def.max) : def.default;
  }
}

// Numeric param value (range type) as the stack reads it on the CPU side.
function numberParam(pass, id) {
  const def = pass.def.params.find((p) => p.id === id);
  const raw = pass.params && pass.params[id] !== undefined ? Number(pass.params[id]) : def.default;
  return Number.isFinite(raw) ? clamp(raw, def.min, def.max) : def.default;
}

// ---------------------------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------------------------

// Vertex shader for the full-screen triangle (three's ShaderMaterial prefix supplies position/uv).
const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Shared header for every post effect. Each body defines `vec3 effect(vec2 uv, vec4 src)`.
const GLSL_HEAD = `
uniform sampler2D tInput;
uniform sampler2D tDepth;
uniform sampler2D tBloom;
uniform vec2 uRes;
uniform float uScale;
uniform float uTime;
uniform float uStrength;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const float PI = 3.14159265;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}

float luma(vec3 c) {
  return dot(c, LUMA);
}
`;

// Shared main: mix(input, effect, strength) on rgb, alpha kept from the input.
const GLSL_MAIN = `
void main() {
  vec4 src = texture2D(tInput, vUv);
  vec3 fx = effect(vUv, src);
  vec3 c = clamp(mix(src.rgb, fx, uStrength), 0.0, 1.0);
  gl_FragColor = vec4(c, src.a);
}
`;

const BODY = {};

BODY.mosaic = `
vec3 effect(vec2 uv, vec4 src) {
  // 4-tap average inside each block, taps at the quarter points
  float s = max(1.0, pSize * uScale);
  vec2 center = (floor(gl_FragCoord.xy / s) + 0.5) * s;
  vec2 q = vec2(0.25 * s);
  vec3 acc = texture2D(tInput, (center + vec2(-q.x, -q.y)) / uRes).rgb;
  acc += texture2D(tInput, (center + vec2(q.x, -q.y)) / uRes).rgb;
  acc += texture2D(tInput, (center + vec2(-q.x, q.y)) / uRes).rgb;
  acc += texture2D(tInput, (center + vec2(q.x, q.y)) / uRes).rgb;
  return acc * 0.25;
}
`;

BODY.posterize = `
vec3 effect(vec2 uv, vec4 src) {
  float L = max(pLevels, 2.0);
  // round to the nearest of L evenly spaced levels (floor(c*L)/(L-1) skewed muted colors to neon)
  return floor(clamp(src.rgb, 0.0, 1.0) * (L - 1.0) + 0.5) / (L - 1.0);
}
`;

BODY.duotone = `
vec3 effect(vec2 uv, vec4 src) {
  return mix(pShadow, pHighlight, clamp(luma(src.rgb), 0.0, 1.0));
}
`;

BODY.sepia = `
vec3 effect(vec2 uv, vec4 src) {
  vec3 c = src.rgb;
  return vec3(
    dot(c, vec3(0.393, 0.769, 0.189)),
    dot(c, vec3(0.349, 0.686, 0.168)),
    dot(c, vec3(0.272, 0.534, 0.131))
  );
}
`;

BODY.grade = `
vec3 effect(vec2 uv, vec4 src) {
  vec3 c = src.rgb;
  c += pBrightness * 0.5;
  c = (c - 0.5) * pContrast + 0.5;
  c = mix(vec3(luma(c)), c, pSaturation);
  c.r += pTemperature * 0.12;   // warm: more red, less blue
  c.b -= pTemperature * 0.12;
  c.g -= pTint * 0.10;          // positive tint = magenta (less green)
  return clamp(c, 0.0, 1.0);
}
`;

BODY.scanlines = `
vec3 effect(vec2 uv, vec4 src) {
  // barrel distortion of the tube
  vec2 p = uv * 2.0 - 1.0;
  p *= 1.0 + pCurvature * 0.12 * dot(p, p);
  vec2 suv = p * 0.5 + 0.5;
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) return vec3(0.0);
  vec3 c = texture2D(tInput, suv).rgb;
  // slight corner falloff
  c *= 1.0 - 0.10 * dot(p, p);
  // dark scanline every pDensity px (screen space)
  float period = max(2.0, pDensity * uScale);
  float sl = 0.5 + 0.5 * cos(2.0 * PI * gl_FragCoord.y / period);
  c *= mix(0.72, 1.0, sl);
  // RGB aperture grille: one R, G, B triad per CSS px
  float sub = mod(floor(gl_FragCoord.x / max(uScale, 1.0)), 3.0);
  vec3 mask = vec3(
    1.0 - clamp(abs(sub), 0.0, 1.0),
    1.0 - clamp(abs(sub - 1.0), 0.0, 1.0),
    1.0 - clamp(abs(sub - 2.0), 0.0, 1.0)
  );
  c *= mix(vec3(0.7), vec3(1.0), mask);
  return c;
}
`;

BODY.vignette = `
vec3 effect(vec2 uv, vec4 src) {
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float d = length(p) / length(vec2(aspect, 1.0) * 0.5);   // 1.0 at the corners
  float v = 1.0 - smoothstep(pRadius - pSoftness, pRadius, d);
  return src.rgb * mix(0.55, 1.0, v);
}
`;

BODY.grain = `
vec3 effect(vec2 uv, vec4 src) {
  float cell = max(1.0, pSize * uScale);
  vec2 id = floor(gl_FragCoord.xy / cell);
  float frame = mod(floor(uTime * 24.0), 1000.0);
  float n = hash12(id + vec2(frame * 13.0, frame * 7.0))
          + hash12(id * 1.37 + vec2(frame * 3.0 + 19.0, 53.0)) - 1.0;
  // strongest in the mid tones
  float l = luma(src.rgb);
  float w = 0.45 + 0.55 * (1.0 - abs(2.0 * l - 1.0));
  return src.rgb + n * pAmount * 0.35 * w;   // amount 0.25 ≈ ±0.09: visible film grain
}
`;

BODY.paper = `
vec3 effect(vec2 uv, vec4 src) {
  // fbm fibres, stretched along one axis, in a feature size that follows the export scale
  float feature = max(8.0, 60.0 * pScale * uScale);
  vec2 p = gl_FragCoord.xy / feature;
  float fib = fbm(p * vec2(0.35, 2.4));
  float grainTex = fbm(p * vec2(1.9, 0.8) + vec2(3.1, 7.7));
  float tex = 0.6 * fib + 0.4 * grainTex;
  float shade = 0.9 + 0.35 * (tex - 0.5);
  vec3 paperCol = vec3(1.0, 0.975, 0.93) * shade;   // warm paper
  return src.rgb * mix(vec3(1.0), paperCol, pAmount);
}
`;

// Cel shading: snap brightness to a few flat bands but keep each pixel's hue (unlike posterize).
BODY.cel = `
vec3 effect(vec2 uv, vec4 src) {
  float L = luma(src.rgb);
  float n = max(pBands, 2.0);
  float f = L * n;
  float s = clamp(pSoftness, 0.0, 1.0) * 0.5;
  float t = smoothstep(0.5 - s - 0.001, 0.5 + s + 0.001, fract(f));
  float Lq = (floor(f) + t) / n;
  // keep the darkest band from going muddy; a higher lift brightens every band (pastel looks)
  Lq = (pLift > 0.12) ? mix(pLift, 1.0, Lq) : max(Lq, 0.12);
  return clamp(src.rgb * (Lq / max(L, 1e-3)), 0.0, 1.0);
}
`;

// Soft glow (Orton / diffusion): screen a blurred copy over the picture for the dreamy webtoon haze.
// Manga focus (speed) lines: thin spikes fanning out from a point, starting at different distances.
BODY.focus = `
vec3 effect(vec2 uv, vec4 src) {
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 p = (uv - vec2(pCx, pCy)) * vec2(aspect, 1.0);
  float dn = length(p) / length(vec2(aspect, 1.0) * 0.5);   // 1.0 at the corners
  float t = (atan(p.y, p.x) + PI) / (2.0 * PI) * pCount;
  float cell = floor(t);
  float h = hash12(vec2(cell, 7.3));
  float start = pInner + hash12(vec2(cell, 3.1)) * 0.25;
  // spikes widen outwards; some cells have no line at all
  float w = mix(0.05, 0.45, h) * (0.3 + 0.7 * smoothstep(start, start + 0.7, dn));
  float line = (1.0 - smoothstep(w * 0.8, w, abs(fract(t) - 0.5))) * step(0.22, h);
  float mask = line * smoothstep(start, start + 0.08, dn) * pAmount;
  vec3 ink = pTone < 0.5 ? vec3(0.05) : vec3(1.0);
  return mix(src.rgb, ink, clamp(mask, 0.0, 1.0));
}
`;

// Light shafts: bright pixels are smeared towards a light point (the sun, usually above the frame) and added back in.
BODY.rays = `
vec3 effect(vec2 uv, vec4 src) {
  vec2 step1 = (vec2(pLx, pLy) - uv) * pLength / 24.0;
  vec2 p = uv + step1 * (hash12(gl_FragCoord.xy) - 0.5);   // jitter hides banding
  float acc = 0.0;
  float w = 1.0;
  for (int i = 0; i < 24; i++) {
    p += step1;
    acc += smoothstep(pThreshold, 1.0, luma(texture2D(tInput, clamp(p, 0.0, 1.0)).rgb)) * w;
    w *= 0.94;
  }
  return src.rgb + pColor * (acc / 10.0) * pAmount;
}
`;

// Manga panel frame: a margin around the picture with a black border.
BODY.frame = `
vec3 effect(vec2 uv, vec4 src) {
  float m = pMargin;
  float aspect = uRes.x / max(uRes.y, 1.0);
  vec2 mm = vec2(m / aspect, m);                        // equal margin on every side in screen terms
  vec2 d = min(uv - mm, 1.0 - mm - uv);                       // distance inside the frame, in uv
  float dist = min(d.x * uRes.x, d.y * uRes.y);               // in pixels
  float bw = pBorder * uScale;
  vec3 paper = pTone < 0.5 ? vec3(0.98, 0.97, 0.94) : vec3(0.06);
  vec3 ink = pTone < 0.5 ? vec3(0.04) : vec3(0.98, 0.97, 0.94);
  vec3 c = src.rgb;
  float edge = smoothstep(-0.5, 0.5, dist);
  float inner = smoothstep(bw - 0.5, bw + 0.5, dist);
  c = mix(ink, c, inner);
  return mix(paper, c, edge);
}
`;

BODY.glow = `
vec3 effect(vec2 uv, vec4 src) {
  vec2 px = max(pRadius, 1.0) * uScale / uRes;
  vec3 sum = src.rgb;
  float wsum = 1.0;
  for (int i = 0; i < 16; i++) {
    float a = float(i) * 2.39996;            // golden angle spiral
    float r = sqrt((float(i) + 0.5) / 16.0);
    float w = 1.0 - 0.5 * r;
    sum += texture2D(tInput, uv + vec2(cos(a), sin(a)) * r * px).rgb * w;
    wsum += w;
  }
  vec3 b = sum / wsum;
  float k = clamp(pAmount, 0.0, 1.0);
  vec3 screen = 1.0 - (1.0 - src.rgb) * (1.0 - b * k);
  return mix(screen, b, 0.2 * k);            // a little softening, mostly glow
}
`;

// Line colour: tint near-black, unsaturated ink toward a colour (manhwa lines are brown / navy).
BODY.linecolor = `
vec3 effect(vec2 uv, vec4 src) {
  float L = luma(src.rgb);
  float sat = max(src.r, max(src.g, src.b)) - min(src.r, min(src.g, src.b));
  float w = (1.0 - smoothstep(pThreshold * 0.5, pThreshold, L)) * (1.0 - smoothstep(0.08, 0.25, sat));
  return mix(src.rgb, pColor, w);
}
`;

BODY.chroma = `
vec3 effect(vec2 uv, vec4 src) {
  // R pushed outward, B pulled inward, G stays put
  vec2 o = (uv - 0.5) * 2.0 * pOffset * uScale / uRes;
  float r = texture2D(tInput, uv + o).r;
  float b = texture2D(tInput, uv - o).b;
  return vec3(r, src.g, b);
}
`;

BODY.glitch = `
vec3 effect(vec2 uv, vec4 src) {
  float bandH = max(2.0, 16.0 * uScale);
  float seed = pSeed + mod(floor(uTime * 8.0), 1000.0);
  float row = floor(gl_FragCoord.y / bandH);
  float r1 = hash12(vec2(row, seed));
  float r2 = hash12(vec2(row + 17.0, seed + 3.0));
  float r3 = hash12(vec2(row + 5.0, seed + 11.0));
  float gate = step(1.0 - 0.55 * pAmount, r1);            // which bands glitch
  float dx = (r2 - 0.5) * 0.25 * pAmount * gate;          // horizontal band displacement (uv)
  float noiseLine = step(0.985 - 0.02 * pAmount, r3) * pAmount;
  vec2 suv = vec2(fract(uv.x + dx), uv.y);
  float cs = pAmount * (1.5 + 5.0 * gate) * uScale / uRes.x;   // RGB shift in uv
  float r = texture2D(tInput, vec2(fract(suv.x + cs), suv.y)).r;
  float g = texture2D(tInput, suv).g;
  float b = texture2D(tInput, vec2(fract(suv.x - cs), suv.y)).b;
  vec3 c = vec3(r, g, b);
  float ns = hash12(vec2(gl_FragCoord.x, seed * 3.0 + row));
  c = mix(c, vec3(ns), noiseLine * 0.6);
  return c;
}
`;

BODY.halftone = `
vec4 toCMYK(vec3 c) {
  float k = 1.0 - max(c.r, max(c.g, c.b));
  float inv = 1.0 / max(1.0 - k, 1e-3);
  vec3 cmy = (vec3(1.0) - c - vec3(k)) * inv;
  return vec4(clamp(cmy, 0.0, 1.0), clamp(k, 0.0, 1.0));
}

// 1 inside a dot of area ~ cov on a grid of cell S rotated by angDeg
float dotCover(vec2 p, float angDeg, float cov, float S) {
  float a = angDeg * PI / 180.0;
  float ca = cos(a);
  float sa = sin(a);
  vec2 q = vec2(ca * p.x + sa * p.y, -sa * p.x + ca * p.y);
  vec2 cell = floor(q / S + 0.5) * S;
  float d = length(q - cell);
  // dot area pi*R^2 = cov * S^2 (the old S*sqrt(cov)*0.707 covered ~1.57x too much and darkened everything)
  float R = S * sqrt(clamp(cov, 0.0, 1.0) / PI);
  return 1.0 - smoothstep(R - 0.6, R + 0.6, d);
}

vec3 effect(vec2 uv, vec4 src) {
  float S = max(2.0, pSize * uScale);
  vec4 ink = toCMYK(src.rgb);
  float off = pAngle - 15.0;   // default 15 gives the classic 15 / 75 / 0 / 45 set
  float dc = dotCover(gl_FragCoord.xy, 15.0 + off, ink.x, S);
  float dm = dotCover(gl_FragCoord.xy, 75.0 + off, ink.y, S);
  float dy = dotCover(gl_FragCoord.xy, 0.0 + off, ink.z, S);
  float dk = dotCover(gl_FragCoord.xy, 45.0 + off, ink.w, S);
  // subtractive recombination on white paper
  vec3 c = vec3(1.0);
  c *= 1.0 - dc * vec3(0.9, 0.0, 0.0);   // cyan absorbs red
  c *= 1.0 - dm * vec3(0.0, 0.9, 0.0);   // magenta absorbs green
  c *= 1.0 - dy * vec3(0.0, 0.0, 0.9);   // yellow absorbs blue
  c *= 1.0 - dk * vec3(0.95);            // key
  return c;
}
`;

BODY.dither = `
const float BAYER8[64] = float[64](
   0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
   3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

// palettes: 0 bw, 1 gameboy, 2 cga, 3 sepia4
vec3 palColor(int p, int i) {
  if (p == 0) return i == 0 ? vec3(0.0) : vec3(1.0);
  if (p == 1) {
    if (i == 0) return vec3(15.0, 56.0, 15.0) / 255.0;
    if (i == 1) return vec3(48.0, 98.0, 48.0) / 255.0;
    if (i == 2) return vec3(139.0, 172.0, 15.0) / 255.0;
    return vec3(155.0, 188.0, 15.0) / 255.0;
  }
  if (p == 2) {
    if (i == 0) return vec3(0.0);
    if (i == 1) return vec3(85.0, 255.0, 255.0) / 255.0;
    if (i == 2) return vec3(255.0, 85.0, 255.0) / 255.0;
    return vec3(1.0);
  }
  if (i == 0) return vec3(43.0, 29.0, 18.0) / 255.0;
  if (i == 1) return vec3(107.0, 74.0, 43.0) / 255.0;
  if (i == 2) return vec3(176.0, 138.0, 90.0) / 255.0;
  return vec3(242.0, 227.0, 198.0) / 255.0;
}

vec3 effect(vec2 uv, vec4 src) {
  float cell = max(1.0, pScale * uScale);
  vec2 id = floor(gl_FragCoord.xy / cell);
  int bx = int(mod(id.x, 8.0));
  int by = int(mod(id.y, 8.0));
  float th = (BAYER8[by * 8 + bx] + 0.5) / 64.0 - 0.5;
  int pal = int(pPalette + 0.5);
  int n = pal == 0 ? 2 : 4;
  float amp = 1.0 / float(n - 1);
  vec3 v = clamp(src.rgb + th * amp, 0.0, 1.0);
  vec3 best = palColor(pal, 0);
  float bd = 1e9;
  for (int i = 0; i < 4; i++) {
    if (i >= n) break;
    vec3 pc = palColor(pal, i);
    vec3 dv = pc - v;
    float d = dot(dv, dv);
    if (d < bd) {
      bd = d;
      best = pc;
    }
  }
  return best;
}
`;

BODY.kuwahara = `
vec3 effect(vec2 uv, vec4 src) {
  // radius in CSS px; the sample spacing follows the export scale
  int r = int(clamp(floor(pRadius + 0.5), 1.0, 8.0));
  vec3 bestMean = src.rgb;
  float bestVar = 1e9;
  for (int q = 0; q < 4; q++) {
    float sx = (q == 0 || q == 2) ? -1.0 : 1.0;
    float sy = (q < 2) ? -1.0 : 1.0;
    vec3 s = vec3(0.0);
    vec3 s2 = vec3(0.0);
    float cnt = 0.0;
    for (int j = 0; j <= 8; j++) {
      if (j > r) break;
      for (int i = 0; i <= 8; i++) {
        if (i > r) break;
        vec2 off = vec2(float(i) * sx, float(j) * sy) * uScale / uRes;
        vec3 c = texture2D(tInput, uv + off).rgb;
        s += c;
        s2 += c * c;
        cnt += 1.0;
      }
    }
    vec3 mean = s / cnt;
    vec3 var3 = max(s2 / cnt - mean * mean, vec3(0.0));
    float v = var3.r + var3.g + var3.b;
    if (v < bestVar) {
      bestVar = v;
      bestMean = mean;
    }
  }
  return bestMean;
}
`;

BODY.watercolor = `
vec3 effect(vec2 uv, vec4 src) {
  vec2 px = uScale / uRes;
  // noise-driven bleed: colour is pulled a few px across the wash
  vec2 np = gl_FragCoord.xy / (8.0 * uScale);
  vec2 bleed = vec2(fbm(np), fbm(np + vec2(5.2, 1.7))) - 0.5;
  vec2 buv = uv + bleed * pWetness * 10.0 * px;
  vec3 base = texture2D(tInput, buv).rgb;
  // smoothed colour, then soft colour quantisation (flat wash areas)
  vec3 avg = base * 0.4;
  avg += 0.15 * texture2D(tInput, buv + vec2(2.0, 0.0) * px).rgb;
  avg += 0.15 * texture2D(tInput, buv - vec2(2.0, 0.0) * px).rgb;
  avg += 0.15 * texture2D(tInput, buv + vec2(0.0, 2.0) * px).rgb;
  avg += 0.15 * texture2D(tInput, buv - vec2(0.0, 2.0) * px).rgb;
  vec3 q = floor(clamp(avg, 0.0, 1.0) * 6.0 + 0.5) / 6.0;
  vec3 col = mix(avg, q, 0.6);
  // edge darkening: pigment is darker than its 4 px luminance blur at wash boundaries
  float lb = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982;
    vec2 d = vec2(cos(a), sin(a)) * 4.0 * px;
    lb += luma(texture2D(tInput, buv + d).rgb);
  }
  lb *= 0.125;
  float edge = clamp((lb - luma(base)) * 5.0, 0.0, 1.0);
  // paper: off-white tint, granulation in the valleys of the paper noise
  float gran = fbm(gl_FragCoord.xy / (3.0 * uScale) + vec2(40.0));
  col *= vec3(0.985, 0.97, 0.94);
  col *= mix(vec3(1.0), vec3(0.82 + 0.36 * gran), pGranulation);
  col *= 1.0 - 0.45 * pWetness * edge;
  return col;
}
`;

BODY.pencil = `
// one set of straight lines at angDeg, spaced by 'spacing' px, drawn 'width' px wide
float hatchLine(vec2 p, float angDeg, float spacing, float width, float wob) {
  float a = angDeg * PI / 180.0;
  vec2 n = vec2(-sin(a), cos(a));
  float x = dot(p, n) + wob;
  float dd = abs(fract(x / spacing + 0.5) - 0.5) * spacing;
  return 1.0 - smoothstep(width - 0.6, width + 0.6, dd);
}

vec3 effect(vec2 uv, vec4 src) {
  vec2 p = gl_FragCoord.xy;
  float scl = max(uScale, 0.5);
  float dark = clamp(1.0 - luma(src.rgb), 0.0, 1.0);
  float sp = max(2.0, 6.0 * scl / pDensity);
  // wobble: lines drift with low-frequency noise
  float wob1 = (vnoise(p / (40.0 * scl)) - 0.5) * sp * 0.7;
  float wob2 = (vnoise(p / (37.0 * scl) + vec2(9.1, 4.3)) - 0.5) * sp * 0.7;
  // darker areas get the second set of lines (at angle + 90)
  float k1 = clamp((dark - 0.10) * 1.7, 0.0, 1.0) * 0.8;
  float k2 = clamp((dark - 0.45) * 2.2, 0.0, 1.0) * 0.8;
  float h1 = hatchLine(p, pAngle, sp, sp * 0.5 * k1, wob1);
  float h2 = hatchLine(p, pAngle + 90.0, sp, sp * 0.5 * k2, wob2);
  float ink = max(h1, h2);
  vec3 paper = vec3(0.975, 0.965, 0.94);
  vec3 graphite = vec3(0.24, 0.24, 0.26);
  vec3 col = mix(paper, graphite, clamp(ink * 0.85, 0.0, 1.0));
  // a hint of the source edges
  vec2 o = uScale / uRes;
  float gx = luma(texture2D(tInput, uv + vec2(o.x, 0.0)).rgb) - luma(texture2D(tInput, uv - vec2(o.x, 0.0)).rgb);
  float gy = luma(texture2D(tInput, uv + vec2(0.0, o.y)).rgb) - luma(texture2D(tInput, uv - vec2(0.0, o.y)).rgb);
  float edge = clamp(length(vec2(gx, gy)) * 2.5, 0.0, 1.0);
  col = mix(col, graphite, edge * 0.3);
  return col;
}
`;

BODY.dof = `
// circle of confusion, 0..1 (blur radius = pBlur * coc)
float cocOf(float d, vec2 uv) {
  if (pTiltshift > 0.5) {
    return clamp((abs(uv.y - 0.5) - 0.12) / max(pRange, 0.02), 0.0, 1.0);
  }
  float s = step(0.999, d);                       // sky
  float c = clamp(abs(d - pFocus) / max(pRange, 0.01), 0.0, 1.0);
  return mix(c, min(c, 0.5), s);                  // sky gets at most half blur
}

vec3 effect(vec2 uv, vec4 src) {
  float R = pBlur * uScale * cocOf(texture2D(tDepth, uv).a, uv);
  if (R < 0.5) return src.rgb;
  float rot = hash12(gl_FragCoord.xy) * 6.2831853;
  vec2 texel = 1.0 / uRes;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  // 32-tap golden-angle disc; a sample only spreads as far as its own blur radius
  for (int i = 0; i < 32; i++) {
    float fi = float(i);
    float rr = sqrt((fi + 0.5) / 32.0);
    float ang = fi * 2.3999632 + rot;
    vec2 off = vec2(cos(ang), sin(ang)) * rr * R;
    vec2 suv = uv + off * texel;
    vec3 c = texture2D(tInput, suv).rgb;
    float rs = pBlur * uScale * cocOf(texture2D(tDepth, suv).a, suv);
    float w = clamp(rs - rr * R + 1.0, 0.0, 1.0);
    acc += c * w;
    wsum += w;
  }
  return acc / max(wsum, 1e-3);
}
`;

BODY.fog = `
vec3 effect(vec2 uv, vec4 src) {
  float d = texture2D(tDepth, uv).a;     // linear depth / far, sky = 1
  float sky = step(0.999, d);
  float metres = d * uFar;
  float f = 1.0 - exp(-pDensity * 0.003 * metres);   // density 0.5: ~26% at 200 m, ~78% at 1 km
  f = mix(f, 0.15 * pDensity, sky);      // sky only lightly fogged
  return mix(src.rgb, pColor, clamp(f, 0.0, 1.0));
}
`;

BODY.bloom = `
vec3 effect(vec2 uv, vec4 src) {
  // blurred bright pass (half res) added back on top
  return src.rgb + texture2D(tBloom, uv).rgb * pIntensity;
}
`;

// Helper materials (not catalogue effects).
const HELPER_FRAG = {
  copy: `
uniform sampler2D tInput;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tInput, vUv);
}
`,
  bright: `
uniform sampler2D tInput;
uniform float pThreshold;
varying vec2 vUv;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);
void main() {
  vec3 c = texture2D(tInput, vUv).rgb;
  float l = dot(c, LUMA);
  float knee = 0.15;
  float soft = clamp(l - pThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  float contrib = max(soft, l - pThreshold) / max(l, 1e-3);
  gl_FragColor = vec4(c * clamp(contrib, 0.0, 1.0), 1.0);
}
`,
  blur: `
uniform sampler2D tInput;
uniform vec2 uOffset;
varying vec2 vUv;
void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 18.0);
    acc += texture2D(tInput, vUv + uOffset * fi).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}
`,
};

const HELPERS = {
  copy: () => ({ tInput: { value: null } }),
  bright: () => ({ tInput: { value: null }, pThreshold: { value: 0.7 } }),
  blur: () => ({ tInput: { value: null }, uOffset: { value: new THREE.Vector2() } }),
};

function fragmentFor(def) {
  const decls = def.params
    .map((p) => `uniform ${p.type === 'color' ? 'vec3' : 'float'} ${uName(p.id)};`)
    .join('\n');
  return GLSL_HEAD + decls + '\n' + BODY[def.id] + GLSL_MAIN;
}

function sharedUniforms() {
  return {
    tInput: { value: null },
    tDepth: { value: null },
    tBloom: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uScale: { value: 1 },
    uTime: { value: 0 },
    uStrength: { value: 1 },
    uNear: { value: 0.1 },
    uFar: { value: 1000 },
  };
}

function makeMaterial(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader,
    uniforms,
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
}

// ---------------------------------------------------------------------------------------------
// EffectStack
// ---------------------------------------------------------------------------------------------

const TARGET_OPTS = {
  type: THREE.UnsignedByteType,
  format: THREE.RGBAFormat,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
};

const BLOOM_OPTS = { ...TARGET_OPTS, type: THREE.HalfFloatType };

export class EffectStack {
  /** @param {THREE.WebGLRenderer} gl */
  constructor(gl) {
    this.gl = gl;
    this._passes = [];
    this._mats = new Map();
    this._helpers = {};
    this._pp = null;        // ping-pong pair at the frame size
    this._bloomRT = null;   // half-res pair for bloom
    this._geom = new THREE.BufferGeometry();
    this._geom.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this._geom.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this._cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._scene = new THREE.Scene();
    this._mesh = new THREE.Mesh(this._geom, null);
    this._mesh.frustumCulled = false;
    this._scene.add(this._mesh);
  }

  /** Keeps only enabled post effects with strength > 0, in list order. World entries are ignored. */
  setEffects(list) {
    this._passes = [];
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!e || !e.enabled) continue;
      const def = BY_ID.get(e.id);
      if (!def || def.kind !== 'post') continue;
      const strength = clamp(Number(e.strength ?? 1), 0, 1);
      if (!(strength > 0)) continue;
      this._passes.push({ id: e.id, def, strength, params: e.params || {} });
    }
  }

  get active() {
    return this._passes.length > 0;
  }

  needsDepth() {
    return this._passes.some((p) => p.def.needsDepth);
  }

  /** True when the output changes with `time` (grain, glitch). */
  isAnimated() {
    return this._passes.some((p) => p.id === 'grain' || p.id === 'glitch');
  }

  /**
   * Runs the enabled post effects over `input` and writes the last pass to `output` (null = canvas).
   * input / depth: THREE.Texture (or render target). depth: .a = linear depth / far, sky = 1.
   * scale: target px per CSS px. time: seconds. near / far: camera planes in metres.
   */
  render({ input, depth = null, output = null, width, height, scale = 1, time, near = 0.1, far = 1000 } = {}) {
    const r = this.gl;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const src0 = input && input.isWebGLRenderTarget ? input.texture : input;
    const depthTex = depth && depth.isWebGLRenderTarget ? depth.texture : depth || null;
    const t = time ?? performance.now() / 1000;
    const scl = scale || 1;
    // depth effects are skipped when no depth texture is supplied
    const passes = this._passes.filter((p) => !p.def.needsDepth || depthTex);

    const prevRT = r.getRenderTarget();
    const prevAuto = r.autoClear;
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    try {
      r.autoClear = false;
      this._ensureTargets(w, h);
      if (passes.length === 0) {
        const m = this._helper('copy');
        m.uniforms.tInput.value = src0;
        this._draw(m, output);
        return;
      }
      const ppA = this._pp.a;
      const ppB = this._pp.b;
      let src = src0;
      let srcRT = null;
      for (let i = 0; i < passes.length; i++) {
        const p = passes[i];
        const last = i === passes.length - 1;
        const dst = last ? output : srcRT === ppA ? ppB : ppA;
        if (p.id === 'bloom') {
          this._bloom(p, src, dst, w, h, scl, t, near, far, depthTex);
        } else {
          const m = this._mat(p.id);
          this._setShared(m, p, src, depthTex, w, h, scl, t, near, far);
          this._applyParams(m, p);
          this._draw(m, dst);
        }
        src = dst ? dst.texture : null;
        srcRT = dst;
      }
    } finally {
      r.setRenderTarget(prevRT);
      r.autoClear = prevAuto;
      r.setClearColor(prevClear, prevAlpha);
    }
  }

  dispose() {
    if (this._pp) {
      this._pp.a.dispose();
      this._pp.b.dispose();
      this._pp = null;
    }
    if (this._bloomRT) {
      this._bloomRT.a.dispose();
      this._bloomRT.b.dispose();
      this._bloomRT = null;
    }
    for (const m of this._mats.values()) m.dispose();
    this._mats.clear();
    for (const k of Object.keys(this._helpers)) this._helpers[k].dispose();
    this._helpers = {};
    this._geom.dispose();
  }

  // ----- internals -----

  _ensureTargets(w, h) {
    if (this._pp && this._pp.w === w && this._pp.h === h) return;
    if (this._pp) {
      this._pp.a.dispose();
      this._pp.b.dispose();
    }
    this._pp = {
      w,
      h,
      a: new THREE.WebGLRenderTarget(w, h, TARGET_OPTS),
      b: new THREE.WebGLRenderTarget(w, h, TARGET_OPTS),
    };
  }

  _ensureBloom(w, h) {
    const B = this._bloomRT;
    if (B && B.w === w && B.h === h) return B;
    if (B) {
      B.a.dispose();
      B.b.dispose();
    }
    this._bloomRT = {
      w,
      h,
      a: new THREE.WebGLRenderTarget(w, h, BLOOM_OPTS),
      b: new THREE.WebGLRenderTarget(w, h, BLOOM_OPTS),
    };
    return this._bloomRT;
  }

  _mat(id) {
    let m = this._mats.get(id);
    if (!m) {
      const def = BY_ID.get(id);
      const uniforms = sharedUniforms();
      for (const p of def.params) {
        uniforms[uName(p.id)] = { value: p.type === 'color' ? new THREE.Vector3() : 0 };
      }
      m = makeMaterial(fragmentFor(def), uniforms);
      this._mats.set(id, m);
    }
    return m;
  }

  _helper(name) {
    let m = this._helpers[name];
    if (!m) {
      const fragmentShader = HELPER_FRAG[name];
      m = makeMaterial(fragmentShader, HELPERS[name]());
      this._helpers[name] = m;
    }
    return m;
  }

  _setShared(m, pass, src, depth, w, h, scale, t, near, far) {
    const u = m.uniforms;
    u.tInput.value = src;
    u.tDepth.value = depth || src;
    u.uRes.value.set(w, h);
    u.uScale.value = scale;
    u.uTime.value = t;
    u.uStrength.value = pass.strength;
    u.uNear.value = near;
    u.uFar.value = far;
  }

  _applyParams(m, pass) {
    for (const p of pass.def.params) {
      setParamUniform(m.uniforms[uName(p.id)], p, pass.params);
    }
  }

  _bloom(pass, src, dst, w, h, scale, t, near, far, depth) {
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    const B = this._ensureBloom(hw, hh);

    // bright pass (soft threshold) into A
    const bright = this._helper('bright');
    bright.uniforms.tInput.value = src;
    bright.uniforms.pThreshold.value = numberParam(pass, 'threshold');
    this._draw(bright, B.a);

    // separable gaussian: horizontal into B, vertical back into A
    const blur = this._helper('blur');
    const step = Math.max(0.75, numberParam(pass, 'radius') * scale * 0.25); // half-res px per tap
    blur.uniforms.tInput.value = B.a.texture;
    blur.uniforms.uOffset.value.set(step / hw, 0);
    this._draw(blur, B.b);
    blur.uniforms.tInput.value = B.b.texture;
    blur.uniforms.uOffset.value.set(0, step / hh);
    this._draw(blur, B.a);

    // add back on the full-res source
    const m = this._mat('bloom');
    this._setShared(m, pass, src, depth, w, h, scale, t, near, far);
    this._applyParams(m, pass);
    m.uniforms.tBloom.value = B.a.texture;
    this._draw(m, dst);
  }

  _draw(mat, dst) {
    this._mesh.material = mat;
    this.gl.setRenderTarget(dst);
    this.gl.render(this._scene, this._cam);
  }
}
