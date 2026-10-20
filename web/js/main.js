// Panelscape — app wiring: UI state, URL hash, build pipeline, camera, map, export.
import * as THREE from 'three';
import { CityRenderer } from './render.js';
import { CameraRig } from './controls.js';
import { MiniMap } from './map.js';
import { toLocal, toLatLon } from './geo.js';
import { fetchCity, fetchSurroundings, findViewpoints } from './osm.js';
import { fetchElevation } from './elevation.js';
import { fitBounds } from './camera-fit.js';
import { inArea } from './surfaces.js';
import { parseLocation, parseKmlFile } from './coords.js';
import { loadPlaces, searchPlaces } from './places.js';
import { FORMATS, makeFile, suggestedName, prepareSave, commitSave, chooseFolder, currentFolder, supportsFolders } from './save.js';
import { initPresets, PRESETS } from './presets.js';
import { initEffectsUI } from './effects-ui.js';
import { initWorld } from './world.js';
import { t, initI18n, setLang } from './i18n.js';

const $ = (id) => document.getElementById(id);
initI18n(); // picks the language and translates the static text before anything else runs

// ---------------------------------------------------------------------------
// State
const state = {
  lat: -6.1754,
  lon: 106.8272,
  size: 300,
  far: 2,
  name: 'Monas, Jakarta',
  style: 'lines-tone',
  lens: 32,
  city: null,
  elevation: null,
  surroundings: null,
  viewpoints: [],
  pin: null, // local [x, y]
  seed: 0,
  buildToken: 0,
  abort: null,
  pendingView: null, // camera pose from hash / Google Earth link applied after build
};

// ---------------------------------------------------------------------------
// Renderer, camera rig, map
const canvas = $('view3d');
const renderer = new CityRenderer(canvas);
let needsRender = true;
const requestRender = () => { needsRender = true; };

const rig = new CameraRig(canvas, {
  onChange: (pose) => {
    renderer.applyCameraPose(pose);
    markMoving();
    syncEyeHeight(pose);
    updateMapCamera();
    requestRender();
    scheduleHash();
  },
  onClick: (nx, ny) => {
    const p = renderer.pickGround(nx, ny);
    if (p) setPin(p);
  },
  onKeyF: () => moveCameraToPin(),
});
rig.groundAt = (x, z) => (state.city ? renderer.groundHeight(x, -z) : 0);
canvas.tabIndex = 0;

const minimap = new MiniMap($('map'), {
  onPin: (lat, lon) => {
    const [x, y] = toLocal(lat, lon, state.lat, state.lon);
    const half = (state.far > 0 ? state.far * 1000 : state.size) / 2;
    if (Math.abs(x) > half || Math.abs(y) > half) {
      // Outside the built area: rebuild around the clicked point.
      buildAt(lat, lon, `${lat.toFixed(5)}, ${lon.toFixed(5)}`);
      return;
    }
    setPin([x, y]);
  },
});

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.resize(Math.max(1, r.width), Math.max(1, r.height));
  const preset = $('cameraSelect')?.value;
  if (state.city && ['overview', 'top', 'wide'].includes(preset)) applyPreset(preset);
  renderer.applyCameraPose(rig.getPose());
  updateMapCamera();
  requestRender();
}
new ResizeObserver(resize).observe(canvas.parentElement);

function loop() {
  // Animated effects (rain, snow, petals, moving grain) need a frame every tick.
  if (needsRender || renderer.isAnimating?.()) {
    needsRender = false;
    try { renderer.render(); } catch (err) { console.error(err); }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------------------
// UI helpers
function setBusy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}
function setStatus(text) { $('status').textContent = text; }
// Status line keeps its key so it can be re-translated on language change.
let statusState = null;
function setStatusT(key, vars) { statusState = { key, vars }; setStatus(t(key, vars)); }
const HINT_KEYS = { standard: 'hint.standard', middle: 'hint.middle', alt: 'hint.alt', pen: 'hint.pen', look: 'hint.look', trackpad: 'hint.trackpad' };
const hintText = () => t(HINT_KEYS[rig.mode] || HINT_KEYS.standard);

function updateMapCamera() {
  if (!state.city) return;
  const pose = rig.getPose();
  const [lat, lon] = toLatLon(pose.position.x, -pose.position.z, state.lat, state.lon);
  const cam = renderer.camera;
  const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect);
  minimap.setCamera(lat, lon, pose.yaw, hfov, Math.max(40, state.size * 0.35));
}

// ---------------------------------------------------------------------------
// URL hash: #ll=lat,lon&s=300&far=2&n=Name&st=style&lens=32&w=world-settings&cam=x,y,z,yaw,pitch,dist
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('ll')) {
    const [lat, lon] = h.get('ll').split(',').map(Number);
    if (isFinite(lat) && isFinite(lon)) Object.assign(state, { lat, lon });
  }
  if (h.get('s')) state.size = clampSize(Number(h.get('s')));
  if (h.get('far') !== null) state.far = [0, 2, 4].includes(Number(h.get('far'))) ? Number(h.get('far')) : 2;
  if (h.get('n') !== null) state.name = h.get('n');
  if (h.get('st')) state.style = h.get('st');
  if (h.get('lens')) state.lens = Number(h.get('lens')) || 32;
  world.fromString(h.get('w') || '');
  if (h.get('cam')) {
    const c = h.get('cam').split(',').map(Number);
    if (c.length === 6 && c.every(isFinite)) state.pendingView = { kind: 'pose', x: c[0], y: c[1], z: c[2], yaw: c[3], pitch: c[4], dist: c[5] };
  }
}
function clampSize(s) {
  const opts = [200, 300, 400, 600, 800, 1000];
  return opts.reduce((a, b) => (Math.abs(b - s) < Math.abs(a - s) ? b : a), 300);
}
function hashString() {
  const p = new URLSearchParams();
  p.set('ll', `${state.lat.toFixed(6)},${state.lon.toFixed(6)}`);
  p.set('s', state.size);
  p.set('far', state.far);
  p.set('n', state.name || '');
  p.set('st', state.style);
  p.set('lens', state.lens);
  const w = world.toString();
  if (w) p.set('w', w);
  if (state.city) {
    const pose = rig.getPose();
    const e = pose.position;
    p.set('cam', [e.x, e.y, e.z].map((v) => v.toFixed(1)).concat([pose.yaw.toFixed(3), pose.pitch.toFixed(3), pose.distance.toFixed(1)]).join(','));
  }
  return '#' + p.toString();
}
let hashTimer;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => history.replaceState(null, '', hashString()), 400);
}

// ---------------------------------------------------------------------------
// Build pipeline
async function build() {
  const token = ++state.buildToken;
  state.abort?.abort();
  const abort = (state.abort = new AbortController());
  const t0 = performance.now();
  const { lat, lon, size, far } = state;
  $('placeName').textContent = state.name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  $('placeCoords').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  minimap.setArea(lat, lon, size, far);
  setPin(null);
  $('loadError').hidden = true;
  setBusy(t('busy.fetch'));
  setStatusT('status.building', { name: state.name || t('status.area') });
  scheduleHash();

  const progress = (text) => { if (token === state.buildToken) setBusy(text); };
  try {
    const [city, elevation] = await Promise.all([
      fetchCity({ lat, lon, size, seed: state.seed, signal: abort.signal, onProgress: progress }),
      fetchElevation({ lat, lon, size: far > 0 ? far * 1000 : size, n: far > 0 ? 161 : 129, signal: abort.signal }).catch(() => null),
    ]);
    if (token !== state.buildToken) return;
    state.city = city;
    state.elevation = elevation;
    state.surroundings = null;
    setBusy(t('busy.build'));
    await nextFrame();
    // Viewpoints first, so the renderer keeps their camera spots free of poles, trees, people and cars.
    state.viewpoints = safeViewpoints(city);
    // The camera spot plus the first 15 m of its line of sight, sampled every 2.5 m.
    city.keepClear = state.viewpoints.flatMap((vp) => {
      const [px, py] = vp.position, [tx, ty] = vp.target;
      const len = Math.hypot(tx - px, ty - py) || 1;
      const pts = [];
      for (let d = 0; d <= Math.min(15, len); d += 2.5) pts.push([px + ((tx - px) * d) / len, py + ((ty - py) * d) / len]);
      return pts;
    });
    renderer.setCity(city, elevation, null);
    fillCameraSelect();
    applyInitialView();
    showStats();
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    setStatusT('status.built', { name: state.name || t('status.area'), secs });
    postToHost({ type: 'built', lat, lon, size, name: state.name });
    setBusy(null);
    requestRender();

    // Surroundings load after the near area is visible.
    if (far > 0) {
      setStatusT('status.loadingSur', { name: state.name || t('status.area'), secs });
      try {
        const sur = await fetchSurroundings({ lat, lon, size, farSize: far * 1000, signal: abort.signal, onProgress: (txt) => token === state.buildToken && setStatusT('status.surProgress', { name: state.name || t('status.area'), secs, text: txt }) });
        if (token !== state.buildToken) return;
        state.surroundings = sur;
        renderer.setCity(city, elevation, sur);
        renderer.applyCameraPose(rig.getPose());
        showStats();
        requestRender();
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('Surroundings failed', err);
      }
      if (token === state.buildToken) setStatusT('status.built', { name: state.name || t('status.area'), secs: ((performance.now() - t0) / 1000).toFixed(1) });
    }
  } catch (err) {
    if (err.name === 'AbortError' || token !== state.buildToken) return;
    console.error(err);
    setBusy(null);
    setStatusT('status.couldNot', { msg: err.message || err });
    toast(t('toast.couldNotLoad'));
    $('loadError').hidden = false;
  }
}

// Yield one frame so the busy overlay paints; rAF never fires in a hidden tab, so fall back to a timeout.
const nextFrame = () => new Promise((r) => {
  const done = () => { clearTimeout(timer); r(); };
  const timer = setTimeout(done, 60);
  requestAnimationFrame(done);
});

function safeViewpoints(city) {
  try {
    return (findViewpoints(city) || []).filter((vp) => {
      const [x, y] = vp.position, eye = vp.eyeHeight ?? 1.6;
      return !(city.buildings || []).some((b) => b.height > eye && (b.minHeight || 0) < eye && inArea(x, y, b));
    });
  } catch (err) { console.warn(err); return []; }
}

$('loadRetryBtn').addEventListener('click', () => build());

function buildAt(lat, lon, name, view) {
  Object.assign(state, { lat, lon, name: name || '', pendingView: view || null });
  $('candidates').value = '';
  build();
}

function showStats() {
  const c = state.city;
  if (!c) return;
  const s = c.stats || {};
  const parts = [
    t('stats.buildings', { n: s.buildings ?? c.buildings.length, g: s.guessed ?? c.buildings.filter((b) => b.guessed).length }),
    t('stats.roads', { n: s.roads ?? c.roads.length }),
    t('stats.trees', { n: s.trees ?? c.trees.length }),
  ];
  if (state.elevation) parts.push(t('stats.elevation', { m: Math.round(state.elevation.baseElevation) }) + (state.elevation.source ? ` (${state.elevation.source})` : ''));
  if (s.bytes) parts.push(t('stats.mapData', { kb: Math.round(s.bytes / 1024) }));
  if (state.surroundings) parts.push(t('stats.surr', { km: state.far, n: state.surroundings.buildings.length }));
  $('stats').textContent = parts.join(' · ');
  $('elevationCredit').textContent = state.elevation?.source ? `Elevation: ${state.elevation.source}` : 'Elevation unavailable (flat terrain)';
}

// ---------------------------------------------------------------------------
// Camera presets
// Translated preset label; the English label from osm.js carries the street names.
function vpLabel(vp) {
  const label = String(vp.label);
  if (vp.kind === 'crossing') {
    const m = label.match(/^Crossing (\d+) ?(.*)$/);
    return m ? t('vp.crossing', { n: m[1], names: m[2] }).trim() : label;
  }
  const key = { 'street-eye': 'vp.eye', 'street-low': 'vp.low', 'street-down': 'vp.down' }[vp.kind];
  const m = label.match(/^Central street · (?:eye level|low angle|looking down) (.*)$/);
  return key && m ? t(key, { name: m[1] }) : label;
}
function fillCameraSelect() {
  const sel = $('cameraSelect');
  const keep = sel.value;
  [...sel.querySelectorAll('option[data-vp]')].forEach((o) => o.remove());
  state.viewpoints.forEach((vp, i) => {
    const o = document.createElement('option');
    o.value = `vp${i}`;
    o.dataset.vp = i;
    o.textContent = vpLabel(vp);
    sel.appendChild(o);
  });
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function groundAt(x, y) { return state.city ? renderer.surfaceHeight(x, y) : 0; }

function applyPreset(value) {
  const size = state.size;
  if (['overview', 'top', 'wide'].includes(value)) {
    const bounds = renderer.nearBounds();
    if (value === 'wide') {
      const half = Math.max(size / 2, state.far * 500);
      bounds.min[0] = Math.min(bounds.min[0], -half); bounds.max[0] = Math.max(bounds.max[0], half);
      bounds.min[2] = Math.min(bounds.min[2], -half); bounds.max[2] = Math.max(bounds.max[2], half);
    }
    const frame = fitBounds(bounds, { fov: renderer.camera.fov, aspect: renderer.camera.aspect,
      yaw: value === 'top' ? 0 : 0.55, pitch: value === 'top' ? -Math.PI / 2 + 0.001 : value === 'wide' ? -0.32 : -0.62 });
    rig.setOrbit({ ...frame, target: new THREE.Vector3(...frame.target) });
  }
  else if (value.startsWith('vp')) {
    const vp = state.viewpoints[Number(value.slice(2))];
    if (!vp) return;
    const [px, py] = vp.position, [tx, ty] = vp.target;
    const eyeY = groundAt(px, py) + (vp.eyeHeight ?? 1.6);
    const targetY = groundAt(tx, ty) + (vp.kind === 'street-down' ? 0 : vp.kind === 'street-low' ? 6 : 2.5);
    const dist = Math.hypot(tx - px, ty - py);
    const yaw = Math.atan2(tx - px, ty - py);
    let pitch = Math.atan2(targetY - eyeY, Math.max(1, dist));
    if (vp.kind === 'street-low') pitch = Math.max(pitch, 0.18);
    rig.setPose({ position: new THREE.Vector3(px, eyeY, -py), yaw, pitch, distance: Math.max(20, dist) });
  }
}

function applyInitialView() {
  const v = state.pendingView;
  state.pendingView = null;
  if (v?.kind === 'pose') {
    rig.setPose({ position: new THREE.Vector3(v.x, v.y, v.z), yaw: v.yaw, pitch: v.pitch, distance: v.dist });
    $('cameraSelect').value = 'free';
  } else if (v?.kind === 'earth') {
    // Google Earth: camera looks at (lat, lon) from `range` meters, heading/tilt in degrees (tilt 0 = straight down).
    const tilt = THREE.MathUtils.degToRad(v.tilt ?? 45);
    const range = v.range ?? state.size;
    rig.setOrbit({ target: new THREE.Vector3(0, groundAt(0, 0), 0), distance: range, yaw: THREE.MathUtils.degToRad(v.heading ?? 0), pitch: -(Math.PI / 2 - tilt) });
    $('cameraSelect').value = 'free';
  } else {
    // Named places should open with their scene in frame. Street viewpoints remain optional.
    $('cameraSelect').value = 'overview';
    applyPreset('overview');
  }
}

// ---------------------------------------------------------------------------
// Pin
function setPin(p) {
  state.pin = p;
  $('moveCamBtn').disabled = $('standBtn').disabled = !p;
  if (!p) { minimap.setPin(null); return; }
  const [lat, lon] = toLatLon(p[0], p[1], state.lat, state.lon);
  minimap.setPin(lat, lon);
}

function moveCameraToPin() {
  if (!state.pin) return;
  const pose = rig.getPose();
  const [x, y] = state.pin;
  const heightAbove = pose.position.y - groundAt(pose.position.x, -pose.position.z);
  const pos = new THREE.Vector3(x, groundAt(x, y) + Math.max(1.6, heightAbove), -y);
  rig.setPose({ position: pos, yaw: pose.yaw, pitch: pose.pitch, distance: pose.distance });
  $('cameraSelect').value = 'free';
}

function standAtPin() {
  if (!state.pin) return;
  const pose = rig.getPose();
  const [x, y] = state.pin;
  rig.setPose({ position: new THREE.Vector3(x, groundAt(x, y) + 1.6, -y), yaw: pose.yaw, pitch: 0.05, distance: 30 });
  $('cameraSelect').value = 'free';
}

// ---------------------------------------------------------------------------
// Search
let searchAbort;
async function doSearch(text) {
  text = text.trim();
  if (!text) return;
  const loc = parseLocation(text);
  if (loc) {
    $('searchResults').hidden = true;
    const view = loc.heading !== undefined || loc.tilt !== undefined ? { kind: 'earth', heading: loc.heading, tilt: loc.tilt, range: loc.range } : null;
    buildAt(loc.lat, loc.lon, `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}`, view);
    return;
  }
  searchAbort?.abort();
  searchAbort = new AbortController();
  const box = $('searchResults');
  box.hidden = false;
  box.innerHTML = `<div class="empty">${t('search.searching')}</div>`;
  try {
    const results = await searchPlaces(text, searchAbort.signal);
    box.innerHTML = '';
    if (!results.length) { box.innerHTML = `<div class="empty">${t('search.none')}</div>`; return; }
    for (const r of results) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.name;
      b.addEventListener('click', () => {
        box.hidden = true;
        buildAt(r.lat, r.lon, r.name.split(',').slice(0, 3).join(','));
      });
      box.appendChild(b);
    }
  } catch (err) {
    if (err.name !== 'AbortError') box.innerHTML = `<div class="empty">${t('search.failed')}</div>`;
  }
}

async function openKml(file) {
  try {
    const loc = await parseKmlFile(file);
    if (!loc) { toast(t('toast.noLocation')); return; }
    const view = loc.heading !== undefined || loc.tilt !== undefined ? { kind: 'earth', heading: loc.heading, tilt: loc.tilt, range: loc.range } : null;
    buildAt(loc.lat, loc.lon, loc.name || file.name.replace(/\.(km[lz]|geojson|json)$/i, ''), view);
  } catch (err) {
    console.error(err);
    toast(t('toast.couldNotRead'));
  }
}

// ---------------------------------------------------------------------------
// Options
function readOptions() {
  return {
    shadows: $('optShadows').checked,
    distantWindows: $('optWindows').checked,
    straightVerticals: $('optStraight').checked,
    terrain: $('optTerrain').checked,
    trees: $('optTrees').checked,
    details: $('optDetails').checked,
    lowPoly: $('optLowPoly').checked,
    detailDistance: Number($('detailDist').value),
    treeDistance: Number($('treeDist').value),
    season: $('season').value,
    treeStyle: $('treeStyle').value,
    leafEdge: $('leafEdge').value,
    ...world.read(),
    twoSidedShadows: $('shadowSide').value === 'double',
  };
}
// World settings panel (people, cars, trees, street details); kept in the share link
const world = initWorld({ onChange: () => { applyOptions(); scheduleHash(); } });
function applyOptions() {
  renderer.setOptions(readOptions());
  renderer.applyCameraPose(rig.getPose());
  requestRender();
}

function setStyle(style) {
  state.style = style;
  document.querySelectorAll('#styleSeg button').forEach((b) => b.classList.toggle('on', b.dataset.style === style));
  renderer.setStyle(style);
  requestRender();
  scheduleHash();
}

// ---------------------------------------------------------------------------
// Wire up UI
function bindRange(id, fmt, fn) {
  const el = $(id), out = $(id + 'Out');
  const upd = () => { if (out) out.textContent = fmt(Number(el.value)); fn(Number(el.value)); };
  el.addEventListener('input', upd);
  if (out) out.textContent = fmt(Number(el.value));
}

$('searchForm').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('searchInput').value); });
$('kmlBtn').addEventListener('click', () => $('kmlInput').click());
$('kmlInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openKml(f); e.target.value = ''; });
$('sizeSelect').addEventListener('change', (e) => { state.size = Number(e.target.value); build(); });
$('farSelect').addEventListener('change', (e) => { state.far = Number(e.target.value); build(); });

document.querySelectorAll('#styleSeg button').forEach((b) => b.addEventListener('click', () => setStyle(b.dataset.style)));
bindRange('lineWidth', (v) => v.toFixed(1), (v) => { renderer.setLineWidth(v); requestRender(); });
bindRange('outlineWidth', (v) => v.toFixed(1), (v) => { renderer.setOutlineWidth(v); requestRender(); });
// Sun position for latitude, month (15th) and local solar time. Returns compass azimuth / elevation in degrees.
function solarPosition(lat, month, hour) {
  const R = Math.PI / 180;
  const doy = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349][month - 1];
  const decl = 23.44 * Math.sin((2 * Math.PI * (284 + doy)) / 365) * R;
  const H = 15 * (hour - 12) * R;
  const phi = lat * R;
  const el = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) / R + 180;
  return { azimuth: (az + 360) % 360, elevation: el / R };
}
function updLight() {
  if ($('realSun').checked) {
    const s = solarPosition(state.lat, Number($('sunMonth').value), Number($('sunHour').value));
    $('sunAz').value = String(Math.round(s.azimuth / 5) * 5 % 360);
    $('sunEl').value = String(Math.round(Math.min(85, Math.max(5, s.elevation))));
    $('sunAzOut').textContent = `${$('sunAz').value}°`;
    $('sunElOut').textContent = `${$('sunEl').value}°`;
    // Below the horizon: keep a low sun so the picture still reads.
    renderer.setLight({ azimuth: s.azimuth, elevation: Math.max(5, s.elevation) });
  } else {
    renderer.setLight({ azimuth: Number($('sunAz').value), elevation: Number($('sunEl').value) });
  }
  requestRender();
}
const pct = (v) => `${Math.round(v)}%`;
bindRange('sunAz', (v) => `${v}°`, () => { $('realSun').checked = false; $('realSunBox').hidden = true; updLight(); });
bindRange('sunEl', (v) => `${v}°`, () => { $('realSun').checked = false; $('realSunBox').hidden = true; updLight(); });
bindRange('sunMonth', (v) => String(v), updLight);
bindRange('sunHour', (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`, updLight);
$('realSun').addEventListener('change', () => { $('realSunBox').hidden = !$('realSun').checked; updLight(); });
$('shadowSide').addEventListener('change', applyOptions);
$('lightBtn').addEventListener('click', () => ($('lightPop').hidden = !$('lightPop').hidden));

function updAir() {
  renderer.setAir({ shade: Number($('shade').value) / 100, haze: Number($('haze').value) / 100, sky: $('skyTone').checked });
  requestRender();
}
bindRange('shade', pct, updAir);
bindRange('haze', pct, updAir);
$('skyTone').addEventListener('change', updAir);

let toneSeed = 0;
function updTone() {
  renderer.setTone({
    shadow: Number($('toneShadow').value) / 100,
    base: Number($('toneBase').value) / 100,
    pattern: $('tonePattern').value,
    size: Number($('toneSize').value),
    seed: toneSeed,
    opacity: Number($('toneOpacity').value) / 100,
    grayFill: $('toneGray').checked,
    blackRange: Number($('blackRange').value) / 100,
    whiteLines: $('whiteLines').checked,
  });
  requestRender();
}
bindRange('toneShadow', pct, updTone);
bindRange('toneBase', pct, updTone);
bindRange('toneSize', (v) => pct(v * 100), updTone);
bindRange('toneOpacity', pct, updTone);
bindRange('blackRange', pct, updTone);
for (const id of ['tonePattern', 'toneGray', 'whiteLines']) $(id).addEventListener('change', updTone);
$('toneSeed').addEventListener('click', () => { toneSeed++; updTone(); });
bindRange('lens', (v) => `${v}mm`, (v) => { state.lens = v; renderer.setLens(v); renderer.applyCameraPose(rig.getPose()); updateMapCamera(); requestRender(); scheduleHash(); });
$('cameraSelect').addEventListener('change', (e) => { if (e.target.value !== 'free') applyPreset(e.target.value); });
canvas.addEventListener('pointerdown', () => { if ($('cameraSelect').value !== 'free') $('cameraSelect').value = 'free'; });
$('recenterBtn').addEventListener('click', () => {
  const p = renderer.pickGround(0, 0) || [rig.target.x, -rig.target.z];
  const pose = rig.getPose();
  const [lat, lon] = toLatLon(p[0], p[1], state.lat, state.lon);
  // Keep the camera where it is, relative to the new center.
  const e = pose.position;
  state.pendingView = { kind: 'pose', x: e.x - p[0], y: e.y, z: e.z + p[1], yaw: pose.yaw, pitch: pose.pitch, dist: pose.distance };
  Object.assign(state, { lat, lon, name: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
  build();
});
for (const id of ['optStraight', 'optShadows', 'optWindows', 'optTerrain', 'optTrees', 'optDetails', 'optLowPoly', 'season', 'treeStyle', 'leafEdge']) {
  $(id).addEventListener('change', applyOptions);
}
bindRange('detailDist', (v) => `${Math.round(v * 100)}%`, () => { savePref('detailDist'); applyOptions(); });
bindRange('treeDist', (v) => (v > 0 ? `${v}m` : 'off'), () => { savePref('treeDist'); applyOptions(); });

// Eye height: the camera's height above the ground right under it (keeps position and direction).
let eyeSync = false;
function syncEyeHeight(pose) {
  if (eyeSync || !state.city) return;
  const h = pose.position.y - groundAt(pose.position.x, -pose.position.z);
  if (h >= 0.15 && h <= 2.45) { $('eyeHeight').value = String(Math.round(h * 10) / 10); $('eyeHeightOut').textContent = `${$('eyeHeight').value} m`; }
}
bindRange('eyeHeight', (v) => `${v.toFixed(1)} m`, (v) => {
  if (!state.city) return;
  const pose = rig.getPose();
  const pos = pose.position.clone();
  pos.y = groundAt(pos.x, -pos.z) + v;
  eyeSync = true;
  rig.setPose({ position: pos, yaw: pose.yaw, pitch: pose.pitch, distance: pose.distance });
  eyeSync = false;
  $('cameraSelect').value = 'free';
});

// Light display (slow computers): 1x resolution, coarser while the camera moves. Saved in this browser.
let movingTimer;
function markMoving() {
  if (!$('optLightDisplay').checked) return;
  renderer.setDisplayQuality({ moving: true });
  clearTimeout(movingTimer);
  movingTimer = setTimeout(() => { renderer.setDisplayQuality({ moving: false }); requestRender(); }, 250);
}
$('optLightDisplay').addEventListener('change', () => {
  savePref('optLightDisplay');
  renderer.setDisplayQuality({ light: $('optLightDisplay').checked, moving: false });
  requestRender();
});

// Per-browser preferences (like the original: light display, detail and tree picture distance).
function savePref(id) {
  const el = $(id);
  try { localStorage.setItem('rokehan-pref-' + id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value); } catch {}
}
function loadPrefs() {
  for (const id of ['optLightDisplay', 'detailDist', 'treeDist', 'saveFormat', 'jpegQuality']) {
    let v = null;
    try { v = localStorage.getItem('rokehan-pref-' + id); } catch {}
    if (v === null) continue;
    const el = $(id);
    if (el.type === 'checkbox') el.checked = v === '1';
    else { el.value = v; el.dispatchEvent(new Event('input')); }
  }
  renderer.setDisplayQuality({ light: $('optLightDisplay').checked, moving: false });
  syncSaveUI();
  refreshFolderName();
}
$('controlMode').addEventListener('change', (e) => { rig.setMode(e.target.value); $('controlHint').textContent = hintText(); });
$('controlHint').textContent = hintText();

$('moveCamBtn').addEventListener('click', moveCameraToPin);
$('standBtn').addEventListener('click', standAtPin);
document.querySelectorAll('.nudge button').forEach((b) => b.addEventListener('click', () => {
  const d = { n: [0, 1], s: [0, -1], e: [1, 0], w: [-1, 0] }[b.dataset.dir];
  const [lat, lon] = toLatLon(d[0] * state.size, d[1] * state.size, state.lat, state.lon);
  const pose = rig.getPose();
  const e = pose.position;
  state.pendingView = { kind: 'pose', x: e.x - d[0] * state.size, y: e.y, z: e.z + d[1] * state.size, yaw: pose.yaw, pitch: pose.pitch, dist: pose.distance };
  Object.assign(state, { lat, lon, name: `${lat.toFixed(5)}, ${lon.toFixed(5)}` });
  build();
}));

// Candidates: the list comes from the server, so it is loaded before the select is filled.
const cand = $('candidates');
let PLACES = [];
try {
  PLACES = await loadPlaces();
} catch (err) {
  console.warn('Could not load the candidate list', err);
}
// One <optgroup> per region (the list arrives grouped, in display order).
let candGroup = null;
let candParent = cand;
PLACES.forEach((p, i) => {
  if (p.group && p.group !== candGroup) {
    candGroup = p.group;
    candParent = document.createElement('optgroup');
    candParent.label = p.group;
    cand.appendChild(candParent);
  }
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = p.name;
  candParent.appendChild(o);
});
cand.addEventListener('change', () => {
  const p = PLACES[Number(cand.value)];
  if (p) { buildAt(p.lat, p.lon, p.name); cand.value = String(PLACES.indexOf(p)); }
});

// Re-roll: the server computes the city again with a new seed (guessed heights change, known heights
// stay). The near-area geometry, viewpoints and surroundings are unchanged.
let rerollSeq = 0;
async function reroll() {
  if (!state.city) return;
  const before = state.city;
  const buildToken = state.buildToken;
  const seq = ++rerollSeq;
  const seed = (state.seed + 1) | 0 || 1;
  const { lat, lon, size } = state;
  setBusy(t('busy.fetch'));
  try {
    const city = await fetchCity({ lat, lon, size, seed });
    if (state.city !== before || buildToken !== state.buildToken) return; // superseded by a build or a newer re-roll
    city.keepClear = before.keepClear;
    state.seed = seed;
    state.city = city;
    renderer.setCity(city, state.elevation, state.surroundings);
    renderer.applyCameraPose(rig.getPose());
    showStats();
    requestRender();
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      toast(t('toast.couldNotLoad'));
    }
  } finally {
    // Only the latest re-roll clears the overlay, and not when a build has taken it over.
    if (seq === rerollSeq && buildToken === state.buildToken) setBusy(null);
  }
}
$('rerollBtn').addEventListener('click', reroll);

// Export
async function runExport(label, fn) {
  if (!state.city) { toast(t('toast.buildFirst')); return; }
  setBusy(t('busy.exporting', { label }));
  await nextFrame();
  try {
    lastSaved = null;
    await fn();
    toast(lastSaved?.where === 'folder' ? t('toast.savedTo', { name: lastSaved.name, folder: $('saveFolderName').textContent }) : t('toast.saved', { label }));
  } catch (err) {
    if (err?.cancelled) return;
    console.error(err);
    toast(t('toast.exportFailed', { msg: err.message || err }));
  } finally {
    setBusy(null);
    renderer.resize(canvas.clientWidth, canvas.clientHeight);
    renderer.applyCameraPose(rig.getPose());
    requestRender();
  }
}
// Save toolbar: pick a file type, then Save (into the chosen folder, or a download) or Save as… (dialog).
const fmtOf = () => FORMATS.find((f) => f.id === $('saveFormat').value) || FORMATS[0];
function syncSaveUI() {
  const f = fmtOf();
  const lossy = f.id === 'jpeg' || f.id === 'webp';
  $('jpegQuality').closest('label')?.classList.toggle('hidden', !lossy);
  savePref('saveFormat');
}
async function refreshFolderName() {
  const name = supportsFolders() ? await currentFolder() : null;
  $('saveFolderName').textContent = name || t('save.downloads');
  $('saveFolderBtn').hidden = !supportsFolders();
}
async function saveCurrent(mode) {
  const f = fmtOf();
  if (!state.city) { toast(t('toast.buildFirst')); return; }
  // Ask for the destination first, while the click still counts as a user gesture.
  const target = await prepareSave(suggestedName(state.name || 'place', state.style, f.ext), f.id, mode);
  if (target.kind === 'cancelled') return;
  await runExport(f.label, async () => {
    const opts = {
      longSide: Number($('pngSize').value),
      transparent: $('pngTransparent').checked,
      credit: $('pngCredit').checked,
      quality: Number($('jpegQuality').value) / 100,
      includeSurroundings: $('modelSurroundings').checked,
    };
    const { blob, ext } = await makeFile(renderer, f.id, opts);
    lastSaved = await commitSave(target, blob, suggestedName(state.name || 'place', state.style, ext));
  });
}
let lastSaved = null;
$('saveFormat').addEventListener('change', syncSaveUI);
bindRange('jpegQuality', (v) => `${v}%`, () => savePref('jpegQuality'));
$('saveBtn').addEventListener('click', () => saveCurrent('auto'));
$('saveAsBtn').addEventListener('click', () => saveCurrent('picker'));
$('saveFolderBtn').addEventListener('click', async () => {
  try { if (await chooseFolder()) await refreshFolderName(); } catch (err) { console.error(err); }
});
// Ctrl/Cmd+S saves, Ctrl/Cmd+Shift+S opens Save as…
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveCurrent(e.shiftKey ? 'picker' : 'auto'); }
});

// Theater (default) / compact layout, and fullscreen viewer.
function setTheater(on) {
  document.body.classList.toggle('compact', !on);
  $('theaterBtn').setAttribute('aria-pressed', String(on));
  try { localStorage.setItem('rokehan-pref-theater', on ? '1' : '0'); } catch {}
}
$('theaterBtn').addEventListener('click', () => setTheater(document.body.classList.contains('compact')));
$('fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else $('viewer').requestFullscreen?.().catch(() => {});
});
try { setTheater(localStorage.getItem('rokehan-pref-theater') !== '0'); } catch { setTheater(true); }

$('copyLinkBtn').addEventListener('click', async () => {
  const url = location.href.split('#')[0] + hashString();
  history.replaceState(null, '', hashString());
  try { await navigator.clipboard.writeText(url); toast(t('toast.linkCopied')); } catch { prompt(t('prompt.copyLink'), url); }
});

// Drag & drop KML/KMZ
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { dragDepth++; $('dropzone').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f && /\.(km[lz]|geojson|json)$/i.test(f.name)) openKml(f);
  else if (f) toast(t('toast.dropBad'));
});
window.addEventListener('hashchange', () => {
  // Only react to external hash edits (ours use replaceState and don't fire this).
  readHash();
  syncControls();
  setStyle(state.style);
  renderer.setLens(state.lens);
  renderer.setOptions(readOptions());
  build();
});

function syncControls() {
  $('sizeSelect').value = String(state.size);
  $('farSelect').value = String(state.far);
  $('lens').value = String(state.lens);
  $('lensOut').textContent = `${state.lens}mm`;
  const idx = PLACES.findIndex((p) => p.name === state.name);
  cand.value = idx >= 0 ? String(idx) : '';
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Embed API: when this page runs inside another app's iframe, that host can pick a spot as a story
// background. Messages carry { app: 'panelscape', tok } (tok from ?tok= so the host can match them).
//   to host:   { type: 'ready' } · { type: 'built', lat, lon, size, name } · { type: 'pick', v: 1, recipe }
//              { type: 'rendered', id, url }  (PNG data URL, or null on failure)
//   from host: { type: 'lang', lang } · { type: 'load', lat, lon, size?, name? } · { type: 'render', id, longSide?, transparent? }
const EMBED = window.parent !== window;
const EMBED_TOK = new URLSearchParams(location.search).get('tok') || '';
function postToHost(msg) {
  if (!EMBED) return;
  try { window.parent.postMessage({ app: 'panelscape', tok: EMBED_TOK, ...msg }, '*'); } catch (err) { console.error(err); }
}
if (EMBED) {
  $('useBgBtn').hidden = false;
  $('useBgBtn').addEventListener('click', () => {
    $('useBgBtn').blur();
    if (!state.city) return;
    if (!state.pin) { toast(t('status.needPin')); return; }
    const pose = rig.getPose();
    const [plat, plon] = toLatLon(state.pin[0], state.pin[1], state.lat, state.lon);
    // rot: compass heading of the camera's view (0 = north, clockwise, radians). The characters are shown
    // side by side, so the host frames them perpendicular to the line from the camera to the pin.
    const recipe = {
      lat: +plat.toFixed(6), lon: +plon.toFixed(6),
      center: { lat: state.lat, lon: state.lon }, size: state.size, far: state.far,
      style: state.style, lens: state.lens, rot: +pose.yaw.toFixed(4),
      pin: state.pin.map((v) => +v.toFixed(2)),
      camera: { position: pose.position.toArray().map((v) => +v.toFixed(2)), yaw: +pose.yaw.toFixed(4), pitch: +pose.pitch.toFixed(4) },
      options: { terrain: $('optTerrain').checked, trees: $('optTrees').checked, details: $('optDetails').checked, season: $('season').value, ...world.read() },
      name: String(state.name || '').slice(0, 80),
      link: location.href.split('#')[0] + hashString(),
    };
    postToHost({ type: 'pick', v: 1, recipe });
    toast(t('status.picked'));
  });
  window.addEventListener('message', async (e) => {
    if (e.source !== window.parent) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.type === 'lang' && typeof d.lang === 'string') {
      setLang(d.lang);
      window.dispatchEvent(new Event('langchange'));
    } else if (d.type === 'load' && isFinite(d.lat) && isFinite(d.lon)) {
      if (d.size) { state.size = clampSize(Number(d.size)); $('sizeSelect').value = String(state.size); }
      buildAt(Number(d.lat), Number(d.lon), d.name || `${Number(d.lat).toFixed(5)}, ${Number(d.lon).toFixed(5)}`);
    } else if (d.type === 'render') {
      let url = null;
      try {
        if (state.city) {
          const cv = renderer.renderImage(Math.min(4800, Math.max(256, Number(d.longSide) || 1600)), { transparent: !!d.transparent });
          url = cv.toDataURL('image/png');
        }
      } catch (err) { console.error(err); }
      renderer.resize(canvas.clientWidth, canvas.clientHeight);
      renderer.applyCameraPose(rig.getPose());
      requestRender();
      postToHost({ type: 'rendered', id: d.id, url });
    }
  });
}

// Debug / automation handle (used for testing in the browser console).
window.panelscape = { renderer, rig, state };

// Start
// Language change: re-translate the runtime text built here (static text is handled by i18n.js).
window.addEventListener('langchange', () => {
  $('controlHint').textContent = hintText();
  if (statusState) setStatus(t(statusState.key, statusState.vars));
  showStats();
  fillCameraSelect();
});
readHash();
syncControls();
setStyle(state.style);
renderer.setLens(state.lens);
renderer.setLineWidth(Number($('lineWidth').value));
renderer.setOutlineWidth(Number($('outlineWidth').value));
updLight();
updAir();
updTone();
loadPrefs();
renderer.setOptions(readOptions());
// Effects: an ordered stack of image filters plus world effects (night, rain, snow, petals).
// While a preset's effects are on, storage keeps the user's own stack, so a reload (or another preset)
// does not inherit the preset's effects as if the user had added them.
const fxUI = initEffectsUI({
  button: $('effectsBtn'), panel: $('effectsPanel'),
  onChange: (list) => { renderer.setEffects(list); requestRender(); },
  toStorage: (list) => {
    if (!presetFxOn || !userFx || !presetFxIds) return list;
    const own = new Map(userFx.map((e) => [e.id, e]));
    return list.flatMap((e) => (presetFxIds.has(e.id) ? (own.has(e.id) ? [own.get(e.id)] : []) : [e]));
  },
});

// Presets may also carry effects (e.g. Manhwa: cel bands, glow, line colour…). Their effects are layered
// on top of the user's own stack, scaled by the preset strength; leaving the preset restores that stack.
let userFx = null;      // the user's stack captured when a preset with effects took over
let presetFxOn = false;
let presetFxIds = null;   // ids of the active preset's effects
function applyPresetEffects(id, s) {
  const p = PRESETS.find((x) => x.id === id);
  const fx = p && p.effects && s > 0 ? p.effects : null;
  if (!fx) {
    if (presetFxOn && userFx) fxUI.setList(userFx);
    presetFxOn = false;
    presetFxIds = null;
    userFx = null;
    return;
  }
  if (!presetFxOn) userFx = fxUI.getList();
  presetFxOn = true;
  const byId = new Map(userFx.map((e) => [e.id, e]));
  const ids = new Set(fx.map((e) => e.id));
  presetFxIds = ids;
  const list = [
    ...fx.map((e) => ({ id: e.id, enabled: true, strength: e.strength * s, params: { ...(byId.get(e.id)?.params || {}), ...e.params } })),
    ...userFx.filter((e) => !ids.has(e.id)),
  ];
  fxUI.setList(list);
}
// Presets start after the page settings are restored, so their base is the real starting look.
initPresets({ picker: $('presetSelect'), strength: $('presetStrength'), strengthOut: $('presetStrengthOut'), onChange: (id, s) => { applyPresetEffects(id, s); requestRender(); } });
resize();
build();
postToHost({ type: 'ready' });
