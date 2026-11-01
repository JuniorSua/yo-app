/**
 * After Work & Personal spaces: every agent is a normal teammate, Yo is the primary, work hours are prompt context,
 * and each agent keeps its memory focus (Yo: work, Pip: personal, Pepe: none). Migration 16 upgrades a database
 * shaped like the owner's (spaces on) and like a friend's (spaces turned off, Pip archived).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Avatar, WorkHours } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { migrate, openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { Hub } from "../src/hub";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { createYoTools } from "../src/tools/yoTools";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
type Core = Awaited<ReturnType<typeof startCore>>;

let dataDir: string;
let mock: MockAgentd;
let agentdUrl: string;
let cores: Core[] = [];
let port = 20200 + Math.floor(Math.random() * 500);

async function until(fn: () => boolean, ms = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function boot(): Promise<Core> {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const core = await startCore(
    {
      ...loadConfig({}),
      dev: false,
      port: port++,
      dataDir,
      agentdUrl,
      computerMode: "remote" as const,
      secrets: "file" as const,
      webDist: null,
    },
    { secrets: new MemorySecretStore() },
  );
  cores.push(core);
  await core.agentd.waitReady(5000);
  return core;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-focus-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const AVATAR: Avatar = { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" };
const EVERY_DAY: WorkHours = Array.from({ length: 7 }, () => ({ on: true, start: "11:00", end: "19:00" }));

function fields(name: string) {
  return {
    name,
    role: "",
    instructions: "",
    avatar: AVATAR,
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "full-access" as const,
    isPrimary: false,
    pinned: false,
  };
}

const names = (store: Store) => store.listAgents().map((a) => `${a.name}:${a.space ?? "-"}`);

/**
 * A database as the spaces version (migration 15) left it on the owner's install: Yo (work), Pepe (no space) and
 * Pip (personal, on Grok), every-day 11–7 work hours, 30 untagged, 8 work and 3 personal memories, and chats.
 * `spacesOff`: a friend who turned spaces off, so Pip was archived; Dew was archived by hand.
 */
function oldInstall(db: DatabaseSync, opts: { spacesOff?: boolean } = {}) {
  migrate(db, 15);
  const store = new Store(db);
  const yo = store.createAgent({
    ...fields("Yo"),
    role: "your work assistant",
    isPrimary: true,
    pinned: true,
    space: "work",
  });
  const pepe = store.createAgent({ ...fields("Pepe"), role: "Head of Polestar" });
  const pip = store.createAgent({
    ...fields("Pip"),
    role: "your personal-time agent",
    model: "grok-4.7",
    pinned: true,
    space: "personal",
  });
  const dew = store.createAgent({ ...fields("Dew"), role: "Research" });
  store.updateAgent(dew.id, { archivedAt: 1 });
  if (opts.spacesOff) store.updateAgent(pip.id, { archivedAt: 2 });
  const set = db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)");
  set.run("userName", JSON.stringify("Sam"));
  set.run("onboarded", "true");
  set.run("workHours", JSON.stringify(EVERY_DAY));
  set.run("spacesOn", opts.spacesOff ? "false" : "true");
  set.run("spaceManual", JSON.stringify({ space: "personal", until: null }));
  set.run("_personalAgentId", JSON.stringify(pip.id));
  for (let i = 0; i < 30; i++) store.addMemory(`Fact ${i}`, null, null);
  for (let i = 0; i < 8; i++) store.addMemory(`[area:work] Polestar note ${i}`, null, "work");
  for (let i = 0; i < 3; i++) store.addMemory(`[area:personal] Home note ${i}`, null, "personal");
  const chat = db.prepare("INSERT INTO timeline (id, agent_id, created_at, item_json) VALUES (?, ?, ?, ?)");
  for (const a of [yo, pepe, pip, dew])
    for (let i = 0; i < 3; i++)
      chat.run(
        `tl_${a.name}_${i}`,
        a.id,
        i,
        JSON.stringify({
          id: `itm_${a.name}_${i}`,
          kind: "user_message",
          status: "completed",
          text: `hi ${i}`,
        }),
      );
  return { yo, pepe, pip, dew };
}

const rows = (db: DatabaseSync, sql: string) => db.prepare(sql).all() as Record<string, any>[];
const labels = (db: DatabaseSync) =>
  Object.fromEntries(
    rows(db, "SELECT coalesce(space, 'everywhere') AS l, count(*) AS n FROM memories GROUP BY l").map((r) => [
      r.l,
      r.n,
    ]),
  );

describe("migration 16 (spaces removed)", () => {
  it("on the owner's database: drops the two space settings and keeps everything else", () => {
    const db = new DatabaseSync(":memory:");
    const { yo, pepe, pip, dew } = oldInstall(db);
    const before = rows(db, "SELECT * FROM agents ORDER BY id");
    migrate(db);
    // The same agents, nobody archived or brought back, Pip still on Grok with its focus.
    expect(rows(db, "SELECT * FROM agents ORDER BY id")).toEqual(before);
    const store = new Store(db);
    expect(names(store)).toEqual(["Yo:work", "Pip:personal", "Pepe:-"]);
    expect(store.getAgent(pip.id)).toMatchObject({ model: "grok-4.7", archivedAt: null });
    expect(store.getAgent(dew.id)!.archivedAt).toBe(1);
    // Settings: spacesOn and spaceManual gone; work hours, name and the rest untouched.
    const keys = rows(db, "SELECT key FROM settings ORDER BY key").map((r) => r.key);
    expect(keys).not.toContain("spacesOn");
    expect(keys).not.toContain("spaceManual");
    expect(keys).toEqual(["_personalAgentId", "onboarded", "userName", "workHours"]);
    const s = store.getSettings();
    expect(s.workHours).toEqual(EVERY_DAY);
    expect(s.timezone).toBe("America/New_York");
    expect(s).not.toHaveProperty("spacesOn");
    // Every memory, with its label; every chat.
    expect(labels(db)).toEqual({ everywhere: 30, work: 8, personal: 3 });
    expect(store.listMemories(null, { focus: "personal" })).toHaveLength(33);
    expect(store.listMemories(null, { focus: "work" })).toHaveLength(38);
    for (const a of [yo, pepe, pip, dew])
      expect(rows(db, `SELECT id FROM timeline WHERE agent_id = '${a.id}'`)).toHaveLength(3);
    // Run once: the version table keeps it from running again.
    migrate(db);
    expect(rows(db, "SELECT version FROM _migrations WHERE version = 16")).toHaveLength(1);
    db.close();
  });

  it("on a friend's database with spaces off: Pip stays archived, and live agents keep seeing every memory", () => {
    const db = new DatabaseSync(":memory:");
    const { yo, pip, dew } = oldInstall(db, { spacesOff: true });
    migrate(db);
    const store = new Store(db);
    // Before, with spaces off, Yo saw every memory: it still does (no focus).
    expect(names(store)).toEqual(["Yo:-", "Pepe:-"]);
    expect(store.getAgent(yo.id)).toMatchObject({
      isPrimary: true,
      archivedAt: null,
      role: "your work assistant",
    });
    expect(store.getAgent(pip.id)).toMatchObject({ archivedAt: 2, space: "personal", model: "grok-4.7" });
    expect(store.getAgent(dew.id)!.archivedAt).toBe(1);
    expect(labels(db)).toEqual({ everywhere: 30, work: 8, personal: 3 });
    expect(rows(db, `SELECT id FROM timeline WHERE agent_id = '${pip.id}'`)).toHaveLength(3);
    expect(rows(db, "SELECT key FROM settings WHERE key IN ('spacesOn', 'spaceManual')")).toEqual([]);
    db.close();
  });
});

describe("booting after the upgrade", () => {
  it("a new install has just Yo: no Pip, and a second boot adds nobody", async () => {
    const core = await boot();
    expect(names(core.store)).toEqual(["Yo:-"]);
    await core.shutdown();
    cores = [];
    expect(names((await boot()).store)).toEqual(["Yo:-"]);
  });

  it("the owner's install keeps Yo, Pip and Pepe; nothing is created, archived or switched", async () => {
    const db = new DatabaseSync(path.join(dataDir, "yo.sqlite"));
    const { pip } = oldInstall(db);
    db.close();
    const core = await boot();
    expect(names(core.store)).toEqual(["Yo:work", "Pip:personal", "Pepe:-"]);
    expect(core.store.getAgent(pip.id)).toMatchObject({ archivedAt: null, model: "grok-4.7" });
    // Phone and Telegram (and the Tasks page) go to the primary, whatever the time.
    expect(core.store.primaryAgent()?.name).toBe("Yo");
  });

  it("Pip is a normal teammate: it can be archived like any other", async () => {
    const db = new DatabaseSync(path.join(dataDir, "yo.sqlite"));
    const { yo, pip } = oldInstall(db);
    db.close();
    const core = await boot();
    await core.api["agent.archive"]({ id: pip.id });
    expect(core.store.getAgent(pip.id)!.archivedAt).not.toBeNull();
    await expect(core.api["agent.archive"]({ id: yo.id })).rejects.toThrow(
      "The main agent can't be archived",
    );
  });

  it("Pip's session: Personal and Everywhere memories, the work-hours line, a main agent's tools", async () => {
    const db = new DatabaseSync(path.join(dataDir, "yo.sqlite"));
    const { pip } = oldInstall(db);
    db.close();
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    // Pip runs on the default account's model here (the test has no Grok sign-in).
    core.store.updateAgent(pip.id, { model: null });
    await core.api["chat.send"]({ agentId: pip.id, text: "hello" });
    await until(() => [...mock.sessions.values()].some((s) => s.agentId === pip.id), 5000, "Pip's session");
    const prompt = [...mock.sessions.values()].find((s) => s.agentId === pip.id)!.systemAppend;
    expect(prompt).toContain("(long-term memory: Personal and Everywhere)");
    expect(prompt).toContain("Home note 2");
    expect(prompt).toContain("Fact 29");
    expect(prompt).not.toContain("Polestar note");
    expect(prompt).toMatch(
      /- Sam's work hours: every day 11:00–19:00 \(America\/New_York\)\. It's now \w{3} /,
    );
    expect(prompt).toContain("don't bring up work unless Sam does");
    expect(prompt).toContain("# Your team\nYo is the main agent: Sam's front door. You're Pip, a teammate");
    expect(prompt).toContain("# Helpers");
    expect(prompt).not.toContain("# Yo Phone");
    expect(prompt).not.toContain("# Your space");
    const start = mock.requests.find((r) => r.type === "session.start" && r.agentId === pip.id) as any;
    expect(start.toolset).toBe("primary");
    await until(() => mock.turnTexts.some((t) => t.endsWith("hello")), 5000, "the turn");
    expect(mock.turnTexts.find((t) => t.endsWith("hello"))).toMatch(
      / · (work hours|outside work hours)\] hello$/,
    );
  });
});

describe("remember and recall with memory focus", () => {
  function setup() {
    const store = new Store(openMemoryDb());
    const hub = new Hub();
    const yo = store.createAgent({ ...fields("Yo"), isPrimary: true, space: "work" });
    const pip = store.createAgent({ ...fields("Pip"), space: "personal" });
    const pepe = store.createAgent(fields("Pepe"));
    const tools = createYoTools({
      store,
      hub,
      scheduler: null as never,
      dataDir: "/tmp",
      fetchFile: async () => Buffer.alloc(0),
      bugReports: null as never,
    });
    return { store, yo, pip, pepe, tools };
  }
  const labelOf = (store: Store, out: string) => {
    const id = /id (mem_\w+)/.exec(out)![1]!;
    return store.listMemories().find((m) => m.id === id)!.space;
  };

  it("an agent remembers into its focus by default; an area or an explicit label wins", async () => {
    const { store, pip, yo, pepe, tools } = setup();
    expect(labelOf(store, await tools(pip.id, "remember", { fact: "Gym on Tuesdays" }))).toBe("personal");
    expect(labelOf(store, await tools(yo.id, "remember", { fact: "Standup at 11" }))).toBe("work");
    expect(labelOf(store, await tools(pepe.id, "remember", { fact: "Likes window seats" }))).toBeNull();
    expect(labelOf(store, await tools(pip.id, "remember", { fact: "Quote due", area: "work" }))).toBe("work");
    expect(
      labelOf(store, await tools(pip.id, "remember", { fact: "Name is Sam", label: "everywhere" })),
    ).toBeNull();
    // A helper remembers into its parent's focus.
    const helper = store.createAgent({ ...fields("helper"), kind: "helper", parentId: pip.id });
    expect(labelOf(store, await tools(helper.id, "remember", { fact: "Likes tapas" }))).toBe("personal");
  });

  it("recall searches every memory, labelled, the agent's own focus first", async () => {
    const { store, pip, yo, pepe, tools } = setup();
    await tools(pip.id, "remember", { fact: "Dentist appointment Thursday" });
    await tools(yo.id, "remember", { fact: "Dentist client Acme renews in May" });
    await tools(pepe.id, "remember", { fact: "Dentist is Dr. Lee" });
    const lines = (await tools(yo.id, "recall", { query: "dentist" })).split("\n");
    expect(lines).toHaveLength(3);
    // Same score: Yo's Work and the Everywhere one before Pip's Personal one.
    expect(lines.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\[mem_\w+\] \(work\) Dentist client Acme/),
        expect.stringMatching(/^\[mem_\w+\] Dentist is Dr\. Lee$/),
      ]),
    );
    expect(lines[2]).toMatch(/^\[mem_\w+\] \(personal\) Dentist appointment Thursday/);
    expect(
      store
        .listMemories(yo.id, { focus: "work" })
        .map((m) => m.content)
        .sort(),
    ).toEqual(["Dentist client Acme renews in May", "Dentist is Dr. Lee"]);
  });
});

describe("migration 11 (memory labels)", () => {
  it("gives the live primary the work focus and labels tagged memories, leaving the rest Everywhere", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, 10);
    const agent = db.prepare(
      "INSERT INTO agents (id, name, avatar_json, created_at, is_primary, kind, archived_at) VALUES (?,?,?,?,?,?,?)",
    );
    agent.run("old_yo", "Yo", "{}", 1, 1, "agent", 5);
    agent.run("yo", "Yo", "{}", 2, 1, "agent", null);
    agent.run("pepe", "Pepe", "{}", 3, 0, "agent", null);
    agent.run("hlp", "Helper", "{}", 4, 0, "helper", null);
    const mem = db.prepare(
      "INSERT INTO memories (id, agent_id, content, created_at, updated_at) VALUES (?,?,?,?,?)",
    );
    mem.run("m1", null, "[area:work] Desk quotes go out by Friday", 1, 1);
    mem.run("m2", null, "  [Area:Personal] Gym on Tuesdays", 1, 1);
    mem.run("m3", "pepe", "Prefers window seats", 1, 1);
    mem.run("m4", null, "[area:yo-project] Ship it", 1, 1);

    migrate(db);
    const focus = Object.fromEntries(rows(db, "SELECT id, space FROM agents").map((r) => [r.id, r.space]));
    expect(focus).toEqual({ old_yo: null, yo: "work", pepe: null, hlp: null });
    const store = new Store(db);
    expect(Object.fromEntries(store.listMemories().map((m) => [m.id, m.space]))).toEqual({
      m1: "work",
      m2: "personal",
      m3: null,
      m4: null,
    });
    // Nothing disappears for a Work-focused agent: Everywhere and Work.
    expect(
      store
        .listMemories("pepe", { focus: "work" })
        .map((m) => m.id)
        .sort(),
    ).toEqual(["m1", "m3", "m4"]);
    db.close();
  });
});
