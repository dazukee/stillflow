// A small animated GIF encoder. No dependencies, nothing fancy:
//   - one global palette (median cut), built from the first frame
//   - ordered dithering, which unlike error diffusion doesn't crawl between frames
//   - each frame after the first only stores the rectangle that changed, and
//     marks unchanged pixels transparent. Frozen areas never change, so for
//     this app that usually cuts the file size a lot.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  const TRANSPARENT = 255; // palette slot reserved for "same as last frame"

  // Median cut on a sample of the pixels. Returns a 768-byte palette with at
  // most `maxColors` real entries, plus how many it actually used.
  SF.buildPalette = function (rgba, maxColors = 255) {
    const total = rgba.length / 4;
    const stride = Math.max(1, Math.floor(total / 60000));
    const count = Math.floor(total / stride);
    const px = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      const j = i * stride * 4;
      px[i * 3] = rgba[j];
      px[i * 3 + 1] = rgba[j + 1];
      px[i * 3 + 2] = rgba[j + 2];
    }

    const idx = new Uint32Array(count).map((_, i) => i);
    const measure = (start, end) => {
      let lo = [255, 255, 255], hi = [0, 0, 0];
      for (let i = start; i < end; i++) {
        const k = idx[i] * 3;
        for (let c = 0; c < 3; c++) {
          const v = px[k + c];
          if (v < lo[c]) lo[c] = v;
          if (v > hi[c]) hi[c] = v;
        }
      }
      const ranges = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      const channel = ranges.indexOf(Math.max(...ranges));
      return { start, end, channel, range: ranges[channel] };
    };

    const boxes = [measure(0, count)];
    while (boxes.length < maxColors) {
      // Split the box that is both big and busy. Weighting by pixel count
      // spends colors where the picture actually is (skies, gradients).
      let best = -1, bestScore = 0;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        const score = b.range * (b.end - b.start);
        if (b.end - b.start > 1 && b.range > 0 && score > bestScore) { best = i; bestScore = score; }
      }
      if (best < 0) break;
      const b = boxes[best];
      const c = b.channel;
      const part = idx.subarray(b.start, b.end);
      part.sort((a, z) => px[a * 3 + c] - px[z * 3 + c]);
      const mid = b.start + ((b.end - b.start) >> 1);
      boxes.splice(best, 1, measure(b.start, mid), measure(mid, b.end));
    }

    const palette = new Uint8Array(768);
    boxes.forEach((b, i) => {
      let r = 0, g = 0, bl = 0;
      for (let j = b.start; j < b.end; j++) {
        const k = idx[j] * 3;
        r += px[k]; g += px[k + 1]; bl += px[k + 2];
      }
      const n = b.end - b.start || 1;
      palette[i * 3] = Math.round(r / n);
      palette[i * 3 + 1] = Math.round(g / n);
      palette[i * 3 + 2] = Math.round(bl / n);
    });
    return { palette, size: boxes.length };
  };

  // Returns map(rgba, width, height, out) -> palette indices.
  SF.makeQuantizer = function ({ palette, size }) {
    const cache = new Int16Array(32768).fill(-1);
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const STRENGTH = 9;

    function nearest(r, g, b) {
      let best = 0, bestD = Infinity;
      for (let i = 0; i < size; i++) {
        const dr = palette[i * 3] - r, dg = palette[i * 3 + 1] - g, db = palette[i * 3 + 2] - b;
        // Rough perceptual weights. Green matters most, blue least.
        const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    }

    return function map(rgba, width, height, out) {
      for (let y = 0; y < height; y++) {
        const row = (y & 3) * 4;
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const t = (bayer[row + (x & 3)] / 16 - 0.47) * STRENGTH;
          const r = SF.clamp(rgba[i * 4] + t, 0, 255) >> 3;
          const g = SF.clamp(rgba[i * 4 + 1] + t, 0, 255) >> 3;
          const b = SF.clamp(rgba[i * 4 + 2] + t, 0, 255) >> 3;
          const key = (r << 10) | (g << 5) | b;
          let v = cache[key];
          if (v < 0) v = cache[key] = nearest((r << 3) + 4, (g << 3) + 4, (b << 3) + 4);
          out[i] = v;
        }
      }
      return out;
    };
  };

  class ByteWriter {
    constructor(size = 1 << 16) {
      this.buf = new Uint8Array(size);
      this.pos = 0;
    }
    ensure(n) {
      if (this.pos + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.pos + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.pos));
      this.buf = next;
    }
    byte(b) { this.ensure(1); this.buf[this.pos++] = b; }
    u16(v) { this.byte(v & 255); this.byte((v >> 8) & 255); }
    bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.pos); this.pos += arr.length; }
    ascii(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
    result() { return this.buf.slice(0, this.pos); }
  }

  // GIF flavoured LZW. This follows the structure of the old Unix compress /
  // Jef Poskanzer GIFEncoder code, including the hash table with secondary
  // probing, because that version is known to agree with every decoder.
  function lzw(pixels, out) {
    const MIN_CODE = 8;
    const BITS = 12;
    const HSIZE = 5003;
    const MAXMAX = 1 << BITS;
    const htab = new Int32Array(HSIZE).fill(-1);
    const codetab = new Int32Array(HSIZE);
    const initBits = MIN_CODE + 1;
    const clearCode = 1 << MIN_CODE;
    const eofCode = clearCode + 1;

    let nBits = initBits;
    let maxcode = (1 << nBits) - 1;
    let freeEnt = clearCode + 2;
    let clearFlag = false;
    let acc = 0, accBits = 0;
    const block = new Uint8Array(255);
    let blen = 0;

    const flushBlock = () => {
      if (!blen) return;
      out.byte(blen);
      out.bytes(block.subarray(0, blen));
      blen = 0;
    };
    const pushByte = b => {
      block[blen++] = b;
      if (blen === 255) flushBlock();
    };
    const output = code => {
      acc |= code << accBits;
      accBits += nBits;
      while (accBits >= 8) {
        pushByte(acc & 255);
        acc >>= 8;
        accBits -= 8;
      }
      if (freeEnt > maxcode || clearFlag) {
        if (clearFlag) {
          nBits = initBits;
          maxcode = (1 << nBits) - 1;
          clearFlag = false;
        } else {
          nBits++;
          maxcode = nBits === BITS ? MAXMAX : (1 << nBits) - 1;
        }
      }
    };

    out.byte(MIN_CODE);
    output(clearCode);

    let ent = pixels[0];
    outer:
    for (let i = 1; i < pixels.length; i++) {
      const c = pixels[i];
      const fcode = (c << BITS) + ent;
      let h = (c << 4) ^ ent;

      if (htab[h] === fcode) { ent = codetab[h]; continue; }
      if (htab[h] >= 0) {
        const disp = h === 0 ? 1 : HSIZE - h;
        do {
          h -= disp;
          if (h < 0) h += HSIZE;
          if (htab[h] === fcode) { ent = codetab[h]; continue outer; }
        } while (htab[h] >= 0);
      }

      output(ent);
      ent = c;
      if (freeEnt < MAXMAX) {
        codetab[h] = freeEnt++;
        htab[h] = fcode;
      } else {
        htab.fill(-1);
        freeEnt = clearCode + 2;
        clearFlag = true;
        output(clearCode);
      }
    }

    output(ent);
    output(eofCode);
    if (accBits > 0) pushByte(acc & 255);
    flushBlock();
    out.byte(0); // block terminator
  }

  class GifWriter {
    constructor(width, height, palette) {
      this.width = width;
      this.height = height;
      this.prev = null;
      const o = this.out = new ByteWriter(width * height);

      o.ascii('GIF89a');
      o.u16(width);
      o.u16(height);
      o.byte(0xf7); // global color table, 8 bits per channel, 256 entries
      o.byte(0);    // background color
      o.byte(0);    // pixel aspect ratio
      o.bytes(palette);

      // NETSCAPE2.0 block: loop forever.
      o.byte(0x21); o.byte(0xff); o.byte(11);
      o.ascii('NETSCAPE2.0');
      o.byte(3); o.byte(1); o.u16(0); o.byte(0);
    }

    addFrame(indices, delay) {
      const { width: w, height: h } = this;
      let x0 = 0, y0 = 0, x1 = w - 1, y1 = h - 1;
      let pixels = indices;
      const first = !this.prev;

      if (first) {
        this.prev = indices.slice();
      } else {
        const prev = this.prev;
        x0 = w; y0 = h; x1 = -1; y1 = -1;
        for (let y = 0; y < h; y++) {
          let i = y * w;
          for (let x = 0; x < w; x++, i++) {
            if (indices[i] !== prev[i]) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              y1 = y;
            }
          }
        }
        if (x1 < 0) { x0 = y0 = x1 = y1 = 0; } // nothing changed, send one clear pixel
        const rw = x1 - x0 + 1, rh = y1 - y0 + 1;
        pixels = new Uint8Array(rw * rh);
        for (let y = 0; y < rh; y++) {
          let src = (y + y0) * w + x0;
          let dst = y * rw;
          for (let x = 0; x < rw; x++, src++, dst++) {
            const v = indices[src];
            pixels[dst] = v === prev[src] ? TRANSPARENT : v;
          }
        }
        prev.set(indices);
      }

      const o = this.out;
      // Graphic control extension. Disposal 1 = leave this frame in place so
      // the next one can draw on top of it.
      o.byte(0x21); o.byte(0xf9); o.byte(4);
      o.byte((1 << 2) | (first ? 0 : 1));
      o.u16(delay);
      o.byte(TRANSPARENT);
      o.byte(0);

      // Image descriptor, no local palette.
      o.byte(0x2c);
      o.u16(x0); o.u16(y0);
      o.u16(x1 - x0 + 1); o.u16(y1 - y0 + 1);
      o.byte(0);

      lzw(pixels, o);
    }

    finish() {
      this.out.byte(0x3b);
      return this.out.result();
    }
  }

  SF.GifWriter = GifWriter;
  SF.GIF_TRANSPARENT = TRANSPARENT;
})();
