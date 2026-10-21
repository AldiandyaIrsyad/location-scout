// World settings panel: the controls for what is in the scene (buildings, street furniture, people, cars, trees, street details).
// The panel markup is in index.html; this module reads and writes it, and maps it onto the renderer
// options (see WORLD_KEYS in render.js). Settings that differ from the defaults go into the share link
// (`w=` in the URL hash) so the same crowd comes back when the link is opened.

const $ = (id) => document.getElementById(id);

const pct = (v) => `${Math.round(v)}%`;
const plain = (v) => String(Math.round(v));
const times = (v) => `${v.toFixed(2)}×`;
const wearName = (v) => (v === 0 ? 'New' : `${Math.round(v)}% worn`);
const deg = (v) => `${Math.round(v)}°`;
const metres = (v) => `${Math.round(v)} m`;
const metres2 = (v) => `${v.toFixed(2)} m`;
const cm = (v) => `${(v * 100).toFixed(1)} cm`;

// [element id, option key, output formatter]
const SLIDERS = [
  ['wPeople', 'peopleDensity', pct], ['wUmbrellas', 'umbrellaShare', pct], ['wUmbrellaSize', 'umbrellaSize', times], ['wWalk', 'walkShare', plain], ['wStand', 'standShare', plain], ['wTalk', 'talkShare', plain],
  ['wGroup', 'groupSize', plain], ['wKids', 'kidsShare', pct], ['wCross', 'crossing', pct], ['wGesture', 'gesture', pct],
  ['wCars', 'carDensity', pct], ['wParked', 'carParked', pct], ['wQueue', 'carQueue', plain],
  ['wTreeDen', 'treeDensity', pct], ['wSizeMin', 'treeSizeMin', times], ['wSizeMax', 'treeSizeMax', times],
  ['wBarrierScale', 'barrierScale', times], ['wBenchWear', 'benchWear', wearName], ['wVending', 'vendingDensity', pct], ['wPostboxes', 'postboxDensity', pct], ['wPostboxSize', 'postboxSize', times], ['wPlanters', 'planterDensity', pct], ['wPlanterSize', 'planterSize', times], ['wLamps', 'lampDensity', pct], ['wLampHeight', 'lampHeight', metres], ['wRoadSigns', 'roadSignDensity', pct], ['wMirrors', 'mirrorDensity', pct], ['wBikes', 'bikeDensity', pct], ['wScooters', 'scooterDensity', pct], ['wBirds', 'birdDensity', pct], ['wAds', 'adDensity', pct], ['wRubbish', 'rubbishDensity', pct], ['wPlates', 'plateDensity', pct], ['wCafes', 'cafeDensity', pct], ['wHydrants', 'hydrantDensity', pct], ['wHydrantSize', 'hydrantSize', times], ['wTaxis', 'taxiShare', pct], ['wCafeParasol', 'cafeParasol', pct], ['wCafeSize', 'cafeSize', times], ['wPlateSize', 'plateSize', times], ['wRubbishSize', 'rubbishSize', times], ['wAdSize', 'adSize', times], ['wBirdSize', 'birdSize', times], ['wScooterSize', 'scooterSize', times], ['wAc', 'acDensity', pct], ['wAcSize', 'acSize', times], ['wBalconies', 'balconyDensity', pct], ['wBalconyWidth', 'balconyWidth', metres2], ['wLaundry', 'laundryAmount', pct], ['wRoofClutter', 'roofClutter', pct], ['wTrim', 'trimShare', pct], ['wShutters', 'shutterDensity', pct], ['wShutterClosed', 'shutterClosed', pct], ['wTrimDepth', 'trimDepth', metres2], ['wRoofParapet', 'roofParapet', metres2], ['wLanterns', 'lanternDensity', pct], ['wLanternSize', 'lanternSize', times], ['wNoren', 'norenDensity', pct], ['wAwning', 'awningDensity', pct], ['wAwningDepth', 'awningDepth', metres2], ['wSigns', 'signDensity', pct],
  ['wPoleSpacing', 'poleSpacing', metres], ['wWires', 'wireCount', plain], ['wWireSag', 'wireSag', metres2], ['wWireThick', 'wireThickness', cm], ['wTransformers', 'poleTransformers', pct],
  ['wSkyScreentone', 'skyScreentone', pct], ['wSkyScreentoneReach', 'skyScreentoneReach', pct], ['wCloudCover', 'cloudCover', pct], ['wCloudScale', 'cloudScale', times], ['wCloudSoft', 'cloudSoft', pct], ['wCloudShade', 'cloudShade', pct],
  ['wWinVariety', 'windowVariety', pct], ['wWinCurtains', 'windowCurtains', pct], ['wWinReflect', 'windowReflection', pct], ['wWinFrames', 'windowFrames', pct], ['wWeather', 'wallWeathering', pct], ['wPaveJoints', 'paveJoints', pct], ['wPaveSlab', 'paveSlab', metres2], ['wRoadWear', 'roadWear', pct], ['wWet', 'wetStreets', pct], ['wPuddleSize', 'puddleSize', times], ['wPatches', 'patchDensity', pct], ['wCracks', 'crackDensity', pct], ['wPatchSize', 'patchSize', times], ['wCovers', 'coverDensity', pct], ['wCoverSize', 'coverSize', times],
  ['wLitter', 'litterDensity', pct], ['wLitterSize', 'litterSize', times], ['wFolSat', 'foliageSat', pct], ['wFolHue', 'foliageHue', deg], ['wFolLight', 'foliageLight', pct],
  ['wSkyHaze', 'skyHaze', pct], ['wShadowTintAmt', 'shadowTintAmt', pct], ['wSkyGlow', 'skyGlow', pct],
];
const SELECTS = [
  ['wPalette', 'carPalette'], ['wSide', 'trafficSide'],
  ['wRoofStyle', 'roofStyle'], ['wRoofColor', 'roofColor'], ['wWallTone', 'wallTone'],
  ['wBenchStyle', 'benchStyle'], ['wBenchColor', 'benchColor'], ['wBinStyle', 'binStyle'],
  ['wCloudStyle', 'cloudStyle'], ['wCloudDark', 'cloudDark'], ['wSkyPalette', 'skyPalette'], ['wPoleStyle', 'poleStyle'], ['wEdgeLines', 'edgeLines'], ['wVendingColour', 'vendingColour'], ['wPostStyle', 'postboxStyle'], ['wAwningColour', 'awningColour'], ['wLanternColour', 'lanternColour'], ['wRoofTank', 'roofTank'], ['wTrimTone', 'trimTone'], ['wShutterColour', 'shutterColour'], ['wBalconyStyle', 'balconyStyle'], ['wAcTone', 'acTone'], ['wPlanterStyle', 'planterStyle'], ['wPlanterColour', 'planterColour'], ['wLampStyle', 'lampStyle'], ['wCoverTone', 'coverTone'], ['wSignStyle', 'roadSignStyle'], ['wBikeColour', 'bikeColour'], ['wBikeStyle', 'bikeStyle'], ['wScooterColour', 'scooterColour'], ['wScooterStyle', 'scooterStyle'], ['wBirdKind', 'birdKind'], ['wAdStyle', 'adStyle'], ['wRubbishKind', 'rubbishKind'], ['wLitterColour', 'litterColour'], ['wUmbrellaColour', 'umbrellaColour'], ['wPlateColour', 'plateColour'], ['wCafeColour', 'cafeColour'], ['wHydrantColour', 'hydrantColour'], ['wTaxiColour', 'taxiColour'], ['wBinColour', 'binColour'], ['wPosterColour', 'posterColour'], ['wShadowTint', 'shadowTint'],
];
const CHECKS = [
  ['wCarTrim', 'carTrim'], ['wSurrWindows', 'surroundWindows'], ['wPoles', 'detailPoles'], ['wSignals', 'detailSignals'], ['wRails', 'detailRails'],
  ['wCrosswalks', 'detailCrosswalks'], ['wTactile', 'detailTactile'], ['wLandmarks', 'landmarks'],
  ['wBenches', 'furnBenches'], ['wBins', 'furnBins'], ['wStops', 'furnStops'],
  ['wFences', 'barrierFences'], ['wWalls', 'barrierWalls'], ['wHedges', 'barrierHedges'],
];
const MIX = [['wMixRound', 'round'], ['wMixColumnar', 'columnar'], ['wMixConifer', 'conifer'], ['wMixPalm', 'palm'], ['wMixUmbrella', 'umbrella']];

// species presets (the old "Tree type" list) and size presets (the old "Tree size" list)
const MIX_PRESETS = {
  mixed: { round: 60, columnar: 15, conifer: 25, palm: 0, umbrella: 0 },
  broadleaf: { round: 100, columnar: 0, conifer: 0, palm: 0, umbrella: 0 },
  conifer: { round: 0, columnar: 0, conifer: 100, palm: 0, umbrella: 0 },
  columnar: { round: 0, columnar: 100, conifer: 0, palm: 0, umbrella: 0 },
  palm: { round: 0, columnar: 0, conifer: 0, palm: 100, umbrella: 0 },
  umbrella: { round: 0, columnar: 0, conifer: 0, palm: 0, umbrella: 100 },
  tropical: { round: 30, columnar: 0, conifer: 0, palm: 35, umbrella: 35 },
};
const SIZE_PRESETS = { small: [0.7, 0.75], normal: [0.95, 1.05], large: [1.25, 1.4], varied: [0.6, 1.45] };

const carBoxes = () => [...document.querySelectorAll('#worldPop input[data-car]')];

export function initWorld({ onChange } = {}) {
  let seed = 0;

  function showOut(id, fmt) {
    const out = $(id + 'Out');
    if (out) out.textContent = fmt(Number($(id).value));
  }

  /** Renderer options for the current panel state. */
  function read() {
    const o = {};
    for (const [id, key] of SLIDERS) o[key] = Number($(id).value);
    for (const [id, key] of SELECTS) o[key] = $(id).value;
    for (const [id, key] of CHECKS) o[key] = $(id).checked;
    o.carTypes = carBoxes().filter((b) => b.checked).map((b) => b.dataset.car).join(',');
    // 'auto' (the default) lets the renderer pick the species for the climate
    o.treeMix = $('treeType').value === 'auto' ? 'auto' : MIX.map(([id, kind]) => `${kind}:${Number($(id).value)}`).join(',');
    o.worldSeed = seed;
    return o;
  }

  /** Write option values (by option key) into the panel; unknown keys and bad values are ignored. */
  function write(o) {
    for (const [id, key, fmt] of SLIDERS) {
      if (!(key in o)) continue;
      const el = $(id);
      const v = Number(o[key]);
      if (!Number.isFinite(v)) continue;
      el.value = String(Math.min(Number(el.max), Math.max(Number(el.min), v)));
      showOut(id, fmt);
    }
    for (const [id, key] of SELECTS) {
      if (key in o && [...$(id).options].some((x) => x.value === o[key])) $(id).value = o[key];
    }
    for (const [id, key] of CHECKS) if (key in o) $(id).checked = o[key] === true || o[key] === 'true' || o[key] === '1';
    if ('carTypes' in o) {
      const on = new Set(String(o.carTypes).split(','));
      for (const b of carBoxes()) b.checked = on.has(b.dataset.car);
    }
    if (o.treeMix === 'auto') $('treeType').value = 'auto';
    else if ('treeMix' in o) {
      $('treeType').value = 'custom';
      const w = Object.fromEntries(String(o.treeMix).split(',').map((p) => p.split(':')));
      for (const [id, kind, fmt = plain] of MIX) if (kind in w && Number.isFinite(Number(w[kind]))) { $(id).value = String(Number(w[kind])); showOut(id, fmt); }
    }
    if ('worldSeed' in o && Number.isFinite(Number(o.worldSeed))) seed = Math.max(0, Math.floor(Number(o.worldSeed)));
  }

  const defaults = read();

  /** Compact `key=value;key=value` of the settings that differ from the defaults ('' when none do). */
  function toString() {
    const now = read();
    return Object.keys(now).filter((k) => now[k] !== defaults[k]).map((k) => `${k}=${now[k]}`).join(';');
  }
  function fromString(str) {
    const o = {};
    for (const part of String(str || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) o[part.slice(0, i)] = part.slice(i + 1);
    }
    write({ ...defaults, ...o });
  }
  function reset() {
    write(defaults);
    $('treeType').value = 'auto';
    $('treeSize').value = 'normal';
  }

  const changed = () => onChange?.();

  for (const [id, , fmt] of SLIDERS) {
    $(id).addEventListener('input', () => showOut(id, fmt));
    $(id).addEventListener('change', changed);
  }
  for (const [id, , fmt] of [...MIX.map(([id, kind]) => [id, kind, plain])]) {
    $(id).addEventListener('input', () => showOut(id, fmt));
    // moving a species slider makes the mix custom (even when it was on auto: the sliders then take over)
    $(id).addEventListener('change', () => { if ($('treeType').value === 'auto') $('treeType').value = 'custom'; changed(); });
  }
  for (const [id] of [...SELECTS, ...CHECKS]) $(id).addEventListener('change', changed);
  for (const b of carBoxes()) b.addEventListener('change', changed);

  // the preset lists fill in the sliders below them
  $('treeType').addEventListener('change', () => {
    const p = MIX_PRESETS[$('treeType').value];
    if (p) {
      const keep = $('treeType').value;
      write({ treeMix: Object.entries(p).map(([k, v]) => `${k}:${v}`).join(',') });
      $('treeType').value = keep;
    }
    changed();
  });
  $('treeSize').addEventListener('change', () => {
    const p = SIZE_PRESETS[$('treeSize').value];
    if (!p) return;
    write({ treeSizeMin: p[0], treeSizeMax: p[1] });
    changed();
  });
  // keep the smallest size below the largest
  $('wSizeMin').addEventListener('change', () => {
    if (Number($('wSizeMin').value) > Number($('wSizeMax').value)) { $('wSizeMax').value = $('wSizeMin').value; showOut('wSizeMax', times); }
  }, true);
  $('wSizeMax').addEventListener('change', () => {
    if (Number($('wSizeMax').value) < Number($('wSizeMin').value)) { $('wSizeMin').value = $('wSizeMax').value; showOut('wSizeMin', times); }
  }, true);

  $('wSeedBtn').addEventListener('click', () => { seed++; changed(); });
  $('wResetBtn').addEventListener('click', () => { reset(); seed = 0; changed(); });

  // open / close
  const pop = $('worldPop'), btn = $('worldBtn');
  const setOpen = (open) => { pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', () => setOpen(pop.hidden));

  // wide mode doubles the panel into two columns of sections; the choice is remembered
  const wideBtn = $('worldWideBtn');
  const setWide = (wide) => {
    pop.classList.toggle('wide', wide);
    wideBtn.setAttribute('aria-pressed', String(wide));
    try { localStorage.setItem('panelscape.worldWide', wide ? '1' : '0'); } catch { /* storage may be blocked */ }
  };
  wideBtn.addEventListener('click', () => setWide(!pop.classList.contains('wide')));
  try { if (localStorage.getItem('panelscape.worldWide') === '1') setWide(true); } catch { /* storage may be blocked */ }
  $('worldCloseBtn').addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) setOpen(false); });

  return { read, write, toString, fromString, reset };
}
