/**
 * The first agent's computer setup: `setup.requirements` on a real core (with a faked machine) and the
 * `computerSetup` setting's starting value for fresh installs, older installs and home-server cores.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineFacts } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComputerWatchdog, UNREACHABLE_MS } from "../src/computer/ComputerWatchdog";
import { type CoreConfig, loadConfig } from "../src/config";
import { openDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { createSetupApi, initComputerSetup, moveVmIntoYo } from "../src/setup";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
const GB = 1024 ** 3;

const FACTS: MachineFacts = {
  platform: "darwin",
  totalMemBytes: 8 * GB,
  cpu: { model: "Apple M1", appleSilicon: true, physicalCores: 8, logicalCores: 8 },
  diskFreeBytes: 50 * GB,
  macosVersion: "15.6",
  tools: {
    homebrew: { installed: true, version: "Homebrew 4.6.12" },
    colima: { installed: false, version: null },
    docker: { installed: false, version: null },
    compose: { installed: false, version: null },
  },
};

let dataDir: string;
let mock: MockAgentd;
let cores: Awaited<ReturnType<typeof startCore>>[] = [];
let port = 23800 + Math.floor(Math.random() * 1000);

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-setup-test-"));
  mock = new MockAgentd(TOKEN);
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const cfgFor = (mode: "local" | "remote"): CoreConfig => ({
  ...loadConfig({}),
  port: port++,
  dataDir,
  computerMode: mode,
  secrets: "file",
  webDist: null,
  dev: false,
});

describe("setup.requirements", () => {
  it("measures the machine and evaluates it with the shared thresholds", async () => {
    process.env.YO_AGENTD_TOKEN = TOKEN;
    const core = await startCore(
      { ...cfgFor("remote"), agentdUrl: await mock.listen() },
      { secrets: new MemorySecretStore(), probeMachine: async () => FACTS },
    );
    cores.push(core);
    const r = await core.api["setup.requirements"]({});
    expect(r.computerMode).toBe("remote");
    expect(r.facts).toEqual(FACTS);
    expect(r.verdict).toBe("block");
    expect(r.items.find((i) => i.id === "ram")?.status).toBe("block");
    expect(r.items.find((i) => i.id === "cpu")?.status).toBe("pass");
    expect(r.missingTools).toEqual(["colima", "docker", "compose"]);
  });

  it("a home-server core starts set up, and the setting round-trips", async () => {
    process.env.YO_AGENTD_TOKEN = TOKEN;
    const core = await startCore(
      { ...cfgFor("remote"), agentdUrl: await mock.listen() },
      { secrets: new MemorySecretStore(), probeMachine: async () => FACTS },
    );
    cores.push(core);
    expect((await core.api.bootstrap({})).settings.computerSetup).toBe("done");
    await core.api["settings.update"]({ computerSetup: "later" });
    expect(core.store.getSettings().computerSetup).toBe("later");
  });

  it("works with the real probe on this machine (never throws)", async () => {
    const api = createSetupApi({ cfg: cfgFor("local") });
    const r = await api["setup.requirements"]({});
    expect(["pass", "warn", "block"]).toContain(r.verdict);
    expect(r.facts.platform).toBe(process.platform);
    expect(r.items).toHaveLength(5);
  });
});

describe("initComputerSetup", () => {
  const open = () => {
    const db = openDb(dataDir);
    return { db, store: new Store(db) };
  };

  it("a fresh local install starts pending", () => {
    const { db, store } = open();
    initComputerSetup(db, store, cfgFor("local"));
    expect(store.getSettings().computerSetup).toBe("pending");
    db.close();
  });

  it("a fresh install closed after onboarding still gets the setup chat on the next launch", () => {
    const first = open();
    initComputerSetup(first.db, first.store, cfgFor("local")); // first launch, before onboarding
    first.store.updateSettings({ onboarded: true }); // onboarded; Yo is closed before the setup chat ends
    first.db.close();
    const next = open();
    initComputerSetup(next.db, next.store, cfgFor("local"));
    expect(next.store.getSettings().computerSetup).toBe("pending");
    next.db.close();
  });

  it("an install that finished onboarding before the setup chat counts as set up", () => {
    const { db, store } = open();
    store.updateSettings({ onboarded: true });
    initComputerSetup(db, store, cfgFor("local"));
    expect(store.getSettings().computerSetup).toBe("done");
    db.close();
  });

  it("keeps a saved choice, even after onboarding", () => {
    const { db, store } = open();
    store.updateSettings({ computerSetup: "later" });
    store.updateSettings({ onboarded: true });
    initComputerSetup(db, store, cfgFor("local"));
    expect(store.getSettings().computerSetup).toBe("later");
    db.close();
  });

  it("a home-server core is always set up", () => {
    const { db, store } = open();
    store.updateSettings({ computerSetup: "pending" });
    initComputerSetup(db, store, cfgFor("remote"));
    expect(store.getSettings().computerSetup).toBe("done");
    db.close();
  });

  it("an updating user with a finished setup and an existing VM is kept, not asked", () => {
    const base = process.platform === "darwin" ? "/tmp" : os.tmpdir();
    const root = fs.mkdtempSync(path.join(base, "yo-update-"));
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    fs.mkdirSync(data, { recursive: true });
    const instance = path.join(home, ".colima", "_lima", "colima-yo");
    fs.mkdirSync(path.join(home, ".colima", "yo"), { recursive: true });
    fs.mkdirSync(instance, { recursive: true });
    fs.writeFileSync(path.join(home, ".colima", "yo", "colima.yaml"), "runtime: docker\n");
    fs.writeFileSync(path.join(instance, "disk"), "vm-disk");
    const prev = process.env.YO_HOME;
    process.env.YO_HOME = home;
    const db = openDb(data);
    const store = new Store(db);
    try {
      // Onboarded before this version's choice file existed: setup is already done.
      store.updateSettings({ onboarded: true, computerSetup: "done" });
      initComputerSetup(db, store, { ...cfgFor("local"), dataDir: data });
      expect(store.getSettings().computerSetup).toBe("done");
      const saved = JSON.parse(fs.readFileSync(path.join(data, "vm-home.json"), "utf8")) as {
        choice: string;
      };
      expect(saved.choice).toBe("reuse");
      expect(fs.readFileSync(path.join(instance, "disk"), "utf8")).toBe("vm-disk");
      expect(fs.existsSync(path.join(data, "lima", "colima-yo"))).toBe(false);
      expect(fs.existsSync(path.join(data, "colima", "yo"))).toBe(false);
    } finally {
      db.close();
      if (prev === undefined) delete process.env.YO_HOME;
      else process.env.YO_HOME = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a fresh install with an existing VM still gets the Keep or Move question", () => {
    const base = process.platform === "darwin" ? "/tmp" : os.tmpdir();
    const root = fs.mkdtempSync(path.join(base, "yo-fresh-"));
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(path.join(home, ".colima", "yo"), { recursive: true });
    fs.writeFileSync(path.join(home, ".colima", "yo", "colima.yaml"), "runtime: docker\n");
    const prev = process.env.YO_HOME;
    process.env.YO_HOME = home;
    const db = openDb(data);
    const store = new Store(db);
    try {
      initComputerSetup(db, store, { ...cfgFor("local"), dataDir: data });
      expect(store.getSettings().computerSetup).toBe("pending");
      expect(fs.existsSync(path.join(data, "vm-home.json"))).toBe(false);
    } finally {
      db.close();
      if (prev === undefined) delete process.env.YO_HOME;
      else process.env.YO_HOME = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("setup.vmHome.choose stops the VM before a Move", () => {
  function rootDir() {
    const base = process.platform === "darwin" ? "/tmp" : os.tmpdir();
    return fs.mkdtempSync(path.join(base, "yo-move-"));
  }

  function legacy(home: string) {
    const instance = path.join(home, ".colima", "_lima", "colima-yo");
    fs.mkdirSync(path.join(home, ".colima", "yo"), { recursive: true });
    fs.mkdirSync(instance, { recursive: true });
    fs.writeFileSync(path.join(home, ".colima", "yo", "colima.yaml"), "runtime: docker\n");
    fs.writeFileSync(path.join(instance, "disk"), "vm-disk");
    return instance;
  }

  async function withHome<T>(home: string, body: () => Promise<T>) {
    const prev = process.env.YO_HOME;
    process.env.YO_HOME = home;
    try {
      return await body();
    } finally {
      if (prev === undefined) delete process.env.YO_HOME;
      else process.env.YO_HOME = prev;
    }
  }

  it("aborts when colima stop fails, and leaves the VM where it is", async () => {
    const root = rootDir();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const instance = legacy(home);
    const calls: string[] = [];
    const api = createSetupApi({
      cfg: { ...cfgFor("local"), dataDir: data },
      run: async (_cmd, args) => {
        calls.push(args[0] ?? "");
        if (args[0] === "stop") throw new Error("error stopping vm");
        throw new Error("colima is not running");
      },
    });
    await withHome(home, async () => {
      await expect(api["setup.vmHome.choose"]({ choice: "move" })).rejects.toThrow(/nothing was moved/i);
    });
    expect(calls).toEqual(["stop", "status"]);
    expect(fs.readFileSync(path.join(instance, "disk"), "utf8")).toBe("vm-disk");
    expect(fs.existsSync(path.join(data, "vm-home.json"))).toBe(false);
    expect(fs.existsSync(path.join(data, "lima", "colima-yo"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("aborts when colima status still says the VM is running", async () => {
    const root = rootDir();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const instance = legacy(home);
    const api = createSetupApi({
      cfg: { ...cfgFor("local"), dataDir: data },
      run: async () => ({ stdout: "Running" }),
    });
    await withHome(home, async () => {
      await expect(api["setup.vmHome.choose"]({ choice: "move" })).rejects.toThrow(/still running/);
    });
    expect(fs.readFileSync(path.join(instance, "disk"), "utf8")).toBe("vm-disk");
    expect(fs.existsSync(path.join(data, "vm-home.json"))).toBe(false);
    expect(fs.existsSync(path.join(data, "colima", "yo"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("moves only after stop succeeds and status says the VM is not running", async () => {
    const root = rootDir();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const instance = legacy(home);
    const calls: string[] = [];
    const api = createSetupApi({
      cfg: { ...cfgFor("local"), dataDir: data },
      run: async (_cmd, args) => {
        calls.push(args[0] ?? "");
        if (args[0] === "status") throw new Error("colima is not running");
        return { stdout: "done" };
      },
    });
    const vm = await withHome(home, () => api["setup.vmHome.choose"]({ choice: "move" }));
    expect(calls).toEqual(["stop", "status"]);
    expect(vm.choice).toBe("move");
    expect(fs.existsSync(path.join(instance, "disk"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    fs.rmSync(root, { recursive: true, force: true });
  });

  function lifecycleDouble() {
    const calls: string[] = [];
    const life = {
      runtime: "running",
      async stop() {
        calls.push("lifecycle.stop");
        this.runtime = "stopped";
      },
      async start() {
        calls.push("lifecycle.start");
        this.runtime = "running";
      },
    };
    return { calls, life };
  }

  it("stops through the lifecycle so the watchdog does not restart mid-move, then starts again", async () => {
    const root = rootDir();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const instance = legacy(home);
    const { calls, life } = lifecycleDouble();
    let connected = true;
    let now = 1_000_000;
    let repairs = 0;
    const dog = new ComputerWatchdog({
      now: () => now,
      connected: () => connected,
      shouldBeRunning: () => life.runtime === "running",
      repair: async () => {
        repairs++;
      },
    });
    dog.check();
    connected = false;
    const api = createSetupApi({
      cfg: { ...cfgFor("local"), dataDir: data },
      lifecycle: life,
      run: async (_cmd, args) => {
        calls.push(args[0] ?? "");
        if (args[0] === "status") {
          now += UNREACHABLE_MS + 60_000;
          expect(life.runtime).toBe("stopped");
          expect(dog.check()).toBe(false);
          expect(repairs).toBe(0);
          throw new Error("colima is not running");
        }
        return { stdout: "done" };
      },
    });
    const vm = await withHome(home, () => api["setup.vmHome.choose"]({ choice: "move" }));
    expect(vm.choice).toBe("move");
    expect(calls).toEqual(["lifecycle.stop", "stop", "status", "lifecycle.start"]);
    expect(life.runtime).toBe("running");
    expect(repairs).toBe(0);
    expect(fs.existsSync(path.join(instance, "disk"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts the computer again when the move fails, and leaves the VM where it is", async () => {
    const root = rootDir();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const instance = legacy(home);
    const { calls, life } = lifecycleDouble();
    let repairs = 0;
    const dog = new ComputerWatchdog({
      now: () => 1_000_000,
      connected: () => false,
      shouldBeRunning: () => life.runtime === "running",
      repair: async () => {
        repairs++;
      },
    });
    const api = createSetupApi({
      cfg: { ...cfgFor("local"), dataDir: data },
      lifecycle: life,
      run: async (_cmd, args) => {
        calls.push(args[0] ?? "");
        if (args[0] === "status") {
          expect(life.runtime).toBe("stopped");
          expect(dog.check()).toBe(false);
          return { stdout: "Running" };
        }
        return { stdout: "done" };
      },
    });
    await withHome(home, async () => {
      await expect(api["setup.vmHome.choose"]({ choice: "move" })).rejects.toThrow(/still running/);
    });
    expect(calls).toEqual(["lifecycle.stop", "stop", "status", "lifecycle.start"]);
    expect(life.runtime).toBe("running");
    expect(repairs).toBe(0);
    expect(fs.readFileSync(path.join(instance, "disk"), "utf8")).toBe("vm-disk");
    expect(fs.existsSync(path.join(data, "vm-home.json"))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("starts the computer again when stopping it does not leave it stopped", async () => {
    const calls: string[] = [];
    const life = {
      runtime: "running",
      async stop() {
        calls.push("lifecycle.stop");
        this.runtime = "error";
      },
      async start() {
        calls.push("lifecycle.start");
        this.runtime = "running";
      },
    };
    let moved = false;
    await expect(
      moveVmIntoYo({
        lifecycle: life,
        move: async () => {
          moved = true;
        },
      }),
    ).rejects.toThrow(/nothing was moved/i);
    expect(moved).toBe(false);
    expect(calls).toEqual(["lifecycle.stop", "lifecycle.start"]);
    expect(life.runtime).toBe("running");
  });

  it("replies that the computer moved before a restart of a running computer finishes", async () => {
    const root = rootDir();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const instance = legacy(home);
    let releaseStart: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const calls: string[] = [];
    const life = {
      runtime: "running",
      async stop() {
        calls.push("lifecycle.stop");
        this.runtime = "stopped";
      },
      start() {
        calls.push("lifecycle.start");
        return started.then(() => {
          this.runtime = "running";
        });
      },
    };
    const api = createSetupApi({
      cfg: { ...cfgFor("local"), dataDir: data },
      lifecycle: life,
      run: async (_cmd, args) => {
        calls.push(args[0] ?? "");
        if (args[0] === "status") throw new Error("colima is not running");
        return { stdout: "done" };
      },
    });
    const vm = await withHome(home, () => api["setup.vmHome.choose"]({ choice: "move" }));
    expect(vm.choice).toBe("move");
    expect(calls).toEqual(["lifecycle.stop", "stop", "status", "lifecycle.start"]);
    expect(life.runtime).toBe("stopped");
    expect(fs.existsSync(path.join(instance, "disk"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    releaseStart();
    await started;
    expect(life.runtime).toBe("running");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("a failed restart does not turn a finished move into a failure", async () => {
    const life = {
      runtime: "running",
      async stop() {
        this.runtime = "stopped";
      },
      start() {
        return Promise.reject(new Error("boot failed"));
      },
    };
    await expect(
      moveVmIntoYo({
        lifecycle: life,
        move: async () => "moved",
      }),
    ).resolves.toBe("moved");
  });

  it("does not start the computer when it was not already running", async () => {
    const root = rootDir();
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const instance = legacy(home);
    const calls: string[] = [];
    const life = {
      runtime: "stopped",
      async stop() {
        calls.push("lifecycle.stop");
        this.runtime = "stopped";
      },
      async start() {
        calls.push("lifecycle.start");
        this.runtime = "running";
      },
    };
    const api = createSetupApi({
      cfg: { ...cfgFor("local"), dataDir: data },
      lifecycle: life,
      run: async (_cmd, args) => {
        calls.push(args[0] ?? "");
        if (args[0] === "status") throw new Error("colima is not running");
        return { stdout: "done" };
      },
    });
    const vm = await withHome(home, () => api["setup.vmHome.choose"]({ choice: "move" }));
    expect(vm.choice).toBe("move");
    expect(calls).toEqual(["lifecycle.stop", "stop", "status"]);
    expect(life.runtime).toBe("stopped");
    expect(fs.existsSync(path.join(instance, "disk"))).toBe(false);
    expect(fs.readFileSync(path.join(data, "lima", "colima-yo", "disk"), "utf8")).toBe("vm-disk");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
