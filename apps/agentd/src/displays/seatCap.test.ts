/**
 * The cap on awake computers: waking one more than YO_MAX_AWAKE_SEATS is refused with NO_FREE_SEAT (core then
 * frees an idle agent's computer or waits), before anything starts. States are set by hand: no X or Chromium.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_FREE_SEAT } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../config";
import type { Logger } from "../log";
import { DisplayManager } from "./DisplayManager";
import { SharedDesktop } from "./SharedDesktop";

const noop = () => undefined;
const log: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => log };

let dir: string;
const saved = { ...config };
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "yo-seatcap-"));
  config.dataDir = dir;
  config.runDir = dir;
  config.sharedComputer = true;
});
afterEach(() => {
  Object.assign(config, saved);
  rmSync(dir, { recursive: true, force: true });
});

describe("awake seat cap", () => {
  it("refuses one more awake computer than YO_MAX_AWAKE_SEATS, without starting it", async () => {
    config.maxAwakeSeats = 2;
    const states: string[] = [];
    const dm = new DisplayManager(log, (agentId, state) => states.push(`${agentId}:${state}`));
    dm.get("agt_a").state = "ready";
    dm.get("agt_b").state = "booting"; // waking counts: two can't race past the cap
    dm.get("agt_c").state = "hibernated";
    expect(dm.hasRoom()).toBe(false);
    await expect(dm.ensure("agt_c")).rejects.toMatchObject({ code: NO_FREE_SEAT });
    expect(dm.get("agt_c").state).toBe("hibernated");
    expect(states).toEqual([]);
    // One goes to sleep: room again.
    dm.get("agt_a").state = "hibernated";
    expect(dm.hasRoom()).toBe(true);
  });

  it("0 means no cap", () => {
    config.maxAwakeSeats = 0;
    const dm = new DisplayManager(log, noop);
    for (const id of ["agt_a", "agt_b", "agt_c", "agt_d"]) dm.get(id).state = "ready";
    expect(dm.hasRoom()).toBe(true);
  });

  it("a full shared screen is the same NO_FREE_SEAT, not a dead end", () => {
    const shared = new SharedDesktop(log);
    for (let t = 0; t < config.sharedTiles; t++) shared.seat(`agt_${t}`, t + 1).tile = t;
    let err: unknown;
    try {
      shared.claimTile("agt_new");
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ code: NO_FREE_SEAT });
    shared.seat("agt_0", 1).tile = null;
    expect(shared.claimTile("agt_new")).toBe(0);
  });
});
