// Pigeons and crows pecking about on the pavement, behind the "Street furniture" section of the World settings panel.
// Pure data and decisions, no rendering (render.js builds the boxes from birdParts).

export const BIRD_COLOURS = { pigeon: '#8f96a0', crow: '#1c1d21' };
export const BIRD_KINDS = ['auto', 'pigeon', 'crow'];

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** Metres of street between flocks at 100%: city squares and old towns in Europe have the most, then Japan, then the rest. */
export function birdSpacing(center) {
  if (inBox(center, 35, 60, -12, 30)) return 34;
  if (inBox(center, 24, 46, 122, 146)) return 44;
  return 60;
}

/** Chance that a street sample gets a flock: density is a percentage, `every` the sampling interval in metres. */
export function birdChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** The bird for a choice: 'pigeon' or 'crow' as chosen; 'auto' (and anything unknown) gives crows 45% of the time in Japan and pigeons otherwise, by `u` (0..1). */
export function birdKind(choice, center, u) {
  if (choice === 'pigeon' || choice === 'crow') return choice;
  return inBox(center, 24, 46, 122, 146) && u < 0.45 ? 'crow' : 'pigeon';
}

/** How many birds in a flock: 1 to 2 crows, 2 to 7 pigeons, from `u`. */
export function flockSize(kind, u) {
  const t = Math.max(0, Math.min(0.999, Number(u) || 0));
  return kind === 'crow' ? 1 + Math.floor(t * 2) : 2 + Math.floor(t * 6);
}

/**
 * One bird in its own frame: u along it (head at +u), v across, h up from the ground. `size` scales it (0.6..2.5);
 * `peck` lowers the head to the ground. Returns `boxes` ({ u0, u1, v0, v1, h0, h1, role }, roles body, wing, head, beak,
 * leg and tail); a crow is bigger and all black, a pigeon has a pale head and a dark wing bar.
 */
export function birdParts(kind, size = 1, peck = false) {
  const k = Math.max(0.6, Math.min(2.5, Number(size) || 1)) * (kind === 'crow' ? 1.5 : 1);
  const box = (u0, u1, v0, v1, h0, h1, role) => ({ u0: u0 * k, u1: u1 * k, v0: v0 * k, v1: v1 * k, h0: h0 * k, h1: h1 * k, role });
  const lean = peck ? 0.08 : 0; // the head drops, the body tips forward a little
  return [
    box(-0.1, 0.12, -0.065, 0.065, 0.1 - lean * 0.2, 0.22 - lean * 0.2, 'body'),
    box(-0.08, 0.08, -0.075, 0.075, 0.13 - lean * 0.2, 0.2 - lean * 0.2, 'wing'),
    box(0.1, 0.17, -0.03, 0.03, 0.2 - lean * 2, 0.27 - lean * 2.4, 'head'),
    box(0.17, 0.2, -0.012, 0.012, 0.225 - lean * 2.3, 0.245 - lean * 2.3, 'beak'),
    box(-0.22, -0.09, -0.04, 0.04, 0.12, 0.15, 'tail'),
    box(-0.015, 0.015, -0.035, -0.02, 0, 0.1, 'leg'),
    box(-0.015, 0.015, 0.02, 0.035, 0, 0.1, 'leg'),
  ];
}
