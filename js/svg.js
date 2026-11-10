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
    const root = host.firstChild, bb = root.getBBox(), step = Math.max(bb.width, bb.height) / 500 || 1;
    const strokes = [];
    for (const el of root.querySelectorAll('path,line,polyline,polygon,rect,circle,ellipse')) {
      if (el.closest('defs,clipPath,mask,symbol,marker')) continue;
      const L = el.getTotalLength(), n = Math.max(1, Math.ceil(L / step)), ctm = el.getCTM();
      let s = [], prev = null;
      for (let i = 0; i <= n; i++) {
        const q = el.getPointAtLength(L * i / n);
        // a moveto inside a path shows up as a jump between consecutive samples → pen up
        if (prev && Math.hypot(q.x - prev.x, q.y - prev.y) > 2 * L / n) { if (s.length > 1) strokes.push(s); s = []; }
        const p = q.matrixTransform(ctm);
        s.push([p.x, p.y]); prev = q;
      }
      if (s.length > 1) strokes.push(s);
    }
    if (!strokes.length) throw new Error('no drawable shapes in SVG');
    const all = strokes.flat(), xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    mmPerUnit ??= 80 / Math.max(x1 - x0, y1 - y0, 1e-9);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, r = v => Math.round(v * 100) / 100;
    return {
      strokes: strokes.map(s => simplify(s.map(([x, y]) => [r((x - cx) * mmPerUnit), r((cy - y) * mmPerUnit)]), 0.02)),
      w: r((x1 - x0) * mmPerUnit), h: r((y1 - y0) * mmPerUnit),
    };
  } finally { host.remove(); }
}

// Ramer–Douglas–Peucker: drop points closer than tol to the line through their neighbours (straight runs → 1 move)
export function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts.at(-1)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  let iMax = 0, dMax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], d = L ? Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / L : Math.hypot(p[0] - a[0], p[1] - a[1]);
    if (d > dMax) { dMax = d; iMax = i; }
  }
  return dMax <= tol ? [a, b] : [...simplify(pts.slice(0, iMax + 1), tol).slice(0, -1), ...simplify(pts.slice(iMax), tol)];
}
