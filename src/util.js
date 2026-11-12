// Small helpers the other files share. Nothing clever lives here.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  SF.clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  SF.lerp = (a, b, t) => a + (b - a) * t;
  SF.sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  let idCounter = 0;
  SF.uid = prefix => prefix + (++idCounter).toString(36) + Math.random().toString(36).slice(2, 6);

  SF.pathLength = function (pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return len;
  };

  SF.distToSegment = function (px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = SF.clamp(t, 0, 1);
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  };

  // Ramer-Douglas-Peucker. A mouse drag gives us hundreds of points and most
  // of them say nothing new.
  SF.simplify = function (pts, eps) {
    if (pts.length < 3) return pts.map(p => p.slice());
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let maxD = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = SF.distToSegment(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > eps) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    return pts.filter((_, i) => keep[i]).map(p => p.slice());
  };

  // Chaikin corner cutting. Endpoints stay where the user put them.
  SF.smooth = function (pts, iterations = 2) {
    let out = pts;
    for (let n = 0; n < iterations && out.length > 2; n++) {
      const next = [out[0]];
      for (let i = 0; i < out.length - 1; i++) {
        const [ax, ay] = out[i], [bx, by] = out[i + 1];
        next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
        next.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
      }
      next.push(out[out.length - 1]);
      out = next;
    }
    return out;
  };

  // Evenly spaced points along a polyline.
  SF.resample = function (pts, step) {
    if (pts.length < 2 || !(step > 0)) return pts.map(p => p.slice());
    const out = [pts[0].slice()];
    let need = step;
    for (let i = 1; i < pts.length; i++) {
      let ax = pts[i - 1][0], ay = pts[i - 1][1];
      const bx = pts[i][0], by = pts[i][1];
      let seg = Math.hypot(bx - ax, by - ay);
      while (seg >= need) {
        const t = need / seg;
        ax += (bx - ax) * t;
        ay += (by - ay) * t;
        out.push([ax, ay]);
        seg -= need;
        need = step;
      }
      need -= seg;
    }
    const last = pts[pts.length - 1], prev = out[out.length - 1];
    if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) > step * 0.25) out.push(last.slice());
    return out;
  };

  // Calls fn(x, y, angle, distance) every `spacing` px along a path,
  // starting `offset` px in. Used for the little arrow marks on paths.
  SF.walkPath = function (pts, spacing, offset, fn) {
    let next = offset, travelled = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const seg = Math.hypot(bx - ax, by - ay);
      if (!seg) continue;
      while (next <= travelled + seg) {
        const t = (next - travelled) / seg;
        fn(ax + (bx - ax) * t, ay + (by - ay) * t, Math.atan2(by - ay, bx - ax), next);
        next += spacing;
      }
      travelled += seg;
    }
  };

  // Seeded value noise. Used for the sample picture and for breaking up the
  // pulse in the shader, so it only has to look natural, not be fast.
  SF.makeNoise = function (seed = 1) {
    let s = seed >>> 0;
    const rand = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const perm = new Uint8Array(512);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const values = new Float32Array(256).map(rand);

    function noise2(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf);
      const v = yf * yf * (3 - 2 * yf);
      const X = xi & 255, Y = yi & 255;
      const a = values[perm[perm[X] + Y]];
      const b = values[perm[perm[X + 1] + Y]];
      const c = values[perm[perm[X] + Y + 1]];
      const d = values[perm[perm[X + 1] + Y + 1]];
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }

    function fbm(x, y, octaves = 5) {
      let sum = 0, amp = 0.5, freq = 1, norm = 0;
      for (let i = 0; i < octaves; i++) {
        sum += amp * noise2(x * freq + i * 31.7, y * freq + i * 17.3);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      return sum / norm;
    }

    return { noise2, fbm, rand };
  };

  SF.download = function (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  SF.formatBytes = function (n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };
})();
