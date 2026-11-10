import * as THREE from 'three';
import { fk, ik } from './kin.js';
import { Robot } from './serial.js';
import { parseSvg, simplify } from './svg.js';
import { arm, ghost, baseFrame, target, wpTarget, gizmo, setWaypoints, setPath, onPick } from './scene.js';

const $ = id => document.getElementById(id);
const R = Math.PI / 180;
const uid = () => crypto.randomUUID().slice(0, 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = v => (+v).toFixed(1);
const STOP = new Error('stopped');

// ---------------- state ----------------
const robot = new Robot();
const live = () => robot.open && robot.enabled; // global gate: nothing is sent to the arm unless this is true
let prog, sel = null, cur = [0, 0, 0], real = null, running = false, abort = false, runId = null, runLive = false;

const newProgram = () => ({
  name: 'Untitled',
  author: '',
  base: { x: 200, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
  waypoints: [],
  root: { id: 'root', type: 'program', children: [] },
});

// ---------------- base frame math ----------------
let M = new THREE.Matrix4(), Minv = new THREE.Matrix4(), Q = new THREE.Quaternion();
function updateBase() {
  const b = prog.base;
  Q.setFromEuler(new THREE.Euler(b.rx * R, b.ry * R, b.rz * R, 'XYZ'));
  M.compose(new THREE.Vector3(b.x, b.y, b.z), Q, new THREE.Vector3(1, 1, 1));
  Minv.copy(M).invert();
  baseFrame.position.set(b.x, b.y, b.z);
  baseFrame.quaternion.copy(Q);
  prog.waypoints.forEach(w => updateWp(w, 'pos'));
}
const toRobot = p => new THREE.Vector3(...p).applyMatrix4(M).toArray();
const toBase = p => new THREE.Vector3(...p).applyMatrix4(Minv).toArray();
const baseDir = v => new THREE.Vector3(...v).applyQuaternion(Q).toArray();

// waypoint = { id, name, pos (base frame), joints }; derived: robotPos, bad
function updateWp(w, from) {
  if (from === 'joints') { w.robotPos = fk(w.joints); w.pos = toBase(w.robotPos); w.bad = false; return; }
  w.robotPos = toRobot(w.pos);
  const j = ik(w.robotPos);
  w.bad = !j;
  if (j) w.joints = j;
}
const wpById = id => prog.waypoints.find(w => w.id === id);
const round = a => a.map(v => Math.round(v * 100) / 100);

// ---------------- tree helpers ----------------
function find(id, node = prog.root, parent = null) {
  if (node.id === id) return { node, parent, index: parent ? parent.children.indexOf(node) : -1 };
  for (const c of node.children || []) { const r = find(id, c, node); if (r) return r; }
  return null;
}
const ICON = { movej: '⤳', movel: '→', wait: '⏱', loop: '↻', poweron: '⏻', home: '⌂', release: '⊘', svg: '✎' };
function nodeLabel(n) {
  const wp = n.wp && wpById(n.wp);
  switch (n.type) {
    case 'movej': return `MoveJ → ${wp ? wp.name : '?'}  (${n.speed})`;
    case 'movel': return `MoveL → ${wp ? wp.name : '?'}  (${n.speed})`;
    case 'wait': return `Wait ${n.ms} ms`;
    case 'loop': return `Loop × ${n.count}`;
    case 'poweron': return 'Power on';
    case 'home': return 'Home';
    case 'release': return 'Release servos';
    case 'svg': return `Plot ${n.file || '(no SVG)'}  (${n.strokes.length} strokes, ${n.speed})`;
  }
}
const nodeBad = n => (n.type === 'movej' || n.type === 'movel') && (!wpById(n.wp) || wpById(n.wp).bad)
  || n.type === 'svg' && plotTargets(n).some(t => !t.j);

// SVG plot: strokes (mm, drawing frame) → robot-frame targets. Anchor = drawing centre, pose relative to the base frame;
// pen goes down along the anchor's −Z from the approach height. Curves are simplified to 0.2 mm.
function plotTargets(n) {
  const a = n.anchor;
  const A = new THREE.Matrix4().compose(new THREE.Vector3(a.x, a.y, a.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(a.rx * R, a.ry * R, a.rz * R, 'XYZ')), new THREE.Vector3(1, 1, 1)).premultiply(M);
  const out = [], add = (x, y, z) => { const p = new THREE.Vector3(x * n.scale, y * n.scale, z).applyMatrix4(A).toArray(); out.push({ p, j: ik(p) }); };
  for (const s of n.strokes) {
    const pts = simplify(s, 0.2 / n.scale);  // 0.2 mm chord tolerance at the drawn size
    add(...pts[0], n.approach);
    pts.forEach(q => add(...q, 0));
    add(...pts.at(-1), n.approach);
  }
  return out;
}

// ---------------- rendering ----------------
function renderTree() {
  const item = (id, icon, text, bad) =>
    `<div class="item ${id === sel ? 'sel' : ''} ${id === runId ? 'run' : ''} ${bad ? 'bad' : ''}" data-id="${id}"><span class="ic">${icon}</span>${esc(text)}</div>`;
  const nodes = list => `<ul>${list.map(n => `<li>${item(n.id, ICON[n.type], nodeLabel(n), nodeBad(n))}${n.children ? nodes(n.children) : ''}</li>`).join('')}</ul>`;
  $('tree').innerHTML =
    `<div class="tree">` +
    `<div class="group">Setup</div>${item('base', '⌖', `Base (${fmt(prog.base.x)}, ${fmt(prog.base.y)}, ${fmt(prog.base.z)})`)}` +
    `<div class="group">Waypoints</div>${prog.waypoints.map(w => item(w.id, '◆', `${w.name}  (${w.pos.map(fmt).join(', ')})`, w.bad)).join('') || '<div class="note">none yet</div>'}` +
    `<div class="group">Program</div>${prog.root.children.length ? nodes(prog.root.children) : '<div class="note">empty – use the buttons below</div>'}` +
    `</div>`;
  $('progName').value = prog.name;
  $('progAuthor').value = prog.author || '';
}
const esc = s => String(s).replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`);

function renderScene() {
  setWaypoints(prog.waypoints, sel);
  const w = wpById(sel) || wpById(find(sel)?.node?.wp);
  ghost.visible = !!(w && !w.bad);
  if (ghost.visible) ghost.setJoints(w.joints);
  setPath(programPath());
  // gizmo: on the selected waypoint if any, otherwise on the TCP
  const sw = wpById(sel);
  if (sw && !gizmo.dragging) wpTarget.position.fromArray(sw.robotPos);
  gizmo.attach(sw ? wpTarget : target);
}

// TCP trace of the program: MoveJ sampled through joint space (curved), MoveL straight, Home → zero pose.
// Starts at the first known pose; loops are unrolled (max 2 passes – enough to show the return leg).
function programPath() {
  const pts = [];
  let j = null;
  const goJ = to => {
    if (j) for (let s = 1; s <= 24; s++) pts.push(fk(j.map((v, i) => v + (to[i] - v) * s / 24)));
    else pts.push(fk(to));
    j = to;
  };
  const walk = n => {
    if (n.type === 'program') n.children.forEach(walk);
    if (n.type === 'loop') for (let i = 0; i < Math.min(n.count, 2); i++) n.children.forEach(walk);
    if (n.type === 'home') goJ([0, 0, 0]);
    if (n.type === 'svg') {
      const T = plotTargets(n);
      if (!T.length || T.some(t => !t.j)) return;
      goJ(T[0].j); T.slice(1).forEach(t => pts.push(t.p)); j = T.at(-1).j;
    }
    const w = wpById(n.wp);
    if (!w || w.bad) return;
    if (n.type === 'movej') goJ(w.joints);
    if (n.type === 'movel') { pts.push(w.robotPos); j = w.joints; }
  };
  walk(prog.root);
  return pts;
}

// props panel: built from field descriptors; numeric inputs commit on change
function renderProps() {
  const el = $('props');
  const focus = document.activeElement?.dataset?.k;
  let html = '', binds = {};
  const num = (k, v, set, step = 1) => { binds[k] = set; return `<input type="number" step="${step}" data-k="${k}" value="${Math.round(v * 100) / 100}">`; };
  const text = (k, v, set) => { binds[k] = set; return `<input data-k="${k}" value="${esc(v)}">`; };
  const field = (label, input) => `<div class="field"><label>${label}</label>${input}</div>`;
  const trip = (label, inputs) => `<div class="trip"><label>${label}</label>${inputs.join('')}</div>`;
  const btns = list => `<div class="row">${list.map(([t, a]) => `<button data-act="${a}">${t}</button>`).join('')}</div>`;
  const acts = {};

  if (sel === 'base') {
    const b = prog.base, s = k => v => { b[k] = v; updateBase(); };
    html += `<div class="note" style="margin-bottom:8px">Base frame pose relative to the robot. Waypoint coordinates are expressed in this frame, so moving the base moves all waypoints.</div>`;
    html += trip('Pos mm', ['x', 'y', 'z'].map(k => num(k, b[k], s(k))));
    html += trip('Rot °', ['rx', 'ry', 'rz'].map(k => num(k, b[k], s(k))));
    html += btns([['Set origin to TCP', 'tcp'], ['Reset', 'reset']]);
    acts.tcp = () => { [b.x, b.y, b.z] = round(fk(cur)); updateBase(); };
    acts.reset = () => { Object.assign(b, newProgram().base); updateBase(); };
  } else if (wpById(sel)) {
    const w = wpById(sel);
    html += `<div class="note" style="margin-bottom:8px">Drag the gizmo to move this waypoint. Click the robot to drag the TCP again.</div>`;
    html += field('Name', text('name', w.name, v => { w.name = v; }));
    if (w.bad) html += `<div class="warn">Unreachable – joints keep their last valid value.</div>`;
    html += trip('Base mm', [0, 1, 2].map(i => num('p' + i, w.pos[i], v => { w.pos[i] = v; updateWp(w, 'pos'); })));
    html += trip('Joints °', [0, 1, 2].map(i => num('j' + i, w.joints[i], v => { w.joints[i] = v; updateWp(w, 'joints'); })));
    html += trip('Robot mm', w.robotPos.map(v => `<span class="note" style="text-align:right">${fmt(v)}</span>`));
    html += btns([['Capture TCP', 'cap'], ['Identity', 'id']]);
    html += btns([['Go (MoveJ)', 'gj'], ['Go (MoveL)', 'gl']]);
    acts.cap = () => { w.joints = [...cur]; updateWp(w, 'joints'); };
    acts.id = () => { w.pos = [0, 0, 0]; updateWp(w, 'pos'); };
    acts.gj = () => run({ type: 'movej', wp: w.id, speed: +$('jogSpeed').value });
    acts.gl = () => run({ type: 'movel', wp: w.id, speed: +$('jogSpeed').value });
  } else if (find(sel)) {
    const n = find(sel).node;
    html += `<div class="note" style="margin-bottom:8px">${ICON[n.type]} ${n.type}</div>`;
    if (n.type === 'movej' || n.type === 'movel') {
      binds.wp = v => { n.wp = v; };
      html += field('Waypoint', `<select data-k="wp">${prog.waypoints.map(w => `<option value="${w.id}" ${w.id === n.wp ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}<option value="" ${n.wp ? '' : 'selected'}>—</option></select>`);
      html += field('Speed', num('speed', n.speed, v => { n.speed = Math.max(1, Math.min(200, v)); }));
      html += btns([['New WP from TCP', 'nwp'], ['Run line', 'line']]);
      acts.nwp = () => { n.wp = addWaypoint(true).id; sel = n.id; };
    }
    if (n.type === 'svg') {
      const a = n.anchor;
      html += field('SVG', `<span class="note">${esc(n.file || 'none')}${n.file ? ` · ${fmt(n.w * n.scale)} × ${fmt(n.h * n.scale)} mm` : ''}</span>`);
      if (nodeBad(n)) html += `<div class="warn">Part of the drawing is out of reach – move the anchor or scale it down.</div>`;
      html += field('Scale', num('scale', n.scale, v => { n.scale = Math.max(0.01, v); }, 0.1));
      html += trip('Anchor mm', ['x', 'y', 'z'].map(k => num('a' + k, a[k], v => { a[k] = v; })));
      html += trip('Anchor °', ['rx', 'ry', 'rz'].map(k => num('a' + k, a[k], v => { a[k] = v; })));
      html += field('Approach', num('approach', n.approach, v => { n.approach = v; }));
      html += field('Speed', num('speed', n.speed, v => { n.speed = Math.max(1, Math.min(200, v)); }));
      html += `<div class="note" style="margin-bottom:6px">Anchor = drawing centre, relative to the base frame. The pen lifts by the approach height between strokes.</div>`;
      html += btns([['Load SVG…', 'svgload'], ['Anchor at TCP', 'atcp']]);
      acts.svgload = () => pickFile('.svg,image/svg+xml', async f => { Object.assign(n, parseSvg(await f.text()), { file: f.name }); });
      acts.atcp = () => { [a.x, a.y, a.z] = round(toBase(fk(cur))); };
    }
    if (n.type === 'wait') html += field('Time ms', num('ms', n.ms, v => { n.ms = Math.max(0, v); }, 100));
    if (n.type === 'loop') html += field('Count', num('count', n.count, v => { n.count = Math.max(1, v | 0); }));
    if (!html.includes('data-act="line"')) html += btns([['Run line', 'line']]);
    acts.line = () => run(n);
  } else {
    html = `<div class="note">Select a node, waypoint or the base in the tree (or click a waypoint in 3D). Click the robot to drag the TCP.</div>`;
  }

  el.innerHTML = html;
  el.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('change', () => {
    binds[inp.dataset.k](inp.type === 'number' ? +inp.value : inp.value);
    refresh();
  }));
  el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { acts[b.dataset.act](); refresh(); }));
  if (focus) el.querySelector(`[data-k="${focus}"]`)?.focus();
}

function pickFile(accept, cb) {
  const i = Object.assign(document.createElement('input'), { type: 'file', accept });
  i.onchange = () => i.files[0] && guard(async () => { await cb(i.files[0]); refresh(); })();
  i.click();
}

function refresh() { renderTree(); renderProps(); renderScene(); renderButtons(); }

function select(id) { sel = id; refresh(); }

// ---------------- sim robot / jogging ----------------
function setCur(j) {
  cur = j;
  arm.setJoints(j);
  if (!gizmo.dragging) target.position.fromArray(fk(j));
  renderReadout();
}

function renderReadout() {
  const p = fk(cur), b = toBase(p);
  const row = (l, v) => `<span>${l}</span>${v ? v.map(x => `<span>${fmt(x)}</span>`).join('') : '<span>–</span><span>–</span><span>–</span>'}`;
  $('readout').innerHTML =
    `<span></span><span>1 / X</span><span>2 / Y</span><span>3 / Z</span>` +
    row('Sim J', cur) + row('Sim rob', p) + row('Sim base', b) +
    row('Real J', real?.j) + row('Real rob', real?.p);
  // jog row values
  const f = jogFrame, vals = f === 'joint' ? cur : f === 'robot' ? p : b;
  document.querySelectorAll('#jogRows .v').forEach((e, i) => { e.textContent = fmt(vals[i]); });
}

function renderJogRows() {
  const names = jogFrame === 'joint' ? ['J1', 'J2', 'J3'] : ['X', 'Y', 'Z'];
  document.querySelectorAll('[data-frame]').forEach(b => b.classList.toggle('on', b.dataset.frame === jogFrame));
  $('jogRows').innerHTML = names.map((n, i) =>
    `<div class="jog"><b>${n}</b><button data-j="${i}" data-d="-1">−</button><span class="v"></span><button data-j="${i}" data-d="1">+</button></div>`).join('');
  gizmo.setSpace(jogFrame === 'base' ? 'local' : 'world');
  target.quaternion.copy(jogFrame === 'base' ? Q : new THREE.Quaternion());
  wpTarget.quaternion.copy(target.quaternion);
  renderReadout();
}

let jogFrame = 'joint';
async function jog(i, d) {
  if (running) return;
  const step = +$('jogStep').value * d, f = jogFrame;
  let j;
  if (f === 'joint') { j = [...cur]; j[i] += step; if (!ik(fk(j))) return log('joint limit', true); }
  else {
    const dv = [0, 0, 0]; dv[i] = step;
    const v = f === 'base' ? baseDir(dv) : dv;
    j = ik(fk(cur).map((x, k) => x + v[k]));
    if (!j) return log('out of reach', true);
  }
  setCur(j);
  await sendJog(f === 'joint' ? 'j' : 'l');
}
let jogChain = Promise.resolve();
function sendJog(kind) {
  if (!live()) return;
  const j = [...cur], f = +$('jogSpeed').value;
  lastCmdT = performance.now();
  jogChain = jogChain.then(() => kind === 'j' ? robot.movej(j, f) : robot.movel(fk(j), f)).catch(e => log(e.message, true));
}

// gizmo drag: stream targets to the robot, throttled (firmware queues moves; don't flood it)
const STREAM_MS = 150, STREAM_MIN_MM = 1;
let lastSent = { t: 0, p: null };
function streamTarget(force) {
  const p = fk(cur), now = performance.now();
  if (!force && (now - lastSent.t < STREAM_MS || (lastSent.p && Math.hypot(...p.map((v, i) => v - lastSent.p[i])) < STREAM_MIN_MM))) return;
  lastSent = { t: now, p };
  sendJog('l');
}
gizmo.addEventListener('objectChange', () => {
  if (gizmo.object === wpTarget) {          // dragging a waypoint: edit it (sim/robot untouched)
    const w = wpById(sel), j = ik(wpTarget.position.toArray());
    if (!j) return wpTarget.position.fromArray(w.robotPos);
    w.joints = j; updateWp(w, 'joints');
    return renderScene();
  }
  const j = ik(target.position.toArray());
  if (j) { setCur(j); streamTarget(); } else target.position.fromArray(fk(cur));
});
gizmo.addEventListener('mouseUp', () => {
  if (gizmo.object === wpTarget) return refresh();
  target.position.fromArray(fk(cur)); streamTarget(true);
});

async function syncFromRobot() {
  const j = await robot.getAngles();
  const p = await robot.getCoords().catch(() => null);
  real = { j, p };
  return j;
}

// poll the real robot while connected; the sim follows it (e.g. moved by hand with servos released),
// except shortly after a jog/drag command (sim leads, robot catches up), while dragging, or with "send to robot" off
const POLL_MS = 700, HOLD_MS = 1500;
let pollBusy = false, lastCmdT = 0, pollFail = 0;
setInterval(async () => {
  if (!robot.open || running || pollBusy) return;
  pollBusy = true;
  try {
    const j = await syncFromRobot();
    if (pollFail) log('robot answering again');
    pollFail = 0;
    if (live() && !gizmo.dragging && performance.now() - lastCmdT > HOLD_MS && !running) setCur(j);
    else renderReadout();
  } catch (e) { if (robot.open && pollFail++ === 0) log('robot not answering position requests: ' + e.message, true); }
  pollBusy = false;
}, POLL_MS);

// ---------------- execution ----------------
function animate(dur, step) {
  return new Promise((res, rej) => {
    const t0 = performance.now();
    const f = () => {
      if (abort) return rej(STOP);
      const t = Math.min(1, (performance.now() - t0) / dur);
      try { step(t * t * (3 - 2 * t)); } catch (e) { return rej(e); }
      t < 1 ? requestAnimationFrame(f) : res();
    };
    f();
  });
}
function animJ(to, speed) {
  const from = [...cur], d = Math.max(...to.map((v, i) => Math.abs(v - from[i])));
  return animate(Math.max(150, d / speed * 1000), t => setCur(from.map((v, i) => v + (to[i] - v) * t)));
}
function animL(to, speed, min = 150) {
  const from = fk(cur), d = Math.hypot(...to.map((v, i) => v - from[i]));
  return animate(Math.max(min, d / speed * 1000), t => {
    const j = ik(from.map((v, i) => v + (to[i] - v) * t));
    if (!j) throw new Error('linear path leaves workspace');
    setCur(j);
  });
}
async function waitAbortable(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (abort) throw STOP; await sleep(Math.min(50, ms - (Date.now() - t0))); }
}

// let Stop/Esc interrupt a long wait on the robot (e.g. homing)
const abortable = p => new Promise((res, rej) => {
  const t = setInterval(() => { if (abort) { clearInterval(t); robot.cancel(); rej(STOP); } }, 50);
  p.then(v => { clearInterval(t); res(v); }, e => { clearInterval(t); rej(e); });
});

async function exec(n) {
  if (abort) throw STOP;
  if (n.id) { runId = n.id; renderTree(); }
  const on = runLive; // decided once per run: connecting mid-preview never starts sending
  switch (n.type) {
    case 'program': for (const c of n.children) await exec(c); break;
    case 'loop': for (let i = 0; i < n.count; i++) for (const c of n.children) await exec(c); break;
    case 'wait': await waitAbortable(n.ms); break;
    case 'poweron': if (on) { await robot.powerOn(); await sleep(300); } break;
    case 'release': if (on) { await robot.release(); await sleep(300); } break;
    case 'home':
      if (on) { log('homing…'); await abortable(robot.home()); setCur(await syncFromRobot().catch(() => [0, 0, 0])); }
      else await animJ([0, 0, 0], 60);
      break;
    case 'movej': case 'movel': {
      const w = wpById(n.wp);
      if (!w) throw new Error('move has no waypoint');
      if (w.bad) throw new Error(`waypoint ${w.name} unreachable`);
      if (on) n.type === 'movej' ? await robot.movej(w.joints, n.speed) : await robot.movel(w.robotPos, n.speed);
      n.type === 'movej' ? await animJ(w.joints, n.speed) : await animL(w.robotPos, n.speed);
      if (on) { await robot.waitIdle(() => abort); setCur(await syncFromRobot().catch(() => cur)); }
      break;
    }
    case 'svg': {
      const T = plotTargets(n);
      if (!T.length) throw new Error('plot has no SVG loaded');
      if (T.some(t => !t.j)) throw new Error('drawing leaves the workspace');
      for (const [i, t] of T.entries()) {   // joint move to the first approach point, then linear moves
        if (abort) throw STOP;
        if (on) i ? await robot.movel(t.p, n.speed) : await robot.movej(t.j, n.speed);
        i ? await animL(t.p, n.speed, 1) : await animJ(t.j, n.speed);
        if (on) await robot.waitIdle(() => abort);
      }
      if (on) setCur(await syncFromRobot().catch(() => cur));
      break;
    }
  }
}

async function run(node) {
  if (running) return;
  running = true; abort = false; runLive = live(); renderButtons();
  try { await exec(node); log('done'); }
  catch (e) { log(e === STOP ? 'stopped' : 'error: ' + e.message, e !== STOP); }
  running = false; runId = null; refresh();
}

// ---------------- program editing ----------------
function addWaypoint(capture) {
  const n = prog.waypoints.length + 1;
  let name = 'WP' + n;
  for (let i = n; prog.waypoints.some(w => w.name === name); i++) name = 'WP' + i;
  const w = { id: uid(), name, pos: [0, 0, 0], joints: [...cur] };
  capture ? updateWp(w, 'joints') : updateWp(w, 'pos');
  prog.waypoints.push(w);
  return w;
}

function addNode(type) {
  const defaults = { movej: { speed: 50 }, movel: { speed: 50 }, wait: { ms: 1000 }, loop: { count: 2, children: [] },
    svg: { file: '', strokes: [], w: 0, h: 0, scale: 1, anchor: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }, approach: 20, speed: 50 } };
  const n = { id: uid(), type, ...structuredClone(defaults[type] || {}) };
  if (type === 'movej' || type === 'movel') n.wp = wpById(sel)?.id || prog.waypoints.at(-1)?.id || addWaypoint(true).id;
  const f = find(sel);
  if (f && f.node.type === 'loop') f.node.children.push(n);
  else if (f && f.parent) f.parent.children.splice(f.index + 1, 0, n);
  else prog.root.children.push(n);
  return n;
}

function op(kind) {
  const wi = prog.waypoints.findIndex(w => w.id === sel);
  if (wi >= 0) {
    const L = prog.waypoints, w = L[wi];
    if (kind === 'up' && wi > 0) [L[wi - 1], L[wi]] = [L[wi], L[wi - 1]];
    if (kind === 'down' && wi < L.length - 1) [L[wi + 1], L[wi]] = [L[wi], L[wi + 1]];
    if (kind === 'dup') { const c = { ...structuredClone(w), id: uid(), name: w.name + "'" }; L.splice(wi + 1, 0, c); sel = c.id; }
    if (kind === 'del') { L.splice(wi, 1); sel = null; }
    return;
  }
  const f = find(sel);
  if (!f || !f.parent) return;
  const sib = f.parent.children, i = f.index;
  if (kind === 'up' && i > 0) [sib[i - 1], sib[i]] = [sib[i], sib[i - 1]];
  if (kind === 'down' && i < sib.length - 1) [sib[i + 1], sib[i]] = [sib[i], sib[i + 1]];
  if (kind === 'in' && sib[i - 1]?.type === 'loop') sib[i - 1].children.push(...sib.splice(i, 1));
  if (kind === 'out' && f.parent !== prog.root) { const p = find(f.parent.id); sib.splice(i, 1); p.parent.children.splice(p.index + 1, 0, f.node); }
  if (kind === 'dup') {
    const reid = n => ({ ...n, id: uid(), ...(n.children ? { children: n.children.map(reid) } : {}) });
    const c = reid(structuredClone(f.node)); sib.splice(i + 1, 0, c); sel = c.id;
  }
  if (kind === 'del') { sib.splice(i, 1); sel = null; }
}

// ---------------- save / load ----------------
const serialize = () => JSON.stringify(prog, (k, v) => (k === 'robotPos' || k === 'bad') ? undefined : v);

// first save creates a guid; later saves keep it and add a new version (server never overwrites)
let progId = null;
const setUrl = (id, v) => { progId = id; history.replaceState(null, '', id ? `?id=${id}&v=${v}` : location.pathname); };

async function save() {
  const r = await fetch('api.php' + (progId ? '?id=' + progId : ''), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: serialize() });
  if (!r.ok) throw new Error('save failed: ' + r.status);
  const { id, v } = await r.json();
  setUrl(id, v);
  log(`saved v${v} → ${location.href}`);
}

async function load(id, v) {
  const r = await fetch(`api.php?id=${encodeURIComponent(id)}${v ? '&v=' + encodeURIComponent(v) : ''}`);
  if (!r.ok) throw new Error('program not found');
  setProgram(await r.json());
  const ver = r.headers.get('X-Version'), latest = r.headers.get('X-Latest-Version');
  setUrl(id, ver);
  log(`loaded ${prog.name} v${ver}` + (ver !== latest ? ` (latest is v${latest})` : ''));
}

// Load dialog: every saved program, newest first, with a version picker (latest by default)
let saved = [];
async function openLoad() {
  const r = await fetch('api.php?list');
  if (!r.ok) throw new Error('list failed: ' + r.status);
  saved = await r.json();
  $('loadFilter').value = '';
  renderLoad();
  $('loadDlg').showModal();
  $('loadFilter').focus();
}
function renderLoad() {
  const f = $('loadFilter').value.toLowerCase();
  const rows = saved.filter(p => (p.name + ' ' + p.author).toLowerCase().includes(f));
  $('loadList').innerHTML = rows.length ? '<table>' + rows.map(p =>
    `<tr data-id="${p.id}"><td>${esc(p.name || 'Untitled')}</td><td class="m">${esc(p.author || '–')}</td>` +
    `<td class="m">${new Date(p.t * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>` +
    `<td><select>${p.versions.slice().reverse().map(v => `<option>${v}</option>`).join('')}</select></td>` +
    `<td><button class="sm pri">Open</button></td></tr>`).join('') + '</table>' : '<div class="note">no saved programs</div>';
}
$('loadList').addEventListener('click', e => {
  if (!e.target.closest('button')) return;
  const tr = e.target.closest('tr');
  $('loadDlg').close();
  guard(load)(tr.dataset.id, tr.querySelector('select').value);
});
$('loadFilter').addEventListener('input', renderLoad);
$('loadClose').onclick = () => $('loadDlg').close();

function setProgram(p) { prog = p; sel = null; updateBase(); refresh(); }

// ---------------- serial UI ----------------
async function refreshPorts() {
  if (!('serial' in navigator)) {
    $('port').innerHTML = '<option>Web Serial unavailable</option>';
    log('Web Serial needs Chrome/Edge on https or localhost', true);
    return;
  }
  const ports = await navigator.serial.getPorts();
  $('port').innerHTML = ports.map((p, i) => {
    const info = p.getInfo();
    return `<option value="${i}">Port ${i + 1}${info.usbVendorId ? ` (${info.usbVendorId.toString(16)}:${info.usbProductId.toString(16)})` : ''}</option>`;
  }).join('') || '<option value="">no port – click + Port</option>';
}

async function addPort() {
  const port = await navigator.serial.requestPort();
  await refreshPorts();
  $('port').value = (await navigator.serial.getPorts()).indexOf(port);
  return port;
}

async function toggleConnection() {
  if (robot.port) { await robot.disconnect(); log('closed'); real = null; return; }
  const port = $('port').value === '' ? await addPort() : (await navigator.serial.getPorts())[+$('port').value];
  log('opening…');
  await robot.connect(port, +$('baud').value);
  log('connected');
  setCur(await syncFromRobot().catch(() => cur));
}

function renderButtons() {
  $('dot').classList.toggle('on', robot.open);
  $('dot').classList.toggle('gated', !robot.enabled);
  $('btnConn').textContent = robot.open ? 'Close' : 'Open';
  for (const b of ['btnRun', 'btnStep', 'btnHome', 'btnSave', 'btnLoad', 'btnNew']) $(b).disabled = running;
  $('btnPower').disabled = $('btnRelease').disabled = running || !live();
  $('btnStop').disabled = !running;
  gizmo.enabled = !running; // no dragging/streaming while a program drives the arm
  document.querySelectorAll('#tools button').forEach(b => { b.disabled = running; });
}

// ---------------- log ----------------
function log(msg, err) {
  const d = document.createElement('div');
  if (err) d.className = 'err';
  d.textContent = msg;
  const L = $('log');
  L.append(d);
  while (L.childElementCount > 300) L.firstChild.remove();
  L.scrollTop = L.scrollHeight;
}
robot.onLog = m => { if (!/^> M(9|12|114)\b|^< (DATA: )?(ANGLES|COORDS)|^< INFO: ABSOLUTE MODE/.test(m)) log(m); }; // hide poll chatter

// ---------------- wiring ----------------
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { log(e.message, true); } renderButtons(); };

$('tree').addEventListener('click', e => { const it = e.target.closest('[data-id]'); if (it) select(it.dataset.id); });
onPick(id => select(id));
document.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
  const t = b.dataset.add;
  sel = t === 'wp' || t === 'wpcap' ? addWaypoint(t === 'wpcap').id : addNode(t).id;
  refresh();
}));
document.querySelectorAll('[data-op]').forEach(b => b.addEventListener('click', () => { op(b.dataset.op); refresh(); }));
$('progName').addEventListener('change', e => { prog.name = e.target.value; });
$('progAuthor').addEventListener('change', e => { prog.author = e.target.value; });

$('btnConn').onclick = guard(toggleConnection);
$('live').onchange = e => { robot.enabled = e.target.checked; log(robot.enabled ? 'sending to robot ON' : 'sending to robot OFF – sim only'); renderButtons(); };
$('btnAddPort').onclick = guard(addPort);
$('btnPower').onclick = () => run({ type: 'poweron' });
$('btnHome').onclick = () => run({ type: 'home' });
$('btnRelease').onclick = () => run({ type: 'release' });
$('btnRun').onclick = () => run(prog.root);
$('btnStep').onclick = () => {
  const n = find(sel)?.node || (wpById(sel) && { type: 'movej', wp: sel, speed: +$('jogSpeed').value });
  if (n && n !== prog.root) run(n); else log('select a program line first', true);
};
$('btnStop').onclick = () => { abort = true; };
$('btnSave').onclick = guard(save);
$('btnLoad').onclick = guard(openLoad);
$('btnNew').onclick = () => { if (confirm('Discard current program?')) { setUrl(null); setProgram(newProgram()); } };
document.querySelectorAll('[data-frame]').forEach(b => b.addEventListener('click', () => { jogFrame = b.dataset.frame; renderJogRows(); }));
$('jogRows').addEventListener('click', e => { const b = e.target.closest('button'); if (b) jog(+b.dataset.j, +b.dataset.d); });
navigator.serial?.addEventListener('disconnect', () => { robot.disconnect(); log('port disconnected', true); renderButtons(); });
addEventListener('keydown', e => { if (e.key === 'Escape') abort = true; });

// ---------------- boot ----------------
setProgram(newProgram());
setCur([0, 0, 0]);
renderJogRows();
refreshPorts();
const q = new URLSearchParams(location.search);
if (q.get('id')) guard(load)(q.get('id'), q.get('v'));
