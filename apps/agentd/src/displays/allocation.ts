/** Stable display-number allocation per agent, persisted to /data/displays.json. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MIN_DISPLAY = 1;
export const MAX_DISPLAY = 99;

export const cdpPort = (n: number) => 9200 + n;
export const vncPort = (n: number) => 5900 + n;

/** Pure: returns the display for agentId, allocating the lowest free number if needed. */
export function allocateDisplay(
  map: Record<string, number>,
  agentId: string,
  min = MIN_DISPLAY,
  max = MAX_DISPLAY,
): { display: number; changed: boolean } {
  const existing = map[agentId];
  if (typeof existing === "number") return { display: existing, changed: false };
  const used = new Set(Object.values(map));
  for (let n = min; n <= max; n++) {
    if (!used.has(n)) {
      map[agentId] = n;
      return { display: n, changed: true };
    }
  }
  throw new Error(`no free display numbers (${min}-${max})`);
}

export class DisplayAllocator {
  private map: Record<string, number> = {};
  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === "number" && Number.isInteger(v) && v >= MIN_DISPLAY && v <= MAX_DISPLAY)
            this.map[k] = v;
        }
      }
    } catch {
      // first run
    }
  }

  get(agentId: string): number {
    const { display, changed } = allocateDisplay(this.map, agentId);
    if (changed) this.save();
    return display;
  }

  peek(agentId: string): number | undefined {
    return this.map[agentId];
  }

  entries(): [string, number][] {
    return Object.entries(this.map);
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.map, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
