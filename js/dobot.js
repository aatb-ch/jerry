// Web Serial driver for the Dobot Magician: binary protocol (Dobot Communication Protocol V1.1.5, 115200 baud).
// Same interface as serial.js (ultraArm), so the editor and the program nodes don't care which arm is connected.
// Packet: AA AA len id ctrl params… checksum. len = 2 + params; ctrl bit 0 = write, bit 1 = queued;
// checksum = two's complement of the byte sum of id, ctrl and params. Every packet is answered with the same id.
// Queued commands (moves, end effector, home) run in order and answer with their index in the arm's queue;
// a move has finished once the arm's current index has reached it.
import { K } from './kin.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ID = { pose: 10, home: 31, endParams: 60, laser: 61, suction: 62, gripper: 63, jointParams: 80, coordParams: 81,
  commonParams: 83, ptp: 84, start: 240, forceStop: 242, clear: 245, index: 246 };
const NAME = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v, k]));
const READ = [ID.pose, ID.index]; // allowed with "send to robot" off; not logged
const MOVL_XYZ = 2, MOVJ_ANGLE = 4;
const W = 1, Q = 3; // ctrl: write, queued write

const f32 = (...v) => { const b = new DataView(new ArrayBuffer(v.length * 4)); v.forEach((x, i) => b.setFloat32(i * 4, x, true)); return new Uint8Array(b.buffer); };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const f2 = v => (+v).toFixed(2);

export class Dobot {
  port = null; writer = null; reader = null; buf = []; waiters = [];
  onLog = () => {};
  onLimit = () => {};
  sent = [];
  ready = false;
  enabled = true;
  last = 0;          // queue index of the last queued command
  speeds = {};       // last speed sent per move kind (params are only re-sent on change)
  stopped = false;   // set by cancel(): ends a wait for the queue
  queue = { every: 5, below: 12 }; // the arm queues 32 commands; each move can take 2 (speed + move)
  get open() { return this.ready; }

  async connect(port, baudRate) {
    await port.open({ baudRate });
    this.port = port; this.q = Promise.resolve(); this.waiters = []; this.buf = []; this.speeds = {};
    this.writer = port.writable.getWriter();
    this.readLoop();
    await sleep(300);
    this.ready = true;
    try {
      await this.cmd(ID.forceStop, W); await this.cmd(ID.clear, W); await this.cmd(ID.start, W);
      this.last = await this.index();
      await this.cmd(ID.endParams, W, f32(K.E, 0, 0)); // the reported pose is then the flange (see kin.js)
      await this.cmd(ID.commonParams, W, f32(100, 100));
      this.onLog('robot ready');
    } catch (e) { this.ready = false; throw new Error('Magician not answering: ' + e.message); }
  }

  async disconnect() {
    const p = this.port; if (!p) return;
    this.port = null; this.ready = false;
    this.cancel('port closed'); this.q = Promise.resolve();
    try { await this.reader?.cancel(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    try { await p.close(); } catch {}
  }

  async readLoop() {
    const port = this.port;
    this.reader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buf.push(...value);
        for (;;) {
          const s = this.buf.findIndex((b, i) => b === 0xaa && this.buf[i + 1] === 0xaa);
          if (s < 0) { this.buf = this.buf.slice(-1); break; }
          if (s > 0) this.buf = this.buf.slice(s);
          if (this.buf.length < 3) break;
          const len = this.buf[2], end = 3 + len + 1;
          if (this.buf.length < end) break;
          const body = this.buf.slice(3, 3 + len), sum = body.reduce((a, b) => a + b, 0) + this.buf[3 + len];
          this.buf = this.buf.slice(end);
          if (sum & 0xff || len < 2) { this.onLog('! bad packet from the arm'); continue; }
          const id = body[0], params = new DataView(new Uint8Array(body.slice(2)).buffer);
          const w = this.waiters.find(w => w.id === id);
          if (w) { this.waiters = this.waiters.filter(x => x !== w); w.resolve(params); }
        }
      }
    } catch (e) { if (this.port === port) this.onLog('! read error: ' + e.message); }
    finally { try { this.reader.releaseLock(); } catch {} }
    if (this.port === port && port.readable) { await sleep(100); this.readLoop(); }
  }

  // one command at a time: send a packet, wait for the answer with the same id
  q = Promise.resolve();
  cmd(id, ctrl, params = new Uint8Array(), log = '', timeout = 1000) {
    const r = this.q.then(async () => {
      if (!this.port) throw new Error('not connected');
      if (!this.enabled && !READ.includes(id)) throw new Error('sending to robot is off');
      if (!READ.includes(id)) {
        const s = NAME[id] + (log ? ' ' + log : '');
        this.onLog('> ' + s);
        this.sent = [...this.sent.slice(-2), s];
      }
      const body = cat([id, ctrl], params), sum = body.reduce((a, b) => a + b, 0);
      const pkt = cat([0xaa, 0xaa, body.length], body, [(256 - (sum & 0xff)) & 0xff]);
      const p = new Promise((resolve, reject) => {
        const w = { id, resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } };
        const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error('no answer to ' + NAME[id])); }, timeout);
        this.waiters.push(w);
      });
      await this.writer.write(pkt);
      return p;
    });
    this.q = r.catch(() => {});
    return r;
  }
  // queued command: remember its queue index
  async queued(id, params, log) {
    const d = await this.cmd(id, Q, params, log);
    this.last = d.getUint32(0, true) + d.getUint32(4, true) * 2 ** 32;
    return this.last;
  }
  async index() { const d = await this.cmd(ID.index, 0); return d.getUint32(0, true) + d.getUint32(4, true) * 2 ** 32; }
  cancel(msg = 'stopped') { this.stopped = true; const e = new Error(msg); this.waiters.forEach(w => w.reject(e)); this.waiters = []; }

  async pose() { const d = await this.cmd(ID.pose, 0); return [...Array(8)].map((_, i) => d.getFloat32(i * 4, true)); }

  // --- commands (same names as serial.js) ---
  powerOn() { this.onLog('(the Magician has no servo power command)'); }
  release() { this.onLog('(the Magician has no servo release: use the unlock button on the forearm)'); }
  async home() {
    this.stopped = false;
    await this.queued(ID.home, new Uint8Array(4), '(takes about 20 s)');
    await this.waitIdle(() => this.stopped, 120000);
  }
  async getAngles() { return (await this.pose()).slice(4, 7); }
  async getCoords() { return (await this.pose()).slice(0, 3); }
  // the Magician's outputs: 'gpio' = suction cup; it has no fan output
  setDO(out, on) {
    if (out !== 'gpio') throw new Error('the Magician has no fan output');
    return this.queued(ID.suction, new Uint8Array([1, on ? 1 : 0]), on ? 'on' : 'off');
  }
  setPWM(v) { return this.queued(ID.laser, new Uint8Array([1, v > 0 ? 1 : 0]), v > 0 ? 'on' : 'off'); } // laser on/off
  // pneumatic gripper: closed below 50 % open, else open; release = pump off
  gripper(pos) { return this.queued(ID.gripper, new Uint8Array([1, pos < 50 ? 1 : 0]), pos < 50 ? 'close' : 'open'); }
  gripperZero() {}
  gripperRelease() { return this.queued(ID.gripper, new Uint8Array([0, 0]), 'off'); }
  speedMode() {} // no blend mode: every move ramps
  async queueSize() { return this.last - await this.index(); }

  // speed = deg/s for joint moves, mm/s for linear moves (same as the sim); acceleration scales with it
  async setSpeed(kind, speed) {
    if (this.speeds[kind] === speed) return;
    const a = Math.max(100, 2 * speed);
    if (kind === 'j') await this.queued(ID.jointParams, f32(speed, speed, speed, speed, a, a, a, a), `${speed}°/s`);
    else await this.queued(ID.coordParams, f32(speed, speed, a, a), `${speed} mm/s`);
    this.speeds[kind] = speed;
  }
  async movej(j, speed) {
    await this.setSpeed('j', speed);
    return this.queued(ID.ptp, cat([MOVJ_ANGLE], f32(j[0], j[1], j[2], 0)), `movj ${j.map(f2).join(' ')}`);
  }
  // r = end rotation in the base frame: following J1 keeps joint 4 at 0
  async movel(p, speed) {
    await this.setSpeed('l', speed);
    return this.queued(ID.ptp, cat([MOVL_XYZ], f32(p[0], p[1], p[2], Math.atan2(p[1], p[0]) * 180 / Math.PI)), `movl ${p.map(f2).join(' ')}`);
  }

  async waitIdle(isAborted, timeout = 30000) {
    const t0 = Date.now();
    while (!isAborted()) {
      if (await this.index().catch(() => -1) >= this.last) return;
      if (Date.now() - t0 > timeout) throw new Error('robot did not finish its moves');
      await sleep(100);
    }
  }
}
