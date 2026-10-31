/**
 * The first agent's computer setup: the `setup.*` API and the `computerSetup` setting's starting value.
 * The chat itself is scripted in the web UI (no model can run before the computer exists).
 */
import { execFile } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import {
  evaluateRequirements,
  type MachineFacts,
  type SetupApiMethods,
  type VmHomeChoice,
  type VmHomeStatus,
} from "@yo/contracts";
import { hostEnv } from "../computer/ComputerLifecycle";
import {
  chooseVmHome,
  hostHome,
  keepUnsetLegacyVm,
  resolveVmHome,
  type VmLayout,
} from "../computer/hostTools";
import type { CoreConfig } from "../config";
import type { Store } from "../db/store";
import { logger } from "../log";
import { probeMachine } from "./probe";

const execFileP = promisify(execFile);

const log = logger("setup");

type HostRun = (cmd: string, args: string[], timeoutMs?: number) => Promise<unknown>;

const defaultRun: HostRun = (cmd, args, timeoutMs = 120_000) =>
  execFileP(cmd, args, { env: hostEnv(), timeout: timeoutMs });

/**
 * Stop and start through ComputerLifecycle, not a raw `colima stop`. While `runtime` is "stopped"
 * the watchdog leaves the VM alone, so it cannot restart underneath the rename.
 */
export interface VmMoveLifecycle {
  stop(opts: { vm?: boolean }): Promise<void>;
  start(): Promise<void>;
  readonly runtime: string;
}

/**
 * Stop the computer, then rename it. The reply is the move itself: a boot can take longer than the
 * UI waits for an answer, and a failed boot must not make a finished move look like it failed.
 * A computer that was already running is started again in the background. One that was not (the
 * setup chat, before its own start step) is left stopped.
 */
export async function moveVmIntoYo<T>(o: { lifecycle: VmMoveLifecycle; move: () => Promise<T> }): Promise<T> {
  const wasRunning = o.lifecycle.runtime === "running";
  const restart = () => {
    if (!wasRunning) return;
    void o.lifecycle
      .start()
      .catch((err) => log.warn("couldn't start the computer again after the move", err));
  };
  await o.lifecycle.stop({ vm: true });
  if (o.lifecycle.runtime !== "stopped") {
    restart();
    throw new Error("Yo couldn't stop the existing computer, so nothing was moved. Nothing was deleted.");
  }
  let moved: T;
  try {
    moved = await o.move();
  } catch (err) {
    restart();
    throw err;
  }
  restart();
  return moved;
}

/**
 * Move renames the VM's disk. A running VM has that disk open, and a failed `colima stop` used to
 * be ignored. Stop, then ask `colima status`. If the stop failed or the VM is still running, do
 * not move anything.
 */
async function stopBeforeMove(run: HostRun, profile: string): Promise<void> {
  let stopFailed = false;
  try {
    await run("colima", ["stop", "--profile", profile], 120_000);
  } catch (err) {
    stopFailed = true;
    log.warn("colima stop before move failed", err);
  }
  let running = false;
  try {
    await run("colima", ["status", "--profile", profile], 20_000);
    running = true;
  } catch {
    running = false;
  }
  if (running) {
    throw new Error(
      "The existing computer is still running, so Yo left it where it is. Stop it and try Move again. Nothing was deleted.",
    );
  }
  if (stopFailed) {
    throw new Error(
      "Yo couldn't stop the existing computer, so nothing was moved. Stop it and try Move again. Nothing was deleted.",
    );
  }
}

type Handlers = {
  [M in keyof SetupApiMethods]: (
    params: SetupApiMethods[M]["params"],
  ) => Promise<SetupApiMethods[M]["result"]>;
};

function vmStatus(vm: VmLayout): VmHomeStatus {
  return {
    state: vm.state,
    choice: vm.choice,
    colimaHome: vm.colimaHome,
    limaHome: vm.limaHome,
    dockerConfig: vm.dockerConfig,
    legacyDir: vm.legacyDir,
    detail: vm.detail,
    legacyKept: vm.legacyKept,
  };
}

function readVm(cfg: CoreConfig): VmHomeStatus {
  return vmStatus(
    resolveVmHome({
      dataDir: cfg.dataDir,
      homeDir: hostHome(),
      profile: cfg.colimaProfile,
    }),
  );
}

export function createSetupApi(d: {
  cfg: CoreConfig;
  probe?: () => Promise<MachineFacts>;
  /** Tests pass this so a Move does not run the real `colima`. */
  run?: HostRun;
  /**
   * When set, a Move stops through the computer lifecycle. Yo's status reads Stopped for the
   * rename, so the watchdog does not restart the VM in the middle. A computer that was running
   * is started again after the reply, without waiting for the boot.
   */
  lifecycle?: VmMoveLifecycle;
}): Handlers {
  const probe = d.probe ?? (() => probeMachine());
  const run = d.run ?? defaultRun;
  const homeDir = () => hostHome();
  const relocate = () => {
    const moved = () => {
      return chooseVmHome({
        dataDir: d.cfg.dataDir,
        homeDir: homeDir(),
        profile: d.cfg.colimaProfile,
        choice: "move",
      });
    };
    if (!d.lifecycle) {
      return stopBeforeMove(run, d.cfg.colimaProfile).then(moved);
    }
    return moveVmIntoYo({
      lifecycle: d.lifecycle,
      move: async () => {
        await stopBeforeMove(run, d.cfg.colimaProfile);
        return moved();
      },
    });
  };
  return {
    "setup.requirements": async () => {
      const facts = await probe();
      return { ...evaluateRequirements(facts, d.cfg.computerMode), vmHome: readVm(d.cfg) };
    },
    "setup.vmHome.choose": async ({ choice }: { choice: VmHomeChoice }) => {
      if (choice !== "reuse" && choice !== "move") {
        throw new Error("Choose whether to keep the existing computer or move it.");
      }
      // A running VM holds its disk open. Stop it, and confirm it stopped, before renaming anything.
      const vm =
        choice === "move"
          ? await relocate()
          : chooseVmHome({
              dataDir: d.cfg.dataDir,
              homeDir: homeDir(),
              profile: d.cfg.colimaProfile,
              choice,
            });
      return vmStatus(vm);
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
    // Updating user: setup is already finished, so the Keep/Move chat will not appear. An existing
    // ~/.colima VM with no saved choice is Keep. Start would otherwise fail on every launch.
    if (cfg.computerMode === "local" && store.getSettings().computerSetup === "done") {
      keepUnsetLegacyVm({ dataDir: cfg.dataDir, homeDir: hostHome(), profile: cfg.colimaProfile });
    }
  } catch (err) {
    log.warn("couldn't read the computer setup state", err);
  }
}
