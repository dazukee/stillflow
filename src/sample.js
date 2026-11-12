// The "Try the sample" picture: a lake at sunset, painted from noise when you
// click the button. Bundling a real photo would mean bundling somebody's
// photo, and this way the repo stays tiny and the license stays simple.
//
// It also comes with paths, pins and a freeze mask already set up, so the
// first thing people see is something moving.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const smooth = (e0, e1, x) => {
    const t = SF.clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  const SKY = [
    [0.00, [26, 34, 80]],
    [0.40, [84, 64, 136]],
    [0.72, [214, 116, 118]],
    [0.90, [248, 166, 120]],
    [1.00, [255, 212, 150]],
  ];

  function skyAt(t) {
    for (let i = 1; i < SKY.length; i++) {
      if (t <= SKY[i][0]) {
        const [t0, c0] = SKY[i - 1], [t1, c1] = SKY[i];
        return mix(c0, c1, (t - t0) / (t1 - t0));
      }
    }
    return SKY[SKY.length - 1][1];
  }

  SF.makeSample = function () {
    const W = 1440, H = 900;
    const horizon = Math.round(H * 0.6);
    const n = SF.makeNoise(1873);
    const sun = { x: W * 0.64, y: horizon - 112, r: 30 };

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    const px = img.data;

    // Two mountain ranges. The near one drops away to the right so the sun
    // has somewhere to set.
    const far = new Float32Array(W), near = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const gap = 1 - 0.65 * Math.exp(-Math.pow((x - sun.x) / 260, 2));
      far[x] = horizon - (30 + 110 * n.fbm(x / 380, 3.7, 4)) * gap;
      const fall = 1 - smooth(0.3, 0.85, x / W) * 0.8;
      near[x] = horizon - (10 + 230 * Math.pow(n.fbm(x / 250 + 40, 8.1, 5), 1.7) * fall);
    }

    // Sky, clouds, mountains.
    for (let y = 0; y < horizon; y++) {
      const ty = y / horizon;
      const base = skyAt(ty);
      const band = smooth(0.02, 0.2, ty) * (1 - smooth(0.6, 0.86, ty));

      for (let x = 0; x < W; x++) {
        const dx = x - sun.x, dy = (y - sun.y) * 1.3;
        const d = Math.sqrt(dx * dx + dy * dy);
        let c = mix(base, [255, 222, 172], Math.min(1, Math.exp(-d / 230) * 0.5 + Math.exp(-d / 55) * 0.55));
        const disc = Math.hypot(dx, y - sun.y); // the glow is squashed, the sun isn't
        if (disc < sun.r + 2) c = mix(c, [255, 247, 224], SF.clamp((sun.r + 1 - disc) / 2, 0, 1));

        if (band > 0.001) {
          const wx = x / 300 + n.fbm(x / 520, y / 160, 3) * 1.7;
          const wy = y / 64;
          const dens = n.fbm(wx, wy, 5);
          const cover = smooth(0.5, 0.71, dens) * band;
          if (cover > 0.002) {
            // Denser just above means we're on the underside, which is where a
            // low sun lights a cloud.
            const above = n.fbm(wx, (y - 9) / 64, 4);
            const lit = SF.clamp(0.42 + (dens - above) * 7, 0, 1);
            const close = Math.exp(-Math.abs(x - sun.x) / 540);
            const dark = mix([54, 42, 94], [104, 66, 120], ty);
            const bright = mix([250, 142, 126], [255, 206, 162], close);
            c = mix(c, mix(dark, bright, lit * (0.5 + 0.5 * close)), Math.min(1, cover * 1.15));
          }
        }

        if (y >= far[x]) {
          const t = (y - far[x]) / (horizon - far[x] + 1);
          c = mix(mix(base, [132, 96, 150], 0.5), [104, 76, 134], t * 0.6);
          c = mix(c, [255, 200, 160], Math.exp(-d / 260) * 0.25);
        }
        if (y >= near[x]) {
          const t = (y - near[x]) / (horizon - near[x] + 1);
          const grain = (n.noise2(x / 7, y / 7) - 0.5) * 10;
          c = mix([60, 42, 82], [32, 24, 52], Math.min(1, t * 1.3));
          c = [c[0] + grain, c[1] + grain, c[2] + grain];
        }

        const i = (y * W + x) * 4;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }

    // Water: a rippled reflection of everything above the horizon.
    for (let y = horizon; y < H; y++) {
      const depth = (y - horizon) / (H - horizon);
      const mirror = 2 * horizon - y - 1;
      const water = mix([44, 36, 84], [16, 18, 42], depth);
      for (let x = 0; x < W; x++) {
        const ripple = (n.fbm(x / 70, y / (2.5 + depth * 9), 3) - 0.5) * (6 + 50 * depth);
        const sx = SF.clamp(Math.round(x + ripple), 0, W - 1);
        const sy = SF.clamp(Math.round(mirror + (n.noise2(x / 30, y / 4) - 0.5) * 8 * depth), 0, horizon - 1);
        const j = (sy * W + sx) * 4;
        let c = mix([px[j], px[j + 1], px[j + 2]], water, 0.26 + depth * 0.38);

        const streak = n.noise2(x / 220, y / 2.2);
        c = mix(c, [255, 196, 150], Math.max(0, streak - 0.7) * 0.7 * (1 - depth));

        // Glitter under the sun, widening as it comes toward us.
        const spread = 24 + 200 * depth;
        const column = Math.exp(-Math.pow((x - sun.x) / spread, 2));
        const spark = n.noise2(x / 5, y / 1.5);
        if (spark > 0.58) c = mix(c, [255, 238, 196], Math.min(1, column * (spark - 0.58) * 2.6));

        const i = (y * W + x) * 4;
        px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
      }
    }

    ctx.putImageData(img, 0, 0);

    // Dark shore with pines in the bottom left corner.
    const shoreEnd = W * 0.38;
    const shoreY = x => H * 0.76 + Math.pow(x / shoreEnd, 1.9) * H * 0.3 + (n.noise2(x / 40, 3.3) - 0.5) * 14;
    ctx.fillStyle = '#120d1f';
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= shoreEnd; x += 6) ctx.lineTo(x, shoreY(x));
    ctx.lineTo(shoreEnd, H);
    ctx.closePath();
    ctx.fill();

    const trees = [];
    for (let x = 14; x < W * 0.3; x += 22 + n.rand() * 34) {
      const base = shoreY(x) + 4;
      const h = (300 - x * 0.45) * (0.65 + n.rand() * 0.5);
      trees.push({ x, base, h });
      ctx.beginPath();
      const tiers = 7;
      for (let k = 0; k < tiers; k++) {
        const top = base - h + h * (k / tiers) * 0.84;
        const bottom = Math.min(base - h * 0.08, base - h + h * ((k + 1.7) / tiers) * 0.84);
        const half = h * 0.19 * (0.25 + 0.75 * (k + 1) / tiers) * (0.85 + n.rand() * 0.3);
        ctx.moveTo(x, top);
        ctx.lineTo(x + half, bottom);
        ctx.lineTo(x - half, bottom);
        ctx.closePath();
      }
      ctx.rect(x - 1.5, base - h * 0.12, 3, h * 0.12);
      ctx.fill();
    }

    const vignette = ctx.createRadialGradient(W / 2, H * 0.45, H * 0.35, W / 2, H * 0.45, W * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);

    return { canvas, preset: makePreset(W, H, horizon, sun, far, near, trees) };
  };

  function makePreset(W, H, horizon, sun, far, near, trees) {
    const flow = (points, speed, reach) => ({ id: SF.uid('f'), points, speed, reach });
    const pin = (x, y, radius) => ({ id: SF.uid('p'), x, y, radius });

    const flows = [
      flow([[W * 0.02, H * 0.13], [W * 0.35, H * 0.11], [W * 0.7, H * 0.13], [W * 0.98, H * 0.12]], 0.7, 100),
      flow([[W * 0.02, H * 0.27], [W * 0.4, H * 0.25], [W * 0.75, H * 0.27], [W * 0.98, H * 0.26]], 0.9, 100),
      flow([[W * 0.05, H * 0.4], [W * 0.5, H * 0.39], [W * 0.95, H * 0.41]], 0.6, 80),
      flow([[W * 0.98, H * 0.7], [W * 0.6, H * 0.71], [W * 0.3, H * 0.7]], 0.5, 70),
      flow([[W * 0.98, H * 0.86], [W * 0.7, H * 0.88], [W * 0.42, H * 0.9]], 0.75, 85),
    ];

    // Pins along the horizon keep the waterline crisp.
    const pins = [];
    for (let x = W * 0.42; x < W; x += W * 0.11) pins.push(pin(Math.round(x), horizon - 2, 34));

    // Freeze the mountains: trace the ridge, then fill below it in rows.
    const masks = [];
    const brush = 64;
    const top = x => Math.min(far[x], near[x]);
    const ridge = [];
    for (let x = 0; x < W; x += 16) ridge.push([x, Math.round(top(x) + brush * 0.35)]);
    ridge.push([W - 1, Math.round(top(W - 1) + brush * 0.35)]);
    masks.push({ mode: 'freeze', size: brush, softness: 0.45, points: ridge });

    let minTop = horizon;
    for (let x = 0; x < W; x++) minTop = Math.min(minTop, top(x));
    for (let y = minTop + brush * 0.8; y < horizon + brush * 0.2; y += brush * 0.55) {
      let start = -1;
      for (let x = 0; x <= W; x++) {
        const inside = x < W && top(x) < y - brush * 0.3;
        if (inside && start < 0) start = x;
        if (!inside && start >= 0) {
          masks.push({ mode: 'freeze', size: brush, softness: 0.3, points: [[start, Math.round(y)], [x - 1, Math.round(y)]] });
          start = -1;
        }
      }
    }

    // The sun should stay round, and the trees shouldn't sway.
    masks.push({ mode: 'freeze', size: sun.r * 3.2, softness: 0.6, points: [[Math.round(sun.x), Math.round(sun.y)]] });
    for (const t of trees) {
      masks.push({ mode: 'freeze', size: Math.max(30, t.h * 0.42), softness: 0.25, points: [[Math.round(t.x), Math.round(t.base - t.h * 0.15)], [Math.round(t.x), Math.round(t.base - t.h * 0.85)]] });
    }

    return { flows, pins, masks, settings: { speed: 1, cycle: 3 } };
  }
})();
