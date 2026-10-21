// Utility poles and the overhead wires between them, behind the "Street details" section of the World
// settings panel. Pure data and decisions, no rendering (render.js builds the geometry from these).

export const POLE_STYLES = ['auto', 'wood', 'concrete', 'steel'];
export const POLE_LOOK = {
  wood: { colour: '#6b5a48', width: 0.26, arm: '#5a4a3c' },
  concrete: { colour: '#aaa8a1', width: 0.3, arm: '#8e8c86' },
  steel: { colour: '#7a8087', width: 0.2, arm: '#666c73' },
};
export const POLE_HEIGHT = 8.5; // metres from the ground to the pole top
export const WIRE_COLOUR = '#2b2b30';
export const INSULATOR_COLOUR = '#d9d8cf';
export const TRANSFORMER_COLOUR = '#767c82';

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/**
 * The pole style to build: the chosen one, or by place for 'auto' and anything unknown.
 * Japan, Korea and Indonesia use concrete poles; elsewhere they are wood.
 */
export function poleStyleFor(choice, center) {
  if (own(POLE_LOOK, choice)) return choice;
  const concrete = inBox(center, 24, 46, 122, 146) || inBox(center, 33, 39, 124, 132) || inBox(center, -11, 6, 95, 141);
  return concrete ? 'concrete' : 'wood';
}

/**
 * Where the wires hang on a pole, one entry per wire, for 0..6 wires. `across` is the distance along the
 * cross-arm (metres, negative = towards the street) and `down` the distance below the pole top.
 * The first three sit on the cross-arm (power), the rest lower on the pole (telephone and cable).
 */
export function wireSlots(count) {
  const slots = [
    { across: -0.8, down: 0.35 }, { across: 0, down: 0.35 }, { across: 0.8, down: 0.35 },
    { across: -0.45, down: 1.25 }, { across: 0.45, down: 1.25 }, { across: 0, down: 1.7 },
  ];
  const n = Math.max(0, Math.min(slots.length, Math.floor(Number(count)) || 0));
  return slots.slice(0, n);
}

/**
 * Points of a sagging wire from a to b ([x, height, z]); the middle drops by `sag` metres on a parabola.
 * `segs` is the number of straight pieces (at least 2).
 */
export function catenary(a, b, sag, segs) {
  const n = Math.max(2, Math.floor(segs) || 2);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t]);
  }
  return out;
}

/** Index pairs of poles that a wire runs between: neighbours closer than `maxGap` metres (a pole may be missing). */
export function wireSpans(poles, maxGap) {
  const spans = [];
  for (let i = 0; i + 1 < poles.length; i++) {
    if (Math.hypot(poles[i + 1].x - poles[i].x, poles[i + 1].y - poles[i].y) <= maxGap) spans.push([i, i + 1]);
  }
  return spans;
}

/** Whether pole number `i` carries a transformer; `share` is a percentage and `u` a 0..1 random value for the pole. */
export function hasTransformer(share, u) {
  return u * 100 < Math.max(0, Math.min(100, Number(share) || 0));
}

/** Sag of a span of `length` metres: the setting is the sag of a 30 m span, longer spans sag more. */
export function spanSag(setting, length) {
  const k = length / 30;
  return Math.max(0, Number(setting) || 0) * k * k;
}
