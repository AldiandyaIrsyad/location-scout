// Camera rig + mouse/keyboard/touch controls.
// The rig is an orbit around `target` at `distance`, with yaw (0 = north / -Z, + = toward east)
// and pitch (+ = looking up). "Stand & look around" rotates around the eye instead of the target.
import * as THREE from 'three';

const HINTS = {
  standard: 'Left drag: look around · Ctrl+drag: orbit · Right drag: pan · Wheel: zoom · Click: drop a pin · WASD: move (Shift: faster)',
  middle: 'Middle drag: look around · Shift+middle: pan · Wheel: zoom · Click: drop a pin',
  alt: 'Alt+left: look around · Alt+middle: pan · Alt+right: zoom · Click: drop a pin',
  pen: 'Drag: look around · Ctrl+drag: pan · Shift+drag: zoom · Tap: drop a pin',
  look: 'Drag: look around · Wheel / W S: walk · A D: sidestep · Click: drop a pin',
  trackpad: 'Two-finger drag: pan · Pinch: zoom · Drag: look around · Ctrl+drag: orbit · Click: drop a pin',
};

export class CameraRig {
  constructor(dom, { onChange, onClick, onKeyF }) {
    this.dom = dom;
    this.onChange = onChange;
    this.onClick = onClick;
    this.onKeyF = onKeyF;
    this.mode = 'standard';
    this.target = new THREE.Vector3();
    this.distance = 400;
    this.yaw = 0.6;
    this.pitch = -0.6;
    this.minEye = 0.3; // keep the eye above this height (relative to y=0 fallback)
    this.groundAt = () => 0; // (x, z) -> ground height, set by main
    this._drag = null;
    this._pointers = new Map();
    this._keys = new Set();
    this._shift = false;
    this.speedScale = 1; // multiplier on the walking speed (slider)
    this.stick = { x: 0, y: 0, up: 0 }; // on-screen joystick: x = right, y = forward, up = rise (-1..1)
    this._bind();
  }

  /** Touch joystick input, each axis -1..1 (forward and rise are positive). */
  setStick(x, y, up = 0) {
    this.stick.x = x;
    this.stick.y = y;
    this.stick.up = up;
  }

  get hint() { return HINTS[this.mode]; }

  forward() {
    const cp = Math.cos(this.pitch);
    return new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  eye() {
    return this.target.clone().addScaledVector(this.forward(), -this.distance);
  }

  /** Place the eye at `position` looking along yaw/pitch; target is `distance` ahead. */
  setPose({ position, yaw, pitch, distance }) {
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 1e-3, Math.PI / 2 - 0.02);
    if (distance) this.distance = distance;
    this.target.copy(position).addScaledVector(this.forward(), this.distance);
    this._changed();
  }

  /** Orbit framing: look at `target` from `distance` along yaw/pitch. */
  setOrbit({ target, distance, yaw, pitch }) {
    this.target.copy(target);
    this.distance = distance;
    if (yaw !== undefined) this.yaw = yaw;
    if (pitch !== undefined) this.pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 1e-3, Math.PI / 2 - 0.02);
    this._changed();
  }

  getPose() {
    return { position: this.eye(), yaw: this.yaw, pitch: this.pitch, target: this.target.clone(), distance: this.distance };
  }

  setMode(mode) {
    this.mode = mode;
    this._changed();
  }

  _changed() {
    // Keep the eye above the ground.
    const e = this.eye();
    const g = this.groundAt(e.x, e.z) + this.minEye;
    if (e.y < g) this.target.y += g - e.y;
    this.onChange?.(this.getPose());
  }

  // --- operations -------------------------------------------------------
  /** Rotate the view. By default the eye stays put and the view turns; `aroundTarget` orbits the target instead. */
  orbit(dx, dy, aroundTarget = false) {
    const k = 0.005;
    if (!aroundTarget) {
      // rotate around the eye
      const eye = this.eye();
      this.yaw += dx * k * 0.6;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * k * 0.6, -Math.PI / 2 + 1e-3, Math.PI / 2 - 0.02);
      this.target.copy(eye).addScaledVector(this.forward(), this.distance);
    } else {
      this.yaw += dx * k;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * k, -Math.PI / 2 + 1e-3, Math.PI / 2 - 0.02);
    }
    this._changed();
  }

  pan(dx, dy) {
    const s = this.distance * 0.0018;
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const fwdFlat = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    // Looking mostly down: vertical drag moves along the ground; otherwise it moves up/down.
    if (this.pitch < -0.35) {
      this.target.addScaledVector(right, -dx * s).addScaledVector(fwdFlat, dy * s);
    } else {
      this.target.addScaledVector(right, -dx * s);
      this.target.y += dy * s;
    }
    this._changed();
  }

  zoom(delta) {
    if (this.mode === 'look') {
      this.walk(-delta * 0.05, 0);
      return;
    }
    this.distance = THREE.MathUtils.clamp(this.distance * Math.exp(delta * 0.0012), 2, 30000);
    this._changed();
  }

  /** `alongView` moves forward/back along the look direction (pitch included) instead of the ground plane. */
  walk(forwardM, rightM, upM = 0, alongView = false) {
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    const fwd = alongView ? this.forward() : new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(fwd, forwardM).addScaledVector(right, rightM);
    this.target.y += upM;
    this._changed();
  }

  // --- input binding ------------------------------------------------------
  _bind() {
    const dom = this.dom;
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    window.addEventListener('pointercancel', (e) => this._up(e));
    dom.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this._keydown(e));
    window.addEventListener('keyup', (e) => { this._keys.delete(e.code); this._shift = e.shiftKey; });
    window.addEventListener('blur', () => { this._keys.clear(); this._shift = false; });
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      this._keyMove(dt);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _actionFor(e) {
    const b = e.button; // 0 left, 1 middle, 2 right
    if (e.pointerType === 'touch') return 'orbit';
    switch (this.mode) {
      case 'standard':
      case 'look':
        if (b === 0) return e.shiftKey ? 'pan' : e.ctrlKey ? 'orbitTarget' : 'orbit';
        return 'pan';
      case 'middle':
        if (b === 1) return e.shiftKey ? 'pan' : 'orbit';
        if (b === 2) return 'pan';
        return 'click';
      case 'alt':
        if (!e.altKey) return 'click';
        return b === 0 ? 'orbit' : b === 1 ? 'pan' : 'zoom';
      case 'pen':
        if (e.ctrlKey || b === 2) return 'pan';
        if (e.shiftKey) return 'zoom';
        return 'orbit';
      case 'trackpad':
        return b === 0 ? (e.shiftKey ? 'pan' : e.ctrlKey ? 'orbitTarget' : 'orbit') : 'pan';
    }
    return 'orbit';
  }

  _down(e) {
    this.dom.focus?.();
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this._pointers.size === 2) {
      // start pinch
      const [a, b] = [...this._pointers.values()];
      this._drag = { action: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, moved: true };
      return;
    }
    this._drag = { action: this._actionFor(e), x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, id: e.pointerId };
    try { this.dom.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  }

  _move(e) {
    if (!this._pointers.has(e.pointerId) || !this._drag) return;
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = this._drag;
    if (d.action === 'pinch') {
      if (this._pointers.size < 2) return;
      const [a, b] = [...this._pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      this.zoom(-(dist - d.dist) * 3);
      this.pan(cx - d.cx, cy - d.cy);
      Object.assign(d, { dist, cx, cy });
      return;
    }
    if (e.pointerId !== d.id) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
    if (!d.moved) return;
    if (d.action === 'orbit') this.orbit(dx, dy);
    else if (d.action === 'orbitTarget') this.orbit(dx, dy, true);
    else if (d.action === 'pan') this.pan(dx, dy);
    else if (d.action === 'zoom') this.zoom(dy * 4);
  }

  _up(e) {
    if (!this._pointers.has(e.pointerId)) return;
    this._pointers.delete(e.pointerId);
    const d = this._drag;
    if (d && d.id === e.pointerId && !d.moved && e.type === 'pointerup') {
      const r = this.dom.getBoundingClientRect();
      this.onClick?.((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    }
    if (this._pointers.size === 0) this._drag = null;
  }

  _wheel(e) {
    e.preventDefault();
    const scale = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
    const dx = e.deltaX * scale, dy = e.deltaY * scale;
    if (this.mode === 'trackpad' && !e.ctrlKey) {
      this.pan(-dx, -dy);
    } else if (e.ctrlKey) {
      this.zoom(dy * 4); // pinch gesture
    } else {
      this.zoom(dy);
    }
  }

  _keydown(e) {
    this._shift = e.shiftKey; // held-key speed boost; Shift itself is never in `_keys`
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'KeyF') { this.onKeyF?.(); return; }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      if (e.target === document.body || e.target === this.dom || this.dom.contains(e.target)) {
        this._keys.add(e.code);
        e.preventDefault();
      }
    }
  }

  _keyMove(dt) {
    const s = this.stick;
    if (!this._keys.size && !s.x && !s.y && !s.up) return;
    const eyeH = Math.max(2, this.eye().y - this.groundAt(this.eye().x, this.eye().z));
    const speed = THREE.MathUtils.clamp(eyeH * 1.2, 4, 300) * dt * (this._shift ? 3 : 1) * this.speedScale;
    const k = this._keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) + s.y;
    const r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0) + s.x;
    const u = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0) + s.up;
    if (f || r || u) this.walk(f * speed, r * speed, u * speed, true);
  }
}
