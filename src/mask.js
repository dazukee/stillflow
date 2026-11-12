// The freeze mask lives on a plain 2D canvas: white = frozen. The document
// keeps the brush strokes as vectors, and this paints them. That keeps undo
// cheap and means the mask can always be rebuilt exactly.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  const MAX_SIDE = 1024; // the mask gets sampled smoothly anyway

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  class MaskPainter {
    constructor(width, height) {
      this.scale = Math.min(1, MAX_SIDE / Math.max(width, height));
      const w = Math.max(1, Math.round(width * this.scale));
      const h = Math.max(1, Math.round(height * this.scale));
      this.canvas = makeCanvas(w, h);   // what the renderer reads
      this.base = makeCanvas(w, h);     // all finished strokes
      this.ctx = this.canvas.getContext('2d');
      this.baseCtx = this.base.getContext('2d');
    }

    rebuild(strokes) {
      this.baseCtx.clearRect(0, 0, this.base.width, this.base.height);
      for (const s of strokes) this.paint(this.baseCtx, s);
      this.preview(null);
    }

    commit(stroke) {
      this.paint(this.baseCtx, stroke);
      this.preview(null);
    }

    // Finished strokes plus the one still being drawn.
    preview(stroke) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(this.base, 0, 0);
      if (stroke) this.paint(this.ctx, stroke);
    }

    paint(ctx, stroke) {
      const k = this.scale;
      const size = Math.max(1, stroke.size * k);
      const blur = size * stroke.softness * 0.5;
      const core = Math.max(1, size - blur);

      // Soft brush without per-dab gradients: draw the stroke far off to the
      // left and let only its blurred shadow land on the canvas. Shadows work
      // in every browser, ctx.filter doesn't.
      const shift = this.canvas.width + size * 4 + blur * 4;

      ctx.save();
      ctx.globalCompositeOperation = stroke.mode === 'thaw' ? 'destination-out' : 'source-over';
      ctx.shadowColor = '#fff';
      ctx.shadowBlur = blur;
      ctx.shadowOffsetX = shift;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = core;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const pts = stroke.points;
      ctx.moveTo(pts[0][0] * k - shift, pts[0][1] * k);
      if (pts.length === 1) {
        ctx.lineTo(pts[0][0] * k - shift + 0.01, pts[0][1] * k);
      } else {
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * k - shift, pts[i][1] * k);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  SF.MaskPainter = MaskPainter;
})();
