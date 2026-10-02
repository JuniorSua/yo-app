/**
 * The first agent's computer setup: `setup.requirements` on a real core (with a faked machine) and the
 * `computerSetup` setting's starting value for fresh installs, older installs and home-server cores.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MachineFacts } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CoreConfig, loadConfig } from "../src/config";
import { openDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { createSetupApi, initComputerSetup } from "../src/setup";
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
});
