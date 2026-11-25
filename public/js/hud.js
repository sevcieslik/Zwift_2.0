// 2D overlays: elevation profile and mini map.

function setup(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

export class Profile {
  constructor(canvas, route) { this.c = canvas; this.r = route; }
  draw(riders) {
    const { g, w, h } = setup(this.c);
    const r = this.r, n = r.x.length;
    const pad = 4, top = 14;
    const span = Math.max(30, r.maxEle - r.minEle);
    const X = (d) => pad + (d / r.total) * (w - pad * 2);
    const Y = (e) => h - pad - ((e - r.minEle) / span) * (h - pad - top);
    g.clearRect(0, 0, w, h);
    const stride = Math.max(1, Math.floor(n / w));
    // fill coloured by gradient
    for (let i = 0; i < n - stride; i += stride) {
      const win = Math.max(stride, Math.round(150 / r.step));
      const a = Math.max(0, i - win), b = Math.min(n - 1, i + win);
      const gr = (r.ele[b] - r.ele[a]) / Math.max(1, r.dist[b] - r.dist[a]);
      g.fillStyle = gr > 0.08 ? '#d9433b' : gr > 0.04 ? '#f2a33a' : gr > 0.01 ? '#e7d85a' : gr < -0.02 ? '#5aa1e7' : '#9ccf6b';
      const x0 = X(r.dist[i]), x1 = X(r.dist[Math.min(n - 1, i + stride)]);
      g.fillRect(x0, Y(r.ele[i]), x1 - x0 + 0.6, h - pad - Y(r.ele[i]));
    }
    g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 1.2; g.beginPath();
    for (let i = 0; i < n; i += stride) { const x = X(r.dist[i]), y = Y(r.ele[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
    // riders
    const sorted = [...riders].sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
    for (const rd of sorted) {
      const i = Math.min(n - 1, Math.round(rd.dist / r.step));
      const x = X(rd.dist), y = Y(r.ele[i]);
      g.fillStyle = rd.color; g.strokeStyle = rd.me ? '#fff' : '#000'; g.lineWidth = rd.me ? 2.5 : 1;
      g.beginPath(); g.arc(x, y - 4, rd.me ? 6 : 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
      if (rd.me) { g.strokeStyle = 'rgba(255,255,255,.6)'; g.beginPath(); g.moveTo(x, top); g.lineTo(x, h - pad); g.stroke(); }
    }
  }
}

export class MiniMap {
  constructor(canvas, route) {
    this.c = canvas; this.r = route;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let i = 0; i < route.x.length; i++) {
      a = Math.min(a, route.x[i]); b = Math.max(b, route.x[i]);
      c = Math.min(c, route.y[i]); d = Math.max(d, route.y[i]);
    }
    this.bb = { minX: a, maxX: b, minY: c, maxY: d };
  }
  draw(riders) {
    const { g, w, h } = setup(this.c);
    const { minX, maxX, minY, maxY } = this.bb, r = this.r, n = r.x.length;
    const pad = 10;
    const s = Math.min((w - pad * 2) / (maxX - minX || 1), (h - pad * 2) / (maxY - minY || 1));
    const ox = (w - (maxX - minX) * s) / 2, oy = (h - (maxY - minY) * s) / 2;
    const P = (i) => [ox + (r.x[i] - minX) * s, h - (oy + (r.y[i] - minY) * s)];
    g.clearRect(0, 0, w, h);
    g.lineJoin = 'round';
    const stride = Math.max(1, Math.floor(n / 1500));
    for (const [col, lw] of [['rgba(0,0,0,.6)', 5], ['#f4f4f4', 2.5]]) {
      g.strokeStyle = col; g.lineWidth = lw; g.beginPath();
      for (let i = 0; i < n; i += stride) { const [x, y] = P(i); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    }
    const [sx, sy] = P(0);
    g.fillStyle = '#111'; g.fillRect(sx - 4, sy - 4, 8, 8);
    const sorted = [...riders].sort((a, b) => (a.me ? 1 : 0) - (b.me ? 1 : 0));
    for (const rd of sorted) {
      const [x, y] = P(Math.min(n - 1, Math.round(rd.dist / r.step)));
      g.fillStyle = rd.color; g.strokeStyle = rd.me ? '#fff' : '#000'; g.lineWidth = rd.me ? 2.5 : 1;
      g.beginPath(); g.arc(x, y, rd.me ? 6 : 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
    }
  }
}
