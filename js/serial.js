// Web Serial wrapper + ultraArm G-code protocol (see pymycobot ultraArm.py / common.py)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const f2 = v => (+v).toFixed(2);
// The arm's native frame is mirrored vs. the sim (its +Y / +J1 go clockwise seen from above).
// Convert at the wire so the app/sim stay right-handed: robot = [x, -y, z], [-j1, j2, j3].
const MIRROR = true;
const m = ([a, b, c]) => MIRROR ? [a, -b, c] : [a, b, c];   // coords
const mj = ([a, b, c]) => MIRROR ? [-a, b, c] : [a, b, c];  // joints

export class Robot {
  port = null; writer = null; reader = null; buf = ''; waiters = [];
  onLog = () => {};

  ready = false; // true once the board has booted: nothing is sent before that
  get open() { return this.ready; }

  async connect(port, baudRate) {
    await port.open({ baudRate });
    this.port = port; this.q = Promise.resolve(); this.waiters = []; this.buf = '';
    this.writer = port.writable.getWriter();
    this.readLoop();
    // Opening the port resets the board. Stay silent until it has booted: bytes sent while its
    // bootloader is listening can keep it there, and then it never answers anything.
    const booted = await this.waitFor(/ROBOT ONLINE/i, 5000).then(() => true, () => false);
    if (this.port !== port) throw new Error('port closed');
    this.onLog(booted ? 'robot booted' : 'no boot message (board did not reset)');
    await sleep(500);
    this.ready = true;
  }

  async disconnect() {
    const p = this.port; if (!p) return;
    this.port = null; this.ready = false;
    this.cancel('port closed'); this.q = Promise.resolve(); // nothing from this session may block the next one
    try { await this.reader?.cancel(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    try { await p.close(); } catch {}
  }

  async readLoop() {
    const dec = new TextDecoder();
    const port = this.port;
    this.reader = port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buf += dec.decode(value);
        let i;
        while ((i = this.buf.search(/[\r\n]/)) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          this.onLog('< ' + line);
          this.waiters = this.waiters.filter(w => !(w.re.test(line) && (w.resolve(line), true)));
        }
      }
    } catch (e) { if (this.port === port) this.onLog('! read error: ' + e.message); }
    finally { try { this.reader.releaseLock(); } catch {} }
    // after a non-fatal error (e.g. break/framing on a board reset) Web Serial offers a new readable: keep reading
    if (this.port === port && port.readable) { await sleep(100); this.readLoop(); }
  }

  enabled = true; // global gate: when false only read-only queries go out
  send(cmd) {
    if (!this.port) throw new Error('not connected');
    if (!this.enabled && !/^(M9|M12|M114|M120)$/.test(cmd)) throw new Error('sending to robot is off');
    this.onLog('> ' + cmd);
    let t;
    return Promise.race([
      this.writer.write(new TextEncoder().encode(cmd + '\r')),
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error('write timeout – robot not accepting data, reconnect')), 2000); }),
    ]).finally(() => clearTimeout(t));
  }

  waitFor(re, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const w = { re, resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } };
      const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error('timeout waiting for ' + re)); }, timeout);
      this.waiters.push(w);
    });
  }

  // One command/response at a time (like pymycobot's lock): a background poll can never slip in
  // between e.g. G28 and its "ok". The timeout starts when the command is actually sent.
  q = Promise.resolve();
  exclusive(fn) { const r = this.q.then(fn); this.q = r.catch(() => {}); return r; }
  query(cmd, re, timeout) { return this.exclusive(async () => { const p = this.waitFor(re, timeout); await this.send(cmd); return p; }); }
  write(cmd) { return this.exclusive(() => this.send(cmd)); }
  // Stop: give up on whatever we wait for, so the queue frees up
  cancel(msg = 'stopped') { const e = new Error(msg); this.waiters.forEach(w => w.reject(e)); this.waiters = []; }

  async nums(cmd, tag) {
    const line = await this.query(cmd, new RegExp(tag + '\\['));
    return line.slice(line.indexOf('[') + 1, line.indexOf(']')).split(',').map(Number);
  }

  // --- commands ---
  powerOn() { return this.write('M18'); }
  release() { return this.write('M17'); }
  async home() { await this.query('G28', /ok/i, 120000); } // pymycobot waits for "ok" with no timeout
  async getAngles() { return mj(await this.nums('M12', 'ANGLES')); }
  async getCoords() { return m(await this.nums('M114', 'COORDS')); }
  // digital outputs (pymycobot): 'gpio' = the GPIO/suction pump output (M22 on / M23 off), 'fan' = fan output (M27 / M28)
  setDO(out, on) { return this.write({ gpio: on ? 'M22' : 'M23', fan: on ? 'M27' : 'M28' }[out]); }
  // M16: S0 = constant speed (moves blend, used when streaming), S2 = accel/decel per move (default)
  speedMode(s) { return this.write('M16 S' + s); }
  // number of moves waiting in the firmware queue (pymycobot: reply contains "QUEUE SIZE[n]")
  async queueSize() { const l = await this.query('M120', /QUEUE SIZE/i, 1000); return parseInt(l.slice(l.indexOf('[') + 1)); }
  movej(j, speed) { j = mj(j); return this.write(`M11 X${f2(j[0])} Y${f2(j[1])} Z${f2(j[2])} F${speed | 0}`); }
  movel(p, speed) { p = m(p); return this.write(`G0 X${f2(p[0])} Y${f2(p[1])} Z${f2(p[2])} F${speed | 0}`); }

  // poll M9 until "Moving end"; throws on timeout (caller handles abort)
  async waitIdle(isAborted, timeout = 30000) {
    const t0 = Date.now();
    while (!isAborted()) {
      try { await this.query('M9', /Moving end/i, 300); return; } catch {}
      if (Date.now() - t0 > timeout) throw new Error('robot did not report end of move');
      await sleep(100);
    }
  }
}
