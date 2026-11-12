// Export dialog and the frame-by-frame encoders behind it.
//
// Frames are rendered offscreen at an exact size and an exact time, not
// recorded off the screen, so a 1-loop export is precisely one loop long and
// repeats with no visible seam.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};
  const $ = id => document.getElementById(id);

  // GIF frame delays are in hundredths of a second and browsers bump anything
  // under 2 up to 10, so 25 fps (4/100 s) is the sensible ceiling.
  const GIF_FPS = 25;
  const LOOP_CHOICES = [1, 2, 3, 5, 10];

  let deps = null;   // { app, renderer, toast }
  let job = null;    // the export in progress, if any

  const canEncodeMp4 = () => typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';

  SF.initExport = function (d) {
    deps = d;
    const dialog = $('export-dialog');
    for (const r of document.querySelectorAll('input[name=format]')) r.addEventListener('change', refresh);
    $('ex-fps').addEventListener('change', refresh);
    $('ex-go').addEventListener('click', run);
    $('ex-cancel').addEventListener('click', () => {
      if (job) job.cancelled = true;
      else dialog.close();
    });
    // Esc while encoding stops the export instead of hiding it.
    dialog.addEventListener('cancel', e => {
      if (job) {
        e.preventDefault();
        job.cancelled = true;
      }
    });
  };

  SF.openExport = function () {
    if (!deps.app.doc || deps.app.busy) return;
    $('video-kind').textContent = canEncodeMp4() ? 'MP4' : 'WebM';
    $('ex-progress').hidden = true;
    refresh();
    $('export-dialog').showModal();
  };

  function format() {
    return document.querySelector('input[name=format]:checked').value;
  }

  function outputSize(longSide, even) {
    const { width, height } = deps.app.doc;
    const s = longSide / Math.max(width, height);
    let w = Math.max(2, Math.round(width * s));
    let h = Math.max(2, Math.round(height * s));
    if (even) { w -= w % 2; h -= h % 2; } // H.264 wants even dimensions
    return { w, h };
  }

  function refresh() {
    const app = deps.app;
    const gif = format() === 'gif';
    const long = Math.max(app.doc.width, app.doc.height);

    const cap = gif ? 800 : 1920;
    const presets = gif ? [320, 480, 640, 800] : [480, 720, 1080, 1440, 1920];
    const sizes = presets.filter(s => s < Math.min(long, cap));
    sizes.push(Math.min(long, cap));

    const sizeSel = $('ex-size');
    const wanted = gif ? 480 : 1920;
    sizeSel.innerHTML = '';
    for (const s of sizes) {
      const { w, h } = outputSize(s, !gif);
      sizeSel.add(new Option(`${w} × ${h}`, s));
    }
    sizeSel.value = sizes.includes(wanted) ? wanted : sizes[sizes.length - 1];

    const fps = +$('ex-fps').value;
    const perLoop = Math.max(2, Math.round(app.settings.cycle * fps));
    const lengthSel = $('ex-length');
    const prev = lengthSel.value || '3';
    lengthSel.innerHTML = '';
    for (const n of LOOP_CHOICES) {
      const secs = (perLoop * n / fps).toFixed(1);
      lengthSel.add(new Option(`${n} ${n === 1 ? 'loop' : 'loops'} · ${secs} s`, n));
    }
    lengthSel.value = prev;

    for (const el of document.querySelectorAll('#export-dialog [data-video]')) el.hidden = gif;

    $('ex-note').textContent = gif
      ? 'GIFs only get 256 colors and grow fast, so keep them small. This one loops forever on its own.'
      : 'The end lines up with the start, so it loops cleanly in any player that repeats. Most social apps want at least 3 seconds.';
  }

  function setBusy(on) {
    deps.app.busy = on;
    for (const el of document.querySelectorAll('#export-dialog select, #export-dialog input')) el.disabled = on;
    $('ex-go').disabled = on;
    $('ex-cancel').textContent = on ? 'Stop' : 'Cancel';
    if (on) $('ex-progress').hidden = false;
  }

  function progress(fraction, text) {
    $('ex-bar').style.width = (fraction * 100).toFixed(1) + '%';
    $('ex-status').textContent = text;
  }

  function slug(name) {
    return (name || 'loop').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'loop';
  }

  async function run() {
    if (job) return;
    const { app, renderer } = deps;
    const gif = format() === 'gif';
    const fps = gif ? GIF_FPS : +$('ex-fps').value;
    const loops = gif ? 1 : +$('ex-length').value;
    const { w, h } = outputSize(+$('ex-size').value, !gif);
    const perLoop = Math.max(2, Math.round(app.settings.cycle * fps));
    const frames = perLoop * loops;

    const params = {
      loop: app.settings.cycle,
      speed: app.settings.speed,
      jitter: app.settings.jitter,
      tint: 0,
      still: false,
    };
    // Frame i lands at exactly i/perLoop through the loop, so the frame after
    // the last one would be frame 0 again.
    const render = (i, out) => renderer.renderPixels(w, h, { ...params, time: (i % perLoop) / perLoop }, out);

    const current = job = { cancelled: false };
    setBusy(true);
    progress(0, 'Starting…');

    let failed = false;
    try {
      const options = {
        width: w,
        height: h,
        fps,
        frames,
        render,
        isCancelled: () => current.cancelled,
        onProgress: (i, phase) => progress(i / frames, phase || `Rendering frame ${i} of ${frames}`),
      };
      const result = gif ? await encodeGif(options) : await encodeVideo(options);
      if (!result) {
        progress(0, 'Stopped.');
        return;
      }
      const filename = `stillflow-${slug(app.name)}.${result.ext}`;
      SF.download(result.blob, filename);
      $('export-dialog').close();
      deps.toast(`Saved ${filename} (${SF.formatBytes(result.blob.size)})`);
    } catch (err) {
      console.error(err);
      failed = true;
      progress(0, 'Export failed: ' + (err && err.message ? err.message : err));
    } finally {
      renderer.releaseTarget();
      job = null;
      setBusy(false);
      if (!failed && !$('export-dialog').open) $('ex-progress').hidden = true;
    }
  }

  // ---- video ----------------------------------------------------------------

  async function pickAvcConfig(width, height, fps) {
    // Pick the lowest H.264 level that fits, otherwise some encoders refuse
    // big frames. Values are [level byte, max macroblocks per frame, per second].
    const levels = [['1f', 3600, 108000], ['20', 5120, 216000], ['28', 8192, 245760], ['2a', 8704, 522240], ['32', 22080, 589824], ['33', 36864, 983040]];
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    const level = (levels.find(([, fs, rate]) => mbs <= fs && mbs * fps <= rate) || levels[levels.length - 1])[0];
    const bitrate = Math.round(SF.clamp(width * height * fps * 0.14, 1.5e6, 24e6));

    for (const profile of ['6400', '4d00', '42e0']) { // high, main, baseline
      const config = {
        codec: `avc1.${profile}${level}`,
        width,
        height,
        bitrate,
        framerate: fps,
        avc: { format: 'avc' },
      };
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return config;
      } catch (e) { /* try the next one */ }
    }
    return null;
  }

  async function encodeVideo(opts) {
    if (canEncodeMp4()) {
      const config = await pickAvcConfig(opts.width, opts.height, opts.fps);
      if (config) return encodeMp4(opts, config);
    }
    return encodeWithRecorder(opts);
  }

  async function encodeMp4({ width, height, fps, frames, render, onProgress, isCancelled }, config) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    const pixels = new Uint8Array(image.data.buffer);

    const muxer = new SF.Mp4Muxer({ width, height, fps });
    let error = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.add(chunk, meta),
      error: e => { error = e; },
    });
    encoder.configure(config);

    const frameUs = 1e6 / fps;
    for (let i = 0; i < frames; i++) {
      if (isCancelled()) {
        encoder.close();
        return null;
      }
      if (error) throw error;
      render(i, pixels);
      ctx.putImageData(image, 0, 0);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();

      // Don't let the encoder queue grow without bound on slow machines.
      while (encoder.encodeQueueSize > 6 && !error) await SF.sleep(2);
      onProgress(i + 1);
      if (i % 3 === 2) await SF.sleep(0);
    }

    onProgress(frames, 'Finishing up…');
    await encoder.flush();
    encoder.close();
    if (error) throw error;
    return { blob: new Blob([muxer.finish()], { type: 'video/mp4' }), ext: 'mp4' };
  }

  // Fallback for browsers without WebCodecs. MediaRecorder records in real
  // time, so this paces the frames and takes as long as the video is.
  async function encodeWithRecorder({ width, height, fps, frames, render, onProgress, isCancelled }) {
    if (typeof window.MediaRecorder !== 'function') {
      throw new Error("this browser can't record video. Try the GIF option instead.");
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(width, height);
    const pixels = new Uint8Array(image.data.buffer);

    const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find(t => MediaRecorder.isTypeSupported(t));
    if (!type) throw new Error("this browser can't record video. Try the GIF option instead.");

    const stream = canvas.captureStream(fps);
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8e6 });
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; });

    render(0, pixels);
    ctx.putImageData(image, 0, 0);
    recorder.start();
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      if (isCancelled()) {
        recorder.stop();
        await stopped;
        return null;
      }
      render(i, pixels);
      ctx.putImageData(image, 0, 0);
      onProgress(i + 1, `Recording frame ${i + 1} of ${frames} (this one runs in real time)`);
      const due = start + (i + 1) * 1000 / fps;
      await SF.sleep(Math.max(0, due - performance.now()));
    }
    recorder.stop();
    await stopped;
    const mime = type.split(';')[0];
    return { blob: new Blob(chunks, { type: mime }), ext: mime === 'video/mp4' ? 'mp4' : 'webm' };
  }

  // ---- gif ------------------------------------------------------------------

  async function encodeGif({ width, height, frames, render, onProgress, isCancelled }) {
    const rgba = new Uint8Array(width * height * 4);
    const indices = new Uint8Array(width * height);

    render(0, rgba);
    const palette = SF.buildPalette(rgba, 255);
    const quantize = SF.makeQuantizer(palette);
    const writer = new SF.GifWriter(width, height, palette.palette);
    const delay = Math.round(100 / GIF_FPS);

    for (let i = 0; i < frames; i++) {
      if (isCancelled()) return null;
      if (i > 0) render(i, rgba);
      quantize(rgba, width, height, indices);
      writer.addFrame(indices, delay);
      onProgress(i + 1);
      await SF.sleep(0);
    }
    return { blob: new Blob([writer.finish()], { type: 'image/gif' }), ext: 'gif' };
  }
})();
