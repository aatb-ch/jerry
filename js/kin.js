// ultraArm P340 kinematics (approximate geometry, mm / deg). Robot frame: Z up, X forward.
// Parallel-linkage arm: J2 = upper arm tilt from vertical, J3 = forearm tilt below horizontal, tool stays level.
// TCP: r = A0 + L1*sin(j2) + L2*cos(j3) + E ;  z = SH + L1*cos(j2) - L2*sin(j3) - D
// Tuned so max reach = 365.55 and z range ≈ [-140, 130] like the official coord limits.
export const K = {
  L1: 140, L2: 140,   // upper arm, forearm
  A0: 20,             // shoulder offset from J1 axis
  E: 65.55, D: 70,    // tool bracket: forward, down
  SH: 60,             // shoulder height above robot origin
  TABLE: -150,        // table z (visual only)
  // joint limits from the P340 manual: J1 -150..170, J2 -20..90, J3 -5..75 (pymycobot's docstring says J3 110).
  // J1 is mirrored at the wire (serial.js), so in the sim's frame it is -170..150.
  lim: [[-170, 150], [-20, 90], [-5, 75]],
  // elbow fold: the max J3 depends on J2 (measured on the arm: J3 stops at 51° with J2 = 0), so J3 − J2 ≤ 51
  fold: 51,
  // Cartesian limits the firmware checks (pymycobot set_coords): x, y, z in mm, robot frame
  box: [[-360, 365.55], [-365.55, 365.55], [-140, 130]],
};

const R = Math.PI / 180;

const within = (v, l) => v.every((x, i) => x >= l[i][0] - 1e-6 && x <= l[i][1] + 1e-6);
export const inLimits = j => within(j, K.lim) && j[2] - j[1] <= K.fold + 1e-6 && within(flange(j), K.box);

// Tool: TCP offset from the flange, in the flange frame (x forward, y left, z up; it turns with J1, stays level).
// [0, 0, 0] = TCP at the flange. The arm itself only knows flange coordinates (what M114 / G0 use).
export const tool = [0, 0, 0];
export const setTool = t => tool.splice(0, 3, ...t);

// flange position (robot frame) for joints
export function flange([j1, j2, j3]) {
  const r = K.A0 + K.L1 * Math.sin(j2 * R) + K.L2 * Math.cos(j3 * R) + K.E;
  const z = K.SH + K.L1 * Math.cos(j2 * R) - K.L2 * Math.sin(j3 * R) - K.D;
  return [r * Math.cos(j1 * R), r * Math.sin(j1 * R), z];
}

// flange point + tool offset → TCP
export function addTool([x, y, z], j1) {
  const c = Math.cos(j1 * R), s = Math.sin(j1 * R);
  return [x + tool[0] * c - tool[1] * s, y + tool[0] * s + tool[1] * c, z + tool[2]];
}

// TCP position (robot frame) for joints
export const fk = j => addTool(flange(j), j[0]);

// TCP position → [j1,j2,j3], or null if unreachable / out of limits
export const ik = p => { const j = solve(p); return j && inLimits(j) ? j : null; };

// why a TCP position is refused, e.g. "J3 77.3° (limit −5…75°)"; '' if it is fine
export function whyNot(p) {
  const j = solve(p);
  if (!j) return 'out of reach';
  const f = flange(j), deg = v => v.toFixed(1);
  for (let i = 0; i < 3; i++) if (j[i] < K.lim[i][0] - 1e-6 || j[i] > K.lim[i][1] + 1e-6) return `J${i + 1} ${deg(j[i])}° (limit ${K.lim[i][0]}…${K.lim[i][1]}°)`;
  if (j[2] - j[1] > K.fold + 1e-6) return `elbow folded too far: J3 ${deg(j[2])}° with J2 ${deg(j[1])}° (J3 may be at most J2 + ${K.fold}°)`;
  for (let i = 0; i < 3; i++) if (f[i] < K.box[i][0] - 1e-6 || f[i] > K.box[i][1] + 1e-6) return `${'XYZ'[i]} ${deg(f[i])} mm (limit ${K.box[i][0]}…${K.box[i][1]})`;
  return '';
}

// inverse kinematics without limit checks (null only if geometrically unreachable)
function solve([x, y, z]) {
  const rt2 = x * x + y * y - tool[1] ** 2;  // TCP distance from the J1 axis, along the flange's forward direction
  if (rt2 < 0) return null;
  const rt = Math.sqrt(rt2);
  const j1 = (Math.atan2(y, x) - Math.atan2(tool[1], rt)) / R;
  const r = rt - tool[0] - K.A0 - K.E, h = z - tool[2] - K.SH + K.D;
  const d = Math.hypot(r, h);
  const c = (K.L1 ** 2 + d * d - K.L2 ** 2) / (2 * K.L1 * d);
  if (!(Math.abs(c) <= 1)) return null;
  const a = Math.atan2(h, r) + Math.acos(c);                       // upper arm angle from horizontal (elbow up)
  const b = Math.atan2(h - K.L1 * Math.sin(a), r - K.L1 * Math.cos(a)); // forearm angle from horizontal
  return [j1, 90 - a / R, -b / R];
}
