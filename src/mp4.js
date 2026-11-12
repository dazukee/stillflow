// Minimal MP4 muxer for a single H.264 track coming out of WebCodecs.
//
// The encoder gives us compressed frames, but browsers and phones want a
// proper .mp4 container around them. For one video track at a constant frame
// rate the container is small: a ftyp box, a moov box describing every
// sample, and an mdat box with the frames back to back. moov goes before
// mdat ("fast start") so the file plays before it has fully downloaded.
//
// Box layouts follow ISO/IEC 14496-12 and 14496-15.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  const TIMESCALE = 90000; // divides evenly by 24, 30 and 60 fps

  const u8 = v => Uint8Array.of(v & 255);
  const u16 = v => Uint8Array.of((v >> 8) & 255, v & 255);
  const u24 = v => Uint8Array.of((v >> 16) & 255, (v >> 8) & 255, v & 255);
  const u32 = v => Uint8Array.of((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
  const ascii = s => Uint8Array.from(s, ch => ch.charCodeAt(0));

  function concat(parts) {
    const flat = [];
    (function walk(list) {
      for (const p of list) {
        if (p == null) continue;
        if (Array.isArray(p)) walk(p);
        else flat.push(p);
      }
    })(parts);
    const out = new Uint8Array(flat.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of flat) { out.set(p, pos); pos += p.length; }
    return out;
  }

  function box(type, ...parts) {
    const body = concat(parts);
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(ascii(type), 4);
    out.set(body, 8);
    return out;
  }

  const fullBox = (type, version, flags, ...parts) => box(type, u8(version), u24(flags), ...parts);

  const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);

  class Mp4Muxer {
    constructor({ width, height, fps }) {
      this.width = width;
      this.height = height;
      this.fps = fps;
      this.samples = [];
      this.avcC = null;
    }

    // Plug straight into VideoEncoder's output callback.
    add(chunk, meta) {
      const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
      if (desc && !this.avcC) {
        this.avcC = desc instanceof ArrayBuffer
          ? new Uint8Array(desc.slice(0))
          : new Uint8Array(desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength));
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      this.samples.push({
        data,
        key: chunk.type === 'key',
        pts: Math.round(chunk.timestamp * TIMESCALE / 1e6),
      });
    }

    finish() {
      if (!this.avcC) throw new Error('The video encoder never sent its H.264 settings (avcC)');
      const n = this.samples.length;
      const delta = Math.round(TIMESCALE / this.fps);

      // If the encoder used B-frames, presentation order differs from decode
      // order and we need composition offsets. Most browser encoders don't,
      // in which case every offset is 0 and the ctts box is skipped.
      let offsets = this.samples.map((s, i) => s.pts - i * delta);
      const shift = -offsets.reduce((m, o) => Math.min(m, o), 0);
      offsets = offsets.map(o => o + shift);

      const ftyp = box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));
      const mdatSize = 8 + this.samples.reduce((sum, s) => sum + s.data.length, 0);

      // The chunk offset lives inside moov, and moov's size doesn't depend on
      // the offset's value, so build it once to measure, then for real.
      let moov = this.moov(delta, offsets, shift, 0);
      moov = this.moov(delta, offsets, shift, ftyp.length + moov.length + 8);

      const out = new Uint8Array(ftyp.length + moov.length + mdatSize);
      out.set(ftyp, 0);
      out.set(moov, ftyp.length);
      let pos = ftyp.length + moov.length;
      new DataView(out.buffer).setUint32(pos, mdatSize);
      out.set(ascii('mdat'), pos + 4);
      pos += 8;
      for (const s of this.samples) {
        out.set(s.data, pos);
        pos += s.data.length;
      }
      return out;
    }

    moov(delta, offsets, shift, chunkOffset) {
      const { width: w, height: h, samples } = this;
      const n = samples.length;
      const duration = n * delta;
      const ms = Math.round(duration / TIMESCALE * 1000);

      const mvhd = fullBox('mvhd', 0, 0,
        u32(0), u32(0), u32(1000), u32(ms),
        u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
        MATRIX,
        u32(0), u32(0), u32(0), u32(0), u32(0), u32(0),
        u32(2));

      const tkhd = fullBox('tkhd', 0, 3,
        u32(0), u32(0), u32(1), u32(0), u32(ms),
        u32(0), u32(0), u16(0), u16(0), u16(0), u16(0),
        MATRIX,
        u32(w * 65536), u32(h * 65536));

      // Only needed when B-frames forced us to shift the timeline.
      const edts = shift
        ? box('edts', fullBox('elst', 0, 0, u32(1), u32(ms), u32(shift), u16(1), u16(0)))
        : null;

      const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0));
      const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii('vide'), u32(0), u32(0), u32(0), ascii('Stillflow\0'));
      const vmhd = fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
      const dinf = box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1)));

      const avc1 = box('avc1',
        new Uint8Array(6), u16(1),             // reserved, data_reference_index
        u16(0), u16(0), u32(0), u32(0), u32(0), // pre_defined / reserved
        u16(w), u16(h),
        u32(0x00480000), u32(0x00480000),       // 72 dpi
        u32(0), u16(1),
        new Uint8Array(32),                     // compressor name
        u16(0x0018), u16(0xffff),
        box('avcC', this.avcC));

      const stsd = fullBox('stsd', 0, 0, u32(1), avc1);
      const stts = fullBox('stts', 0, 0, u32(1), u32(n), u32(delta));

      let ctts = null;
      if (offsets.some(o => o !== 0)) {
        const runs = [];
        for (const o of offsets) {
          const last = runs[runs.length - 1];
          if (last && last[1] === o) last[0]++;
          else runs.push([1, o]);
        }
        ctts = fullBox('ctts', 0, 0, u32(runs.length), runs.map(([count, o]) => [u32(count), u32(o)]));
      }

      const keys = [];
      samples.forEach((s, i) => { if (s.key) keys.push(u32(i + 1)); });
      const stss = fullBox('stss', 0, 0, u32(keys.length), keys);
      const stsc = fullBox('stsc', 0, 0, u32(1), u32(1), u32(n), u32(1));
      const stsz = fullBox('stsz', 0, 0, u32(0), u32(n), samples.map(s => u32(s.data.length)));
      const stco = fullBox('stco', 0, 0, u32(1), u32(chunkOffset));

      const stbl = box('stbl', stsd, stts, ctts, stss, stsc, stsz, stco);
      const minf = box('minf', vmhd, dinf, stbl);
      const mdia = box('mdia', mdhd, hdlr, minf);
      const trak = box('trak', tkhd, edts, mdia);
      return box('moov', mvhd, trak);
    }
  }

  SF.Mp4Muxer = Mp4Muxer;
})();
