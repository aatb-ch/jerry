// Program geometry shared by the editor and the results slideshow: SVG plot targets and the TCP path of a program.
// Waypoints need robotPos / joints / bad (the editor keeps them up to date; prepare() computes them for a loaded file).
import * as THREE from 'three';
import { fk, ik, setTool } from './kin.js';
import { simplify } from './svg.js';

const R = Math.PI / 180;

// Function = named subprogram (skipped where it stands), Call = run a function's children there
export const allFuncs = (n, o = []) => { if (n.type === 'func') o.push(n); (n.children || []).forEach(c => allFuncs(c, o)); return o; };
export const findFunc = (root, id) => id ? allFuncs(root).find(f => f.id === id) : null;

// base frame pose → matrix (base frame → robot frame)
export const baseMatrix = b => new THREE.Matrix4().compose(new THREE.Vector3(b.x, b.y, b.z),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(b.rx * R, b.ry * R, b.rz * R, 'XYZ')), new THREE.Vector3(1, 1, 1));

// a saved program as loaded from the db: set its tool, derive waypoint robot positions / joints; returns the base matrix
export function prepare(prog) {
  const t = prog.tool || { x: 0, y: 0, z: 0 };
  setTool([t.x, t.y, t.z]);
  const M = baseMatrix(prog.base);
  for (const w of prog.waypoints) {
    w.robotPos = new THREE.Vector3(...w.pos).applyMatrix4(M).toArray();
    const j = ik(w.robotPos);
    w.bad = !j;
    if (j) w.joints = j;
  }
  return M;
}

// SVG plot: strokes (mm, drawing frame) → robot-frame targets. Anchor = drawing centre, pose relative to the base frame;
// pen goes down along the anchor's −Z from the approach height. Curves become straight segments that stay within
// n.tol mm of the true curve (Ramer–Douglas–Peucker at the drawn size): smaller = more, shorter segments, smoother curves.
export function plotTargets(n, M) {
  const a = n.anchor;
  const A = new THREE.Matrix4().compose(new THREE.Vector3(a.x, a.y, a.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(a.rx * R, a.ry * R, a.rz * R, 'XYZ')), new THREE.Vector3(1, 1, 1)).premultiply(M);
  const out = [], add = (x, y, z, end) => { const p = new THREE.Vector3(x * n.scale, y * n.scale, z).applyMatrix4(A).toArray(); out.push({ p, j: ik(p), end }); };
  for (const s of n.strokes) {
    const pts = simplify(s, (n.tol ?? 0.2) / n.scale);
    add(...pts[0], n.approach); out.at(-1).start = true; // pen up above the stroke start
    pts.forEach(q => add(...q, 0));
    add(...pts.at(-1), n.approach, true); // pen lifted: end of stroke
  }
  return out;
}

// TCP trace of the program: MoveJ sampled through joint space (curved), MoveL straight, Home → zero pose.
// Starts at the first known pose; loops are unrolled (max 2 passes – enough to show the return leg).
export function programPath(prog, M) {
  const wpById = id => prog.waypoints.find(w => w.id === id), funcById = id => findFunc(prog.root, id);
  const pts = [];
  let j = null;
  const goJ = to => {
    if (j) for (let s = 1; s <= 24; s++) pts.push(fk(j.map((v, i) => v + (to[i] - v) * s / 24)));
    else pts.push(fk(to));
    j = to;
  };
  let depth = 0;
  const call = f => { if (f && depth < 20) { depth++; f.children.forEach(walk); depth--; } };
  const walk = n => {
    if (n.type === 'program') n.children.forEach(walk);
    if (n.type === 'call') call(funcById(n.fn));
    if (n.type === 'loop') for (let i = 0; i < Math.min(n.count, 2); i++) n.children.forEach(walk);
    if (n.type === 'home') goJ([0, 0, 0]);
    if (n.type === 'svg') {
      const T = plotTargets(n, M);
      if (!T.length || T.some(t => !t.j)) return;
      const f = funcById(n.call);
      T.forEach((t, i) => {
        if (t.start && f) call(f);
        if (i === 0 || t.start && f) goJ(t.j); else { pts.push(t.p); j = t.j; }
      });
    }
    const w = wpById(n.wp);
    if (!w || w.bad) return;
    if (n.type === 'movej') goJ(w.joints);
    if (n.type === 'movel') { pts.push(w.robotPos); j = w.joints; }
  };
  walk(prog.root);
  return pts;
}
