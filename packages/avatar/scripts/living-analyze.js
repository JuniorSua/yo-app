/* Browser-side analysis used by build-living.mjs (ported from the goo-agents design prototype). Generated assets are committed; rerun only when the source renders change. */
const TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
function rgb2hsv([r, g, b]) {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, mx ? d / mx : 0, mx];
}
/* ================================ Image analysis ================================ */
// Measures each render once: outline box, bottom anchor, right flank, eyes, bottom profile.
async function analyze(src, bodyHue) {
  const im = new Image();
  im.src = src;
  await im.decode();
  const W = im.width,
    H = im.height,
    c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const at = (x, y) => (y * W + x) * 4;
  const isBody = (i) => {
    if (d[i + 3] < 200) return false;
    const [h, s, v] = rgb2hsv([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]);
    const dh = Math.abs(((h * 360 - bodyHue + 540) % 360) - 180);
    return s > 0.22 && v > 0.3 && dh < 46;
  };
  let x0 = W,
    y0 = H,
    x1 = 0,
    y1 = 0,
    bx0 = W,
    bx1 = 0,
    by0 = H,
    by1 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      if (d[i + 3] > 128) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      if (isBody(i)) {
        bx0 = Math.min(bx0, x);
        bx1 = Math.max(bx1, x);
        by0 = Math.min(by0, y);
        by1 = Math.max(by1, y);
      }
    }
  // Bottom anchor: centre of the lowest body rows.
  let sx = 0,
    n = 0;
  for (let y = by1 - 6; y <= by1; y++)
    for (let x = bx0; x <= bx1; x++)
      if (isBody(at(x, y))) {
        sx += x;
        n++;
      }
  const anchor = [n ? sx / n : (bx0 + bx1) / 2, by1];
  // Right flank at 78% down the body (below the earcups).
  const fy = Math.round(by0 + (by1 - by0) * 0.8);
  let fx = bx1;
  for (let x = bx1; x > bx0; x--)
    if (isBody(at(x, fy))) {
      fx = x;
      break;
    }
  // Bottom profile (lowest body pixel per column) for drip anchors.
  const bottomArr = new Float32Array(W).fill(by1);
  for (let x = bx0; x <= bx1; x++)
    for (let y = by1; y > by0; y--)
      if (isBody(at(x, y))) {
        bottomArr[x] = y;
        break;
      }
  const bottom = (x) => bottomArr[clamp(Math.round(x), 0, W - 1)];
  // Eyes: dark blobs fully ringed by body colour.
  const dark = new Uint8Array(W * H);
  for (let y = by0; y < by1; y++)
    for (let x = bx0; x < bx1; x++) {
      const i = at(x, y);
      if (d[i + 3] > 200 && 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] < 60) dark[y * W + x] = 1;
    }
  const lab = new Int32Array(W * H),
    eyes = [];
  let id = 0;
  for (let s = 0; s < W * H; s++) {
    if (!dark[s] || lab[s]) continue;
    id++;
    const st = [s];
    lab[s] = id;
    let cnt = 0,
      mx = 0,
      my = 0,
      a = W,
      b = 0,
      cc = H,
      dd = 0;
    while (st.length) {
      const q = st.pop(),
        x = q % W,
        y = (q / W) | 0;
      cnt++;
      mx += x;
      my += y;
      a = Math.min(a, x);
      b = Math.max(b, x);
      cc = Math.min(cc, y);
      dd = Math.max(dd, y);
      for (const r of [q + 1, q - 1, q + W, q - W])
        if (r >= 0 && r < W * H && dark[r] && !lab[r]) {
          lab[r] = id;
          st.push(r);
        }
    }
    if (cnt < 300) continue;
    const ex = (a + b) / 2,
      ey = (cc + dd) / 2,
      rx = (b - a) / 2 + 12,
      ry = (dd - cc) / 2 + 12;
    let ring = 0,
      ok = 0;
    for (let k = 0; k < 40; k++) {
      const t = (k / 40) * TAU,
        x = Math.round(ex + Math.cos(t) * rx),
        y = Math.round(ey + Math.sin(t) * ry);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      ring++;
      if (isBody(at(x, y))) ok++;
    }
    if (ok / ring > 0.8 && dd - cc > (b - a) * 1.2) eyes.push([mx / cnt, my / cnt, b - a, dd - cc]);
  }
  eyes.sort((p, q) => p[0] - q[0]);
  const eyes2 = eyes.slice(0, 2);
  // Headset map: large connected regions of dark, non-body-coloured pixels (band, cups, mic). Small dark
  // specks inside the body are shading, not headset. Eyes are excluded.
  const inEye = (x, y) =>
    eyes2.some(([ex, ey, ew, eh]) => ((x - ex) / (ew * 0.75)) ** 2 + ((y - ey) / (eh * 0.7)) ** 2 < 1);
  const cand = new Uint8Array(W * H);
  let total = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      if (d[i + 3] < 60) continue;
      total++;
      const [h, s2, v] = rgb2hsv([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]);
      const dh = Math.abs(((h * 360 - bodyHue + 540) % 360) - 180);
      if (v < 0.5 && (s2 < 0.62 || dh > 45) && !inEye(x, y)) cand[y * W + x] = 1;
    }
  const hs = new Uint8Array(W * H),
    seen = new Uint8Array(W * H);
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!cand[s0] || seen[s0]) continue;
    const st = [s0],
      comp = [];
    seen[s0] = 1;
    while (st.length) {
      const q = st.pop();
      comp.push(q);
      for (const r of [q + 1, q - 1, q + W, q - W])
        if (r >= 0 && r < W * H && cand[r] && !seen[r]) {
          seen[r] = 1;
          st.push(r);
        }
    }
    if (comp.length > total * 0.004) for (const q of comp) hs[q] = 1;
  }
  const mc = document.createElement("canvas");
  mc.width = W;
  mc.height = H;
  const mg = mc.getContext("2d");
  const md = mg.createImageData(W, H);
  for (let q = 0; q < W * H; q++) {
    const i = q * 4,
      a = d[i + 3];
    md.data[i] = hs[q] ? 255 : 0;
    md.data[i + 1] = a > 60 && !hs[q] ? 255 : 0;
    md.data[i + 2] = 0;
    md.data[i + 3] = 255;
  }
  mg.putImageData(md, 0, 0);
  // Soften the mask edges by a pixel so recolours blend into anti-aliased edges.
  const mask = document.createElement("canvas");
  mask.width = W;
  mask.height = H;
  const m2 = mask.getContext("2d");
  m2.filter = "blur(1.2px)";
  m2.drawImage(mc, 0, 0);
  const { clean, eyeTex } = removeEyes(d, W, H, eyes2);
  return {
    im,
    mask,
    clean,
    eyeTex,
    W,
    H,
    box: [x0, y0, x1, y1],
    body: [bx0, by0, bx1, by1],
    anchor,
    flank: [fx, fy],
    bottom,
    eyes: eyes2,
  };
}

/* ================================ Eye removal ================================ */
// Rebuilds the skin under each eye (harmonic fill from the surrounding skin + the surface grain copied
// from just below the eye), so eyes can be drawn as a separate, movable layer — and hidden cleanly for
// blinks, happy eyes and question marks. Also returns a matte of what "eye" is (incl. its glossy rim).
function removeEyes(d, W, H, eyes) {
  const clean = new Uint8ClampedArray(d);
  const region = new Float32Array(W * H),
    matte = new Float32Array(W * H);
  for (const [ex, ey, ew, eh] of eyes) {
    const rx = ew * 0.5 * 1.62 + 5,
      ry = eh * 0.5 * 1.34 + 5;
    const X0 = Math.max(1, Math.floor(ex - rx - 2)),
      X1 = Math.min(W - 2, Math.ceil(ex + rx + 2));
    const Y0 = Math.max(1, Math.floor(ey - ry - 2)),
      Y1 = Math.min(H - 2, Math.ceil(ey + ry + 2));
    const bw = X1 - X0 + 1,
      bh = Y1 - Y0 + 1;
    const dn = (x, y) => Math.hypot((x - ex) / rx, (y - ey) / ry);
    const ins = new Uint8Array(bw * bh);
    for (let y = Y0; y <= Y1; y++)
      for (let x = X0; x <= X1; x++) if (dn(x, y) < 1) ins[(y - Y0) * bw + (x - X0)] = 1;
    for (let ch = 0; ch < 3; ch++) {
      const F = new Float32Array(bw * bh);
      for (let y = Y0; y <= Y1; y++)
        for (let x = X0; x <= X1; x++) F[(y - Y0) * bw + (x - X0)] = d[(y * W + x) * 4 + ch];
      // Initial guess: average of row and column interpolation between the boundary pixels.
      const G = new Float32Array(F);
      for (let j = 0; j < bh; j++)
        for (let i = 0; i < bw; i++) {
          if (!ins[j * bw + i]) continue;
          let l = i;
          while (l > 0 && ins[j * bw + l]) l--;
          let r = i;
          while (r < bw - 1 && ins[j * bw + r]) r++;
          let t = j;
          while (t > 0 && ins[t * bw + i]) t--;
          let b = j;
          while (b < bh - 1 && ins[b * bw + i]) b++;
          const h = F[j * bw + l] + ((F[j * bw + r] - F[j * bw + l]) * (i - l)) / Math.max(1, r - l);
          const v = F[t * bw + i] + ((F[b * bw + i] - F[t * bw + i]) * (j - t)) / Math.max(1, b - t);
          G[j * bw + i] = (h + v) / 2;
        }
      // Relax to a smooth (harmonic) fill.
      for (let it = 0; it < 160; it++)
        for (let j = 1; j < bh - 1; j++)
          for (let i = 1; i < bw - 1; i++) {
            const k = j * bw + i;
            if (ins[k]) G[k] = 0.25 * (G[k - 1] + G[k + 1] + G[k - bw] + G[k + bw]);
          }
      // Surface grain (velvet fibres, satin micro-shading) borrowed from the skin just below the eye.
      const dy = Math.round(2 * ry + 6);
      for (let j = 0; j < bh; j++)
        for (let i = 0; i < bw; i++) {
          const k = j * bw + i;
          if (!ins[k]) continue;
          const x = X0 + i,
            y = Math.min(H - 4, Y0 + j + dy);
          let m = 0;
          for (let yy = -2; yy <= 2; yy++)
            for (let xx = -2; xx <= 2; xx++) m += d[((y + yy) * W + x + xx) * 4 + ch];
          const detail = d[(y * W + x) * 4 + ch] - m / 25;
          clean[((Y0 + j) * W + X0 + i) * 4 + ch] = G[k] + detail;
        }
    }
    for (let y = Y0; y <= Y1; y++)
      for (let x = X0; x <= X1; x++) {
        const q = y * W + x,
          n = dn(x, y);
        if (n >= 1) continue;
        region[q] = Math.max(region[q], 1 - smooth(0.84, 1, n));
        const i = q * 4,
          dist = Math.hypot(d[i] - clean[i], d[i + 1] - clean[i + 1], d[i + 2] - clean[i + 2]) / 255;
        matte[q] = Math.max(matte[q], smooth(0.06, 0.26, dist) * (1 - smooth(0.9, 1, n)));
      }
  }
  const cc = document.createElement("canvas");
  cc.width = W;
  cc.height = H;
  const cg = cc.getContext("2d");
  const cid = cg.createImageData(W, H);
  cid.data.set(clean);
  cg.putImageData(cid, 0, 0);
  const ec = document.createElement("canvas");
  ec.width = W;
  ec.height = H;
  const eg = ec.getContext("2d");
  const eid = eg.createImageData(W, H);
  for (let q = 0; q < W * H; q++) {
    eid.data[q * 4] = region[q] * 255;
    eid.data[q * 4 + 1] = matte[q] * 255;
    eid.data[q * 4 + 3] = 255;
  }
  eg.putImageData(eid, 0, 0);
  return { clean: cc, eyeTex: ec };
}
function smooth(a, b, x) {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
