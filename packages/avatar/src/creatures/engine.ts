/**
 * One WebGL renderer (one context) for every creature avatar. The design is in docs/avatars/CREATURES.md.
 *
 * - **One live canvas.** Avatars of the agent you're viewing (chat header, empty-state hero, studio preview)
 *   ask to be live; the largest one on screen gets the renderer's own canvas, moved into its box, and is
 *   animated up to 30 times a second. Every other avatar is a still picture. The loop stops when the window
 *   is hidden or the canvas is offscreen, and draws one settled frame per change under reduced motion.
 * - **Still pictures.** Lists (sidebar, timeline, pickers) show cached pictures: one per (creature, pose,
 *   size bucket), drawn once with the same renderer and shared by every <img> as an object URL.
 * - With nothing live and no pictures to draw, the renderer and its GPU memory are released after a few
 *   seconds; the cached pictures stay.
 */
import * as THREE from "three";
import type { CreatureId, CreaturePose } from "./meta";
import { buildCreature, type Creature, createStage } from "./model";
import { liveFps, snapshotKey } from "./state";

/** Largest drawing buffer (device px) for the live canvas. */
const MAX_PX = 320;
/** Still pictures are drawn at twice their size and scaled down (antialiasing without MSAA). */
const STILL_SS = 2;
/** A calm, eyes-open moment of the motion cycle, used for still pictures and reduced motion. */
export const STILL_T = 1.2;
/** Release the renderer this long after the last live avatar leaves and the last picture is drawn. */
const RELEASE_MS = 5000;

export interface LiveSlot {
  /** Box the live canvas is moved into while this slot holds it. */
  host: HTMLElement;
  kind: CreatureId;
  pose: CreaturePose;
  /** CSS px (the largest visible slot gets the canvas). */
  size: number;
  /** On screen (IntersectionObserver). */
  visible: boolean;
  /** Static: reduced motion or animated={false}. Drawn only when something changes. */
  still: boolean;
  /** Seconds added to the clock so the motion doesn't restart in sync for every avatar. */
  seed: number;
  /** The engine gives (true) or takes back (false) the live canvas. */
  setLive(on: boolean): void;
  /** The renderer was lost (WebGL context lost): fall back to the drawn look. */
  onFail(): void;
}

/** No MSAA (4x the fill cost): the live canvas is always drawn at 2x its CSS size instead. */
const LIVE_SCALE = 2;

export class CreatureEngine {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly stage: ReturnType<typeof createStage>;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly slots = new Set<LiveSlot>();
  /** The slot holding the live canvas, and the creature drawn there. */
  private owner: LiveSlot | null = null;
  private liveCreature: { kind: CreatureId; creature: Creature } | null = null;
  private dirty = true;
  /** Creatures used for still pictures, one per kind. */
  private readonly stills = new Map<CreatureId, Creature>();
  private frame = 0;
  private last = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly reduced = matchMedia("(prefers-reduced-motion: reduce)");
  lost = false;
  disposed = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.dataset.creatureLive = "";
    // Throws when WebGL is unavailable; callers fall back to the drawn avatar.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: true,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.stage = createStage(this.renderer, { shadowMap: false, environment: false });
    this.camera = new THREE.PerspectiveCamera(24, 1, 0.1, 50);
    this.camera.position.set(0.25, 2.55, 8.6);
    this.camera.lookAt(0, 1.96, 0);
    this.canvas.addEventListener("webglcontextlost", this.onLost);
    document.addEventListener("visibilitychange", this.wake);
    this.reduced.addEventListener("change", this.onReduced);
  }

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
    for (const slot of [...this.slots]) slot.onFail();
    dropEngine(this);
  };

  private onReduced = () => {
    this.dirty = true;
    this.wake();
  };

  private render(creature: Creature, px: number) {
    if (this.canvas.width !== px || this.canvas.height !== px) this.renderer.setSize(px, px, false);
    this.stage.scene.add(creature.root);
    this.renderer.render(this.stage.scene, this.camera);
    this.stage.scene.remove(creature.root);
  }

  /* ----------------------------------- live ----------------------------------- */

  add(slot: LiveSlot) {
    this.cancelRelease();
    this.slots.add(slot);
    this.assign();
  }

  remove(slot: LiveSlot) {
    if (!this.slots.delete(slot)) return;
    this.assign();
    this.settle();
  }

  /** Call after changing a slot's kind, pose, size, visibility or stillness. */
  update(slot: LiveSlot) {
    if (!this.slots.has(slot)) return;
    this.assign();
    if (slot === this.owner) {
      this.dirty = true;
      this.wake();
    }
  }

  /** Gives the live canvas to the largest visible slot (the newest one on a tie). */
  private assign() {
    let best: LiveSlot | null = null;
    for (const s of this.slots) if (s.visible && (!best || s.size >= best.size)) best = s;
    // Offscreen: keep it where it is (pausing is enough), unless that slot is gone.
    if (!best && this.owner && this.slots.has(this.owner)) best = this.owner;
    if (best === this.owner) return;
    const previous = this.owner;
    this.owner = best;
    if (previous && this.slots.has(previous)) previous.setLive(false);
    if (!best) {
      this.canvas.remove();
      this.liveCreature?.creature.dispose();
      this.liveCreature = null;
      return;
    }
    best.host.appendChild(this.canvas);
    best.setLive(true);
    this.dirty = true;
    this.wake();
  }

  wake = () => {
    if (this.disposed || this.frame || document.hidden) return;
    this.frame = requestAnimationFrame(this.tick);
  };

  private tick = (now: number) => {
    this.frame = 0;
    const slot = this.owner;
    if (this.disposed || document.hidden || !slot || !slot.visible) return;
    const still = slot.still || this.reduced.matches;
    if (still && !this.dirty) return;
    if (!still && !this.dirty && now - this.last < 1000 / liveFps(slot.size, slot.pose) - 2) {
      this.frame = requestAnimationFrame(this.tick);
      return;
    }
    this.last = now;
    this.drawLive(slot, still, now);
    if (!still) this.frame = requestAnimationFrame(this.tick);
  };

  private drawLive(slot: LiveSlot, still: boolean, now: number) {
    this.dirty = false;
    if (this.liveCreature?.kind !== slot.kind) {
      this.liveCreature?.creature.dispose();
      this.liveCreature = { kind: slot.kind, creature: buildCreature(slot.kind, { detail: "avatar" }) };
    }
    const { creature } = this.liveCreature;
    creature.animate(still ? STILL_T : now / 1000 + slot.seed, slot.pose, 0, true);
    this.render(creature, Math.min(MAX_PX, Math.round(slot.size * LIVE_SCALE)));
  }

  /* ---------------------------------- stills ---------------------------------- */

  /** Draws one still picture onto a fresh 2D canvas. */
  still(kind: CreatureId, pose: CreaturePose, px: number): HTMLCanvasElement {
    this.cancelRelease();
    let creature = this.stills.get(kind);
    if (!creature) {
      creature = buildCreature(kind, { detail: "avatar" });
      this.stills.set(kind, creature);
    }
    // The same time twice settles the pose immediately (no laptop half-way out).
    creature.animate(STILL_T, pose, 0, true);
    creature.animate(STILL_T, pose, 0, true);
    this.render(creature, px * STILL_SS);
    const out = document.createElement("canvas");
    out.width = out.height = px;
    // Same task as the render, so the drawing buffer is still there. Then the live frame is put back
    // before the browser paints, so the live canvas never shows the picture.
    const ctx = out.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.canvas, 0, 0, px, px);
    }
    const owner = this.owner;
    if (owner?.visible && !document.hidden)
      this.drawLive(owner, owner.still || this.reduced.matches, performance.now());
    else this.dirty = true;
    return out;
  }

  /* --------------------------------- lifetime --------------------------------- */

  private cancelRelease() {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }

  /** Schedules the release once nothing needs the renderer. */
  settle() {
    if (this.slots.size || this.releaseTimer || pending > 0) return;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (!this.slots.size && pending === 0) dropEngine(this);
    }, RELEASE_MS);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelRelease();
    if (this.frame) cancelAnimationFrame(this.frame);
    document.removeEventListener("visibilitychange", this.wake);
    this.reduced.removeEventListener("change", this.onReduced);
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.remove();
    this.slots.clear();
    this.owner = null;
    this.liveCreature?.creature.dispose();
    this.liveCreature = null;
    for (const c of this.stills.values()) c.dispose();
    this.stills.clear();
    this.stage.dispose();
    this.renderer.dispose();
    if (!this.lost) this.renderer.forceContextLoss();
  }
}

let engine: CreatureEngine | null = null;
/** WebGL failed once: don't keep trying (every creature uses its drawn fallback). */
let unavailable = false;
let pending = 0;

function dropEngine(e: CreatureEngine) {
  if (engine === e) engine = null;
  e.dispose();
}

/** The shared engine; throws if WebGL isn't available. */
export function creatureEngine(): CreatureEngine {
  if (unavailable) throw new Error("WebGL unavailable");
  if (!engine) {
    try {
      engine = new CreatureEngine();
    } catch (err) {
      unavailable = true;
      throw err;
    }
  }
  return engine;
}

/** Test/diagnostics: is a renderer alive right now? */
export function creatureEngineAlive() {
  return !!engine;
}

/* ------------------------------ still picture cache ------------------------------ */

const stillUrls = new Map<string, string>();
const stillJobs = new Map<string, Promise<string>>();
/** Still pictures are drawn one after another, one per task. */
let queue: Promise<void> = Promise.resolve();

/** A ready still picture (object URL), if it has been drawn already. */
export function cachedStill(kind: CreatureId, pose: CreaturePose, px: number): string | undefined {
  return stillUrls.get(snapshotKey(kind, pose, px));
}

/**
 * The still picture for (kind, pose, px), drawn once and shared by every avatar that shows it. Rejects if
 * WebGL is unavailable (the avatar then keeps its drawn look).
 */
export function stillPicture(kind: CreatureId, pose: CreaturePose, px: number): Promise<string> {
  const key = snapshotKey(kind, pose, px);
  const ready = stillUrls.get(key);
  if (ready) return Promise.resolve(ready);
  let job = stillJobs.get(key);
  if (!job) {
    pending++;
    job = queue
      .then(() => new Promise<void>((r) => setTimeout(r, 0)))
      .then(() => {
        const canvas = creatureEngine().still(kind, pose, px);
        return new Promise<string>((resolve, reject) =>
          canvas.toBlob((blob) => (blob ? resolve(URL.createObjectURL(blob)) : reject(new Error("toBlob")))),
        );
      })
      .then((url) => {
        stillUrls.set(key, url);
        return url;
      })
      .finally(() => {
        pending--;
        stillJobs.delete(key);
        engine?.settle();
      });
    stillJobs.set(key, job);
    // Keep the queue going past failures (each caller handles its own rejection).
    queue = job.then(
      () => undefined,
      () => undefined,
    );
  }
  return job;
}
