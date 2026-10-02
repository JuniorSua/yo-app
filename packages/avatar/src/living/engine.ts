/**
 * One shared WebGL2 renderer for every living avatar on screen. Each avatar owns a small 2D canvas; per frame
 * the engine renders it into the shared GL canvas and copies the result over (browsers allow only ~16 WebGL
 * contexts, and a busy sidebar + timeline can show more avatars than that). Off-screen avatars and hidden
 * windows cost nothing; tiny avatars update at half rate; without WebGL2 a still picture is drawn instead.
 */
import type { Avatar as AvatarData } from "@yo/contracts";
import { LIVING_TEXTURES } from "./assets";
import { type LivingCharacterId, livingParts } from "./characters";
import { LIVING_META } from "./meta";
import { HU, type LivingFrame, type LivingMotion } from "./motion";
import { FS_BACK, FS_BLUR, FS_MESH, FS_RIM, VS_FULL, VS_MESH } from "./shaders";

/** The canvas is this much larger than the avatar's box, so tilts, glow and z's can spill out. */
export const OVER = 1.5;
const GL_SIZE = 512;
const FIELD = 256;
const YO_YELLOW: [number, number, number] = [1.0, 0.831, 0.231];

export interface LivingLayout {
  /** Stage units per texture pixel. */
  s: number;
  /** Character width in stage units. */
  wu: number;
  /** View in stage units: x, y, w, h (square). */
  view: [number, number, number, number];
}

const layouts = new Map<LivingCharacterId, LivingLayout>();
export function layoutFor(id: LivingCharacterId): LivingLayout {
  let l = layouts.get(id);
  if (l) return l;
  const m = LIVING_META[id];
  const [x0, y0, x1, y1] = m.box;
  const s = HU / (y1 - y0);
  const wu = (x1 - x0) * s;
  const cx = ((x0 + x1) / 2 - m.anchor[0]) * s;
  const cy = ((y0 + y1) / 2 - m.anchor[1]) * s;
  const side = Math.max(wu, HU) * 1.04 * OVER;
  l = { s, wu, view: [cx - side / 2, cy - side / 2, side, side] };
  layouts.set(id, l);
  return l;
}

export interface LivingSlot {
  canvas: HTMLCanvasElement;
  /** Avatar box size in CSS px. */
  size: number;
  living: NonNullable<AvatarData["living"]>;
  motion: LivingMotion;
  visible: boolean;
  /** Static render (reduced motion or animated=false): draw only when something changes. */
  still: boolean;
  dirty: boolean;
  shadow: boolean;
  acc: number;
  skip: number;
  ink: string;
  inkAge: number;
}

/* ---------------------------------- GL helpers ---------------------------------- */

interface Prog {
  p: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
}
function program(gl: WebGL2RenderingContext, vs: string, fs: string): Prog {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  const u: Prog["u"] = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i)!;
    u[info.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}
function texture(gl: WebGL2RenderingContext, src: TexImageSource, mip: boolean) {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  if (mip) gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function hex(h: string): [number, number, number] {
  return [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** A glossy "?" in the same ink as the render's eyes. */
function questionGlyph() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 320;
  const g = c.getContext("2d")!;
  g.translate(128, 160);
  g.scale(0.9, 0.9);
  g.translate(-128, -160);
  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = "#14162a";
  g.lineWidth = 50;
  g.beginPath();
  g.moveTo(66, 108);
  g.bezierCurveTo(66, 38, 190, 30, 192, 104);
  g.bezierCurveTo(194, 156, 128, 158, 128, 206);
  g.lineTo(128, 214);
  g.stroke();
  g.fillStyle = "#14162a";
  g.beginPath();
  g.arc(128, 276, 29, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.34)";
  g.lineWidth = 10;
  g.beginPath();
  g.moveTo(74, 92);
  g.bezierCurveTo(80, 60, 128, 46, 156, 62);
  g.stroke();
  g.fillStyle = "rgba(255,255,255,0.3)";
  g.beginPath();
  g.arc(118, 265, 7, 0, Math.PI * 2);
  g.fill();
  return c;
}

function loadImage(url: string) {
  const im = new Image();
  im.decoding = "async";
  im.src = url;
  return im.decode().then(() => im);
}

interface CharTex {
  color: HTMLImageElement;
  tex?: { color: WebGLTexture; clean: WebGLTexture; mask: WebGLTexture; eyes: WebGLTexture };
}

/* ---------------------------------- Engine ---------------------------------- */

class Engine {
  private gl: WebGL2RenderingContext | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private mesh!: Prog;
  private blur!: Prog;
  private back!: Prog;
  private rim!: Prog;
  private vaoMesh!: WebGLVertexArrayObject;
  private vaoFull!: WebGLVertexArrayObject;
  private nIdx = 0;
  private glyph!: WebGLTexture;
  private fbs: { t: WebGLTexture; f: WebGLFramebuffer }[] = [];
  private chars = new Map<LivingCharacterId, CharTex>();
  private loading = new Set<LivingCharacterId>();
  private slots = new Set<LivingSlot>();
  private raf = 0;
  private last = 0;
  reduced = false;

  constructor() {
    try {
      this.initGL();
    } catch {
      this.gl = null;
    }
    const mq = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    if (mq) {
      this.reduced = mq.matches;
      mq.addEventListener?.("change", () => {
        this.reduced = mq.matches;
        for (const s of this.slots) s.dirty = true;
        this.wake();
      });
    }
    document.addEventListener("visibilitychange", () => this.wake());
  }

  private initGL() {
    const c = document.createElement("canvas");
    c.width = GL_SIZE;
    c.height = GL_SIZE;
    // No MSAA/depth/stencil: silhouettes come from texture alpha (pixel-identical without MSAA, measured) and
    // nothing is depth-tested, so these buffers were pure GPU memory.
    const gl = c.getContext("webgl2", {
      premultipliedAlpha: false,
      antialias: false,
      alpha: true,
      depth: false,
      stencil: false,
    });
    if (!gl) return;
    c.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.gl = null;
      for (const ch of this.chars.values()) ch.tex = undefined;
      for (const s of this.slots) s.dirty = true;
      this.wake();
    });
    this.glCanvas = c;
    this.gl = gl;
    this.mesh = program(gl, VS_MESH, FS_MESH);
    this.blur = program(gl, VS_FULL, FS_BLUR);
    this.back = program(gl, VS_FULL, FS_BACK);
    this.rim = program(gl, VS_FULL, FS_RIM);
    const N = 40;
    const uv: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) uv.push(i / N, j / N);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i;
        idx.push(a, a + 1, a + N + 1, a + 1, a + N + 2, a + N + 1);
      }
    this.vaoMesh = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoMesh);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uv), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.mesh.p, "aUV");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    this.nIdx = idx.length;
    this.vaoFull = gl.createVertexArray()!;
    gl.bindVertexArray(this.vaoFull);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const pr of [this.blur, this.back, this.rim]) {
      const l = gl.getAttribLocation(pr.p, "aP");
      if (l >= 0) {
        gl.enableVertexAttribArray(l);
        gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
      }
    }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    this.glyph = texture(gl, questionGlyph(), true);
    for (let i = 0; i < 4; i++) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, FIELD, FIELD, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.fbs.push({ t, f });
    }
  }

  private ensure(id: LivingCharacterId): CharTex | undefined {
    const ch = this.chars.get(id);
    if (ch && (ch.tex || !this.gl)) return ch;
    if (this.loading.has(id)) return ch;
    this.loading.add(id);
    const urls = LIVING_TEXTURES[id];
    Promise.all([loadImage(urls.color), loadImage(urls.clean), loadImage(urls.mask), loadImage(urls.eyes)])
      .then(([color, clean, mask, eyes]) => {
        const entry: CharTex = { color };
        const gl = this.gl;
        if (gl) {
          const t = texture(gl, color, true);
          const af = gl.getExtension("EXT_texture_filter_anisotropic");
          if (af) gl.texParameterf(gl.TEXTURE_2D, af.TEXTURE_MAX_ANISOTROPY_EXT, 8);
          entry.tex = {
            color: t,
            clean: texture(gl, clean, true),
            mask: texture(gl, mask, true),
            eyes: texture(gl, eyes, true),
          };
        }
        this.chars.set(id, entry);
        for (const s of this.slots) if (s.living.character === id) s.dirty = true;
        this.wake();
      })
      .catch(() => {})
      .finally(() => this.loading.delete(id));
    return ch;
  }

  add(slot: LivingSlot) {
    this.slots.add(slot);
    this.ensure(slot.living.character);
    this.wake();
  }
  remove(slot: LivingSlot) {
    this.slots.delete(slot);
    this.releaseUnused();
  }

  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  /** Free GPU textures of characters nobody shows anymore (after a grace period, so navigating doesn't churn). */
  private releaseUnused() {
    if (this.releaseTimer) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      const used = new Set([...this.slots].map((s) => s.living.character));
      for (const [id, ch] of this.chars) {
        if (used.has(id) || this.loading.has(id)) continue;
        if (this.gl && ch.tex) for (const t of Object.values(ch.tex)) this.gl.deleteTexture(t);
        this.chars.delete(id);
      }
    }, 30_000);
  }

  wake() {
    if (!this.raf && typeof requestAnimationFrame === "function") {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private frame = (now: number) => {
    this.raf = 0;
    const dt = Math.min(50, now - this.last);
    this.last = now;
    if (document.hidden) return;
    let animating = false;
    for (const s of this.slots) {
      if (!s.visible) continue;
      const still = s.still || this.reduced;
      s.motion.still = still;
      if (still) {
        if (s.dirty) {
          s.dirty = false;
          this.draw(s, 16);
        }
        continue;
      }
      animating = true;
      s.acc += dt;
      s.skip = s.skip ? 0 : 1;
      if (s.size <= 30 && s.skip) continue; // tiny avatars: half rate
      this.draw(s, s.acc);
      s.acc = 0;
      s.dirty = false;
    }
    if (animating) this.raf = requestAnimationFrame(this.frame);
  };

  private draw(s: LivingSlot, dt: number) {
    const id = s.living.character;
    const lay = layoutFor(id);
    const f = s.motion.tick(dt, lay.wu);
    const ctx = s.canvas.getContext("2d");
    if (!ctx) return;
    const W = s.canvas.width;
    const H = s.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const ch = this.ensure(id);
    if (!ch) return;
    if (this.gl && ch.tex && this.glCanvas) {
      const px = Math.min(GL_SIZE, W);
      this.render(s, f, ch.tex, lay, px);
      ctx.drawImage(this.glCanvas, 0, GL_SIZE - px, px, px, 0, 0, W, H);
    } else {
      this.drawStill(ctx, ch.color, id, lay, W);
    }
    if (s.inkAge-- <= 0) {
      s.ink = getComputedStyle(s.canvas).color || "#888";
      s.inkAge = 90;
    }
    drawZzz(ctx, W, f, lay, s.ink);
  }

  private drawStill(
    ctx: CanvasRenderingContext2D,
    im: HTMLImageElement,
    id: LivingCharacterId,
    lay: LivingLayout,
    W: number,
  ) {
    const m = LIVING_META[id];
    const [vx, vy, vw] = lay.view;
    const k = W / vw;
    const x = ((0 - m.anchor[0]) * lay.s - vx) * k;
    const y = ((0 - m.anchor[1]) * lay.s - vy) * k;
    ctx.drawImage(im, x, y, m.w * lay.s * k, m.h * lay.s * k);
  }

  private render(
    s: LivingSlot,
    f: LivingFrame,
    tex: NonNullable<CharTex["tex"]>,
    lay: LivingLayout,
    px: number,
  ) {
    const gl = this.gl!;
    const m = LIVING_META[s.living.character];
    const parts = livingParts(s.living);
    const [A, T, N, Wd] = this.fbs as [
      (typeof this.fbs)[0],
      (typeof this.fbs)[0],
      (typeof this.fbs)[0],
      (typeof this.fbs)[0],
    ];
    const glow = f.glow > 0.002;

    const drawBody = (sil: boolean) => {
      const u = this.mesh.u;
      gl.useProgram(this.mesh.p);
      gl.bindVertexArray(this.vaoMesh);
      const bind = (unit: number, t: WebGLTexture, name: string) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.uniform1i(u[name]!, unit);
      };
      bind(0, tex.color, "uTex");
      bind(1, tex.mask, "uMask");
      bind(2, this.glyph, "uGlyph");
      bind(3, tex.clean, "uClean");
      bind(4, tex.eyes, "uEyeT");
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform2f(u.uTexSize!, m.w, m.h);
      const [x0, y0, x1, y1] = m.box;
      gl.uniform4f(u.uRect!, x0 - 12, y0 - 12, x1 + 12, y1 + 12);
      gl.uniform2f(u.uAnchor!, m.anchor[0], m.anchor[1]);
      gl.uniform1f(u.uScale!, lay.s);
      gl.uniform1f(u.uH!, HU);
      gl.uniform2f(u.uPos!, f.pos[0], f.pos[1]);
      gl.uniform2f(u.uSq!, f.sq[0], f.sq[1]);
      gl.uniform1f(u.uLean!, f.lean);
      gl.uniform1f(u.uShear!, f.shear);
      gl.uniform1f(u.uWob!, f.wob);
      gl.uniform1f(u.uT!, f.t);
      gl.uniform1f(u.uRipple!, f.ripple);
      gl.uniform1f(u.uRippleT!, f.rippleT);
      gl.uniform4f(u.uView!, ...lay.view);
      const [el, er] = m.eyes;
      gl.uniform4f(u.uEyeL!, ...(el ?? [0, 0, 1, 1]));
      gl.uniform4f(u.uEyeR!, ...(er ?? el ?? [0, 0, 1, 1]));
      gl.uniform2f(u.uGaze!, f.gaze[0] * (el?.[2] ?? 1), f.gaze[1] * (el?.[3] ?? 1));
      gl.uniform1f(u.uClose!, f.close);
      gl.uniform1f(u.uHappy!, f.happy);
      gl.uniform1f(u.uQuestion!, f.question);
      gl.uniform1f(u.uQPop!, f.qpop);
      gl.uniform1f(u.uSleep!, f.sleep);
      gl.uniform1f(u.uScreen!, f.screen);
      gl.uniform1f(u.uSil!, sil ? 1 : 0);
      gl.uniform3f(u.uRecolor!, ...parts.body.shift);
      const ramp = parts.headset.ramp;
      gl.uniform1f(u.uHsOn!, ramp ? 1 : 0);
      if (ramp) {
        gl.uniform3f(u.uHsDark!, ...hex(ramp[0]));
        gl.uniform3f(u.uHsLight!, ...hex(ramp[1]));
      }
      gl.drawElements(gl.TRIANGLES, this.nIdx, gl.UNSIGNED_SHORT, 0);
    };
    const full = (pr: Prog) => {
      gl.useProgram(pr.p);
      gl.bindVertexArray(this.vaoFull);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const blurInto = (src: typeof A, tmp: typeof A, dst: typeof A, units: number) => {
      const step = units * (FIELD / lay.view[2]);
      gl.useProgram(this.blur.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.blur.u.uT!, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.f);
      gl.bindTexture(gl.TEXTURE_2D, src.t);
      gl.uniform2f(this.blur.u.uDir!, step / FIELD, 0);
      full(this.blur);
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f);
      gl.bindTexture(gl.TEXTURE_2D, tmp.t);
      gl.uniform2f(this.blur.u.uDir!, 0, step / FIELD);
      full(this.blur);
    };

    gl.disable(gl.BLEND);
    if (glow) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, A.f);
      gl.viewport(0, 0, FIELD, FIELD);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      drawBody(true);
      blurInto(A, T, N, 0.29);
      blurInto(A, T, Wd, 1.05);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, px, px);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, px, px);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const b = this.back.u;
    gl.useProgram(this.back.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, N.t);
    gl.uniform1i(b.uNear!, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, Wd.t);
    gl.uniform1i(b.uWide!, 1);
    gl.uniform4f(b.uView!, ...lay.view);
    gl.uniform4f(b.uSh!, f.pos[0] * 0.6, 0.8, lay.wu * 0.42, 4.2);
    gl.uniform1f(b.uShA!, s.shadow ? f.shadowA : 0);
    gl.uniform1f(b.uGlow!, glow ? f.glow : 0);
    gl.uniform3f(b.uGlowCol!, ...YO_YELLOW);
    full(this.back);
    drawBody(false);
    if (glow) {
      const r = this.rim.u;
      gl.useProgram(this.rim.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, A.t);
      gl.uniform1i(r.uSil!, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, N.t);
      gl.uniform1i(r.uNear!, 1);
      gl.uniform1f(r.uGlow!, f.glow);
      gl.uniform3f(r.uGlowCol!, ...YO_YELLOW);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      full(this.rim);
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
  }
}

/** z z z drifting up from the head: they grow, sway and fade. */
function drawZzz(ctx: CanvasRenderingContext2D, W: number, f: LivingFrame, lay: LivingLayout, ink: string) {
  if (!f.zzz.length) return;
  const [vx, vy, vw] = lay.view;
  const unit = W / vw;
  const hx = (f.pos[0] + lay.wu * 0.24 - vx) * unit;
  const hy = (-HU * 0.74 - vy) * unit;
  ctx.save();
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = ink;
  for (const z of f.zzz) {
    const rise = 1 - (1 - z.p) ** 3;
    const size = unit * (5 + 5.5 * rise);
    const x = hx + unit * (2 + 9 * rise + 1.8 * Math.sin(z.p * Math.PI * 3));
    const y = hy - unit * (3 + 15 * rise);
    ctx.globalAlpha = z.a * Math.sin(Math.PI * Math.min(1, z.p * 1.05)) * 0.9;
    ctx.font = `700 ${size.toFixed(1)}px "Geist Variable", "Geist", ui-sans-serif, system-ui, sans-serif`;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.18 + 0.1 * rise);
    ctx.fillText("z", 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

let engine: Engine | null = null;
export function livingEngine(): Engine {
  engine ??= new Engine();
  return engine;
}
