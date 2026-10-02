/**
 * Motion for living avatars (pure maths, no DOM). Units are "stage units": the character is Hu = 78 tall and
 * stands with its bottom centre at (0, 0); y grows downward.
 *
 * Modes (from the agent's state):
 *   asleep   idle / sleeping — eyes closed (curved lid), slow deep breathing, z z z
 *   working  eyes read a screen (saccades along lines, glance up to think) + full jello look-arounds
 *   question needs you — "?" eyes, curious tilt, Yo-yellow glow
 *   done     happy eyes, a nod and a bounce, then calm awake eyes
 *   alert    error — attentive, eyes glance around
 *   awake    decorative (e.g. chat headers) — calm, gently drifting eyes
 */
import type { AgentActivity } from "@yo/contracts";

export type LivingMode = "asleep" | "working" | "question" | "done" | "alert" | "awake";

export function livingMode(state: AgentActivity | undefined, quiet = false): LivingMode {
  if (quiet) return state === "working" ? "working" : state === "waiting" ? "question" : "awake";
  switch (state) {
    case "working":
      return "working";
    case "waiting":
      return "question";
    case "done":
      return "done";
    case "error":
      return "alert";
    default:
      return "asleep"; // idle + sleeping
  }
}

export const HU = 78;

export interface LivingFrame {
  pos: [number, number];
  sq: [number, number];
  lean: number;
  shear: number;
  wob: number;
  t: number;
  ripple: number;
  rippleT: number;
  close: number;
  happy: number;
  question: number;
  qpop: number;
  glow: number;
  sleep: number;
  screen: number;
  /** Eye offset as a fraction of the eye box (x of width, y of height). */
  gaze: [number, number];
  shadowA: number;
  /** z z z: progress 0..1 and opacity. */
  zzz: { p: number; a: number }[];
}

const TAU = Math.PI * 2;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a));
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const outBack = (t: number) => {
  const c1 = 1.7;
  return 1 + (c1 + 1) * (t - 1) ** 3 + c1 * (t - 1) ** 2;
};
function mulberry(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Impulse {
  t0: number;
  amp: number;
  w: number;
  tau: number;
  axis: "x" | "y";
}

export class LivingMotion {
  mode: LivingMode = "asleep";
  /** Reduced motion: hold still, but keep every state readable (closed eyes + z's, "?", glow, happy eyes). */
  still = false;
  t: number;
  private modeT = 0;
  private rand: () => number;
  private impulses: Impulse[] = [];
  private blinkAt: number;
  private happyUntil = 0;
  private nodAt = 0;
  private rippleAt = -1e9;
  private prevX = 0;
  private prevV = 0;
  private shear = 0;
  private shearV = 0;
  private pose = 0;
  private poseFrom = 0;
  private poseTo = 0;
  private poseT0 = 0;
  private nextLook = 0;
  private lookUntil = 0;
  private lookDir: number;
  private eye: [number, number] = [0, 0];
  private eyeTo: [number, number] = [0, 0];
  private readX = -0.5;
  private readLine = 0;
  private sacAt = 0;
  private thinkUntil = 0;
  private glanceAt = 0;
  private q = 0;
  private glow = 0;
  private tilt = 0;
  private sleep = 0;
  private screen = 0;
  private zzzPhase: number[];

  constructor(seed = 1, initial: LivingMode = "asleep") {
    this.rand = mulberry(seed * 7919 + 13);
    this.t = this.rand() * 4000;
    this.blinkAt = this.t + 1200 + this.rand() * 2500;
    this.lookDir = this.rand() < 0.5 ? -1 : 1;
    this.zzzPhase = [0, 1300, 2600].map((p) => p + this.rand() * 900);
    this.mode = initial;
    if (initial === "asleep") this.sleep = 1;
    if (initial === "question") this.q = this.glow = 1;
    if (initial === "working") this.screen = 1;
  }

  setMode(m: LivingMode) {
    if (m === this.mode) return;
    const was = this.mode;
    this.mode = m;
    this.modeT = this.t;
    if (was === "asleep") {
      this.kick(0.06, 2.6, 420, "y"); // waking up: a little stretch + blink
      this.blinkAt = this.t + 400;
    }
    if (m === "working") {
      this.kick(-0.045, 2.2, 380, "y");
      this.nextLook = this.t + 2400;
    }
    if (m === "question") {
      this.kick(-0.06, 2.6, 420, "y");
      this.kick(0.04, 2.6, 420, "x");
      this.blinkAt = this.t;
      this.rippleAt = this.t;
    }
    if (m === "done") {
      this.kick(0.05, 3, 520, "y");
      this.happyUntil = this.t + 2600;
      this.nodAt = this.t + 120;
    }
    if (m === "asleep") this.kick(-0.03, 1.6, 600, "y");
  }

  private kick(amp: number, hz: number, tau: number, axis: "x" | "y") {
    this.impulses.push({ t0: this.t, amp, w: (hz * TAU) / 1000, tau, axis });
    if (this.impulses.length > 16) this.impulses.shift();
  }
  private jig(axis: "x" | "y") {
    let v = 0;
    for (const k of this.impulses) {
      if (k.axis !== axis) continue;
      const a = this.t - k.t0;
      if (a >= 0) v += k.amp * Math.exp(-a / k.tau) * Math.sin(k.w * a);
    }
    return v;
  }

  tick(dt: number, wu: number): LivingFrame {
    this.t += dt;
    const t = this.t;
    const m = this.mode;
    const still = this.still;

    /* ---- Eyes ---- */
    let eyeSpeed = 90;
    if (m === "working") {
      if (t < this.thinkUntil) {
        this.eyeTo = [this.lookDir * 0.3 + 0.08 * Math.sin(t / 420), -0.28];
        eyeSpeed = 220;
      } else if (Math.abs(this.pose) > 0.5) {
        this.eyeTo = [this.lookDir * 0.5 + 0.06 * Math.sin(t / 300), -0.06 + 0.04 * Math.sin(t / 530)];
        eyeSpeed = 120;
      } else {
        // Reading: quick saccades along a line, hop back for the next, look up to think now and then.
        if (t >= this.sacAt) {
          this.readX += 0.2 + this.rand() * 0.12;
          if (this.readX > 0.5) {
            this.readX = -0.5;
            this.readLine = (this.readLine + 1) % 4;
            if (this.readLine === 0 && this.rand() < 0.7) this.thinkUntil = t + 650 + this.rand() * 500;
          }
          this.sacAt = t + 150 + this.rand() * 140;
        }
        this.eyeTo = [this.readX, 0.1 + this.readLine * 0.07];
        eyeSpeed = 45;
      }
    } else if (m === "question") {
      this.eyeTo = [0, -0.05 + 0.05 * Math.sin(t / 620)];
    } else if (m === "alert") {
      if (t > this.glanceAt) {
        this.eyeTo = [(this.rand() - 0.5) * 0.9, (this.rand() - 0.5) * 0.3];
        this.glanceAt = t + 700 + this.rand() * 900;
      }
      eyeSpeed = 70;
    } else if (m === "done" || m === "awake") {
      if (t > this.glanceAt) {
        this.eyeTo = this.eyeTo[0] ? [0, 0] : [this.rand() < 0.5 ? -0.45 : 0.45, (this.rand() - 0.5) * 0.12];
        this.glanceAt = t + (this.eyeTo[0] ? 900 + this.rand() * 500 : 1600 + this.rand() * 2200);
      }
      this.eyeTo = [this.eyeTo[0] + 0.05 * Math.sin(t / 900), this.eyeTo[1] + 0.03 * Math.sin(t / 1300)];
      eyeSpeed = 110;
    } else {
      this.eyeTo = [0, 0.05 * Math.sin(t / 2600)]; // asleep: eyes drift under the lids
    }
    if (still) this.eyeTo = [0, 0];
    const ek = still ? 1 : Math.min(1, dt / eyeSpeed);
    this.eye[0] += (this.eyeTo[0] - this.eye[0]) * ek;
    this.eye[1] += (this.eyeTo[1] - this.eye[1]) * ek;

    /* ---- Body: full look-arounds while working ---- */
    if (m === "working" && !still) {
      if (this.poseTo !== 0 && t >= this.lookUntil) {
        this.poseFrom = this.pose;
        this.poseTo = 0;
        this.poseT0 = t;
        this.nextLook = t + 2600 + this.rand() * 1400;
      } else if (this.poseTo === 0 && t >= this.nextLook) {
        this.lookDir = -this.lookDir;
        this.thinkUntil = 0;
        this.poseFrom = this.pose;
        this.poseTo = this.lookDir;
        this.poseT0 = t + 110; // eyes lead, body follows
        this.lookUntil = t + 1500 + this.rand() * 500;
      }
    } else if (this.poseTo !== 0) {
      this.poseFrom = this.pose;
      this.poseTo = 0;
      this.poseT0 = t;
    }
    this.pose = still ? 0 : lerp(this.poseFrom, this.poseTo, inOut(seg(t, this.poseT0, this.poseT0 + 700)));
    // The renders sit in a slight three-quarter view (already leaning right): the left tilt gets more angle.
    const tiltK = this.pose < 0 ? 0.3 : 0.16;
    const x = this.pose * 3.2;
    const topX = x + this.pose * tiltK * HU * 0.7;
    const v = (topX - this.prevX) / Math.max(dt, 1);
    const acc = (v - this.prevV) / Math.max(dt, 1);
    this.prevX = topX;
    this.prevV = v;
    // Jello: the top is a damped spring pulled against the body's acceleration.
    this.shearV += (-0.00013 * this.shear - 0.0125 * this.shearV - acc * 9) * dt;
    this.shear = still ? 0 : clamp(this.shear + this.shearV * dt, -5.5, 5.5);

    /* ---- State easing ---- */
    const ease = (from: number, to: number, ms: number) =>
      still ? to : from + (to - from) * Math.min(1, dt / ms);
    const qT = m === "question" ? 1 : 0;
    this.q = ease(this.q, qT, qT ? 140 : 180);
    this.glow = ease(this.glow, qT, qT ? 380 : 260);
    this.tilt = ease(this.tilt, m === "question" ? 0.075 : 0, 420);
    this.sleep = ease(this.sleep, m === "asleep" ? 1 : 0, m === "asleep" ? 900 : 350);
    this.screen = ease(this.screen, m === "working" ? 1 : 0, 500);
    const qAge = m === "question" ? t - this.modeT : 1e9;
    const qpop = m === "question" ? (still ? 1 : outBack(seg(qAge, 160, 520))) : 0;
    const pulse = still ? 1 : 0.78 + 0.22 * Math.sin((t / 1700) * TAU);
    const flicker = 0.7 + 0.2 * Math.sin(t / 230) * Math.sin(t / 610) + 0.1 * Math.sin(t / 97);

    /* ---- Breathing, nod, lean ---- */
    const period = lerp(3600, 5600, this.sleep);
    const breathe = still
      ? 0
      : Math.sin((t / period) * TAU) * lerp(m === "working" ? 0.008 : 0.013, 0.02, this.sleep);
    const exhale = still ? 0 : this.sleep * 0.5 * (1 - Math.sin((t / period) * TAU));
    const sq: [number, number] = still
      ? [1 + 0.014 * this.sleep, 1 - 0.03 * this.sleep]
      : [
          1 - breathe * 0.6 + this.jig("x") + 0.014 * this.sleep,
          1 + breathe + this.jig("y") - 0.03 * this.sleep,
        ];
    let nod = 0;
    if (!still && this.nodAt && t > this.nodAt) {
      const a = t - this.nodAt;
      nod = a < 700 ? -0.07 * Math.sin((Math.PI * a) / 700) : 0;
    }
    const lean =
      this.pose * tiltK +
      this.tilt * (1 + (still ? 0 : 0.15 * Math.sin(t / 900))) +
      nod +
      this.sleep * (0.045 + 0.02 * exhale) +
      this.screen * 0.012;

    /* ---- Blink ---- */
    if (t > this.blinkAt + 150) this.blinkAt = t + (m === "working" ? 2600 : 3600) + this.rand() * 3000;
    const bp = seg(t, this.blinkAt, this.blinkAt + 150);
    const blink = !still && bp > 0 && bp < 1 ? Math.sin(Math.PI * bp) : 0;
    const close = Math.max(blink, this.sleep);
    const happy = (m === "done" && still) || (this.happyUntil && t < this.happyUntil) ? 1 : 0;
    const ripple = !still && t - this.rippleAt < 1400 ? 1.2 * Math.exp(-(t - this.rippleAt) / 420) : 0;

    return {
      pos: [x, 0],
      sq,
      lean,
      shear: this.shear,
      wob: still ? 0 : m === "working" ? 0.55 : 0.22 - 0.1 * this.sleep,
      t,
      ripple,
      rippleT: t - this.rippleAt,
      close: happy || this.q > 0.5 ? 0 : close,
      happy,
      question: m === "question" ? Math.max(this.q, 0.999) : this.q,
      qpop,
      glow: this.glow * pulse,
      sleep: this.sleep,
      screen: this.screen * (still ? 0.8 : flicker),
      gaze: [this.eye[0] * 0.42 * (1 - this.q), this.eye[1] * 0.42],
      shadowA: 0.3 * (wu > 0 ? 1 : 0),
      zzz:
        this.sleep > 0.05
          ? this.zzzPhase.map((ph, i) => ({
              p: still ? [0.25, 0.55, 0.85][i]! : ((t + ph) % 3900) / 3900,
              a: this.sleep,
            }))
          : [],
    };
  }
}
