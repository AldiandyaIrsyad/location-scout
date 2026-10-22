// Window shutters on street walls, behind the "Buildings" section of the World settings panel. Pure data and
// decisions, no rendering (render.js builds the panels and slats from shutterParts). Open shutters stand flat against the
// wall either side of a window; closed ones cover it. They sit on the same window grid as the shader's windows (a column
// is 3 m wide with the window 0.7 to 2.3 m across it, a row is 3.2 m tall with the window 0.8 to 2.5 m up it).

export const SHUTTER_COLOURS = {
  grey: '#7d8c93',
  cream: '#e6e1d2',
  green: '#4f7a5c',
  blue: '#46689a',
  brown: '#7a5638',
  white: '#f1efe8',
};
export const SHUTTER_CHOICES = ['auto', ...Object.keys(SHUTTER_COLOURS)];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between shutter runs at 100%: France and the Mediterranean most, nothing much in East Asia. */
export function shutterSpacing(center) {
  if (inBox(center, 41, 51.1, -5.5, 9.8)) return 14;
  if (inBox(center, 35, 45, -10, 30)) return 18;
  if (inBox(center, 24, 46, 122, 146) || inBox(center, 33, 39, 124, 132)) return 400;
  return 60;
}

/** Chance that a street sample gets a run of shutters: density is a percentage, `every` the sampling interval in metres. */
export function shutterChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/**
 * Shutter colour: a chosen one, or by place for 'auto' and unknown choices (grey-blue, cream or green in France, green or
 * brown round the Mediterranean, white or brown elsewhere), by `u` (0..1).
 */
export function shutterColour(choice, center, u) {
  const fixed = own(SHUTTER_COLOURS, choice);
  if (fixed) return fixed;
  const set = inBox(center, 41, 51.1, -5.5, 9.8) ? ['grey', 'grey', 'cream', 'green']
    : inBox(center, 35, 45, -10, 30) ? ['green', 'green', 'brown', 'blue']
      : ['white', 'brown', 'grey'];
  return SHUTTER_COLOURS[set[Math.min(set.length - 1, Math.floor(Math.max(0, Number(u) || 0) * set.length))]];
}

/** How many neighbouring windows a run covers, 1 to 5, from `u`. */
export function shutterRun(u) {
  return 1 + Math.min(4, Math.floor(Math.max(0, Number(u) || 0) * 5));
}

/** Whether a window's shutters are closed: `closed` is a percentage, `u` a 0..1 draw. */
export function isClosed(closed, u) {
  return (Number(u) || 0) < Math.max(0, Math.min(100, Number(closed) || 0)) / 100;
}

/**
 * World heights of the window-row bases (multiples of 3.2) on a wall whose ground is `ground` and whose building is
 * `height` tall, for every row whose window lies fully above the ground and below the roof, each kept with chance `share`.
 */
export function shutterRows(ground, height, rand, share = 0.8) {
  const out = [];
  for (let m = Math.ceil((ground - 0.5) / 3.2) || 0; m * 3.2 + 2.5 <= ground + height - 0.4; m++) if (rand() < share) out.push(m * 3.2);
  return out;
}

/**
 * The shutters of one window in its own frame: u across the wall from the window's centre, v out from the wall, h up
 * from the row base. Returns boxes ({ u0, u1, v0, v1, h0, h1, role }, roles panel and slat): two panels, either beside
 * the window (open) or one over each half of it (closed), each with horizontal slats on its face. `fit` is the glass
 * they go with ({ half, y0, y1 }: half-width and sill / head heights; the classic window by default).
 */
export function shutterParts(closed, fit = { half: 0.8, y0: 0.8, y1: 2.5 }) {
  const { half, y0, y1 } = fit;
  const boxes = [];
  for (const side of [-1, 1]) {
    const a = closed ? 0.02 : half + 0.02;
    const b = closed ? half : Math.min(half + 0.42, 1.4);
    const u0 = side > 0 ? a : -b;
    const u1 = side > 0 ? b : -a;
    const v0 = closed ? 0.03 : 0;
    boxes.push({ u0, u1, v0, v1: v0 + 0.05, h0: y0, h1: y1, role: 'panel' });
    for (let k = 0; y0 + 0.15 + k * 0.27 + 0.05 <= y1 - 0.1 + 1e-9; k++) {
      const h = y0 + 0.15 + k * 0.27;
      boxes.push({ u0: u0 + 0.03, u1: u1 - 0.03, v0: v0 + 0.05, v1: v0 + 0.075, h0: h, h1: h + 0.05, role: 'slat' });
    }
  }
  return boxes;
}
