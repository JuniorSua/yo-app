/**
 * computer.discard (a helper that finished): its seat's tabs aren't saved, its tile and display number are
 * freed, and its home folder goes (~/Shared stays). States are set by hand: no X or Chromium.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config, paths } from "../config";
import type { Logger } from "../log";
import { DisplayManager } from "./DisplayManager";
import type { SharedDesktop } from "./SharedDesktop";

const noop = () => undefined;
const log: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };

let dir: string;
const saved = { ...config };
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "yo-discard-"));
  config.dataDir = dir;
  config.runDir = dir;
  config.sharedComputer = true;
});
afterEach(() => {
  Object.assign(config, saved);
  rmSync(dir, { recursive: true, force: true });
});

const seatsFile = () => JSON.parse(readFileSync(paths.seatsFile(), "utf8"));

describe("computer.discard", () => {
  it("frees the seat, tile and display number without saving tabs, and deletes the home folder", async () => {
    const dm = new DisplayManager(log, noop);
    const yo = dm.displayNumber("agt_yo");
    const n = dm.displayNumber("agt_helper");
    expect(n).toBe(yo + 1);
    // The helper has a tile and saved tabs (it slept once), and files in its home; ~/Shared is a link.
    const shared = (dm as unknown as { shared: SharedDesktop }).shared;
    dm.get("agt_helper");
    shared.claimTile("agt_yo");
    const tile = shared.claimTile("agt_helper");
    shared.saveTabs("agt_helper", ["https://example.com/"]);
    const home = paths.agentHome("agt_helper");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "notes.md"), "x");
    mkdirSync(paths.sharedDir(), { recursive: true });
    writeFileSync(path.join(paths.sharedDir(), "keep.md"), "shared");
    symlinkSync(paths.sharedDir(), path.join(home, "Shared"));
    expect(seatsFile().tiles[String(tile)]).toBe("agt_helper");

    await dm.discard("agt_helper");

    expect(seatsFile().seats.agt_helper).toBeUndefined();
    expect(Object.values(seatsFile().tiles)).not.toContain("agt_helper");
    expect(shared.savedTabs("agt_helper")).toEqual([]);
    expect(existsSync(home)).toBe(false);
    expect(readFileSync(path.join(paths.sharedDir(), "keep.md"), "utf8")).toBe("shared");
    expect(dm.status().map((s) => s.agentId)).toEqual(["agt_yo"]);
    // Its number and tile go to the next one; Yo keeps his.
    expect(dm.displayNumber("agt_next")).toBe(n);
    expect(dm.displayNumber("agt_yo")).toBe(yo);
    expect(shared.claimTile("agt_next")).toBe(tile);
  });

  it("is harmless for an agent the computer never saw", async () => {
    const dm = new DisplayManager(log, noop);
    await expect(dm.discard("agt_unknown")).resolves.toBeUndefined();
    await expect(dm.discard("../etc")).rejects.toThrow(/invalid agentId/);
  });
});
