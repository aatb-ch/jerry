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
  // Cartesian limits the firmware checks (pymycobot set_coords): x, y, z in mm, robot frame
  box: [[-360, 365.55], [-365.55, 365.55], [-140, 130]],
};

const R = Math.PI / 180;

const within = (v, l) => v.every((x, i) => x >= l[i][0] - 1e-6 && x <= l[i][1] + 1e-6);
export const inLimits = j => within(j, K.lim) && within(fk(j), K.box);

export function fk([j1, j2, j3]) {
  const r = K.A0 + K.L1 * Math.sin(j2 * R) + K.L2 * Math.cos(j3 * R) + K.E;
  const z = K.SH + K.L1 * Math.cos(j2 * R) - K.L2 * Math.sin(j3 * R) - K.D;
  return [r * Math.cos(j1 * R), r * Math.sin(j1 * R), z];
}

// returns [j1,j2,j3] or null if unreachable / out of joint limits
export function ik([x, y, z]) {
  const j1 = Math.atan2(y, x) / R;
  const r = Math.hypot(x, y) - K.A0 - K.E, h = z - K.SH + K.D;
  const d = Math.hypot(r, h);
  const c = (K.L1 ** 2 + d * d - K.L2 ** 2) / (2 * K.L1 * d);
  if (!(Math.abs(c) <= 1)) return null;
  const a = Math.atan2(h, r) + Math.acos(c);                       // upper arm angle from horizontal (elbow up)
  const b = Math.atan2(h - K.L1 * Math.sin(a), r - K.L1 * Math.cos(a)); // forearm angle from horizontal
  const j = [j1, 90 - a / R, -b / R];
  return inLimits(j) ? j : null;
}
