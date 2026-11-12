// Turns the paths and pins you draw into a dense velocity field that the
// shader can sample.
//
// Every cell of a coarse grid takes a weighted vote. Each point along a path
// votes for "move in my direction", weighted by a gaussian of the distance.
// Pins vote very loudly for "don't move". And every cell also gets one quiet
// vote for "don't move" (STILLNESS), which is what makes the motion fade out
// as you get away from a path instead of spreading over the whole photo.
//
//   v(cell) = sum(w_i * v_i) / (STILLNESS + sum(w_i) + sum(pin weights))
//
// It's basically a normalized gaussian splat. Cheap, smooth, and it never
// produces anything faster than the paths that went into it.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  const STILLNESS = 1;
  const PIN_STRENGTH = 240;
  const GRID = 160; // cells along the long side

  // Speed 1.0 moves things about 3% of the photo's long side per second.
  SF.baseVelocity = (width, height) => Math.max(width, height) * 0.03;

  SF.buildFlowField = function ({ width, height, flows, pins }) {
    const scale = GRID / Math.max(width, height);
    const gw = Math.max(2, Math.round(width * scale));
    const gh = Math.max(2, Math.round(height * scale));
    const n = gw * gh;
    const sx = new Float32Array(n);
    const sy = new Float32Array(n);
    const wsum = new Float32Array(n).fill(STILLNESS);
    const base = SF.baseVelocity(width, height);

    function splat(cx, cy, sigma, strength, vx, vy) {
      const r = Math.ceil(sigma * 3);
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(gw - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(gh - 1, Math.ceil(cy + r));
      const k = 1 / (2 * sigma * sigma);
      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - cy;
        let i = y * gw + x0;
        for (let x = x0; x <= x1; x++, i++) {
          const dx = x + 0.5 - cx;
          const w = strength * Math.exp(-(dx * dx + dy * dy) * k);
          sx[i] += w * vx;
          sy[i] += w * vy;
          wsum[i] += w;
        }
      }
    }

    for (const flow of flows) {
      if (!flow.points || flow.points.length < 2) continue;
      // Sampling every reach/4 px keeps the "votes per unit length" constant,
      // so a path holds roughly 90% of its speed right next to it no matter
      // how big its reach is.
      const pts = SF.resample(flow.points, flow.reach / 4);
      if (pts.length < 2) continue;
      const sigma = Math.max(1, flow.reach * scale);
      const speed = base * flow.speed;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy) || 1;
        splat(pts[i][0] * scale, pts[i][1] * scale, sigma, 1, dx / len * speed, dy / len * speed);
      }
    }

    // The ring you see around a pin is two sigmas out. Inside it motion
    // drops below ~20%.
    for (const pin of pins) {
      splat(pin.x * scale, pin.y * scale, Math.max(1, pin.radius * scale * 0.5), PIN_STRENGTH, 0, 0);
    }

    // Store velocity in texture units per second so the shader doesn't need
    // to know the photo size.
    const data = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      data[i * 2] = sx[i] / wsum[i] / width;
      data[i * 2 + 1] = sy[i] / wsum[i] / height;
    }
    return { width: gw, height: gh, data };
  };
})();
