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

  get open() { return !!this.port; }

  async connect(port, baudRate) {
    await port.open({ baudRate });
    this.port = port;
    this.writer = port.writable.getWriter();
    this.readLoop();
    await sleep(1500); // board resets on open
  }

  async disconnect() {
    const p = this.port; if (!p) return;
    this.port = null;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    try { await p.close(); } catch {}
  }

  async readLoop() {
    const dec = new TextDecoder();
    this.reader = this.port.readable.getReader();
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
          // board rebooted (power dip / reset): fail whatever we were waiting for instead of hanging
          if (/Restart board|ROBOT ONLINE/i.test(line)) {
            const e = new Error(/Restart/i.test(line) ? "robot asks to 'Restart board' – power-cycle the arm, reconnect, then Home" : 'robot board rebooted – press Home');
            this.waiters.forEach(w => w.reject(e)); this.waiters = [];
          }
          this.waiters = this.waiters.filter(w => !(w.re.test(line) && (w.resolve(line), true)));
        }
      }
    } catch {}
    finally { try { this.reader.releaseLock(); } catch {} }
  }

  enabled = true; // global gate: when false only read-only queries go out
  send(cmd) {
    if (!this.port) throw new Error('not connected');
    if (!this.enabled && !/^(M9|M12|M114)$/.test(cmd)) throw new Error('sending to robot is off');
    this.onLog('> ' + cmd);
    return this.writer.write(new TextEncoder().encode(cmd + '\r'));
  }

  waitFor(re, timeout = 1000) {
    return new Promise((resolve, reject) => {
      const w = { re, resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } };
      const t = setTimeout(() => { this.waiters = this.waiters.filter(x => x !== w); reject(new Error('timeout waiting for ' + re)); }, timeout);
      this.waiters.push(w);
    });
  }

  async query(cmd, re, timeout) { const p = this.waitFor(re, timeout); await this.send(cmd); return p; }

  async nums(cmd, tag) {
    const line = await this.query(cmd, new RegExp(tag + '\\['));
    return line.slice(line.indexOf('[') + 1, line.indexOf(']')).split(',').map(Number);
  }

  // --- commands ---
  powerOn() { return this.send('M18'); }
  release() { return this.send('M17'); }
  async home() { await this.query('G28', /ok/i, 60000); }
  async getAngles() { return mj(await this.nums('M12', 'ANGLES')); }
  async getCoords() { return m(await this.nums('M114', 'COORDS')); }
  movej(j, speed) { j = mj(j); return this.send(`M11 X${f2(j[0])} Y${f2(j[1])} Z${f2(j[2])} F${speed | 0}`); }
  movel(p, speed) { p = m(p); return this.send(`G0 X${f2(p[0])} Y${f2(p[1])} Z${f2(p[2])} F${speed | 0}`); }

  // poll M9 until "Moving end"; throws on timeout or board restart (caller handles abort)
  async waitIdle(isAborted, timeout = 30000) {
    const t0 = Date.now();
    while (!isAborted()) {
      try { await this.query('M9', /Moving end/i, 300); return; }
      catch (e) { if (/restarted/.test(e.message)) throw e; }
      if (Date.now() - t0 > timeout) throw new Error('robot did not report end of move');
      await sleep(100);
    }
  }
}
