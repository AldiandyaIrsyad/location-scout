// Street lamps along the roads, behind the "Street furniture" section of the World settings panel.
// Pure data and decisions, no rendering (render.js builds the tubes and boxes from lampParts).

export const LAMP_STYLES = ['auto', 'cobra', 'classic', 'modern'];
export const LAMP_POLE = { cobra: '#6f757c', classic: '#2f3a35', modern: '#8b9096' };
export const LAMP_GLASS = '#f1e7b8';

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** The style to draw: a chosen one, or by place for 'auto' and anything unknown (Paris and old Europe: classic cast iron). */
export function lampStyleFor(choice, center) {
  if (choice === 'cobra' || choice === 'classic' || choice === 'modern') return choice;
  if (inBox(center, 35, 60, -12, 30)) return 'classic';
  if (inBox(center, 24, 46, 122, 146) || inBox(center, 33, 39, 124, 132)) return 'cobra';
  return 'modern';
}

/** Metres between lamps along one side of a street at 100%; classic lamps stand closer together. */
export function lampSpacing(style) {
  return style === 'classic' ? 22 : style === 'modern' ? 36 : 30;
}

/** Chance that a street sample gets a lamp: density is a percentage, `every` the sampling interval in metres. */
export function lampChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Lamp height in metres: the "Lamp height" slider (4..12 m) as asked, clamped; classic lamps are a little shorter. */
export function lampHeight(style, height) {
  const h = Math.max(4, Math.min(12, Number(height) || 7));
  return style === 'classic' ? Math.min(h, 4.6) : h;
}

/**
 * One lamp in its own frame: u points from the pole towards the street, h is up, v across. `top` is the pole height.
 * Returns the pole and arm `tubes` ({ a: [u, h, v], b, r, role }), the `boxes` ({ u0, u1, v0, v1, h0, h1, role })
 * and the `bulb` position [u, h] (where the night glow sits). Roles: pole, head, glass.
 */
export function lampParts(style, top) {
  const tubes = [];
  const boxes = [];
  const t = (a, b, r, role = 'pole') => tubes.push({ a, b, r, role });
  if (style === 'classic') {
    // cast-iron lamp post: plinth, fluted shaft, a collar, and a glass lantern under a cap
    const post = top - 0.9;
    boxes.push({ u0: -0.2, u1: 0.2, v0: -0.2, v1: 0.2, h0: 0, h1: 0.7, role: 'pole' });
    t([0, 0.7, 0], [0, post, 0], 0.07);
    boxes.push({ u0: -0.12, u1: 0.12, v0: -0.12, v1: 0.12, h0: post - 0.1, h1: post, role: 'pole' });
    boxes.push({ u0: -0.17, u1: 0.17, v0: -0.17, v1: 0.17, h0: post, h1: post + 0.6, role: 'glass' });
    boxes.push({ u0: -0.23, u1: 0.23, v0: -0.23, v1: 0.23, h0: post + 0.6, h1: post + 0.7, role: 'head' });
    t([0, post + 0.7, 0], [0, post + 0.95, 0], 0.03, 'head');
    return { tubes, boxes, bulb: [0, post + 0.3] };
  }
  if (style === 'modern') {
    // slender pole, a straight arm reaching over the road, a flat luminaire
    t([0, 0, 0], [0, top, 0], 0.06);
    t([0, top, 0], [1.9, top + 0.15, 0], 0.04);
    boxes.push({ u0: 1.4, u1: 2.3, v0: -0.14, v1: 0.14, h0: top + 0.02, h1: top + 0.2, role: 'head' });
    boxes.push({ u0: 1.45, u1: 2.25, v0: -0.11, v1: 0.11, h0: top - 0.01, h1: top + 0.02, role: 'glass' });
    return { tubes, boxes, bulb: [1.85, top] };
  }
  // cobra head: pole bending over the road in three steps, a long lamp head at the end
  t([0, 0, 0], [0, top, 0], 0.075);
  t([0, top, 0], [0.5, top + 0.35, 0], 0.05);
  t([0.5, top + 0.35, 0], [1.3, top + 0.5, 0], 0.045);
  boxes.push({ u0: 1.0, u1: 1.85, v0: -0.16, v1: 0.16, h0: top + 0.3, h1: top + 0.5, role: 'head' });
  boxes.push({ u0: 1.05, u1: 1.8, v0: -0.12, v1: 0.12, h0: top + 0.27, h1: top + 0.3, role: 'glass' });
  return { tubes, boxes, bulb: [1.45, top + 0.27] };
}
