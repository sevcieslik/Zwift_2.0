// Rasterises land-cover draw commands into soft class-weight maps off the main thread
// (OffscreenCanvas), so building a terrain patch doesn't make the ride stutter.
// in:  { res, ncls, priority:[class ids, low -> high], grass, water, cmds:[{c, fill, w, rings:[Float32Array x,y,...]}] }
// out: { w0, w1, w2 (RGBA weights), water (Uint8 mask) } — all transferred
self.onmessage = (e) => {
  const { id, res, ncls, priority, grass, water, cmds } = e.data;
  const cans = [];
  for (let k = 0; k < ncls; k++) {
    const c = new OffscreenCanvas(res, res);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
    cans.push(g);
  }
  for (const cmd of cmds) {
    const g = cans[cmd.c];
    g.beginPath();
    for (const r of cmd.rings) {
      for (let i = 0; i < r.length; i += 2) (i ? g.lineTo(r[i], r[i + 1]) : g.moveTo(r[i], r[i + 1]));
      if (cmd.fill) g.closePath();
    }
    if (cmd.fill) g.fill();
    else { g.lineWidth = cmd.w; g.stroke(); }
  }
  const N = res * res;
  const masks = cans.map((g) => g.getImageData(0, 0, res, res).data);
  const out = [new Uint8Array(N * 4), new Uint8Array(N * 4), new Uint8Array(N * 4)];
  const wmask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    let left = 1;
    for (let k = priority.length - 1; k >= 0 && left > 0.003; k--) {
      const c = priority[k];
      const a = masks[c][i * 4 + 3] / 255;
      if (!a) continue;
      const w = a * left;
      out[c >> 2][i * 4 + (c & 3)] = Math.round(w * 255);
      left -= w;
      if (c === water) wmask[i] = masks[c][i * 4 + 3];
    }
    if (left > 0.003) out[grass >> 2][i * 4 + (grass & 3)] += Math.round(left * 255);
  }
  self.postMessage({ id, w0: out[0], w1: out[1], w2: out[2], water: wmask }, [out[0].buffer, out[1].buffer, out[2].buffer, wmask.buffer]);
};
