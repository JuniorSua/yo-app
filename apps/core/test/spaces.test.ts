/** Work & Personal spaces on the core: the agents (Yo for Work, Pip for Personal), memory per space, migration 11. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ApiPushChannel, Avatar } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { migrate, openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { Hub } from "../src/hub";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { activeSpaceAgent, ensureSpaceAgents, shelvePersonalAgent } from "../src/team/spaces";
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-spaces-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const YO_AVATAR: Avatar = { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" };

function addAgent(store: Store, name: string, extra: { isPrimary?: boolean; avatar?: Avatar } = {}) {
  return store.createAgent({
    name,
    role: extra.isPrimary ? "your personal agent" : "",
    instructions: "",
    avatar: extra.avatar ?? YO_AVATAR,
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "full-access",
    isPrimary: !!extra.isPrimary,
    pinned: !!extra.isPrimary,
  });
}

const names = (store: Store) => store.listAgents().map((a) => `${a.name}:${a.space ?? "-"}`);

describe("Work & Personal on boot", () => {
  it("first boot makes Yo the Work agent and creates Pip; a second boot adds nothing", async () => {
    const core = await boot();
    expect(names(core.store)).toEqual(["Yo:work", "Pip:personal"]);
    const pip = core.store.getSpaceAgent("personal")!;
    expect(pip).toMatchObject({ role: "your personal-time agent", pinned: true, isPrimary: false });
    expect(pip.avatar.softie?.kind).toBe("mochi");
    expect(core.store.listActivity(pip.id).map((e) => e.summary)).toContain(
      "Created Pip, your Personal agent",
    );
    await core.shutdown();
    cores = [];

    const again = await boot();
    expect(names(again.store)).toEqual(["Yo:work", "Pip:personal"]);
    expect(again.store.getSpaceAgent("personal")!.id).toBe(pip.id);
  });

  it("with spaces off there's no Pip; turning them on creates it and tells the apps", async () => {
    const core = await boot();
    const pip = core.store.getSpaceAgent("personal")!;
    const pushes: { channel: ApiPushChannel; data: any }[] = [];
    core.hub.subscribe((channel, data) => pushes.push({ channel, data }));

    await core.api["settings.update"]({ spacesOn: false });
    expect(names(core.store)).toEqual(["Yo:work"]);
    expect(pushes.find((p) => p.channel === "agent.removed")?.data).toEqual({ id: pip.id });
    // Off means one main agent again: phone and Telegram go to Yo whatever the time.
    expect(activeSpaceAgent(core.store)?.name).toBe("Yo");

    pushes.length = 0;
    await core.api["settings.update"]({ spacesOn: true });
    // The same Pip comes back (chats and all), not a second one.
    expect(names(core.store)).toEqual(["Yo:work", "Pip:personal"]);
    expect(core.store.getSpaceAgent("personal")!.id).toBe(pip.id);
    const updated = pushes.filter((p) => p.channel === "agent.updated").map((p) => p.data.id);
    expect(updated).toContain(pip.id);
    const order = pushes.map((p) => p.channel);
    expect(order.indexOf("agent.updated")).toBeLessThan(order.indexOf("settings.updated"));
  });

  it("Pip can't be archived (spaces are turned off instead), and isn't offered for consolidation", async () => {
    const core = await boot();
    const pip = core.store.getSpaceAgent("personal")!;
    await expect(core.api["agent.archive"]({ id: pip.id })).rejects.toThrow(
      "Turn off Work & Personal in Settings instead.",
    );
    // Yo 2 offers nobody on its own (teammates stay), and Pip can't be folded in even when asked.
    addAgent(core.store, "Sam");
    expect((await core.api["team.consolidatePlan"]({})).agents).toEqual([]);
    const res = await core.api["team.consolidate"]({ agentIds: [pip.id] });
    expect(res.agents[0]).toMatchObject({ status: "skipped", error: "This is your Work or Personal agent." });
    expect(core.store.getAgent(pip.id)!.archivedAt).toBeNull();
  });

  it("Pip's session gets the Personal space, its memories and Everywhere's, and Yo as its counterpart", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const pip = core.store.getSpaceAgent("personal")!;
    core.store.addMemory("Sister's birthday is May 2", null, "personal");
    core.store.addMemory("Quotes go out on Fridays", null, "work");
    core.store.addMemory("Lives in Miami", null, null);
    await core.api["chat.send"]({ agentId: pip.id, text: "hello" });
    await until(() => [...mock.sessions.values()].some((s) => s.agentId === pip.id), 5000, "Pip's session");
    const prompt = [...mock.sessions.values()].find((s) => s.agentId === pip.id)!.systemAppend;
    expect(prompt).toContain("# Your space: Personal");
    expect(prompt).toContain("Yo handles Work.");
    expect(prompt).toContain("hobbies and side projects");
    expect(prompt).toContain("(long-term memory: Personal and Everywhere)");
    expect(prompt).toContain("Sister's birthday is May 2");
    expect(prompt).toContain("Lives in Miami");
    expect(prompt).not.toContain("Quotes go out on Fridays");
    // Yo is the counterpart, not a teammate to lead.
    expect(prompt).not.toContain("# Leading the team");
    expect(prompt).not.toContain("# Other agents");
    // Lead tools: helpers, not "create_agent" teammates.
    expect(prompt).toContain("# Helpers");
    await until(() => mock.turnTexts.some((t) => t.endsWith("hello")), 5000, "the turn");
    expect(mock.turnTexts.find((t) => t.endsWith("hello"))).toMatch(/ · (work|personal) time\] hello$/);
  });
});

describe("ensureSpaceAgents on an existing database", () => {
  it("never makes a second Pip, even run over and over", () => {
    const store = new Store(openMemoryDb());
    addAgent(store, "Yo", { isPrimary: true });
    for (let i = 0; i < 3; i++) ensureSpaceAgents(store);
    expect(names(store)).toEqual(["Yo:work", "Pip:personal"]);
    // The database refuses a second live agent for a space.
    const extra = addAgent(store, "Imposter");
    expect(() => store.setAgentSpace(extra.id, "personal")).toThrow();
  });

  it("renames the primary's old role once, and leaves a role the owner wrote", () => {
    const store = new Store(openMemoryDb());
    const yo = addAgent(store, "Yo", { isPrimary: true });
    ensureSpaceAgents(store);
    expect(store.getAgent(yo.id)!.role).toBe("your work assistant");
    store.updateAgent(yo.id, { role: "your personal agent" });
    ensureSpaceAgents(store);
    expect(store.getAgent(yo.id)!.role).toBe("your personal agent");

    const other = new Store(openMemoryDb());
    const mine = addAgent(other, "Yo", { isPrimary: true });
    other.updateAgent(mine.id, { role: "chief of staff" });
    ensureSpaceAgents(other);
    expect(other.getAgent(mine.id)!.role).toBe("chief of staff");
  });

  it("copes with an archived primary or none at all, and an owner's Pepe stays a teammate", () => {
    const store = new Store(openMemoryDb());
    const old = addAgent(store, "Yo", { isPrimary: true });
    store.updateAgent(old.id, { archivedAt: Date.now() });
    addAgent(store, "Pepe");
    expect(ensureSpaceAgents(store)).toHaveLength(1);
    expect(names(store)).toEqual(["Pip:personal", "Pepe:-"]);
    expect(store.getAgent(old.id)!.space).toBeNull();
  });

  it("brings an archived Pip back rather than making another", () => {
    const store = new Store(openMemoryDb());
    addAgent(store, "Yo", { isPrimary: true });
    ensureSpaceAgents(store);
    const pip = store.getSpaceAgent("personal")!;
    expect(shelvePersonalAgent(store)).toBe(pip.id);
    expect(store.getSpaceAgent("personal")).toBeNull();
    expect(ensureSpaceAgents(store)).toEqual([pip.id]);
    expect(store.getSpaceAgent("personal")!.id).toBe(pip.id);
    expect(store.listAgents()).toHaveLength(2);
  });

  it("gives Pip a Softie nobody on the team wears yet", () => {
    const store = new Store(openMemoryDb());
    addAgent(store, "Yo", { isPrimary: true, avatar: { ...YO_AVATAR, softie: { kind: "mochi" } } });
    ensureSpaceAgents(store);
    expect(store.getSpaceAgent("personal")!.avatar.softie?.kind).toBe("dew");
  });

  it("does nothing while spaces are off", () => {
    const store = new Store(openMemoryDb());
    addAgent(store, "Yo", { isPrimary: true });
    store.updateSettings({ spacesOn: false });
    expect(ensureSpaceAgents(store)).toEqual([]);
    expect(names(store)).toEqual(["Yo:-"]);
  });
});

describe("remember and recall across spaces", () => {
  function setup() {
    const store = new Store(openMemoryDb());
    const hub = new Hub();
    const yo = addAgent(store, "Yo", { isPrimary: true });
    ensureSpaceAgents(store);
    const pip = store.getSpaceAgent("personal")!;
    const tools = createYoTools({
      store,
      hub,
      scheduler: null as never,
      dataDir: "/tmp",
      fetchFile: async () => Buffer.alloc(0),
      bugReports: null as never,
    });
    return { store, yo, pip, tools };
  }
  const spaceOf = (store: Store, out: string) => {
    const id = /id (mem_\w+)/.exec(out)![1]!;
    return store.listMemories().find((m) => m.id === id)!.space;
  };

  it("Pip remembers into Personal by default; an area or an explicit space wins", async () => {
    const { store, pip, yo, tools } = setup();
    expect(spaceOf(store, await tools(pip.id, "remember", { fact: "Gym on Tuesdays" }))).toBe("personal");
    expect(spaceOf(store, await tools(yo.id, "remember", { fact: "Standup at 11" }))).toBe("work");
    expect(spaceOf(store, await tools(pip.id, "remember", { fact: "Quote due", area: "work" }))).toBe("work");
    expect(
      spaceOf(store, await tools(pip.id, "remember", { fact: "Name is Sam", space: "everywhere" })),
    ).toBeNull();
    // A helper remembers into its parent's space.
    const helper = store.createAgent({
      ...addAgentFields("helper"),
      kind: "helper",
      parentId: pip.id,
    });
    expect(spaceOf(store, await tools(helper.id, "remember", { fact: "Likes tapas" }))).toBe("personal");
  });

  it("Yo's recall finds Pip's memories too, labelled with their space", async () => {
    const { store, pip, yo, tools } = setup();
    await tools(pip.id, "remember", { fact: "Dentist appointment Thursday" });
    await tools(yo.id, "remember", { fact: "Dentist client Acme renews in May" });
    const out = await tools(yo.id, "recall", { query: "dentist" });
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    // Same score: Yo's own space comes first.
    expect(lines[0]).toMatch(/^\[mem_\w+\] \(work\) Dentist client Acme/);
    expect(lines[1]).toMatch(/^\[mem_\w+\] \(personal\) Dentist appointment Thursday/);
    expect(store.listMemories(yo.id, { space: "work" }).map((m) => m.content)).toEqual([
      "Dentist client Acme renews in May",
    ]);
  });

  it("with spaces off, remember keeps Everywhere and recall has no labels", async () => {
    const { store, yo, tools } = setup();
    store.updateSettings({ spacesOn: false });
    expect(spaceOf(store, await tools(yo.id, "remember", { fact: "Window seats" }))).toBeNull();
    expect(await tools(yo.id, "recall", { query: "window" })).toMatch(/^\[mem_\w+\] Window seats$/);
  });
});

function addAgentFields(name: string) {
  return {
    name,
    role: "",
    instructions: "",
    avatar: YO_AVATAR,
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "full-access" as const,
    isPrimary: false,
    pinned: false,
  };
}

describe("migration 11 (spaces)", () => {
  it("makes the live primary the Work agent and sorts tagged memories, leaving the rest Everywhere", () => {
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
    mem.run("m4", null, "[area:yo-project] Ship spaces", 1, 1);

    migrate(db);
    const spaces = Object.fromEntries(
      (db.prepare("SELECT id, space FROM agents").all() as { id: string; space: string | null }[]).map(
        (r) => [r.id, r.space],
      ),
    );
    expect(spaces).toEqual({ old_yo: null, yo: "work", pepe: null, hlp: null });
    const store = new Store(db);
    expect(Object.fromEntries(store.listMemories().map((m) => [m.id, m.space]))).toEqual({
      m1: "work",
      m2: "personal",
      m3: null,
      m4: null,
    });
    // Nothing disappears for the Work agent: Everywhere and Work.
    expect(
      store
        .listMemories("pepe", { space: "work" })
        .map((m) => m.id)
        .sort(),
    ).toEqual(["m1", "m3", "m4"]);
    db.close();
  });
});
