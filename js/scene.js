import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { K, tool } from './kin.js';

const R = Math.PI / 180;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d2228);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 5, 20000);
camera.position.set(750, -650, 450);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const labels = new CSS2DRenderer();
labels.setSize(innerWidth, innerHeight);
labels.domElement.className = 'labels';
document.body.prepend(labels.domElement);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(150, 0, -50);
orbit.update();

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(400, -300, 800);
scene.add(sun);

const grid = new THREE.GridHelper(1000, 20, 0x5a6470, 0x353c44);
grid.rotation.x = Math.PI / 2;
grid.position.z = K.TABLE;
scene.add(grid);
scene.add(new THREE.AxesHelper(60));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  labels.setSize(innerWidth, innerHeight);
});

// ---------- arm model (primitive boxes, Z-up, mm) ----------
function makeArm(ghost) {
  const mat = c => new THREE.MeshStandardMaterial({ color: ghost ? 0x4da3ff : c, transparent: ghost, opacity: ghost ? 0.28 : 1, depthWrite: !ghost, roughness: 0.55, metalness: 0.15 });
  const box = (parent, sx, sy, sz, x, y, z, c) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat(c));
    m.position.set(x, y, z);
    parent.add(m);
  };
  const cyl = (parent, r, h, x, y, z, c, axis = 'z') => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 32), mat(c));
    if (axis === 'z') m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    parent.add(m);
  };
  const root = new THREE.Group();
  const H = -K.TABLE;
  cyl(root, 75, 30, 0, 0, K.TABLE + 15, 0x2b2f35);
  cyl(root, 55, H - 30, 0, 0, K.TABLE + 30 + (H - 30) / 2, 0xdfe3e8);
  const j1 = new THREE.Group(); root.add(j1);
  box(j1, 70, 90, K.SH + 20, K.A0 - 10, 0, K.SH / 2 - 10, 0xdfe3e8);
  cyl(j1, 22, 100, K.A0, 0, K.SH, 0x2b2f35, 'y');
  const sh = new THREE.Group(); sh.position.set(K.A0, 0, K.SH); j1.add(sh);
  box(sh, 26, 34, K.L1, 0, 0, K.L1 / 2, 0xf2f4f6);
  const el = new THREE.Group(); j1.add(el);
  cyl(el, 16, 46, 0, 0, 0, 0x2b2f35, 'y');
  box(el, K.L2, 24, 22, K.L2 / 2, 0, 0, 0xf2f4f6);
  const wr = new THREE.Group(); j1.add(wr);
  box(wr, K.E + 10, 26, 16, K.E / 2, 0, 0, 0x2b2f35);
  cyl(wr, 12, K.D, K.E, 0, -K.D / 2, 0x8a939d);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(5, 16, 12), mat(0xff7a2f));
  wr.add(tip);
  const toolLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(K.E, 0, -K.D), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xff7a2f }));
  wr.add(toolLine);

  root.setJoints = ([a, b, c]) => {
    j1.rotation.z = a * R;
    sh.rotation.y = b * R;
    el.position.set(K.A0 + K.L1 * Math.sin(b * R), 0, K.SH + K.L1 * Math.cos(b * R));
    el.rotation.y = c * R;
    wr.position.set(el.position.x + K.L2 * Math.cos(c * R), 0, el.position.z - K.L2 * Math.sin(c * R));
    tip.position.set(K.E + tool[0], tool[1], -K.D + tool[2]); // orange ball = TCP, line from the flange
    toolLine.geometry.attributes.position.setXYZ(1, tip.position.x, tip.position.y, tip.position.z);
    toolLine.geometry.attributes.position.needsUpdate = true;
  };
  return root;
}

export const arm = makeArm(false);
export const ghost = makeArm(true);
ghost.visible = false;
scene.add(arm, ghost);

// ---------- base frame ----------
export const baseFrame = new THREE.Group();
baseFrame.add(new THREE.AxesHelper(90));
baseFrame.add(label('Base', 'base'));
const baseHandle = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 12), new THREE.MeshStandardMaterial({ color: 0xffd23f })); // click to select / drag the base
baseHandle.userData.id = 'base';
baseFrame.add(baseHandle);
scene.add(baseFrame);

function label(text, cls = '') {
  const d = document.createElement('div');
  d.className = 'lbl ' + cls;
  d.textContent = text;
  return new CSS2DObject(d);
}

// ---------- waypoints ----------
const wpGroup = new THREE.Group();
scene.add(wpGroup);
const wpGeo = new THREE.SphereGeometry(6, 16, 12);
export function setWaypoints(list, selId) {
  wpGroup.children.slice().forEach(c => { c.traverse(o => o.element?.remove()); wpGroup.remove(c); });
  for (const w of list) {
    const m = new THREE.Mesh(wpGeo, new THREE.MeshBasicMaterial({ color: w.bad ? 0xff4d4d : w.id === selId ? 0xffd23f : 0x4da3ff }));
    m.position.fromArray(w.robotPos);
    m.userData.id = w.id;
    const l = label(w.name, 'wp'); l.position.set(0, 0, 14); m.add(l);
    wpGroup.add(m);
  }
}

// ---------- program path preview ----------
const path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff }));
scene.add(path);
export function setPath(points) {
  path.geometry.dispose();
  path.geometry = new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p)));
}

// ---------- TCP gizmo ----------
export const target = new THREE.Object3D();   // TCP handle
export const wpTarget = new THREE.Object3D(); // selected-waypoint handle
scene.add(target, wpTarget);
export const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.7);
gizmo.attach(target);
scene.add(gizmo);
gizmo.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; });

// ---------- picking ----------
const ray = new THREE.Raycaster();
let down = null;
renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
export function onPick(cb) {
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || gizmo.dragging) return;
    ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1), camera);
    const hit = ray.intersectObjects([...wpGroup.children, baseHandle, arm])[0];
    if (hit) cb(hit.object.userData.id ?? null); // waypoint id, 'base', or null for the arm (→ gizmo back on TCP)
  });
}

renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  labels.render(scene, camera);
});
