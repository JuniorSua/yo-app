/**
 * The first agent's computer setup: the `setup.*` API and the `computerSetup` setting's starting value.
 * The chat itself is scripted in the web UI (no model can run before the computer exists).
 */
import type { DatabaseSync } from "node:sqlite";
import { evaluateRequirements, type MachineFacts, type SetupApiMethods } from "@yo/contracts";
import type { CoreConfig } from "../config";
import type { Store } from "../db/store";
import { logger } from "../log";
import { probeMachine } from "./probe";

const log = logger("setup");

type Handlers = {
  [M in keyof SetupApiMethods]: (
    params: SetupApiMethods[M]["params"],
  ) => Promise<SetupApiMethods[M]["result"]>;
};

export function createSetupApi(d: { cfg: CoreConfig; probe?: () => Promise<MachineFacts> }): Handlers {
  const probe = d.probe ?? (() => probeMachine());
  return {
    "setup.requirements": async () => {
      const facts = await probe();
      return evaluateRequirements(facts, d.cfg.computerMode);
    },
  };
}

/**
 * Installs from before the setup chat were set up in onboarding, and a home-server core (remote mode) never
 * runs the computer itself: both start "done", so only a fresh local install sees the chat.
 */
export function initComputerSetup(db: DatabaseSync, store: Store, cfg: CoreConfig) {
  try {
    const saved = db.prepare("SELECT 1 AS x FROM settings WHERE key = 'computerSetup'").get();
    const s = store.getSettings();
    if (cfg.computerMode === "remote" ? s.computerSetup !== "done" : !saved && s.onboarded)
      store.updateSettings({ computerSetup: "done" });
    // A fresh install: save "pending" now, so quitting after onboarding but before the setup chat is done
    // doesn't make the next launch take it for an install from before the chat (and skip the setup).
    else if (cfg.computerMode === "local" && !saved) store.updateSettings({ computerSetup: "pending" });
  } catch (err) {
    log.warn("couldn't read the computer setup state", err);
  }
}
