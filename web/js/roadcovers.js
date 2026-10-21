// Manhole covers, kerb drain grates and utility plates on the road and pavement, behind the "Ground" section of the
// World settings panel. Pure data and decisions, no rendering (render.js lays the flat shapes from coverShapes).

export const COVER_TONES = { dark: '#3c3f44', iron: '#55514c', rust: '#6b4a38', light: '#7b7f85' };
export const COVER_CHOICES = ['mixed', ...Object.keys(COVER_TONES)];

// a choice comes from the URL, so 'toString' must not find an inherited property
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

/** Metres of street between covers at 100%: a manhole every few lane lengths, drains and plates a little more often. */
export const COVER_SPACING = { manhole: 38, drain: 22, plate: 30 };

/** Chance that a street sample gets one: density is a percentage, `every` the sampling interval in metres. */
export function coverChance(density, spacing, every) {
  const d = Math.max(0, Math.min(100, Number(density) || 0)) / 100;
  return Math.min(1, (d * every) / spacing);
}

/** Tone for a choice ('mixed' picks from `u`, 0..1); unknown choices count as mixed. */
export function coverTone(choice, u) {
  const fixed = own(COVER_TONES, choice);
  if (fixed) return fixed;
  const all = Object.values(COVER_TONES);
  return all[Math.min(all.length - 1, Math.floor(Math.max(0, u) * all.length))];
}

/**
 * Sideways offset of a manhole from the road centre line: inside the lane area, clear of the kerb by `clear`
 * metres. `u` is 0..1; a road too narrow for the margin gives 0 (the centre line).
 */
export function manholeOffset(u, roadWidth, clear = 1.4) {
  const span = roadWidth / 2 - clear;
  if (!(span > 0)) return 0;
  return (Math.max(0, Math.min(1, u)) * 2 - 1) * span;
}

const ngon = (n, rad, rot = 0) => Array.from({ length: n }, (_, i) => [Math.cos(rot + (i / n) * Math.PI * 2) * rad, Math.sin(rot + (i / n) * Math.PI * 2) * rad]);
const rect = (w, h, cx = 0, cy = 0) => [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];

/**
 * Flat shapes of a cover in its own plane (x across, y along, metres), painted in order as { pts, shade }, where
 * `shade` is a multiplier of the cover tone (1 = the tone itself, below 1 darker, above 1 lighter).
 * Kinds: manhole (round lid, a ring and a cross of ribs), drain (grating with slots), plate (square utility plate).
 */
export function coverShapes(kind, size = 1) {
  const k = Math.max(0.5, Math.min(2, Number(size) || 1));
  const scale = (pts) => pts.map(([x, y]) => [x * k, y * k]);
  switch (kind) {
    case 'drain': {
      const shapes = [{ pts: scale(rect(0.5, 0.9)), shade: 1 }];
      for (let i = 0; i < 5; i++) shapes.push({ pts: scale(rect(0.4, 0.05, 0, -0.34 + i * 0.17)), shade: 0.45 });
      return shapes;
    }
    case 'plate':
      return [{ pts: scale(rect(0.55, 0.55)), shade: 1 }, { pts: scale(rect(0.45, 0.45)), shade: 1.25 }, { pts: scale(rect(0.06, 0.3)), shade: 0.7 }];
    default: // manhole
      return [
        { pts: scale(ngon(16, 0.36)), shade: 0.8 },
        { pts: scale(ngon(16, 0.3)), shade: 1.15 },
        { pts: scale(rect(0.5, 0.05)), shade: 0.8 },
        { pts: scale(rect(0.05, 0.5)), shade: 0.8 },
      ];
  }
}
