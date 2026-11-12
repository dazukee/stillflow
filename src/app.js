// Wires everything together: document state, undo, the render loop, and the
// panel/toolbar UI.
(function () {
  'use strict';
  const SF = window.SF;
  const $ = id => document.getElementById(id);

  const MAX_SIDE = 2048; // bigger photos are scaled down when opened

  const TOOLS = {
    select: {
      title: 'Select',
      hint: 'Click a path or pin to edit it, drag to move it',
      help: 'Click a path to change its speed or reach, or a pin to change its size. Drag either one to move it.',
    },
    motion: {
      title: 'Motion path',
      hint: 'Drag in the direction things should flow',
      help: 'Draw along water, clouds, smoke or hair. Each path drags the area around it along, as far as its reach.',
    },
    pin: {
      title: 'Pin',
      hint: 'Click to pin something in place',
      help: 'A pin holds everything inside its ring still. Good for edges, like a horizon or a shoreline.',
    },
    freeze: {
      title: 'Freeze brush',
      hint: 'Paint over anything that should stay perfectly still. Hold Alt to erase.',
      help: 'Frozen areas never move, whatever paths are nearby. Use it on people, buildings, rocks, the sun.',
    },
    thaw: {
      title: 'Unfreeze',
      hint: 'Paint to bring frozen areas back to life',
      help: 'Erases the freeze mask. Hold Alt to paint freeze instead.',
    },
  };

  const app = SF.app = {
    doc: null,
    name: 'photo',
    settings: { speed: 1, cycle: 3, jitter: 0.35 },
    opts: { reach: 80, pinRadius: 50, brushSize: 80, softness: 0.4 },
    tool: 'motion',
    selection: null,
    draft: null,
    playing: true,
    time: 0,
    showGuides: true,
    showFrozen: true,
    comparing: false,
    busy: false,
  };

  const history = new SF.History();
  const dirty = { flow: false, mask: false, frame: true, overlay: true };
  const syncers = [];
  let renderer = null;
  let editor = null;
  let mask = null;

  // ---- hooks the editor calls -------------------------------------------------

  app.flowChanged = () => { dirty.flow = dirty.frame = dirty.overlay = true; };
  app.overlayChanged = () => { dirty.overlay = true; };
  app.viewChanged = () => {
    dirty.frame = dirty.overlay = true;
    $('zoom-label').textContent = Math.round(editor.view.scale * 100) + '%';
  };

  app.findItem = ref => {
    if (!ref || !app.doc) return null;
    const list = ref.kind === 'pin' ? app.doc.pins : app.doc.flows;
    return list.find(item => item.id === ref.id) || null;
  };

  app.select = ref => {
    app.selection = ref && app.findItem(ref) ? { kind: ref.kind, id: ref.id } : null;
    refreshSelection();
    dirty.overlay = true;
  };

  app.paintPreview = stroke => {
    mask.preview(stroke);
    dirty.mask = true;
  };

  app.paintCommit = stroke => {
    stroke.points = stroke.points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
    app.doc.masks.push(stroke);
    mask.commit(stroke);
    dirty.mask = true;
    app.commit();
  };

  app.commit = () => {
    if (history.push(serialize())) updateUndo();
    if (app.doc.flows.length) hideHintSoon();
  };

  app.revert = () => restore(history.current());

  // ---- document -------------------------------------------------------------

  function serialize() {
    const { flows, pins, masks } = app.doc;
    return JSON.stringify({ flows, pins, masks });
  }

  function restore(json) {
    const state = JSON.parse(json);
    Object.assign(app.doc, state);
    mask.rebuild(app.doc.masks);
    dirty.mask = true;
    app.select(app.selection); // drops the selection if that item is gone now
    app.flowChanged();
  }

  function undo() {
    if (app.busy || editor.action) return;
    const state = history.undo();
    if (state) { restore(state); updateUndo(); }
  }

  function redo() {
    if (app.busy || editor.action) return;
    const state = history.redo();
    if (state) { restore(state); updateUndo(); }
  }

  function updateUndo() {
    $('btn-undo').disabled = !history.canUndo;
    $('btn-redo').disabled = !history.canRedo;
  }

  function hasWork() {
    return app.doc && (app.doc.flows.length || app.doc.pins.length || app.doc.masks.length) && app.name !== 'sample';
  }

  function okToReplace() {
    return !hasWork() || confirm('Open a new photo? The paths, pins and frozen areas on this one will be lost.');
  }

  function toCanvas(source, w, h) {
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(w * scale));
    canvas.height = Math.max(2, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function openFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast("That doesn't look like an image.", true);
      return;
    }
    if (!okToReplace()) return;
    const url = URL.createObjectURL(file);
    try {
      // Plain onload instead of img.decode(): decode() can sit there forever
      // when the tab is in the background.
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('could not decode image'));
        img.src = url;
      });
      const canvas = toCanvas(img, img.naturalWidth, img.naturalHeight);
      startDocument(canvas, file.name.replace(/\.[^.]+$/, '') || 'photo');
    } catch (err) {
      console.error(err);
      toast("Couldn't read that image. If it's a HEIC photo from a phone, try a JPG or PNG.", true);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function loadSample() {
    if (!okToReplace()) return;
    const sample = SF.makeSample();
    startDocument(sample.canvas, 'sample', sample.preset);
    toast('This one is already set up. Click a path with the Select tool to see how.');
  }

  function startDocument(canvas, name, preset) {
    const w = canvas.width, h = canvas.height;
    const side = Math.max(w, h);

    app.doc = { width: w, height: h, flows: [], pins: [], masks: [] };
    if (preset) {
      app.doc.flows = preset.flows;
      app.doc.pins = preset.pins;
      app.doc.masks = preset.masks;
      Object.assign(app.settings, preset.settings || {});
    }
    app.name = name;
    app.selection = null;
    app.draft = null;
    app.time = 0;
    app.opts.reach = Math.round(side * 0.06);
    app.opts.pinRadius = Math.round(side * 0.035);
    app.opts.brushSize = Math.round(side * 0.06);
    setRangeLimits(side);

    renderer.setImage(canvas);
    mask = new SF.MaskPainter(w, h);
    mask.rebuild(app.doc.masks);
    dirty.mask = true;

    history.reset(serialize());
    updateUndo();

    $('empty').hidden = true;
    $('transport').hidden = false;
    $('btn-export').disabled = false;

    editor.fitted = true;
    editor.fit();
    setTool(preset ? 'select' : 'motion');
    setPlaying(true);
    refreshSelection();
    syncAll();
    app.flowChanged();
  }

  function deleteSelection() {
    const sel = app.selection;
    if (!sel) return;
    const list = sel.kind === 'pin' ? app.doc.pins : app.doc.flows;
    const i = list.findIndex(item => item.id === sel.id);
    if (i < 0) return;
    list.splice(i, 1);
    app.select(null);
    app.flowChanged();
    app.commit();
  }

  function clearAll() {
    if (!app.doc) return;
    if (!confirm('Remove every path, pin and frozen area?')) return;
    app.doc.flows = [];
    app.doc.pins = [];
    app.doc.masks = [];
    mask.rebuild([]);
    dirty.mask = true;
    app.select(null);
    app.flowChanged();
    app.commit();
  }

  // ---- tools, playback, view ------------------------------------------------

  function setTool(tool) {
    if (editor.action) return;
    app.tool = tool;
    for (const btn of document.querySelectorAll('.tool')) {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    }
    const info = TOOLS[tool];
    $('tool-title').textContent = info.title;
    $('tool-help').textContent = info.help;
    for (const el of document.querySelectorAll('#tool-section [data-for]')) {
      el.hidden = !el.dataset.for.split(' ').includes(tool);
    }
    editor.setHover(null);
    editor.updateCursor();
    showHint(info.hint);
    dirty.overlay = dirty.frame = true;
  }

  function setPlaying(on) {
    app.playing = on;
    $('btn-play').innerHTML = `<svg class="ico"><use href="#i-${on ? 'pause' : 'play'}"/></svg>`;
    $('btn-play').title = (on ? 'Pause' : 'Play') + ' (Space)';
    dirty.frame = true;
  }

  function setComparing(on) {
    if (app.comparing === on) return;
    app.comparing = on;
    $('btn-compare').classList.toggle('held', on);
    dirty.frame = dirty.overlay = true;
  }

  function setGuides(on) {
    app.showGuides = on;
    $('show-guides').checked = on;
    dirty.overlay = true;
  }

  let hintTimer = 0;
  function showHint(text) {
    const el = $('hint');
    if (!app.doc) { el.hidden = true; return; }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(hintTimer);
    // Keep the motion hint up until the first path exists. After that people
    // know the drill and the hint just gets in the way.
    if (app.doc.flows.length || app.tool !== 'motion') hideHintSoon();
  }

  function hideHintSoon() {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { $('hint').hidden = true; }, 4000);
  }

  // [ and ] resize whatever the current tool uses.
  function nudgeSize(dir) {
    const f = dir > 0 ? 1.15 : 1 / 1.15;
    const side = Math.max(app.doc.width, app.doc.height);
    const o = app.opts;
    if (app.tool === 'freeze' || app.tool === 'thaw') o.brushSize = SF.clamp(Math.round(o.brushSize * f), 2, side * 0.35);
    else if (app.tool === 'pin') o.pinRadius = SF.clamp(Math.round(o.pinRadius * f), 3, side * 0.2);
    else if (app.tool === 'motion') o.reach = SF.clamp(Math.round(o.reach * f), 4, side * 0.3);
    syncAll();
    dirty.overlay = true;
  }

  // ---- panel ----------------------------------------------------------------

  function bindRange(id, { get, set, format, commit }) {
    const input = $(id);
    const out = $(id + '-out');
    const paint = () => {
      const min = +input.min, max = +input.max;
      input.style.setProperty('--fill', ((input.value - min) / (max - min) * 100) + '%');
      if (out) out.textContent = format(+input.value);
    };
    input.addEventListener('input', () => { set(+input.value); paint(); });
    if (commit) input.addEventListener('change', commit);
    syncers.push(() => {
      const v = get();
      if (v != null) input.value = v;
      paint();
    });
  }

  function syncAll() { for (const fn of syncers) fn(); }

  function setRangeLimits(side) {
    const set = (id, min, max) => { $(id).min = Math.max(1, Math.round(min)); $(id).max = Math.round(max); };
    set('opt-reach', side * 0.01, side * 0.3);
    set('sel-reach', side * 0.01, side * 0.3);
    set('opt-pin', side * 0.005, side * 0.2);
    set('sel-pin', side * 0.005, side * 0.2);
    set('opt-brush', side * 0.003, side * 0.35);
  }

  const selectedFlow = () => app.selection && app.selection.kind === 'flow' ? app.findItem(app.selection) : null;
  const selectedPin = () => app.selection && app.selection.kind === 'pin' ? app.findItem(app.selection) : null;

  function refreshSelection() {
    const sel = app.selection;
    $('sel-section').hidden = !sel;
    if (!sel) return;
    $('sel-title').textContent = sel.kind === 'pin' ? 'Selected pin' : 'Selected path';
    for (const el of document.querySelectorAll('#sel-section [data-sel]')) {
      el.hidden = el.dataset.sel !== sel.kind;
    }
    syncAll();
  }

  function setupPanel() {
    const px = v => Math.round(v) + ' px';

    bindRange('speed', {
      get: () => app.settings.speed,
      set: v => { app.settings.speed = v; dirty.frame = true; },
      format: v => v.toFixed(2) + '×',
    });
    bindRange('cycle', {
      get: () => app.settings.cycle,
      set: v => { app.settings.cycle = v; dirty.frame = true; },
      format: v => v.toFixed(1) + ' s',
    });

    bindRange('opt-reach', { get: () => app.opts.reach, set: v => { app.opts.reach = v; }, format: px });
    bindRange('opt-pin', { get: () => app.opts.pinRadius, set: v => { app.opts.pinRadius = v; }, format: px });
    bindRange('opt-brush', { get: () => app.opts.brushSize, set: v => { app.opts.brushSize = v; dirty.overlay = true; }, format: px });
    bindRange('opt-soft', { get: () => app.opts.softness, set: v => { app.opts.softness = v; dirty.overlay = true; }, format: v => Math.round(v * 100) + '%' });

    const commit = () => app.commit();
    bindRange('sel-speed', {
      get: () => selectedFlow() && selectedFlow().speed,
      set: v => { const f = selectedFlow(); if (f) { f.speed = v; app.flowChanged(); } },
      format: v => v.toFixed(2) + '×',
      commit,
    });
    bindRange('sel-reach', {
      get: () => selectedFlow() && selectedFlow().reach,
      set: v => { const f = selectedFlow(); if (f) { f.reach = v; app.flowChanged(); } },
      format: px,
      commit,
    });
    bindRange('sel-pin', {
      get: () => selectedPin() && selectedPin().radius,
      set: v => { const p = selectedPin(); if (p) { p.radius = v; app.flowChanged(); } },
      format: px,
      commit,
    });

    $('sel-reverse').addEventListener('click', () => {
      const f = selectedFlow();
      if (!f) return;
      f.points.reverse();
      app.flowChanged();
      app.commit();
    });
    $('sel-delete').addEventListener('click', deleteSelection);
    $('btn-clear').addEventListener('click', clearAll);

    $('show-guides').addEventListener('change', e => setGuides(e.target.checked));
    $('show-frozen').addEventListener('change', e => { app.showFrozen = e.target.checked; dirty.frame = true; });

    syncAll();
  }

  // ---- misc UI --------------------------------------------------------------

  let toastTimer = 0;
  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 5500 : 3500);
  }
  SF.toast = toast;

  function setupDialogs() {
    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.addEventListener('click', e => {
        if (e.target.closest('[data-close]') || e.target === dialog) dialog.dispatchEvent(new Event('cancel', { cancelable: true })) && dialog.close();
      });
    }
    $('btn-shortcuts').addEventListener('click', () => $('keys-dialog').showModal());
  }

  function setupFileInput() {
    const input = $('file-input');
    const pick = () => { input.value = ''; input.click(); };
    $('btn-open').addEventListener('click', pick);
    $('empty-open').addEventListener('click', pick);
    input.addEventListener('change', () => openFile(input.files[0]));
    $('btn-sample').addEventListener('click', loadSample);
    $('empty-sample').addEventListener('click', loadSample);

    const dropzone = $('dropzone');
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
    let depth = 0;
    window.addEventListener('dragenter', e => {
      if (!hasFiles(e)) return;
      depth++;
      dropzone.classList.add('show');
    });
    window.addEventListener('dragleave', e => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) dropzone.classList.remove('show');
    });
    window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      dropzone.classList.remove('show');
      if (app.busy) return;
      openFile(Array.from(e.dataTransfer.files).find(f => f.type.startsWith('image/')) || e.dataTransfer.files[0]);
    });

    window.addEventListener('paste', e => {
      if (app.busy) return;
      const item = Array.from((e.clipboardData && e.clipboardData.items) || []).find(i => i.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        openFile(item.getAsFile());
      }
    });
  }

  function setupToolbar() {
    for (const btn of document.querySelectorAll('.tool')) {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    }
    $('btn-undo').addEventListener('click', undo);
    $('btn-redo').addEventListener('click', redo);
    $('btn-play').addEventListener('click', () => setPlaying(!app.playing));
    $('btn-fit').addEventListener('click', () => editor.fit());
    $('btn-export').addEventListener('click', () => SF.openExport());

    const compare = $('btn-compare');
    compare.addEventListener('pointerdown', e => { compare.setPointerCapture(e.pointerId); setComparing(true); });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      compare.addEventListener(type, () => setComparing(false));
    }

    const panel = $('panel');
    $('btn-panel').addEventListener('click', () => panel.classList.toggle('open'));
    $('overlay').addEventListener('pointerdown', () => panel.classList.remove('open'));
  }

  function setupKeys() {
    const dialogOpen = () => !!document.querySelector('dialog[open]');

    window.addEventListener('keydown', e => {
      const typing = e.target instanceof Element && e.target.matches('input[type=text], input[type=number], textarea, select');
      if (dialogOpen() || typing) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && key === 'y') { e.preventDefault(); redo(); return; }
      if (mod && key === 'o') { e.preventDefault(); $('file-input').click(); return; }
      if (mod || !app.doc || app.busy) return;

      switch (key) {
        case ' ':
          e.preventDefault();
          // A focused button would also "click" on space. Not what anyone wants here.
          if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
          if (!e.repeat) {
            editor.spaceDown = true;
            editor.spaceUsed = false;
            editor.updateCursor();
            dirty.overlay = true;
          }
          break;
        case 'v': setTool('select'); break;
        case 'a': case 'm': setTool('motion'); break;
        case 'p': setTool('pin'); break;
        case 'f': case 'b': setTool('freeze'); break;
        case 'e': setTool('thaw'); break;
        case '[': nudgeSize(-1); break;
        case ']': nudgeSize(1); break;
        case 'g': setGuides(!app.showGuides); break;
        case 'c': if (!e.repeat) setComparing(true); break;
        case '0': editor.fit(); break;
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          deleteSelection();
          break;
        case 'Escape':
          if (editor.action) editor.abort();
          else app.select(null);
          break;
      }
    });

    window.addEventListener('keyup', e => {
      if (e.key === ' ') {
        const panned = editor.spaceUsed;
        editor.spaceDown = false;
        editor.updateCursor();
        dirty.overlay = true;
        // Tap space to play/pause, hold it to pan. Same key, two jobs.
        if (!panned && app.doc && !app.busy && !dialogOpen()) setPlaying(!app.playing);
      } else if (e.key.toLowerCase() === 'c') {
        setComparing(false);
      }
    });

    window.addEventListener('blur', () => {
      editor.spaceDown = false;
      setComparing(false);
    });
  }

  // ---- main loop ------------------------------------------------------------

  function frameParams() {
    // Faint tint normally, stronger while you're actually painting the mask.
    const brushing = app.tool === 'freeze' || app.tool === 'thaw';
    return {
      time: app.time,
      loop: app.settings.cycle,
      speed: app.settings.speed,
      jitter: app.settings.jitter,
      tint: app.showFrozen && !app.comparing ? (brushing ? 0.45 : 0.16) : 0,
      still: app.comparing,
    };
  }

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!app.doc || app.busy) return;

    if (app.playing) {
      app.time = (app.time + dt / app.settings.cycle) % 1;
      dirty.frame = true;
    }
    if (dirty.flow) {
      dirty.flow = false;
      const { width, height, pins } = app.doc;
      const flows = app.draft ? app.doc.flows.concat([app.draft]) : app.doc.flows;
      renderer.setFlow(SF.buildFlowField({ width, height, flows, pins }));
      dirty.frame = true;
    }
    if (dirty.mask) {
      dirty.mask = false;
      renderer.setMask(mask.canvas);
      dirty.frame = true;
    }
    if (dirty.frame) {
      dirty.frame = false;
      renderer.draw(editor.imageRect(), frameParams());
    }
    if (dirty.overlay) {
      dirty.overlay = false;
      editor.draw();
    }
  }

  function layout() {
    const stage = $('stage');
    const w = stage.clientWidth, h = stage.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.resize(w, h, dpr);
    editor.resize(w, h, dpr);
    dirty.frame = dirty.overlay = true;
  }

  function init() {
    try {
      renderer = new SF.Renderer($('gl'));
    } catch (err) {
      console.error(err);
      $('no-webgl').hidden = false;
      for (const id of ['btn-open', 'btn-sample', 'empty-open', 'empty-sample']) $(id).disabled = true;
      return;
    }

    $('gl').addEventListener('webglcontextlost', e => {
      e.preventDefault();
      toast('The graphics card reset and Stillflow lost its canvas. Reload the page to keep going.', true);
    });

    editor = new SF.Editor(app, $('stage'), $('overlay'));
    setupPanel();
    setupToolbar();
    setupFileInput();
    setupKeys();
    setupDialogs();
    SF.initExport({ app, renderer, toast });

    new ResizeObserver(layout).observe($('stage'));
    layout();
    setTool('motion');
    requestAnimationFrame(frame);
  }

  init();
})();
