// Traffic signs on poles and curve mirrors at junctions, behind the "Street furniture" section of the World settings
// panel. Pure data and decisions, no rendering (render.js builds the flat shapes and poles from signShapes).

export const SIGN_STYLES = ['auto', 'japan', 'europe'];
// kinds by region; the mix is weighted by repeating the common ones
const KINDS = {
  japan: ['limit', 'limit', 'noentry', 'parking', 'oneway', 'warning', 'stop'],
  europe: ['limit', 'limit', 'noentry', 'parking', 'warning', 'stop', 'priority'],
};
const POLE_COLOUR = '#8a8d92';
export const MIRROR_POLE = '#d8782b';

const inBox = (c, lat0, lat1, lon0, lon1) => !!c && c.lat >= lat0 && c.lat <= lat1 && c.lon >= lon0 && c.lon <= lon1;

/** The sign style to draw: a chosen one, or by place for 'auto' and unknown choices (Japan and Korea read the same). */
export function roadSignStyle(choice, center) {
  if (choice === 'japan' || choice === 'europe') return choice;
  return inBox(center, 24, 46, 122, 146) ? 'japan' : 'europe';
}

/** Metres of street between signs at 100%. */
export function roadSignSpacing(center) {
  return inBox(center, 24, 46, 122, 146) ? 70 : 90;
}

/** Chance that a street sample gets a sign (or mirror): density is a percentage, `every` the sampling interval in metres. */
export function roadSignChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** The kind of sign for `u` (0..1) in a style; unknown styles count as europe. */
export function roadSignKind(style, u) {
  const list = KINDS[style === 'japan' ? 'japan' : 'europe'];
  return list[Math.min(list.length - 1, Math.floor(Math.max(0, u) * list.length))];
}

/** Whether a junction gets a curve mirror: Japan and Korea only, `density` a percentage, `u` 0..1. */
export function hasCurveMirror(density, center, u) {
  return inBox(center, 24, 46, 122, 146) && u * 100 < Math.max(0, Math.min(100, Number(density) || 0));
}

const ngon = (n, rad, rot = 0, cx = 0, cy = 0) => Array.from({ length: n }, (_, i) => {
  const a = rot + (i / n) * Math.PI * 2;
  return [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad];
});

/**
 * The flat shapes of a sign in its own plane (x across, y up, unit radius, centred), painted in order:
 * { pts, col } with `col` a hex string. Layers: a rim, the face and a symbol.
 */
export function signShapes(kind, style = 'europe') {
  const white = '#f4f3ee';
  const red = '#c4302b';
  const blue = '#2f5fa8';
  const yellow = '#f0c030';
  const bar = (w, h, col, cy = 0) => ({ pts: [[-w, cy - h], [w, cy - h], [w, cy + h], [-w, cy + h]], col });
  switch (kind) {
    case 'stop':
      return style === 'japan'
        ? [{ pts: ngon(3, 1.05, -Math.PI / 2), col: red }, { pts: ngon(3, 0.6, -Math.PI / 2), col: white }] // Japan's inverted triangle
        : [{ pts: ngon(8, 1, Math.PI / 8), col: white }, { pts: ngon(8, 0.9, Math.PI / 8), col: red }, bar(0.6, 0.1, white)];
    case 'noentry':
      return [{ pts: ngon(16, 1, 0), col: red }, bar(0.62, 0.15, white)];
    case 'parking':
      return [{ pts: ngon(4, 1.15, Math.PI / 4), col: white }, { pts: ngon(4, 1.05, Math.PI / 4), col: blue }, bar(0.18, 0.55, white, 0), bar(0.38, 0.13, white, 0.35)];
    case 'oneway':
      return [{ pts: ngon(4, 1.15, Math.PI / 4), col: blue }, { pts: [[-0.7, -0.14], [0.2, -0.14], [0.2, -0.42], [0.8, 0], [0.2, 0.42], [0.2, 0.14], [-0.7, 0.14]], col: white }];
    case 'warning':
      return [{ pts: ngon(3, 1.15, Math.PI / 2), col: red }, { pts: ngon(3, 0.8, Math.PI / 2), col: yellow }, bar(0.07, 0.3, '#2a2b2e', -0.02)];
    case 'priority':
      return [{ pts: ngon(4, 1.15, 0), col: white }, { pts: ngon(4, 0.95, 0), col: yellow }];
    default: // limit
      return [{ pts: ngon(16, 1, 0), col: red }, { pts: ngon(16, 0.78, 0), col: white }, bar(0.4, 0.1, '#2a2b2e', 0.12), bar(0.25, 0.1, '#2a2b2e', -0.18)];
  }
}

export const SIGN_KINDS = ['limit', 'noentry', 'parking', 'oneway', 'warning', 'stop', 'priority'];
export { POLE_COLOUR };
