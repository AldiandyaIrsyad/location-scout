import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// windowFade (GLSL in render.js) decides how small a window may get before it is dropped. It counts CSS pixels, so a
// hi-res export or a hi-DPI screen shows the same windows as the preview; below about 4 px a window grid only
// produces moire and broken dashes under the line pass, and a far skyline reads better as plain light blocks. The GLSL is run here as JS.
const src = readFileSync(new URL('../web/js/render.js', import.meta.url), 'utf8');
const body = src.match(/float windowFade\(float focalPx, float depth, float distant\) \{([\s\S]*?)\n  \}/)[1];

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a * (1 - t) + b * t;
const windowFade = new Function('smoothstep', 'mix', 'max', 'focalPx', 'depth', 'distant', body.replace(/float px =/g, 'const px =').replace(/float /g, 'let '));
const fade = (px, distant) => windowFade(smoothstep, mix, Math.max, px * 100, 160, distant); // px = focal * 1.6 / depth = px * 100 * 1.6 / 160

test('distant windows go at about 4 CSS px, ordinary ones at about 6', () => {
  assert.equal(fade(3.4, 1), 0);
  assert.equal(fade(5.6, 1), 1);
  assert.equal(fade(4.9, 0), 0, 'ordinary windows are still dropped where distant ones are kept');
  assert.ok(fade(4.9, 1) > 0.5);
  assert.equal(fade(7.5, 0), 1);
  assert.ok(fade(4.4, 1) > 0 && fade(4.4, 1) < 1, 'a ramp, not a pop');
});

test('the fade rises with size, in both modes', () => {
  for (const distant of [0, 1]) {
    let last = -1;
    for (let px = 0; px <= 10; px += 0.25) {
      const f = fade(px, distant);
      assert.ok(f >= last - 1e-12 && f >= 0 && f <= 1, `distant ${distant}, ${px}px: ${f}`);
      last = f;
    }
  }
});

test('the shader is fed CSS pixels: both focal uniforms are divided by the render scale', () => {
  assert.match(src, /_focalU\.value = focal \/ scale;/);
  assert.match(src, /ndMat\.uniforms\.uFocalPx\.value = focal \/ scale;/);
});
