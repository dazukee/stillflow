// Everything you do with the pointer on the photo: drawing paths, dropping
// pins, painting the freeze mask, panning and zooming. Also draws the guide
// overlay on top of the WebGL canvas.
//
// Document coordinates are always photo pixels. The view maps them to screen:
//   screen = photo * view.scale + (view.x, view.y)
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  const HIT = 9;              // px, how close counts as "on" a path or pin
  const MARK_SPACING = 70;    // px between the little chevrons on a path
  const ACCENT = '#4fe3c5';
  const PIN = '#ffb547';

  class Editor {
    constructor(app, stage, canvas) {
      this.app = app;
      this.stage = stage;
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.view = { scale: 1, x: 0, y: 0 };
      this.fitted = true;
      this.width = 0;
      this.height = 0;
      this.dpr = 1;

      this.pointers = new Map();
      this.action = null;
      this.hover = null;
      this.cursor = null;
      this.spaceDown = false;
      this.spaceUsed = false;

      canvas.addEventListener('pointerdown', e => this.onDown(e));
      canvas.addEventListener('pointermove', e => this.onMove(e));
      canvas.addEventListener('pointerup', e => this.onUp(e, false));
      canvas.addEventListener('pointercancel', e => this.onUp(e, true));
      canvas.addEventListener('pointerleave', () => {
        if (this.action) return;
        this.cursor = null;
        this.setHover(null);
        app.overlayChanged();
      });
      canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
      canvas.addEventListener('contextmenu', e => e.preventDefault());
    }

    // ---- view ---------------------------------------------------------------

    resize(width, height, dpr) {
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(width * dpr));
      this.canvas.height = Math.max(1, Math.round(height * dpr));
      if (this.fitted) this.fit();
    }

    fit() {
      const doc = this.app.doc;
      if (!doc) return;
      const narrow = this.width < 600;
      const side = narrow ? 12 : 40;
      const top = narrow ? 52 : 60;      // room for the hint
      const bottom = narrow ? 64 : 76;   // and for the transport bar
      const s = Math.min((this.width - side * 2) / doc.width, (this.height - top - bottom) / doc.height);
      const v = this.view;
      v.scale = Math.max(0.02, s);
      v.x = (this.width - doc.width * v.scale) / 2;
      v.y = top + (this.height - top - bottom - doc.height * v.scale) / 2;
      this.fitted = true;
      this.app.viewChanged();
    }

    zoomAt(sx, sy, factor) {
      const v = this.view;
      const doc = this.app.doc;
      const fitScale = Math.min(this.width / doc.width, this.height / doc.height);
      const next = SF.clamp(v.scale * factor, fitScale * 0.2, 24);
      const k = next / v.scale;
      v.x = sx - (sx - v.x) * k;
      v.y = sy - (sy - v.y) * k;
      v.scale = next;
      this.fitted = false;
      this.app.viewChanged();
    }

    imageRect() {
      const { doc } = this.app;
      const v = this.view;
      return { x: v.x, y: v.y, w: doc.width * v.scale, h: doc.height * v.scale };
    }

    toImage(p) { return [(p.x - this.view.x) / this.view.scale, (p.y - this.view.y) / this.view.scale]; }
    toScreen(q) { return { x: q[0] * this.view.scale + this.view.x, y: q[1] * this.view.scale + this.view.y }; }

    local(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    // ---- pointer ------------------------------------------------------------

    onDown(e) {
      const app = this.app;
      if (!app.doc) return;
      this.canvas.setPointerCapture(e.pointerId);
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      this.cursor = p;

      if (this.pointers.size === 2) {
        // Second finger landed: whatever the first one started becomes a pinch.
        this.abort();
        this.action = this.startPinch();
        return;
      }
      if (this.pointers.size > 2 || this.action) return;

      if (e.button === 1 || e.button === 2 || this.spaceDown) {
        this.spaceUsed = this.spaceDown;
        this.action = { type: 'pan', last: p };
        this.updateCursor();
        return;
      }
      if (e.button !== 0) return;

      const ip = this.toImage(p);
      const opts = app.opts;

      switch (app.tool) {
        case 'select': {
          const hit = this.hitTest(p);
          app.select(hit);
          if (hit) this.action = this.startMove(hit, ip, false);
          break;
        }
        case 'motion': {
          app.draft = { id: SF.uid('f'), points: [ip], speed: 1, reach: opts.reach };
          this.action = { type: 'draw', last: p };
          break;
        }
        case 'pin': {
          let hit = this.hitTest(p, 'pin');
          let created = false;
          if (!hit) {
            const pin = { id: SF.uid('p'), x: ip[0], y: ip[1], radius: opts.pinRadius };
            app.doc.pins.push(pin);
            hit = { kind: 'pin', id: pin.id };
            created = true;
            app.flowChanged();
          }
          app.select(hit);
          this.action = this.startMove(hit, ip, created);
          break;
        }
        case 'freeze':
        case 'thaw': {
          // Alt flips the brush, so you can fix a mistake without switching tools.
          const thaw = (app.tool === 'thaw') !== e.altKey;
          const stroke = { mode: thaw ? 'thaw' : 'freeze', size: opts.brushSize, softness: opts.softness, points: [ip] };
          this.action = { type: 'paint', stroke, last: p };
          app.paintPreview(stroke);
          break;
        }
      }
      app.overlayChanged();
    }

    onMove(e) {
      const app = this.app;
      const p = this.local(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
      this.cursor = p;
      const a = this.action;

      if (!a) {
        if (app.doc && (app.tool === 'select' || app.tool === 'pin')) {
          this.setHover(this.hitTest(p, app.tool === 'pin' ? 'pin' : null));
        }
        app.overlayChanged();
        return;
      }

      switch (a.type) {
        case 'pan':
          this.view.x += p.x - a.last.x;
          this.view.y += p.y - a.last.y;
          a.last = p;
          this.fitted = false;
          app.viewChanged();
          break;

        case 'pinch':
          this.updatePinch(a);
          break;

        case 'move': {
          const ip = this.toImage(p);
          const dx = ip[0] - a.start[0], dy = ip[1] - a.start[1];
          const item = app.findItem(a.item);
          if (!item) break;
          if (a.item.kind === 'pin') {
            item.x = a.origin.x + dx;
            item.y = a.origin.y + dy;
          } else {
            item.points = a.origin.map(([x, y]) => [x + dx, y + dy]);
          }
          a.moved = true;
          app.flowChanged();
          break;
        }

        case 'draw':
        case 'paint': {
          // Coalesced events give the real pointer path between frames, which
          // matters for fast strokes with a pen or a high-rate mouse.
          const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
          const list = events.length ? events.map(ev => this.local(ev)) : [p];
          const minGap = a.type === 'draw' ? 2.5 : 1.5;
          let added = false;
          for (const q of list) {
            if (Math.hypot(q.x - a.last.x, q.y - a.last.y) < minGap) continue;
            const ip = this.toImage(q);
            if (a.type === 'draw') app.draft.points.push(ip);
            else a.stroke.points.push(ip);
            a.last = q;
            added = true;
          }
          if (added) {
            if (a.type === 'draw') app.flowChanged();
            else app.paintPreview(a.stroke);
          }
          break;
        }
      }
      app.overlayChanged();
    }

    onUp(e, cancelled) {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const a = this.action;
      if (!a) return;

      if (a.type === 'pinch') {
        // Wait for every finger to lift so we don't start a stroke by accident.
        if (this.pointers.size === 0) this.action = null;
        return;
      }

      if (cancelled) {
        this.abort();
        return;
      }

      this.action = null;
      const app = this.app;
      switch (a.type) {
        case 'pan':
          this.updateCursor();
          break;
        case 'move':
          if (a.moved) {
            const item = app.findItem(a.item);
            const r = v => Math.round(v * 10) / 10;
            if (item && a.item.kind === 'pin') { item.x = r(item.x); item.y = r(item.y); }
            else if (item) item.points = item.points.map(([x, y]) => [r(x), r(y)]);
            app.commit();
          }
          break;
        case 'draw':
          this.finishPath();
          break;
        case 'paint':
          app.paintCommit(a.stroke);
          break;
      }
      app.overlayChanged();
    }

    onWheel(e) {
      if (!this.app.doc) return;
      e.preventDefault();
      const p = this.local(e);
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= 400;
      // ctrlKey is set for trackpad pinch gestures, which send tiny deltas.
      this.zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)));
    }

    startMove(item, start, created) {
      const found = this.app.findItem(item);
      const origin = item.kind === 'pin' ? { x: found.x, y: found.y } : found.points.map(q => q.slice());
      return { type: 'move', item, start, origin, moved: created };
    }

    startPinch() {
      const [a, b] = [...this.pointers.values()];
      return {
        type: 'pinch',
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        scale: this.view.scale,
        vx: this.view.x,
        vy: this.view.y,
      };
    }

    updatePinch(s) {
      const [a, b] = [...this.pointers.values()];
      if (!b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const doc = this.app.doc;
      const fitScale = Math.min(this.width / doc.width, this.height / doc.height);
      const scale = SF.clamp(s.scale * dist / s.dist, fitScale * 0.2, 24);
      // Keep the photo point that was under the fingers under the fingers.
      const ix = (s.mid.x - s.vx) / s.scale;
      const iy = (s.mid.y - s.vy) / s.scale;
      this.view.scale = scale;
      this.view.x = mid.x - ix * scale;
      this.view.y = mid.y - iy * scale;
      this.fitted = false;
      this.app.viewChanged();
    }

    finishPath() {
      const app = this.app;
      const draft = app.draft;
      app.draft = null;
      if (!draft) return;

      if (SF.pathLength(draft.points) * this.view.scale < 12) {
        // Too short to be a path, so it was probably a click on an existing one.
        app.select(this.hitTest(this.toScreen(draft.points[0])));
        app.flowChanged();
        return;
      }

      let pts = SF.simplify(draft.points, 1.2 / this.view.scale);
      pts = SF.smooth(pts, 2);
      draft.points = pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
      app.doc.flows.push(draft);
      app.select({ kind: 'flow', id: draft.id });
      app.flowChanged();
      app.commit();
    }

    // Throws away whatever the current drag was doing.
    abort() {
      const a = this.action;
      this.action = null;
      if (!a) return;
      const app = this.app;
      if (a.type === 'draw') {
        app.draft = null;
        app.flowChanged();
      } else if (a.type === 'paint') {
        app.paintPreview(null);
      } else if (a.type === 'move' && a.moved) {
        app.revert();
      }
      app.overlayChanged();
    }

    // ---- hit testing --------------------------------------------------------

    hitTest(p, only) {
      const doc = this.app.doc;
      if (!doc) return null;
      if (only !== 'flow') {
        for (let i = doc.pins.length - 1; i >= 0; i--) {
          const pin = doc.pins[i];
          const q = this.toScreen([pin.x, pin.y]);
          if (Math.hypot(p.x - q.x, p.y - q.y) <= HIT + 3) return { kind: 'pin', id: pin.id };
        }
      }
      if (only !== 'pin') {
        for (let i = doc.flows.length - 1; i >= 0; i--) {
          const pts = doc.flows[i].points.map(q => this.toScreen(q));
          for (let j = 1; j < pts.length; j++) {
            if (SF.distToSegment(p.x, p.y, pts[j - 1].x, pts[j - 1].y, pts[j].x, pts[j].y) <= HIT) {
              return { kind: 'flow', id: doc.flows[i].id };
            }
          }
        }
      }
      return null;
    }

    setHover(hit) {
      const same = hit && this.hover && hit.kind === this.hover.kind && hit.id === this.hover.id;
      if (!same && (hit || this.hover)) {
        this.hover = hit;
        this.app.overlayChanged();
      }
      this.updateCursor();
    }

    updateCursor() {
      const tool = this.app.tool;
      let c = 'default';
      if (this.action && this.action.type === 'pan') c = 'grabbing';
      else if (this.spaceDown) c = 'grab';
      else if (this.hover && (tool === 'select' || tool === 'pin')) c = 'move';
      else if (tool === 'motion' || tool === 'pin') c = 'crosshair';
      else if (tool === 'freeze' || tool === 'thaw') c = 'none';
      this.canvas.style.cursor = c;
    }

    // ---- overlay ------------------------------------------------------------

    draw() {
      const { ctx, app } = this;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!app.doc) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      const sel = app.selection;
      const is = (hit, kind, id) => hit && hit.kind === kind && hit.id === id;

      if (app.showGuides && !app.comparing) {
        for (const f of app.doc.flows) this.drawFlow(f, is(sel, 'flow', f.id), is(this.hover, 'flow', f.id));
        for (const pin of app.doc.pins) this.drawPin(pin, is(sel, 'pin', pin.id), is(this.hover, 'pin', pin.id));
      }
      if (app.draft) this.drawFlow(app.draft, true, false);

      const brush = app.tool === 'freeze' || app.tool === 'thaw';
      const panning = this.action && (this.action.type === 'pan' || this.action.type === 'pinch');
      if (brush && this.cursor && !panning && !this.spaceDown) this.drawBrush();
    }

    tracePath(pts) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }

    drawFlow(flow, selected, hovered) {
      const ctx = this.ctx;
      const pts = flow.points.map(q => this.toScreen(q));
      if (pts.length < 2) return;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (selected) {
        // A faint band showing how far this path's influence reaches.
        this.tracePath(pts);
        ctx.strokeStyle = 'rgba(79, 227, 197, 0.09)';
        ctx.lineWidth = flow.reach * 2 * this.view.scale;
        ctx.stroke();
      }

      this.tracePath(pts);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.lineWidth = 4.5;
      ctx.stroke();

      const color = selected ? ACCENT : hovered ? '#ffffff' : 'rgba(255, 255, 255, 0.85)';
      this.tracePath(pts);
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2.25 : 1.6;
      ctx.stroke();

      ctx.fillStyle = color;
      const total = SF.pathLength(pts.map(q => [q.x, q.y]));
      SF.walkPath(pts.map(q => [q.x, q.y]), MARK_SPACING, MARK_SPACING / 2, (x, y, angle, d) => {
        if (total - d > MARK_SPACING * 0.45) this.chevron(x, y, angle, 4.5);
      });

      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      this.chevron(b.x, b.y, Math.atan2(b.y - a.y, b.x - a.x), 7);

      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    chevron(x, y, angle, size) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(size * 0.6, 0);
      ctx.lineTo(-size * 0.9, -size * 0.85);
      ctx.lineTo(-size * 0.45, 0);
      ctx.lineTo(-size * 0.9, size * 0.85);
      ctx.closePath();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }

    drawPin(pin, selected, hovered) {
      const ctx = this.ctx;
      const c = this.toScreen([pin.x, pin.y]);
      const r = pin.radius * this.view.scale;

      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.setLineDash([4, 5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = selected ? ACCENT : hovered ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.45)';
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(c.x, c.y, selected ? 6.5 : 5.5, 0, Math.PI * 2);
      ctx.fillStyle = PIN;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = selected ? ACCENT : 'rgba(0, 0, 0, 0.6)';
      ctx.stroke();
    }

    drawBrush() {
      const ctx = this.ctx;
      const { x, y } = this.cursor;
      const opts = this.app.opts;
      const r = Math.max(2, opts.brushSize / 2 * this.view.scale);
      const inner = r * (1 - opts.softness * 0.5);

      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = '#fff';
      ctx.stroke();

      if (opts.softness > 0.05 && r > 8) {
        ctx.beginPath();
        ctx.arc(x, y, inner, 0, Math.PI * 2);
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  SF.Editor = Editor;
})();
