// Export pipeline for Panelscape: PNG, SVG (hidden-line removed), GLB,
// OBJ (zipped with MTL + README) and binary FBX 7.4.
//
// Every public exporter takes the CityRenderer (see web/js/render.js) and triggers a
// browser download. Geometry exporters work on a baked copy of renderer.cityGroup
// (world transforms applied, InstancedMesh merged, one merged mesh per material),
// so the live scene is never modified.
//
// Units: scene meters, Y up, right-handed (+X east, -Z north). FBX is written in
// centimeters (UnitScaleFactor 1 = cm) and as binary, since Blender cannot
// import ASCII FBX, so Blender imports it at real-world scale.

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { zipSync, strToU8 } from 'fflate';

const OSM_CREDIT = '© OpenStreetMap contributors';
const OMT_CREDIT = ' / © OpenMapTiles';
const OSM_LICENSE = '© OpenStreetMap contributors (ODbL) https://www.openstreetmap.org/copyright';

const SVG_WIDTH = 2400;
const SVG_STEP_PX = 3;         // visibility sampling step along projected segments
const DEPTH_REL_EPS = 0.005;   // occlusion tolerance: 0.5% of the occluder depth ...
const DEPTH_ABS_EPS = 0.3;     // ... plus 0.3 m
const SVG_PATH_CHUNK = 5000;   // polylines per <path> element

/* ----------------------------------------------------------------------------
 * Generic helpers
 * ------------------------------------------------------------------------- */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local time formatted as YYYYMMDD-HHMMSS. */
function timestamp(date = new Date()) {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

function defaultName(ext) {
  return `panelscape-${timestamp()}.${ext}`;
}

/** Trigger a browser download of a Blob through a temporary object URL. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Keep the URL alive long enough for the browser to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function hasSurroundings(group) {
  let found = false;
  if (group) {
    group.traverse((o) => {
      if (o.userData && o.userData.surroundings) found = true;
    });
  }
  return found;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear-light channel to sRGB (for display-referred formats: OBJ/MTL, FBX). */
function linearToSRGB(c) {
  c = clamp01(c);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** Strip a name down to characters that are safe in OBJ, MTL and FBX. */
function sanitizeName(name) {
  return String(name || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

function getGL(renderer) {
  const gl = renderer.renderer || renderer.gl;
  if (!gl) throw new Error('export: THREE.WebGLRenderer not found on renderer.renderer / renderer.gl');
  return gl;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Credit line for images: OSM always, OpenMapTiles when surroundings are in the scene. */
function imageCredit(group) {
  return OSM_CREDIT + (hasSurroundings(group) ? OMT_CREDIT : '');
}

/** Credit lines for files (README, GLB copyright, FBX comment). */
function fileCreditLines(group, includeSurroundings) {
  const lines = [OSM_LICENSE];
  if (includeSurroundings && hasSurroundings(group)) lines.push('© OpenMapTiles');
  return lines;
}

/**
 * Layout of the bottom-right credit box. The text is right-aligned at `textRight`
 * and vertically centred on `textY`.
 */
function creditLayout(W, H, textWidth, fontPx) {
  const pad = fontPx * 0.5;
  const margin = fontPx * 0.8;
  const boxH = fontPx * 1.6;
  const boxW = textWidth + pad * 2;
  const boxX = W - margin - boxW;
  const boxY = H - margin - boxH;
  return { boxX, boxY, boxW, boxH, textRight: boxX + boxW - pad, textY: boxY + boxH / 2 };
}

/* ----------------------------------------------------------------------------
 * PNG
 * ------------------------------------------------------------------------- */

function drawCredit(ctx, W, H, text, fontPx, transparent) {
  ctx.save();
  ctx.font = `${fontPx}px "Helvetica Neue", Arial, sans-serif`;
  const L = creditLayout(W, H, ctx.measureText(text).width, fontPx);
  if (!transparent) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fillRect(L.boxX, L.boxY, L.boxW, L.boxH);
  }
  ctx.fillStyle = '#222222';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, L.textRight, L.textY);
  ctx.restore();
}

/**
 * Render the current view at `longSide` pixels and encode it as a Blob.
 *  - mime: 'image/png' (default), 'image/jpeg' or 'image/webp'.
 *  - quality: 0-1 (values above 1 are read as percent), used by JPEG and WebP.
 *  - JPEG has no alpha: it is composited onto white and `transparent` is ignored.
 *  - Browsers that cannot encode WebP (Safari) return a PNG blob; check blob.type.
 */
export async function renderRasterBlob(
  renderer,
  { mime = 'image/png', quality = 0.92, longSide = 3000, transparent = false, credit = true } = {}
) {
  const opaque = mime === 'image/jpeg';
  const alpha = opaque ? false : !!transparent;
  const src = await renderer.renderImage(longSide, { transparent: alpha });
  const W = src.width;
  const H = src.height;

  // Copy into a fresh 2D canvas: the renderer's canvas may be WebGL.
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (opaque) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.drawImage(src, 0, 0, W, H);

  if (credit) {
    const fontPx = Math.max(10, Math.round(Math.max(W, H) / 120));
    drawCredit(ctx, W, H, imageCredit(renderer.cityGroup), fontPx, alpha);
  }

  const q = quality > 1 ? quality / 100 : quality;
  const lossy = mime === 'image/jpeg' || mime === 'image/webp';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(`${mime} encoding failed`))),
      mime,
      lossy ? q : undefined
    );
  });
}

/** PNG shortcut for renderRasterBlob. */
export function renderPNGBlob(renderer, opts = {}) {
  return renderRasterBlob(renderer, { ...opts, mime: 'image/png' });
}

/** Render the current view at `longSide` pixels and download it as PNG. Returns the Blob. */
export async function exportPNG(renderer, { longSide = 3000, transparent = false, credit = true, filename } = {}) {
  const blob = await renderPNGBlob(renderer, { longSide, transparent, credit });
  downloadBlob(blob, filename || defaultName('png'));
  return blob;
}

/* ----------------------------------------------------------------------------
 * SVG (line art with hidden-line removal)
 * ------------------------------------------------------------------------- */

// Homogeneous clip planes as [a, b, c, d, offset]: a*x + b*y + c*z + d*w + offset >= 0.
const CLIP_PLANES = [
  [1, 0, 0, 1, 0],   // left   x >= -w
  [-1, 0, 0, 1, 0],  // right  x <=  w
  [0, 1, 0, 1, 0],   // bottom y >= -w
  [0, -1, 0, 1, 0],  // top    y <=  w
  [0, 0, 1, 1, 0],   // near   z >= -w
  [0, 0, -1, 1, 0],  // far    z <=  w
];

/** Transform a world point into clip space (column-major matrix elements `me`). */
function toClip(me, x, y, z, out) {
  out[0] = me[0] * x + me[4] * y + me[8] * z + me[12];
  out[1] = me[1] * x + me[5] * y + me[9] * z + me[13];
  out[2] = me[2] * x + me[6] * y + me[10] * z + me[14];
  out[3] = me[3] * x + me[7] * y + me[11] * z + me[15];
  return out;
}

/**
 * Clip the clip-space segment c0..c1 against the frustum and against depth >= near.
 * Clip coordinates are affine in the segment parameter t, so this is Liang-Barsky
 * in homogeneous space. Returns [tEnter, tExit] or null when fully outside.
 */
function clipSegment(c0, c1, near) {
  const planes = CLIP_PLANES.concat([[0, 0, 0, 1, -near]]); // w >= near  <=> depth >= near
  let t0 = 0;
  let t1 = 1;
  for (const p of planes) {
    const f0 = p[0] * c0[0] + p[1] * c0[1] + p[2] * c0[2] + p[3] * c0[3] + p[4];
    const f1 = p[0] * c1[0] + p[1] * c1[1] + p[2] * c1[2] + p[3] * c1[3] + p[4];
    if (f0 < 0 && f1 < 0) return null;
    if (f0 < 0) t0 = Math.max(t0, f0 / (f0 - f1));
    else if (f1 < 0) t1 = Math.min(t1, f0 / (f0 - f1));
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

/** Objects that must not occlude the line art (lines, points, sprites). */
function isLineLike(o) {
  return !!(o.isLine || o.isLineSegments || o.isLineLoop || o.isPoints || o.isSprite || o.isLine2 || o.isLineSegments2);
}

/**
 * Render the scene from the current camera into a W x H RGBA8 target where every
 * pixel stores linear view depth (packed over 4 bytes, divided by camera.far).
 * Lines and points are hidden during the pass; meshes act as occluders.
 * Returns { buf, far } where buf rows are bottom-up (GL readPixels order).
 */
function renderDepthBuffer(renderer, W, H) {
  const webgl = getGL(renderer);
  const { scene, camera } = renderer;

  const target = new THREE.WebGLRenderTarget(W, H, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
    stencilBuffer: false,
    generateMipmaps: false,
  });

  const material = new THREE.ShaderMaterial({
    uniforms: { uFar: { value: camera.far } },
    vertexShader: /* glsl */ `
      varying float vViewZ;
      void main() {
        #include <begin_vertex>
        #include <project_vertex>
        vViewZ = -mvPosition.z;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFar;
      varying float vViewZ;
      void main() {
        float v = clamp(vViewZ / uFar, 0.0, 0.99999);
        vec4 enc = vec4(1.0, 255.0, 65025.0, 16581375.0) * v;
        enc = fract(enc);
        enc -= enc.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
        gl_FragColor = enc;
      }
    `,
    side: THREE.DoubleSide,
  });

  // Save renderer state so it can be restored exactly.
  const prevTarget = webgl.getRenderTarget();
  const prevClearColor = webgl.getClearColor(new THREE.Color());
  const prevClearAlpha = webgl.getClearAlpha();
  const prevAutoClear = webgl.autoClear;
  const prevOverride = scene.overrideMaterial;
  const prevBackground = scene.background;

  const hidden = [];
  scene.traverse((o) => {
    if (o.visible && isLineLike(o)) {
      hidden.push(o);
      o.visible = false;
    }
  });

  const buf = new Uint8Array(W * H * 4);
  try {
    scene.overrideMaterial = material;
    scene.background = null;
    webgl.autoClear = true;
    webgl.setClearColor(0x000000, 0); // zero means "no surface" for the decoder
    webgl.setRenderTarget(target);
    webgl.render(scene, camera);
    webgl.readRenderTargetPixels(target, 0, 0, W, H, buf);
  } finally {
    webgl.setRenderTarget(prevTarget);
    webgl.setClearColor(prevClearColor, prevClearAlpha);
    webgl.autoClear = prevAutoClear;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    for (const o of hidden) o.visible = true;
    target.dispose();
    material.dispose();
  }
  return { buf, far: camera.far };
}

/**
 * Export the visible edges of the current view as a vector SVG (2400 px wide).
 * Segments are projected, sampled every ~3 px and tested against the depth buffer;
 * visible runs are merged into polylines.
 */
export async function svgBlob(renderer) {
  const { camera, cityGroup } = renderer;
  const seg = renderer.getLineSegments();
  const positions = seg && seg.positions ? seg.positions : new Float32Array(0);
  const segCount = Math.floor(positions.length / 6);

  const W = SVG_WIDTH;
  const aspect = camera.aspect > 0 ? camera.aspect : 1;
  const H = Math.max(1, Math.round(W / aspect));
  const near = camera.near;
  const far = camera.far;

  camera.updateMatrixWorld();
  const M = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const me = M.elements;

  const depth = segCount > 0 ? renderDepthBuffer(renderer, W, H) : null;
  const buf = depth ? depth.buf : null;

  // Clip-space endpoints of the current segment and scratch vector.
  const c0 = [0, 0, 0, 0];
  const c1 = [0, 0, 0, 0];
  const tmp = [0, 0, 0, 0];

  const clipAt = (t) => {
    for (let k = 0; k < 4; k++) tmp[k] = c0[k] + (c1[k] - c0[k]) * t;
    return tmp;
  };

  const screenAt = (t) => {
    const c = clipAt(t);
    const w = c[3];
    return [(c[0] / w * 0.5 + 0.5) * W, (0.5 - c[1] / w * 0.5) * H];
  };

  /** True when the point at parameter t is not hidden by the depth buffer. */
  const visibleAt = (t) => {
    const c = clipAt(t);
    const w = c[3];
    const sx = (c[0] / w * 0.5 + 0.5) * W;
    const sy = (0.5 - c[1] / w * 0.5) * H;
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    if (ix < 0 || iy < 0 || ix >= W || iy >= H) return false;
    // readPixels rows are bottom-up; image row iy (top-down) is buffer row H-1-iy.
    const i = ((H - 1 - iy) * W + ix) * 4;
    const r = buf[i];
    const g = buf[i + 1];
    const b = buf[i + 2];
    const a = buf[i + 3];
    if (r === 0 && g === 0 && b === 0 && a === 0) return true; // nothing drawn here
    const occ = (r / 255 + g / 65025 + b / 16581375 + a / 4228250625) * far;
    return w <= occ * (1 + DEPTH_REL_EPS) + DEPTH_ABS_EPS;
  };

  /** Bisect the visibility transition between a visible t and a hidden t. */
  const refineVisibility = (tv, ti) => {
    let a = tv;
    let b = ti;
    for (let it = 0; it < 6; it++) {
      const mid = (a + b) / 2;
      if (visibleAt(mid)) a = mid;
      else b = mid;
    }
    return a;
  };

  const polys = []; // flat [x0, y0, x1, y1, ...] in image pixels, top-left origin
  let cur = null;
  const addRun = (A, B) => {
    if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 0.05) return;
    const n = cur ? cur.length : 0;
    if (cur && Math.abs(cur[n - 2] - A[0]) < 0.01 && Math.abs(cur[n - 1] - A[1]) < 0.01) {
      cur.push(B[0], B[1]); // continue the polyline through the shared vertex
    } else {
      cur = [A[0], A[1], B[0], B[1]];
      polys.push(cur);
    }
  };

  for (let s = 0; s < segCount; s++) {
    const o = s * 6;
    toClip(me, positions[o], positions[o + 1], positions[o + 2], c0);
    toClip(me, positions[o + 3], positions[o + 4], positions[o + 5], c1);
    const range = clipSegment(c0, c1, near);
    if (!range) continue;
    const ta = range[0];
    const tb = range[1];

    const A = screenAt(ta);
    const B = screenAt(tb);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const N = Math.max(1, Math.ceil(len / SVG_STEP_PX));
    const tAt = (k) => ta + (tb - ta) * (k / N);

    const vis = new Uint8Array(N + 1);
    for (let k = 0; k <= N; k++) vis[k] = visibleAt(tAt(k)) ? 1 : 0;

    // Merge consecutive visible samples into runs, refining the run ends.
    let k = 0;
    while (k <= N) {
      if (!vis[k]) {
        k++;
        continue;
      }
      let m = k;
      while (m < N && vis[m + 1]) m++;
      const tStart = k === 0 ? ta : refineVisibility(tAt(k), tAt(k - 1));
      const tEnd = m === N ? tb : refineVisibility(tAt(m), tAt(m + 1));
      addRun(screenAt(tStart), screenAt(tEnd));
      k = m + 1;
    }
  }

  const r1 = (v) => Math.round(v * 10) / 10;
  const polyToPath = (p) => {
    let d = `M${r1(p[0])} ${r1(p[1])}`;
    for (let i = 2; i < p.length; i += 2) d += ` ${r1(p[i])} ${r1(p[i + 1])}`;
    return d;
  };

  const fontPx = Math.round(W / 120);
  const text = imageCredit(cityGroup);
  const L = creditLayout(W, H, text.length * fontPx * 0.56, fontPx);

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`);
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`);
  for (let i = 0; i < polys.length; i += SVG_PATH_CHUNK) {
    const d = polys.slice(i, i + SVG_PATH_CHUNK).map(polyToPath).join(' ');
    parts.push(
      `<path d="${d}" stroke="#000" fill="none" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`
    );
  }
  parts.push(
    `<rect x="${r1(L.boxX)}" y="${r1(L.boxY)}" width="${r1(L.boxW)}" height="${r1(L.boxH)}" fill="#ffffff" fill-opacity="0.75"/>`
  );
  parts.push(
    `<text x="${r1(L.textRight)}" y="${r1(L.textY)}" text-anchor="end" dominant-baseline="central" ` +
      `font-family="Helvetica Neue, Arial, sans-serif" font-size="${fontPx}" fill="#222222">${escapeXml(text)}</text>`
  );
  parts.push('</svg>');

  return new Blob([parts.join('\n')], { type: 'image/svg+xml' });
}

/** Download the line-art SVG of the current view. Returns the Blob. */
export async function exportSVG(renderer, { filename } = {}) {
  const blob = await svgBlob(renderer);
  downloadBlob(blob, filename || defaultName('svg'));
  return blob;
}

/* ----------------------------------------------------------------------------
 * Baking: a plain, export-ready copy of cityGroup
 * ------------------------------------------------------------------------- */

/** Base color of a material: its color, or the uniform color / gray for ShaderMaterial. */
function baseColorOf(mat, isShader) {
  if (isShader) {
    const u = mat.uniforms && mat.uniforms.color && mat.uniforms.color.value;
    return u && u.isColor ? [u.r, u.g, u.b] : [0.8, 0.8, 0.8];
  }
  const c = mat.color;
  return c && c.isColor ? [c.r, c.g, c.b] : [1, 1, 1];
}

/**
 * Bake a group into a new THREE.Group of plain Meshes that can be exported.
 *  - Coordinates are relative to `group` (so the returned group has identity transform).
 *  - World transforms are baked into vertex positions and normals.
 *  - InstancedMesh instances are merged into regular geometry.
 *  - Geometry is merged into one mesh per source material (plus a separate
 *    vertex-colored bucket where needed). Vertex colors are kept, with a white base.
 *  - Objects with userData.surroundings are skipped unless includeSurroundings.
 *  - Invisible objects and line/point objects are skipped.
 * Each mesh gets userData.kdSRGB, its display (sRGB) diffuse color for OBJ/FBX.
 * The returned meshes own new geometry and materials (dispose them when done).
 */
export function bakeGroup(group, includeSurroundings = false) {
  group.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(group.matrixWorld).invert();

  const buckets = new Map();
  const normalCache = new Map();

  // Local normals for geometry that has none (cached per geometry).
  const computedNormals = (geom) => {
    let arr = normalCache.get(geom.uuid);
    if (!arr) {
      const tmp = new THREE.BufferGeometry();
      tmp.setAttribute('position', geom.attributes.position);
      if (geom.index) tmp.setIndex(geom.index);
      tmp.computeVertexNormals();
      arr = tmp.attributes.normal.array;
      normalCache.set(geom.uuid, arr);
    }
    return arr;
  };

  /** Append one mesh (or one instance) transformed by M, to its material bucket. */
  const addPart = (mesh, M, inst) => {
    const geom = mesh.geometry;
    const posAttr = geom.attributes.position;
    if (!posAttr) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material; // multi-material: first slot only
    if (!mat) return;

    const isShader = !!(mat.isShaderMaterial || mat.isRawShaderMaterial);
    const colAttr = geom.attributes.color || null;
    const useGeomColor = !!colAttr && (isShader || !!mat.vertexColors);
    const vc = useGeomColor || !!inst;
    const key = mat.uuid + (vc ? '|vc' : '|flat');

    let bk = buckets.get(key);
    if (!bk) {
      bk = { mat, vc, base: baseColorOf(mat, isShader), pos: [], nrm: [], col: [], idx: [], count: 0 };
      buckets.set(key, bk);
    }
    // Shader materials with per-vertex colors are fully described by those colors.
    const partBase = isShader && useGeomColor ? [1, 1, 1] : bk.base;

    const n = posAttr.count;
    const P = posAttr.array;
    const N = geom.attributes.normal ? geom.attributes.normal.array : computedNormals(geom);
    const e = M.elements;
    const ne = new THREE.Matrix3().getNormalMatrix(M).elements;
    const ofs = bk.count;

    for (let i = 0; i < n; i++) {
      const x = P[i * 3];
      const y = P[i * 3 + 1];
      const z = P[i * 3 + 2];
      bk.pos.push(
        e[0] * x + e[4] * y + e[8] * z + e[12],
        e[1] * x + e[5] * y + e[9] * z + e[13],
        e[2] * x + e[6] * y + e[10] * z + e[14]
      );

      const nx = N[i * 3];
      const ny = N[i * 3 + 1];
      const nz = N[i * 3 + 2];
      const tx = ne[0] * nx + ne[3] * ny + ne[6] * nz;
      const ty = ne[1] * nx + ne[4] * ny + ne[7] * nz;
      const tz = ne[2] * nx + ne[5] * ny + ne[8] * nz;
      const len = Math.hypot(tx, ty, tz) || 1;
      bk.nrm.push(tx / len, ty / len, tz / len);

      if (vc) {
        let r = partBase[0];
        let g = partBase[1];
        let b = partBase[2];
        if (useGeomColor) {
          const ci = colAttr.itemSize;
          const cr = colAttr.array;
          r *= cr[i * ci];
          g *= cr[i * ci + 1];
          b *= cr[i * ci + 2];
        }
        if (inst) {
          r *= inst.r;
          g *= inst.g;
          b *= inst.b;
        }
        bk.col.push(r, g, b);
      }
    }

    const idxAttr = geom.index;
    const cnt = idxAttr ? idxAttr.array.length : n;
    for (let k = 0; k < cnt; k++) bk.idx.push(ofs + (idxAttr ? idxAttr.array[k] : k));
    bk.count += n;
  };

  const instanceColor = new THREE.Color(); // scratch values for InstancedMesh
  const instMatrix = new THREE.Matrix4();
  const visit = (obj) => {
    if (!obj.visible) return;
    if (obj.userData && obj.userData.surroundings && !includeSurroundings) return;

    if (obj.isInstancedMesh) {
      const rel = new THREE.Matrix4().multiplyMatrices(invRoot, obj.matrixWorld);
      const M = new THREE.Matrix4();
      for (let i = 0; i < obj.count; i++) {
        obj.getMatrixAt(i, instMatrix);
        // Tree LOD hides inactive crowns with an all-zero instance matrix.
        // Do not bake their collapsed triangles into the exported model.
        if (instMatrix.elements.every((v) => v === 0)) continue;
        M.multiplyMatrices(rel, instMatrix);
        let inst = null;
        if (obj.instanceColor) {
          obj.getColorAt(i, instanceColor);
          inst = instanceColor;
        }
        addPart(obj, M, inst);
      }
    } else if (obj.isMesh && !isLineLike(obj)) {
      addPart(obj, new THREE.Matrix4().multiplyMatrices(invRoot, obj.matrixWorld), null);
    }

    for (const child of obj.children) visit(child);
  };
  for (const child of group.children) visit(child);

  const out = new THREE.Group();
  out.name = 'Panelscape';
  let k = 0;
  for (const bk of buckets.values()) {
    if (bk.idx.length === 0) continue;
    k++;
    const label = sanitizeName(bk.mat.name) || 'mesh';
    const name = `${label}_${k}`;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bk.nrm, 3));
    if (bk.vc) geometry.setAttribute('color', new THREE.Float32BufferAttribute(bk.col, 3));
    geometry.setIndex(new THREE.Uint32BufferAttribute(bk.idx, 1));

    let kdLinear;
    if (bk.vc) {
      const n = bk.col.length / 3;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < n; i++) {
        r += bk.col[i * 3];
        g += bk.col[i * 3 + 1];
        b += bk.col[i * 3 + 2];
      }
      kdLinear = [r / n, g / n, b / n];
    } else {
      kdLinear = bk.base;
    }

    const material = bk.vc
      ? new THREE.MeshStandardMaterial({
          name,
          color: 0xffffff,
          vertexColors: true,
          roughness: 0.9,
          metalness: 0,
          side: THREE.DoubleSide,
        })
      : new THREE.MeshStandardMaterial({
          name,
          color: new THREE.Color(bk.base[0], bk.base[1], bk.base[2]),
          roughness: 0.9,
          metalness: 0,
          side: THREE.DoubleSide,
        });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.userData.kdSRGB = kdLinear.map((c) => linearToSRGB(c));
    out.add(mesh);
  }
  return out;
}

/** Dispose geometry and materials of a baked group. */
function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

/** Plain mesh data for the text writers (positions in meters). */
function extractMeshes(baked) {
  const out = [];
  baked.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    out.push({
      name: o.name,
      positions: g.attributes.position.array,
      normals: g.attributes.normal ? g.attributes.normal.array : null,
      indices: g.index ? g.index.array : null,
      kd: o.userData.kdSRGB || [0.8, 0.8, 0.8],
    });
  });
  return out;
}

/* ----------------------------------------------------------------------------
 * GLB
 * ------------------------------------------------------------------------- */

/** Set asset.copyright in a GLB binary (the JSON chunk is rewritten, the rest is kept). */
function setGLBCopyright(buffer, copyright) {
  if (buffer.byteLength < 20) return buffer;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) return buffer; // 'glTF'
  if (view.getUint32(16, true) !== 0x4e4f534a) return buffer; // 'JSON' chunk comes first

  const bytes = new Uint8Array(buffer);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  json.asset = Object.assign({}, json.asset, { copyright });

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = (jsonBytes.length + 3) & ~3; // JSON chunk is padded with spaces
  const jsonChunk = new Uint8Array(padded).fill(0x20);
  jsonChunk.set(jsonBytes);

  const rest = bytes.subarray(20 + jsonLength);
  const total = 12 + 8 + padded + rest.byteLength;
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, 0x46546c67, true);
  outView.setUint32(4, 2, true);
  outView.setUint32(8, total, true);
  outView.setUint32(12, padded, true);
  outView.setUint32(16, 0x4e4f534a, true);
  out.set(jsonChunk, 20);
  out.set(rest, 20 + padded);
  return out.buffer;
}

/** The city as a binary glTF (.glb) Blob. */
export async function glbBlob(renderer, { includeSurroundings = false } = {}) {
  const baked = bakeGroup(renderer.cityGroup, includeSurroundings);
  try {
    const exporter = new GLTFExporter();
    const buffer = await new Promise((resolve, reject) => {
      exporter.parse(baked, resolve, reject, { binary: true });
    });
    const copyright = fileCreditLines(renderer.cityGroup, includeSurroundings).join('; ');
    const data = setGLBCopyright(buffer, copyright);
    return new Blob([data], { type: 'model/gltf-binary' });
  } finally {
    disposeGroup(baked);
  }
}

/** Export the current city as a binary glTF (.glb). */
export async function exportGLB(renderer, { includeSurroundings = false, filename } = {}) {
  const blob = await glbBlob(renderer, { includeSurroundings });
  downloadBlob(blob, filename || defaultName('glb'));
  return blob;
}

/* ----------------------------------------------------------------------------
 * OBJ + MTL (zipped with README)
 * ------------------------------------------------------------------------- */

function fmt(v, digits) {
  return (Number.isFinite(v) ? v : 0).toFixed(digits);
}

function objectName(name, i) {
  return `${sanitizeName(name) || 'part'}_${i}`;
}

function materialName(i) {
  return `mat_${i}`;
}

/** Wavefront OBJ text. Each mesh is an object with its own material (usemtl). */
function buildOBJ(meshes, mtlName) {
  const lines = ['# Panelscape OBJ export', '# Units: meters, Y up', `mtllib ${mtlName}`];
  let vBase = 0;
  let nBase = 0;
  meshes.forEach((m, mi) => {
    const V = m.positions.length / 3;
    lines.push(`o ${objectName(m.name, mi)}`, `usemtl ${materialName(mi)}`);
    const P = m.positions;
    for (let i = 0; i < V; i++) {
      lines.push(`v ${fmt(P[i * 3], 6)} ${fmt(P[i * 3 + 1], 6)} ${fmt(P[i * 3 + 2], 6)}`);
    }
    if (m.normals) {
      const N = m.normals;
      for (let i = 0; i < V; i++) {
        lines.push(`vn ${fmt(N[i * 3], 4)} ${fmt(N[i * 3 + 1], 4)} ${fmt(N[i * 3 + 2], 4)}`);
      }
    }
    const idx = m.indices;
    const T = idx ? idx.length / 3 : V / 3;
    for (let t = 0; t < T; t++) {
      const ia = idx ? idx[t * 3] : t * 3;
      const ib = idx ? idx[t * 3 + 1] : t * 3 + 1;
      const ic = idx ? idx[t * 3 + 2] : t * 3 + 2;
      if (m.normals) {
        const a = vBase + ia + 1;
        const b = vBase + ib + 1;
        const c = vBase + ic + 1;
        const na = nBase + ia + 1;
        const nb = nBase + ib + 1;
        const nc = nBase + ic + 1;
        lines.push(`f ${a}//${na} ${b}//${nb} ${c}//${nc}`);
      } else {
        lines.push(`f ${vBase + ia + 1} ${vBase + ib + 1} ${vBase + ic + 1}`);
      }
    }
    vBase += V;
    if (m.normals) nBase += V;
  });
  return lines.join('\n') + '\n';
}

/** MTL text: one material per mesh, diffuse color Kd (sRGB). */
function buildMTL(meshes) {
  const lines = ['# Panelscape MTL', ''];
  meshes.forEach((m, mi) => {
    const kd = m.kd;
    lines.push(
      `newmtl ${materialName(mi)}`,
      `Kd ${fmt(kd[0], 6)} ${fmt(kd[1], 6)} ${fmt(kd[2], 6)}`,
      'Ks 0.000000 0.000000 0.000000',
      'd 1.000000',
      'illum 1',
      ''
    );
  });
  return lines.join('\n');
}

function buildReadme(credits) {
  return [
    'Panelscape export',
    '',
    'Units: meters. Axes: +X east, +Y up, -Z north.',
    '',
    'Credits:',
    ...credits,
    '',
  ].join('\n');
}

/** The city as a .zip Blob holding OBJ + MTL + README. */
export async function objZipBlob(renderer, { includeSurroundings = false } = {}) {
  const baked = bakeGroup(renderer.cityGroup, includeSurroundings);
  try {
    const meshes = extractMeshes(baked);
    const credits = fileCreditLines(renderer.cityGroup, includeSurroundings);
    const zipped = zipSync(
      {
        'panelscape.obj': strToU8(buildOBJ(meshes, 'panelscape.mtl')),
        'panelscape.mtl': strToU8(buildMTL(meshes)),
        'README.txt': strToU8(buildReadme(credits)),
      },
      { level: 6 }
    );
    return new Blob([zipped], { type: 'application/zip' });
  } finally {
    disposeGroup(baked);
  }
}

/** Export the city as OBJ + MTL + README inside a .zip. */
export async function exportOBJ(renderer, { includeSurroundings = false, filename } = {}) {
  const blob = await objZipBlob(renderer, { includeSurroundings });
  downloadBlob(blob, filename || defaultName('zip'));
  return blob;
}

/* ----------------------------------------------------------------------------
 * FBX 7.4 (ASCII)
 * ------------------------------------------------------------------------- */

/** Format a numeric list as FBX ASCII values, wrapped to several lines. */
function fbxList(n, get, fmtValue, indent) {
  const rows = [];
  let row = [];
  for (let i = 0; i < n; i++) {
    row.push(fmtValue(get(i)));
    if (row.length === 12) {
      rows.push(row.join(','));
      row = [];
    }
  }
  if (row.length) rows.push(row.join(','));
  return rows.join(',\n' + indent);
}

/** Escape a string for an FBX double-quoted value. */
function fbxStr(s) {
  return String(s).replace(/["\\\r\n]/g, ' ');
}

/** Face normal of triangle t (meters), used when the mesh has no normals. */
function faceNormals(positions, indices) {
  const T = indices ? indices.length / 3 : positions.length / 9;
  const out = new Float64Array(T * 3);
  for (let t = 0; t < T; t++) {
    const a = (indices ? indices[t * 3] : t * 3) * 3;
    const b = (indices ? indices[t * 3 + 1] : t * 3 + 1) * 3;
    const c = (indices ? indices[t * 3 + 2] : t * 3 + 2) * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      ny = 1;
    }
    out[t * 3] = nx;
    out[t * 3 + 1] = ny;
    out[t * 3 + 2] = nz;
  }
  return out;
}

/**
 * ASCII FBX 7.4 text (encoded to binary by fbxTextToBinary). Positions are written
 * in centimeters (UnitScaleFactor 1: one unit = 1 cm),
 * Y up, one Model + Geometry + Phong Material per mesh, all baked (identity Lcl).
 */
function buildFBX(meshes, credit) {
  const now = new Date();
  const L = [];
  let nextId = 1000000;
  const newId = () => nextId++;
  const docId = newId();
  const fmtCm = (v) => fmt(v * 100, 6);
  const fmtNum = (v) => fmt(v, 6);

  L.push('; FBX 7.4.0 project file');
  L.push('; Generated by Panelscape');
  L.push('; ----------------------------------------------------');
  L.push('');
  L.push('FBXHeaderExtension:  {');
  L.push('\tFBXHeaderVersion: 1003');
  L.push('\tFBXVersion: 7400');
  L.push('\tCreationTimeStamp:  {');
  L.push('\t\tVersion: 1000');
  L.push(`\t\tYear: ${now.getFullYear()}`);
  L.push(`\t\tMonth: ${now.getMonth() + 1}`);
  L.push(`\t\tDay: ${now.getDate()}`);
  L.push(`\t\tHour: ${now.getHours()}`);
  L.push(`\t\tMinute: ${now.getMinutes()}`);
  L.push(`\t\tSecond: ${now.getSeconds()}`);
  L.push('\t\tMillisecond: 0');
  L.push('\t}');
  L.push('\tCreator: "Panelscape"');
  L.push('\tSceneInfo: "SceneInfo::GlobalInfo", "UserData" {');
  L.push('\t\tType: "UserData"');
  L.push('\t\tVersion: 100');
  L.push('\t\tMetaData:  {');
  L.push('\t\t\tVersion: 100');
  L.push('\t\t\tTitle: ""');
  L.push('\t\t\tSubject: ""');
  L.push('\t\t\tAuthor: ""');
  L.push('\t\t\tKeywords: ""');
  L.push('\t\t\tRevision: ""');
  L.push(`\t\t\tComment: "${fbxStr(credit)}"`);
  L.push('\t\t}');
  L.push('\t}');
  L.push('}');
  L.push('');
  L.push('GlobalSettings:  {');
  L.push('\tVersion: 1000');
  L.push('\tProperties70:  {');
  L.push('\t\tP: "UpAxis", "int", "Integer", "",1');
  L.push('\t\tP: "UpAxisSign", "int", "Integer", "",1');
  L.push('\t\tP: "FrontAxis", "int", "Integer", "",2');
  L.push('\t\tP: "FrontAxisSign", "int", "Integer", "",1');
  L.push('\t\tP: "CoordAxis", "int", "Integer", "",0');
  L.push('\t\tP: "CoordAxisSign", "int", "Integer", "",1');
  L.push('\t\tP: "OriginalUpAxis", "int", "Integer", "",-1');
  L.push('\t\tP: "OriginalUpAxisSign", "int", "Integer", "",1');
  L.push('\t\tP: "UnitScaleFactor", "double", "Number", "",1');
  L.push('\t\tP: "OriginalUnitScaleFactor", "double", "Number", "",1');
  L.push('\t}');
  L.push('}');
  L.push('');
  L.push('Documents:  {');
  L.push('\tCount: 1');
  L.push(`\tDocument: ${docId}, "", "Scene" {`);
  L.push('\t\tProperties70:  {');
  L.push('\t\t\tP: "SourceObject", "object", "", ""');
  L.push('\t\t\tP: "ActiveAnimStackName", "KString", "", "", ""');
  L.push('\t\t}');
  L.push('\t\tRootNode: 0');
  L.push('\t}');
  L.push('}');
  L.push('');
  L.push('References:  {');
  L.push('}');
  L.push('');
  L.push('Definitions:  {');
  L.push('\tVersion: 100');
  L.push(`\tCount: ${meshes.length * 3}`);
  L.push('\tObjectType: "Model" {');
  L.push(`\t\tCount: ${meshes.length}`);
  L.push('\t}');
  L.push('\tObjectType: "Geometry" {');
  L.push(`\t\tCount: ${meshes.length}`);
  L.push('\t}');
  L.push('\tObjectType: "Material" {');
  L.push(`\t\tCount: ${meshes.length}`);
  L.push('\t}');
  L.push('}');
  L.push('');

  const connections = [];
  L.push('Objects:  {');
  meshes.forEach((m, mi) => {
    const geomId = newId();
    const modelId = newId();
    const matId = newId();
    const name = objectName(m.name, mi);
    const P = m.positions;
    const V = P.length / 3;
    const idx = m.indices;
    const T = idx ? idx.length / 3 : V / 3;
    const faceN = m.normals ? null : faceNormals(P, idx);

    // Index of the vertex used by polygon corner c (corners are 3 per triangle).
    const vertexOfCorner = (c) => (idx ? idx[c] : c);
    const cornerNormal = (c, comp) => {
      if (m.normals) return m.normals[vertexOfCorner(c) * 3 + comp];
      return faceN[Math.floor(c / 3) * 3 + comp];
    };

    L.push(`\tGeometry: ${geomId}, "Geometry::${name}", "Mesh" {`);
    L.push(`\t\tVertices: *${V * 3} {`);
    L.push(`\t\t\ta: ${fbxList(V * 3, (i) => P[i], fmtCm, '\t\t\t')}`);
    L.push('\t\t}');
    L.push(`\t\tPolygonVertexIndex: *${T * 3} {`);
    L.push(
      `\t\t\ta: ${fbxList(
        T * 3,
        (i) => {
          const k = i % 3;
          const a = vertexOfCorner(i);
          return k === 2 ? -a - 1 : a; // last index of a polygon is stored as ~index
        },
        String,
        '\t\t\t'
      )}`
    );
    L.push('\t\t}');
    L.push('\t\tGeometryVersion: 124');
    L.push('\t\tLayerElementNormal: 0 {');
    L.push('\t\t\tVersion: 101');
    L.push('\t\t\tName: ""');
    L.push('\t\t\tMappingInformationType: "ByPolygonVertex"');
    L.push('\t\t\tReferenceInformationType: "Direct"');
    L.push(`\t\t\tNormals: *${T * 9} {`);
    L.push(`\t\t\t\ta: ${fbxList(T * 9, (i) => cornerNormal(Math.floor(i / 3), i % 3), fmtNum, '\t\t\t\t')}`);
    L.push('\t\t\t}');
    L.push('\t\t}');
    L.push('\t\tLayerElementMaterial: 0 {');
    L.push('\t\t\tVersion: 101');
    L.push('\t\t\tName: ""');
    L.push('\t\t\tMappingInformationType: "AllSame"');
    L.push('\t\t\tReferenceInformationType: "IndexToDirect"');
    L.push('\t\t\tMaterials: *1 {');
    L.push('\t\t\t\ta: 0');
    L.push('\t\t\t}');
    L.push('\t\t}');
    L.push('\t\tLayer: 0 {');
    L.push('\t\t\tVersion: 100');
    L.push('\t\t\tLayerElement:  {');
    L.push('\t\t\t\tType: "LayerElementNormal"');
    L.push('\t\t\t\tTypedIndex: 0');
    L.push('\t\t\t}');
    L.push('\t\t\tLayerElement:  {');
    L.push('\t\t\t\tType: "LayerElementMaterial"');
    L.push('\t\t\t\tTypedIndex: 0');
    L.push('\t\t\t}');
    L.push('\t\t}');
    L.push('\t}');

    L.push(`\tModel: ${modelId}, "Model::${name}", "Mesh" {`);
    L.push('\t\tVersion: 232');
    L.push('\t\tProperties70:  {');
    L.push('\t\t\tP: "InheritType", "enum", "", "",1');
    L.push('\t\t\tP: "DefaultAttributeIndex", "int", "Integer", "",0');
    L.push('\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",0,0,0');
    L.push('\t\t\tP: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0');
    L.push('\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1');
    L.push('\t\t}');
    L.push('\t\tShading: T');
    L.push('\t\tCulling: "CullingOff"');
    L.push('\t}');

    const kd = m.kd.map((c) => fmt(clamp01(c), 6));
    L.push(`\tMaterial: ${matId}, "Material::${name}_mat", "" {`);
    L.push('\t\tVersion: 102');
    L.push('\t\tShadingModel: "phong"');
    L.push('\t\tMultiLayer: 0');
    L.push('\t\tProperties70:  {');
    L.push(`\t\t\tP: "DiffuseColor", "Color", "", "A",${kd[0]},${kd[1]},${kd[2]}`);
    L.push('\t\t\tP: "AmbientColor", "Color", "", "A",0,0,0');
    L.push('\t\t\tP: "SpecularColor", "Color", "", "A",0.2,0.2,0.2');
    L.push('\t\t\tP: "Shininess", "double", "Number", "",10');
    L.push('\t\t\tP: "Opacity", "double", "Number", "",1');
    L.push('\t\t}');
    L.push('\t}');

    connections.push(`\tC: "OO", ${modelId}, 0`);
    connections.push(`\tC: "OO", ${geomId}, ${modelId}`);
    connections.push(`\tC: "OO", ${matId}, ${modelId}`);
  });
  L.push('}');
  L.push('');
  L.push('Connections:  {');
  L.push(...connections);
  L.push('}');
  L.push('');
  return L.join('\n');
}

/* ----------------------------------------------------------------------------
 * Binary FBX 7.4 encoding
 * Blender's FBX importer rejects ASCII FBX ("ASCII FBX files are not
 * supported"), so the text from buildFBX is re-encoded as binary here. Only the
 * subset buildFBX emits is handled: "Name: props {" blocks, "*N { a: ... }"
 * numeric arrays and "Name: props" leaves. Arrays are stored uncompressed
 * (encoding 0). Values are little-endian, as the FBX format requires.
 * ------------------------------------------------------------------------- */

const FBX_NAMED_CLASSES = ['Geometry', 'Model', 'Material', 'Document'];
const FBX_INT32_ARRAYS = new Set(['PolygonVertexIndex', 'Materials']);
const FBX_TEXT_ENCODER = new TextEncoder();

/** Split a comma-separated FBX value list, keeping commas inside quotes. */
function fbxSplitValues(s) {
  if (!s) return [];
  const out = [];
  let cur = '';
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ',' && !inQuote) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Type one ASCII FBX value token. */
function fbxScalar(tok) {
  if (tok[0] === '"') return { t: 'S', v: tok.slice(1, -1) };
  if (tok === 'T' || tok === 'Y') return { t: 'C', v: true };
  if (tok === 'F' || tok === 'N') return { t: 'C', v: false };
  if (/^[-+]?\d+$/.test(tok)) {
    const n = Number(tok);
    return n >= -2147483648 && n <= 2147483647 ? { t: 'I', v: n } : { t: 'L', v: n };
  }
  return { t: 'D', v: Number(tok) };
}

/** Object and connection IDs are int64; named objects store "Name\0\1Class". */
function fbxRetypeNode(name, props) {
  if (FBX_NAMED_CLASSES.includes(name)) {
    if (props[0] && (props[0].t === 'I' || props[0].t === 'L')) props[0] = { t: 'L', v: props[0].v };
    if (props.length >= 3 && props[1].t === 'S' && props[2].t === 'S') {
      // ASCII shows "Class::Name"; binary stores "Name\0\1Class".
      const prefix = `${name}::`;
      const bare = props[1].v.startsWith(prefix) ? props[1].v.slice(prefix.length) : props[1].v;
      props[1] = { t: 'S', v: `${bare}\u0000\u0001${name}` };
    }
  }
  if (name === 'C') {
    return props.map((p, i) => (i > 0 && (p.t === 'I' || p.t === 'L') ? { t: 'L', v: p.v } : p));
  }
  return props;
}

/** Properties70 "P" entries: int/enum/bool/KTime keep their type, numbers are doubles. */
function fbxRetypeProperty(props) {
  if (props.length < 4) return props;
  const ptype = props[1].t === 'S' ? props[1].v : '';
  const out = props.slice(0, 4);
  for (const p of props.slice(4)) {
    if (ptype === 'int' || ptype === 'enum' || ptype === 'Integer') {
      out.push({ t: 'I', v: Math.trunc(Number(p.v)) });
    } else if (ptype === 'bool') {
      out.push({ t: 'C', v: !!p.v });
    } else if (ptype === 'KTime') {
      out.push({ t: 'L', v: Math.trunc(Number(p.v)) });
    } else if (p.t === 'I' || p.t === 'L' || p.t === 'D') {
      out.push({ t: 'D', v: Number(p.v) });
    } else {
      out.push(p);
    }
  }
  return out;
}

/** Parse the ASCII FBX text produced by buildFBX into a node tree. */
function fbxParseAscii(text) {
  const root = { name: '', props: [], children: [], arr: null };
  const stack = [root];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === ';') continue;
    const top = stack[stack.length - 1];
    if (top.arr && (line.startsWith('a:') || /^[-0-9]/.test(line))) {
      top.arr.push(line.startsWith('a:') ? line.slice(2) : line);
      continue;
    }
    if (line === '}') {
      stack.pop();
      continue;
    }
    const isOpen = line.endsWith('{');
    const body = (isOpen ? line.slice(0, -1) : line).trim();
    const colon = body.indexOf(':');
    const name = body.slice(0, colon).trim();
    const rest = body.slice(colon + 1).trim();
    if (isOpen) {
      const node = { name, props: [], children: [], arr: null };
      if (rest.startsWith('*')) node.arr = [];
      else node.props = fbxRetypeNode(name, fbxSplitValues(rest).map(fbxScalar));
      top.children.push(node);
      stack.push(node);
    } else {
      const values = fbxSplitValues(rest).map(fbxScalar);
      const props = name === 'P' ? fbxRetypeProperty(values) : fbxRetypeNode(name, values);
      top.children.push({ name, props, children: [], arr: null });
    }
  }
  return root;
}

/** Growable little-endian byte writer. */
class FbxBinaryWriter {
  constructor() {
    this.buf = new Uint8Array(1 << 20);
    this.dv = new DataView(this.buf.buffer);
    this.len = 0;
  }

  reserve(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }

  bytes(u8) {
    this.reserve(u8.length);
    this.buf.set(u8, this.len);
    this.len += u8.length;
  }

  u8(v) {
    this.reserve(1);
    this.buf[this.len++] = v;
  }

  u32(v) {
    this.reserve(4);
    this.dv.setUint32(this.len, v, true);
    this.len += 4;
  }

  i32(v) {
    this.reserve(4);
    this.dv.setInt32(this.len, v, true);
    this.len += 4;
  }

  i64(v) {
    this.reserve(8);
    this.dv.setBigInt64(this.len, BigInt(v), true);
    this.len += 8;
  }

  f64(v) {
    this.reserve(8);
    this.dv.setFloat64(this.len, v, true);
    this.len += 8;
  }

  setU32(at, v) {
    this.dv.setUint32(at, v, true);
  }
}

function fbxWriteProp(w, p) {
  const code = (c) => c.charCodeAt(0);
  switch (p.t) {
    case 'C':
      w.u8(code('C'));
      w.u8(p.v ? 1 : 0);
      break;
    case 'I':
      w.u8(code('I'));
      w.i32(p.v);
      break;
    case 'L':
      w.u8(code('L'));
      w.i64(p.v);
      break;
    case 'D':
      w.u8(code('D'));
      w.f64(p.v);
      break;
    case 'S': {
      const b = FBX_TEXT_ENCODER.encode(p.v);
      w.u8(code('S'));
      w.u32(b.length);
      w.bytes(b);
      break;
    }
    case 'ARR': {
      const raw = new Uint8Array(p.values.buffer, p.values.byteOffset, p.values.byteLength);
      w.u8(code(p.code));
      w.u32(p.values.length);
      w.u32(0); // encoding 0: uncompressed
      w.u32(raw.length);
      w.bytes(raw);
      break;
    }
    default:
      throw new Error(`fbxWriteProp: unknown type ${p.t}`);
  }
}

function fbxWriteNode(w, node) {
  const start = w.len;
  let props = node.props;
  if (node.arr) {
    const tokens = node.arr.join(',').split(',').filter((t) => t.trim() !== '');
    props = FBX_INT32_ARRAYS.has(node.name)
      ? [{ t: 'ARR', code: 'i', values: Int32Array.from(tokens, Number) }]
      : [{ t: 'ARR', code: 'd', values: Float64Array.from(tokens, Number) }];
  }
  const nameBytes = FBX_TEXT_ENCODER.encode(node.name);
  w.u32(0); // EndOffset, patched below
  w.u32(props.length);
  w.u32(0); // PropertyListLen, patched below
  w.u8(nameBytes.length);
  w.bytes(nameBytes);
  const propsStart = w.len;
  for (const p of props) fbxWriteProp(w, p);
  w.setU32(start + 8, w.len - propsStart);
  if (node.children.length) {
    for (const child of node.children) fbxWriteNode(w, child);
    w.bytes(new Uint8Array(13)); // null record ends the child list
  }
  w.setU32(start, w.len);
}

/** Re-encode buildFBX's ASCII text as a binary FBX 7.4 file. */
function fbxTextToBinary(text) {
  const root = fbxParseAscii(text);
  const w = new FbxBinaryWriter();
  w.bytes(FBX_TEXT_ENCODER.encode('Kaydara FBX Binary  \u0000'));
  w.bytes(Uint8Array.of(0x1a, 0x00));
  w.u32(7400);
  for (const child of root.children) fbxWriteNode(w, child);
  w.bytes(new Uint8Array(13));
  return w.buf.slice(0, w.len);
}

/** The city as a binary FBX 7.4 Blob. */
export async function fbxBlob(renderer, { includeSurroundings = false } = {}) {
  const baked = bakeGroup(renderer.cityGroup, includeSurroundings);
  try {
    const meshes = extractMeshes(baked);
    const credit = fileCreditLines(renderer.cityGroup, includeSurroundings).join('; ');
    const bytes = fbxTextToBinary(buildFBX(meshes, credit));
    return new Blob([bytes], { type: 'application/octet-stream' });
  } finally {
    disposeGroup(baked);
  }
}

/** Export the city as a binary FBX 7.4 file (.fbx). */
export async function exportFBX(renderer, { includeSurroundings = false, filename } = {}) {
  const blob = await fbxBlob(renderer, { includeSurroundings });
  downloadBlob(blob, filename || defaultName('fbx'));
  return blob;
}
