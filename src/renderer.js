// WebGL2 renderer. All the actual animation happens in the fragment shader.
//
// The trick is the same one games use for flowing water (look up "flow maps",
// Valve's Portal 2 water talk is the classic reference). You can't keep
// pushing pixels along the flow forever, the picture would smear into soup.
// So each pixel samples the photo a little way back along the flow, and that
// distance grows over one loop and then snaps back to zero. Two copies run
// half a cycle apart and crossfade, so the snap always happens on the copy
// that is currently invisible.
//
// One thing that took me a while to notice: because the two copies are
// identical apart from their offset, the picture repeats every HALF cycle,
// not every cycle. So a loop of L seconds uses a cycle of 2L seconds and
// uTime only runs from 0 to 0.5. At 0 and 0.5 every pixel is in exactly the
// same state, which is why the loop is seamless.
(function () {
  'use strict';
  const SF = window.SF = window.SF || {};

  const VERT = `#version 300 es
in vec2 aPos;
uniform vec4 uRect; // x, y, w, h in clip space
out vec2 vUv;
void main() {
  vUv = aPos;
  gl_Position = vec4(uRect.xy + aPos * uRect.zw, 0.0, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;

uniform sampler2D uImage;
uniform sampler2D uFlow;   // velocity, texture units per second
uniform sampler2D uMask;   // alpha = frozen
uniform sampler2D uNoise;  // smooth noise, offsets the pulse per area
uniform float uTime;       // 0..0.5 through the loop (see the note at the top)
uniform float uCycle;      // cycle length in seconds, twice the loop length
uniform float uSpeed;
uniform float uJitter;
uniform float uTint;       // how strongly to tint frozen areas
uniform float uStill;      // 1 = show the untouched photo

in vec2 vUv;
out vec4 outColor;

const int STEPS = 6;

vec2 velocity(vec2 uv) {
  return texture(uFlow, uv).xy * (1.0 - texture(uMask, uv).a);
}

// Step backwards through the field instead of jumping in a straight line,
// so things follow curved paths instead of cutting corners.
vec2 trace(vec2 uv, float seconds) {
  float h = seconds / float(STEPS);
  for (int i = 0; i < STEPS; i++) uv -= velocity(uv) * h;
  return uv;
}

void main() {
  float span = uSpeed * uCycle * (1.0 - uStill);
  float offset = texture(uNoise, vUv).r * uJitter;

  float pa = fract(uTime + offset);
  float pb = fract(uTime + offset + 0.5);

  // Centered on zero so the sharpest moment of each copy is the original photo.
  vec4 a = texture(uImage, trace(vUv, (pa - 0.5) * span));
  vec4 b = texture(uImage, trace(vUv, (pb - 0.5) * span));
  float wa = 1.0 - abs(2.0 * pa - 1.0);
  vec3 color = mix(b.rgb, a.rgb, wa);

  float frozen = texture(uMask, vUv).a;
  color = mix(color, vec3(1.0, 0.2, 0.36), frozen * uTint);
  outColor = vec4(color, 1.0);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader failed to compile: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  class Renderer {
    constructor(canvas) {
      const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
      });
      if (!gl) throw new Error('WebGL 2 is not available');
      this.gl = gl;
      this.canvas = canvas;
      this.hasImage = false;

      const prog = gl.createProgram();
      gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error('Shader failed to link: ' + gl.getProgramInfoLog(prog));
      }
      this.prog = prog;
      this.u = {};
      for (const name of ['uRect', 'uImage', 'uFlow', 'uMask', 'uNoise', 'uTime', 'uCycle', 'uSpeed', 'uJitter', 'uTint', 'uStill']) {
        this.u[name] = gl.getUniformLocation(prog, name);
      }

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      const aPos = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

      this.tex = {
        image: this.makeTexture(),
        flow: this.makeTexture(),
        mask: this.makeTexture(),
        noise: this.makeTexture(),
      };
      // Placeholders until real data shows up.
      gl.bindTexture(gl.TEXTURE_2D, this.tex.flow);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, 1, 1, 0, gl.RG, gl.FLOAT, new Float32Array(2));
      gl.bindTexture(gl.TEXTURE_2D, this.tex.mask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      this.uploadNoise();

      this.fbo = null;
      this.fboTex = null;
      this.fboSize = [0, 0];
    }

    makeTexture() {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    uploadNoise() {
      const gl = this.gl;
      const size = 64;
      const noise = SF.makeNoise(7);
      const raw = new Float32Array(size * size);
      let lo = Infinity, hi = -Infinity;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const v = noise.fbm(x / size * 2.2, y / size * 2.2, 3);
          raw[y * size + x] = v;
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      const data = new Uint8Array(size * size);
      for (let i = 0; i < raw.length; i++) data[i] = Math.round((raw[i] - lo) / (hi - lo) * 255);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.noise);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    }

    setImage(source) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex.image);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.hasImage = true;
    }

    setFlow(field) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex.flow);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, field.width, field.height, 0, gl.RG, gl.FLOAT, field.data);
    }

    setMask(canvas) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex.mask);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }

    resize(cssWidth, cssHeight, dpr) {
      const w = Math.max(1, Math.round(cssWidth * dpr));
      const h = Math.max(1, Math.round(cssHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.cssWidth = cssWidth;
      this.cssHeight = cssHeight;
    }

    // rect is where the photo sits on screen, in CSS pixels.
    draw(rect, params) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0.039, 0.039, 0.047, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!this.hasImage) return;
      const cw = this.cssWidth, ch = this.cssHeight;
      // Photo row 0 is the top, so the quad's y axis points down the screen.
      this.drawQuad([
        rect.x / cw * 2 - 1,
        1 - rect.y / ch * 2,
        rect.w / cw * 2,
        -rect.h / ch * 2,
      ], params);
    }

    // Renders one frame at an exact size and reads it back, top row first.
    renderPixels(width, height, params, out) {
      const gl = this.gl;
      if (!this.fbo || this.fboSize[0] !== width || this.fboSize[1] !== height) {
        this.releaseTarget();
        this.fboTex = this.makeTexture();
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        this.fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
        this.fboSize = [width, height];
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, width, height);
      // Photo top goes to framebuffer row 0, which readPixels returns first.
      this.drawQuad([-1, -1, 2, 2], params);
      const pixels = out || new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return pixels;
    }

    releaseTarget() {
      const gl = this.gl;
      if (this.fbo) gl.deleteFramebuffer(this.fbo);
      if (this.fboTex) gl.deleteTexture(this.fboTex);
      this.fbo = this.fboTex = null;
      this.fboSize = [0, 0];
    }

    drawQuad(rect, p) {
      const gl = this.gl, u = this.u;
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);

      const units = [['uImage', this.tex.image], ['uFlow', this.tex.flow], ['uMask', this.tex.mask], ['uNoise', this.tex.noise]];
      units.forEach(([name, tex], i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(u[name], i);
      });

      // p.time is 0..1 through the loop and p.loop is the loop length.
      gl.uniform4f(u.uRect, rect[0], rect[1], rect[2], rect[3]);
      gl.uniform1f(u.uTime, p.time * 0.5);
      gl.uniform1f(u.uCycle, p.loop * 2);
      gl.uniform1f(u.uSpeed, p.speed);
      gl.uniform1f(u.uJitter, p.jitter);
      gl.uniform1f(u.uTint, p.tint || 0);
      gl.uniform1f(u.uStill, p.still ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  SF.Renderer = Renderer;
})();
