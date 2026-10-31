/** The Tasks page on the core: suggest_task, tasks.list / create / start / update, and the task.updated pushes. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiPushChannel } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import {
  createTasksApi,
  MAX_OPEN_SUGGESTIONS,
  RESOLVED_FOR_MS,
  suggestTask,
  taskMoveProblem,
} from "../src/tasks/tasks";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
type Core = Awaited<ReturnType<typeof startCore>>;

let dataDir: string;
let mock: MockAgentd;
let agentdUrl: string;
let cores: Core[] = [];
let port = 20700 + Math.floor(Math.random() * 500);

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
  await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
  return core;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-tasks-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const yoOf = (core: Core) => core.store.listAgents().find((a) => a.isPrimary)!;

function capture(core: Core) {
  const pushes: { channel: ApiPushChannel; data: any }[] = [];
  core.hub.subscribe((channel, data) => pushes.push({ channel, data }));
  return pushes;
}

const userTexts = (core: Core, agentId: string) =>
  core.store
    .listTimeline(agentId)
    .filter((e) => e.item.kind === "user_message")
    .map((e) => e.item.text);

const replies = (core: Core, agentId: string) =>
  core.store
    .listTimeline(agentId)
    .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
    .map((e) => String(e.item.text));

function bareStore() {
  const store = new Store(openMemoryDb());
  const agent = store.createAgent({
    name: "Yo",
    role: "",
    instructions: "",
    avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" },
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "full-access",
    isPrimary: true,
    pinned: true,
  });
  return { store, agent };
}

describe("suggest_task", () => {
  it("saves a suggestion with why and prompt, out of the ledger Yo owes", () => {
    const { store, agent } = bareStore();
    const out = suggestTask(store, agent.id, {
      title: "Draft a reply to Ana about Friday",
      why: "She asked yesterday and the ship date moved.",
      prompt: "Draft a reply to Ana about Friday's ship date",
    });
    expect(out).toMatch(/^Suggested "Draft a reply to Ana about Friday" \(tsk_\w+\)/);
    const [t] = store.listTasks(agent.id, { all: true });
    expect(t).toMatchObject({
      status: "suggested",
      origin: "suggestion",
      why: "She asked yesterday and the ship date moved.",
      prompt: "Draft a reply to Ana about Friday's ship date",
    });
    // The ledger shown to Yo each session leaves suggestions (and hidden ones) out.
    expect(store.listTasks(agent.id)).toEqual([]);
  });

  it("refuses the same title (any case) on the list or hidden, but not a closed one", () => {
    const { store, agent } = bareStore();
    const s = (title: string) => suggestTask(store, agent.id, { title, why: "w", prompt: title });
    store.addTask({ ownerId: agent.id, title: "Book the dentist", status: "in_progress" });
    expect(s("book the  DENTIST")).toMatch(/already on the list \(in progress\)/);
    const hidden = store.addTask({ ownerId: agent.id, title: "Watch the flight price", status: "hidden" });
    expect(s("Watch the flight price")).toMatch(/hid "Watch the flight price" before/);
    store.updateTask(hidden.id, { status: "open" });
    expect(s("watch the flight price")).toMatch(/already on the list \(open\)/);
    store.addTask({ ownerId: agent.id, title: "Renew the domain", status: "done" });
    expect(s("Renew the domain")).toMatch(/^Suggested/);
    expect(s("Renew the domain")).toMatch(/already on the list \(suggested\)/);
  });

  it(`caps waiting suggestions at ${MAX_OPEN_SUGGESTIONS} per agent and says so`, () => {
    const { store, agent } = bareStore();
    const s = (title: string, id = agent.id) => suggestTask(store, id, { title, why: "w", prompt: title });
    for (const t of ["One", "Two", "Three"]) expect(s(t)).toMatch(/^Suggested/);
    expect(s("Four")).toBe(
      'Not suggested: 3 suggestions are already waiting for the user ("One", "Two", "Three"). Wait until they start or hide one.',
    );
    // Hiding one makes room.
    const one = store.listTasks(agent.id, { all: true }).find((t) => t.title === "One")!;
    store.updateTask(one.id, { status: "hidden" });
    expect(s("Four")).toMatch(/^Suggested/);
    // Another agent has its own three.
    expect(s("Five", "agt_other")).toMatch(/^Suggested/);
  });
});

describe("tasks.list", () => {
  it("shows the page's tasks: done ones from the last 7 days, never cancelled, interrupted or hidden", () => {
    const { store, agent } = bareStore();
    const api = createTasksApi({ store, orchestrator: { send: async () => ({ turnId: "x" }) } });
    const now = Date.now();
    const at = (ms: number, fn: () => void) => {
      const spy = vi.spyOn(Date, "now").mockReturnValue(ms);
      fn();
      spy.mockRestore();
    };
    at(now - RESOLVED_FOR_MS - 60_000, () => {
      const old = store.addTask({ ownerId: agent.id, title: "Old done" });
      store.updateTask(old.id, { status: "done" });
    });
    at(now - 2 * 86_400_000, () => {
      const recent = store.addTask({ ownerId: agent.id, title: "Recent done" });
      store.updateTask(recent.id, { status: "done" });
    });
    for (const status of ["open", "in_progress", "waiting", "review", "suggested"] as const)
      store.addTask({ ownerId: agent.id, title: `A ${status}`, status });
    for (const status of ["cancelled", "interrupted", "hidden"] as const)
      store.addTask({ ownerId: agent.id, title: `Gone ${status}`, status });
    return api["tasks.list"]({}).then((list) => {
      expect(list.map((t) => t.title)).toEqual([
        "Recent done",
        "A open",
        "A in_progress",
        "A waiting",
        "A review",
        "A suggested",
      ]);
    });
  });

  it("defaults to the active space's main agent", async () => {
    const core = await boot();
    const yo = yoOf(core);
    const pip = core.store.getSpaceAgent("personal")!;
    core.store.addTask({ ownerId: yo.id, title: "Yo's task" });
    core.store.addTask({ ownerId: pip.id, title: "Pip's task" });
    await core.api["settings.update"]({ spaceManual: { space: "work", until: null } });
    expect((await core.api["tasks.list"]({})).map((t) => t.title)).toEqual(["Yo's task"]);
    await core.api["settings.update"]({ spaceManual: { space: "personal", until: null } });
    expect((await core.api["tasks.list"]({})).map((t) => t.title)).toEqual(["Pip's task"]);
    expect((await core.api["tasks.list"]({ agentId: yo.id })).map((t) => t.title)).toEqual(["Yo's task"]);
  });
});

describe("Tasks page actions", () => {
  it("Start sends the title the user saw as their message, keeps Yo's plan as the note, and can't run twice", async () => {
    const core = await boot();
    const yo = yoOf(core);
    await core.api["settings.update"]({ spaceManual: { space: "work", until: null } });
    const pushes = capture(core);
    suggestTask(core.store, yo.id, {
      title: "Watch the M4 MacBook Air price",
      why: "It dropped $50 last week.",
      prompt: "Watch the M4 MacBook Air price and tell me under $899",
    });
    const s = core.store.listTasks(yo.id, { all: true })[0]!;
    expect(pushes.find((p) => p.channel === "task.updated")?.data).toMatchObject({
      id: s.id,
      status: "suggested",
    });

    const started = await core.api["tasks.start"]({ id: s.id });
    // The user's message is what the card showed; Yo's own words never go out as the user's.
    expect(started).toMatchObject({
      id: s.id,
      status: "in_progress",
      note: "Watch the M4 MacBook Air price and tell me under $899",
    });
    expect(userTexts(core, yo.id)).toEqual(["Watch the M4 MacBook Air price"]);
    await until(() => replies(core, yo.id).includes("echo: Watch the M4 MacBook Air price"));
    expect(pushes.filter((p) => p.channel === "task.updated").map((p) => p.data.status)).toEqual([
      "suggested",
      "in_progress",
    ]);
    await expect(core.api["tasks.start"]({ id: s.id })).rejects.toThrow(/already started/);
    expect(userTexts(core, yo.id)).toHaveLength(1);
  });

  it("Start while Yo is busy queues the message, like the user sending it", async () => {
    const core = await boot();
    const yo = yoOf(core);
    await core.api["chat.send"]({ agentId: yo.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    const t = core.store.addTask({
      ownerId: yo.id,
      title: "Plan the Lisbon trip",
      status: "open",
      origin: "user",
    });
    await core.api["tasks.start"]({ id: t.id });
    expect(core.store.getTask(t.id)!.status).toBe("in_progress");
    expect((await core.api["queue.list"]({ agentId: yo.id })).map((q) => q.text)).toEqual([
      "Plan the Lisbon trip",
    ]);
    await core.api["chat.interrupt"]({ agentId: yo.id });
  });

  it("+ starts a task now, or saves it for Up next", async () => {
    const core = await boot();
    const yo = yoOf(core);
    await core.api["settings.update"]({ spaceManual: { space: "work", until: null } });
    const saved = await core.api["tasks.create"]({ title: "  Compare  phone plans ", start: false });
    expect(saved).toMatchObject({
      ownerId: yo.id,
      title: "Compare phone plans",
      status: "open",
      origin: "user",
    });
    expect(userTexts(core, yo.id)).toEqual([]);

    const now = await core.api["tasks.create"]({
      title: "Find a gift for Mia",
      note: "Under $40, she likes ceramics",
      start: true,
    });
    expect(now).toMatchObject({ status: "in_progress", note: "Under $40, she likes ceramics" });
    expect(userTexts(core, yo.id)).toEqual(["Find a gift for Mia\n\nUnder $40, she likes ceramics"]);
    await expect(core.api["tasks.create"]({ title: "   ", start: false })).rejects.toThrow(/title/);
  });

  it("Start now that can't reach Yo leaves no half-made task behind", async () => {
    const { store, agent } = bareStore();
    const api = createTasksApi({
      store,
      orchestrator: {
        send: async () => {
          throw new Error("Yo isn't reachable");
        },
      },
    });
    await expect(api["tasks.create"]({ title: "Book the dentist", start: true })).rejects.toThrow(
      /isn't reachable/,
    );
    expect(store.listTasks(agent.id, { all: true }).map((t) => t.status)).toEqual(["cancelled"]);
    expect(await api["tasks.list"]({})).toEqual([]);
  });

  it("Start is only for suggestions and the user's saved tasks, not Yo's own to-dos", async () => {
    const { store, agent } = bareStore();
    const sent: string[] = [];
    const api = createTasksApi({
      store,
      orchestrator: {
        send: async (_id, text) => {
          sent.push(text);
          return { turnId: "x" };
        },
      },
    });
    const own = store.addTask({ ownerId: agent.id, title: "Follow up with the plumber" });
    await expect(api["tasks.start"]({ id: own.id })).rejects.toThrow(/Yo's own list/);
    // A suggestion that already has a note keeps it.
    const s = store.addTask({
      ownerId: agent.id,
      title: "Renew the passport",
      status: "suggested",
      origin: "suggestion",
      note: "Expires in March",
      prompt: "Fill in the renewal form",
    });
    expect(await api["tasks.start"]({ id: s.id })).toMatchObject({ note: "Expires in March" });
    expect(sent).toEqual(["Renew the passport"]);
  });

  it("checks off, hides and reopens, pushing each change", async () => {
    const core = await boot();
    const yo = yoOf(core);
    const pushes = capture(core);
    const t = core.store.addTask({ ownerId: yo.id, title: "Draft the newsletter", status: "review" });
    expect(await core.api["tasks.update"]({ id: t.id, status: "done" })).toMatchObject({ status: "done" });
    expect(await core.api["tasks.update"]({ id: t.id, status: "open" })).toMatchObject({ status: "open" });
    const s = core.store.addTask({ ownerId: yo.id, title: "Watch a price", status: "suggested" });
    expect(await core.api["tasks.update"]({ id: s.id, status: "hidden" })).toMatchObject({
      status: "hidden",
    });
    expect(
      pushes.filter((p) => p.channel === "task.updated" && p.data.id === t.id).map((p) => p.data.status),
    ).toEqual(["review", "done", "open"]);
    await expect(core.api["tasks.update"]({ id: t.id, status: "in_progress" as never })).rejects.toThrow(
      /checked off, hidden or reopened/,
    );
    await expect(core.api["tasks.update"]({ id: "tsk_nope", status: "done" })).rejects.toThrow(
      /isn't on the list/,
    );
  });

  it("refuses moves the page doesn't offer", async () => {
    const core = await boot();
    const yo = yoOf(core);
    const add = (status: "suggested" | "hidden" | "in_progress" | "open") =>
      core.store.addTask({ ownerId: yo.id, title: `A ${status}`, status });
    const update = (id: string, status: "done" | "hidden" | "open") =>
      core.api["tasks.update"]({ id, status });
    await expect(update(add("in_progress").id, "hidden")).rejects.toThrow(/Only a suggestion can be hidden/);
    await expect(update(add("hidden").id, "open")).rejects.toThrow(/Only a finished task can be reopened/);
    await expect(update(add("suggested").id, "done")).rejects.toThrow(/Start it or hide it/);
    await expect(update(add("hidden").id, "done")).rejects.toThrow(/can't be checked off/);
    expect(await update(add("open").id, "done")).toMatchObject({ status: "done" });
    expect(core.store.listTasks(yo.id, { all: true }).filter((t) => t.status === "done")).toHaveLength(1);
  });

  it("the allowed moves, one by one", () => {
    for (const from of ["review", "waiting", "in_progress", "open"] as const)
      expect(taskMoveProblem(from, "done"), from).toBeNull();
    for (const from of ["suggested", "hidden", "cancelled", "interrupted"] as const)
      expect(taskMoveProblem(from, "done"), from).not.toBeNull();
    expect(taskMoveProblem("suggested", "hidden")).toBeNull();
    expect(taskMoveProblem("done", "open")).toBeNull();
    for (const from of ["open", "review", "in_progress", "done"] as const)
      expect(taskMoveProblem(from, "hidden"), from).not.toBeNull();
    for (const from of ["hidden", "suggested", "review", "in_progress"] as const)
      expect(taskMoveProblem(from, "open"), from).not.toBeNull();
    // Already there: nothing to refuse.
    expect(taskMoveProblem("hidden", "hidden")).toBeNull();
  });

  it("Yo's own tools push too: task_add, task_update to review, suggest_task", async () => {
    const core = await boot();
    const yo = yoOf(core);
    const pushes = capture(core);
    await core.api["chat.send"]({ agentId: yo.id, text: 'tool task_add {"title":"Draft the reply"}' });
    await until(() => replies(core, yo.id).some((t) => t.includes("Added task")));
    const t = core.store.listTasks(yo.id)[0]!;
    await core.api["chat.send"]({
      agentId: yo.id,
      text: `tool task_update {"id":"${t.id}","status":"review","note":"Draft is in the chat"}`,
    });
    await until(() => replies(core, yo.id).some((x) => x.includes("is review")));
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool suggest_task {"title":"Send the reply","why":"It is ready","prompt":"Send the reply to Ana"}',
    });
    await until(() => replies(core, yo.id).some((x) => x.includes('Suggested "Send the reply"')));
    expect(pushes.filter((p) => p.channel === "task.updated").map((p) => p.data.status)).toEqual([
      "open",
      "review",
      "suggested",
    ]);
    // task_list keeps suggestions apart from what Yo owes.
    await core.api["chat.send"]({ agentId: yo.id, text: "tool task_list {}" });
    await until(() => replies(core, yo.id).some((x) => x.includes("Your suggestions waiting")));
    const list = replies(core, yo.id).at(-1)!;
    expect(list).toMatch(/Draft the reply \(review\): Draft is in the chat/);
    expect(list).toContain('Your suggestions waiting for the user: "Send the reply"');
  });

  it("task_update can't touch a suggestion or one the user hid", async () => {
    const core = await boot();
    const yo = yoOf(core);
    const s = core.store.addTask({ ownerId: yo.id, title: "Send the reply", status: "suggested" });
    const h = core.store.addTask({ ownerId: yo.id, title: "Watch the price", status: "hidden" });
    await core.api["chat.send"]({
      agentId: yo.id,
      text: `tool task_update {"id":"${s.id}","status":"in_progress"}`,
    });
    await until(() => replies(core, yo.id).some((x) => x.includes("only they can start or hide it")));
    await core.api["chat.send"]({
      agentId: yo.id,
      text: `tool task_update {"id":"${h.id}","status":"open"}`,
    });
    await until(() => replies(core, yo.id).some((x) => x.includes("Leave it hidden")));
    expect(core.store.getTask(s.id)!.status).toBe("suggested");
    expect(core.store.getTask(h.id)!.status).toBe("hidden");
  });
});
