import { STRIDE } from './particles';

export interface Renderer {
  readonly kind: 'webgl2' | 'canvas2d';
  resize(w: number, h: number): void;
  draw(buf: Float32Array, count: number): void;
  destroy(): void;
}

const VS = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in vec3 inst;   // x, y, size (device px)
layout(location=2) in vec2 shade;  // gray, alpha
uniform vec2 res;
out vec2 vShade;
void main() {
  // 위치와 크기를 정수 픽셀에 맞춰 선명한 정사각형으로 래스터라이즈
  float s = max(1.0, floor(inst.z + 0.5));
  vec2 p = floor(inst.xy - s * 0.5 + 0.5) + corner * s;
  vec2 clip = p / res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  vShade = shade;
}`;

const FS = `#version 300 es
precision mediump float;
in vec2 vShade;
out vec4 o;
void main() {
  float g = vShade.x * vShade.y;   // premultiplied, R=G=B 이므로 항상 무채색
  o = vec4(g, g, g, vShade.y);
}`;

class GLRenderer implements Renderer {
  readonly kind = 'webgl2';
  private prog!: WebGLProgram;
  private vao!: WebGLVertexArrayObject;
  private instBuf!: WebGLBuffer;
  private quadBuf!: WebGLBuffer;
  private uRes!: WebGLUniformLocation;
  private capacity = 0;
  private w = 1; private h = 1;
  private lost = false;

  constructor(private canvas: HTMLCanvasElement, private gl: WebGL2RenderingContext) {
    this.init();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
  }

  private onLost = (e: Event) => { e.preventDefault(); this.lost = true; };
  private onRestored = () => { this.lost = false; this.capacity = 0; this.init(); this.resize(this.w, this.h); };

  private init() {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    this.prog = prog;
    this.uRes = gl.getUniformLocation(prog, 'res')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quadBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    const B = STRIDE * 4;
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, B, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, B, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 1);
  }

  resize(w: number, h: number) {
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  draw(buf: Float32Array, count: number) {
    if (this.lost) return;
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!count) return;
    gl.useProgram(this.prog);
    gl.uniform2f(this.uRes, this.w, this.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    if (buf.length > this.capacity) {
      gl.bufferData(gl.ARRAY_BUFFER, buf.byteLength, gl.DYNAMIC_DRAW);
      this.capacity = buf.length;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, buf, 0, count * STRIDE);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.bindVertexArray(null);
  }

  destroy() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    const gl = this.gl;
    gl.deleteBuffer(this.instBuf); gl.deleteBuffer(this.quadBuf);
    gl.deleteVertexArray(this.vao); gl.deleteProgram(this.prog);
  }
}

// WebGL2가 없을 때의 대체 경로
class Canvas2DRenderer implements Renderer {
  readonly kind = 'canvas2d';
  private styles = Array.from({ length: 64 }, (_, i) => {
    const g = Math.round((i / 63) * 255);
    return `rgb(${g},${g},${g})`;
  });
  private w = 1; private h = 1;

  constructor(private canvas: HTMLCanvasElement, private ctx: CanvasRenderingContext2D) {}

  resize(w: number, h: number) {
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
  }

  draw(buf: Float32Array, count: number) {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.w, this.h);
    for (let i = 0, k = 0; i < count; i++, k += STRIDE) {
      const s = Math.max(1, Math.round(buf[k + 2]));
      ctx.globalAlpha = buf[k + 4];
      ctx.fillStyle = this.styles[Math.round(buf[k + 3] * 63)];
      ctx.fillRect(Math.round(buf[k] - s / 2), Math.round(buf[k + 1] - s / 2), s, s);
    }
  }

  destroy() {}
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  if (gl) {
    try { return new GLRenderer(canvas, gl); } catch { /* 2D로 대체 */ }
  }
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('no canvas context');
  return new Canvas2DRenderer(canvas, ctx);
}
