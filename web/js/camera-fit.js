// Perspective framing without depending on three.js. World Y is up.
// yaw/pitch follow CameraRig: yaw 0 looks north (-Z), negative pitch looks down.
export function viewDepthRange(distance = 0, radius = 0, detailDistance = 1) {
  const base = 1200 * Math.max(0.25, Math.min(3, detailDistance));
  const back = Math.max(0, distance) + Math.max(0, radius);
  const fogNear = Math.max(base * 0.55, back + 10);
  const far = Math.max(base, (fogNear + Math.max(100, radius * 0.5)) / 0.95);
  // An overview needs depth precision for centimetre-separated map layers.
  // Keep the close plane usable at street level and move it out only beyond the near scene.
  const near = Math.max(0.5, Math.min(20, (Math.max(0,distance)-Math.max(0,radius))*0.02));
  return { near, far, fogNear, fogFar: far * 0.95 };
}

export function fitBounds(bounds, { fov, aspect, yaw = 0.55, pitch = -0.62, margin = 1.12 }) {
  const center = bounds.min.map((v, i) => (v + bounds.max[i]) / 2);
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const right = [cy, 0, sy];
  const up = [-sy * sp, cp, cy * sp];
  const forward = [sy * cp, sp, -cy * cp];
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * Math.max(0.1, aspect);
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  let distance = 1;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const d = [x - center[0], y - center[1], z - center[2]];
        const depth = dot(d, forward);
        distance = Math.max(distance, margin * Math.abs(dot(d, right)) / tanH - depth,
          margin * Math.abs(dot(d, up)) / tanV - depth, 1 - depth);
      }
    }
  }
  return { target: center, distance, yaw, pitch };
}
