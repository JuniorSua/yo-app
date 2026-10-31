/**
 * The PC edition has no app updater: `yo-app update` pulls the newest release. So core looks at the newest GitHub
 * release now and then, and /api/version says when it's newer than this core (Settings → Updates shows it).
 * Only release builds check (CORE_RELEASE is baked in by build.mjs); a core run from source never does.
 */
import { logger } from "../log";

const log = logger("release-check");

const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;
const RELEASE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export interface NewerRelease {
  version: string;
  /** The release page (its html_url). */
  url: string;
}

/** "0.1.312" (or "v0.1.312") as numbers, or null when it isn't a plain release version. */
export function parseRelease(v: string | null | undefined): [number, number, number] | null {
  const m = RELEASE.exec(v?.trim() ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is a later release than `current` (numeric, so 0.1.10 is after 0.1.9). */
export function isNewerRelease(latest: string, current: string): boolean {
  const a = parseRelease(latest);
  const b = parseRelease(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export class ReleaseCheck {
  private newer: NewerRelease | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly o: {
      /** Only "pc" checks. */
      edition: string;
      /** This core's release ("0.1.312"), or null when run from source. */
      current: string | null;
      url: string;
      fetch?: typeof fetch;
      everyMs?: number;
    },
  ) {}

  get enabled() {
    return this.o.edition === "pc" && parseRelease(this.o.current) !== null;
  }

  /** The newest release when it's newer than this core, else null. */
  latest(): NewerRelease | null {
    return this.newer;
  }

  start() {
    if (!this.enabled || this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.o.everyMs ?? CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One look at the newest release. Failures (offline, rate limits) keep the last answer and are only logged. */
  async check(): Promise<NewerRelease | null> {
    if (!this.enabled) return null;
    try {
      const res = await (this.o.fetch ?? fetch)(this.o.url, {
        headers: { accept: "application/vnd.github+json", "user-agent": `yo-core/${this.o.current}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
      const tag = typeof body.tag_name === "string" ? body.tag_name.trim() : "";
      const url = typeof body.html_url === "string" && /^https:\/\//.test(body.html_url) ? body.html_url : "";
      if (!parseRelease(tag) || !url) throw new Error("unexpected release format");
      const version = tag.replace(/^v/, "");
      this.newer = isNewerRelease(version, this.o.current!) ? { version, url } : null;
    } catch (err: any) {
      log.debug(`release check skipped: ${err?.message ?? err}`);
    }
    return this.newer;
  }
}
