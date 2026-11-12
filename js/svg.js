// SVG → strokes (polylines) in mm, centred on the drawing, y up (as seen from above on the table).
// Physical sizes (mm/cm/in/pt/px width + viewBox) are honoured; otherwise the drawing is fitted to 80 mm.
const UNIT = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 };

export function parseSvg(text) {
  const svg = new DOMParser().parseFromString(text, 'image/svg+xml').documentElement;
  if (svg.nodeName !== 'svg') throw new Error('not an SVG file');
  const vb = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  const w = svg.getAttribute('width') || '', unit = UNIT[w.match(/[a-z]+$/)?.[0]];
  let mmPerUnit = unit ? (vb ? parseFloat(w) * unit / vb[2] : unit) : null;
  ['viewBox', 'width', 'height'].forEach(k => svg.removeAttribute(k)); // user units = getCTM space

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden';
  host.appendChild(document.importNode(svg, true));
  document.body.appendChild(host);
  try {
    const root = host.firstChild, bb = root.getBBox(), step = Math.max(bb.width, bb.height) / 4000 || 1; // fine: the plot node decides the final resolution
    const strokes = [];
    for (const el of root.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')) {
      if (el.closest('defs,clipPath,mask,symbol,marker')) continue;
      const ctm = el.getCTM();
      let s = [];
      // Paths are sampled one segment at a time: getPointAtLength on a long path walks it from the start
      // (a 2.5 m spiral took ~1 ms per call, minutes in all). Other shapes are short: sampled whole.
      const parts = el.nodeName === 'path' ? segments(el.getAttribute('d') || '') : [el];
      for (const part of parts) {
        if (!part) { if (s.length > 1) strokes.push(s); s = []; continue; } // moveto: pen up
        let g = part;
        if (typeof part === 'string') { g = document.createElementNS(el.namespaceURI, 'path'); g.setAttribute('d', part); el.after(g); }
        const L = g.getTotalLength(), n = Math.max(1, Math.ceil(L / step));
        for (let i = s.length ? 1 : 0; i <= n; i++) { const p = g.getPointAtLength(L * i / n).matrixTransform(ctm); s.push([p.x, p.y]); }
        if (g !== el) g.remove();
      }
      if (s.length > 1) strokes.push(s);
    }
    if (!strokes.length) throw new Error('no drawable shapes in SVG');
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; // a loop: Math.min(...pts) overflows the stack on long paths
    for (const s of strokes) for (const [x, y] of s) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    mmPerUnit ??= 80 / Math.max(x1 - x0, y1 - y0, 1e-9);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
    return {
      strokes: strokes.map(s => simplify(s.map(([x, y]) => [(x - cx) * mmPerUnit, (cy - y) * mmPerUnit]), 0.002).map(p => p.map(r3))),
      w: r((x1 - x0) * mmPerUnit), h: r((y1 - y0) * mmPerUnit),
    };
  } finally { host.remove(); }
}

// Path data → one standalone path string per segment ("M x y C …", absolute), null for a moveto (pen up).
// S/T are expanded to C/Q, H/V become L, Z becomes a line back to the subpath start.
function segments(d) {
  const t = d.match(/[a-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) || [];
  const out = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, qx = 0, qy = 0, last = '';
  const num = () => +t[i++];
  while (i < t.length) {
    if (/[a-z]/i.test(t[i])) cmd = t[i++];
    else if (/z/i.test(cmd)) break; // numbers after Z: malformed
    const C = cmd.toUpperCase(), ox = cmd === C ? 0 : x, oy = cmd === C ? 0 : y, M = `M${x} ${y}`;
    let seg, nx, ny, cx = null, cy = null; // (cx, cy) = last control point, for S/T reflection
    if (C === 'M') { x = sx = num() + ox; y = sy = num() + oy; out.push(null); cmd = cmd === 'M' ? 'L' : 'l'; last = 'M'; continue; }
    if (C === 'Z') { seg = `L${sx} ${sy}`; nx = sx; ny = sy; }
    else if (C === 'L') { nx = num() + ox; ny = num() + oy; seg = `L${nx} ${ny}`; }
    else if (C === 'H') { nx = num() + ox; ny = y; seg = `L${nx} ${ny}`; }
    else if (C === 'V') { nx = x; ny = num() + oy; seg = `L${nx} ${ny}`; }
    else if (C === 'C' || C === 'S') {
      const [x1, y1] = C === 'C' ? [num() + ox, num() + oy] : /[CS]/.test(last) ? [2 * x - qx, 2 * y - qy] : [x, y];
      const x2 = num() + ox, y2 = num() + oy; nx = num() + ox; ny = num() + oy;
      seg = `C${x1} ${y1} ${x2} ${y2} ${nx} ${ny}`; cx = x2; cy = y2;
    } else if (C === 'Q' || C === 'T') {
      const [x1, y1] = C === 'Q' ? [num() + ox, num() + oy] : /[QT]/.test(last) ? [2 * x - qx, 2 * y - qy] : [x, y];
      nx = num() + ox; ny = num() + oy; seg = `Q${x1} ${y1} ${nx} ${ny}`; cx = x1; cy = y1;
    } else if (C === 'A') {
      const a = [num(), num(), num(), num(), num()]; nx = num() + ox; ny = num() + oy; seg = `A${a.join(' ')} ${nx} ${ny}`;
    } else break; // unknown command
    if (Number.isNaN(nx + ny)) break;
    out.push(M + seg);
    if (cx !== null) { qx = cx; qy = cy; }
    last = C; x = nx; y = ny;
    if (C === 'Z') { cmd = ''; }
  }
  return out;
}

// Ramer–Douglas–Peucker: drop points closer than tol to the line through their neighbours (straight runs → 1 move).
// Iterative, on index ranges: long paths (e.g. a spiral, 100k+ samples) would overflow the stack recursively.
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]];
  keep[0] = keep[pts.length - 1] = 1;
  while (stack.length) {
    const [i0, i1] = stack.pop(), a = pts[i0], b = pts[i1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
    let iMax = 0, dMax = 0;
    for (let i = i0 + 1; i < i1; i++) {
      const p = pts[i], d = L ? Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / L : Math.hypot(p[0] - a[0], p[1] - a[1]);
      if (d > dMax) { dMax = d; iMax = i; }
    }
    if (dMax > tol) { keep[iMax] = 1; stack.push([i0, iMax], [iMax, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}
