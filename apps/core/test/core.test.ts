import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type AgentdResponses, type ApiPushChannel, type Avatar, exchangeIdIn } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { startCore } from "../src/main";
import type { TurnEvent } from "../src/orchestrator/Orchestrator";
import { CATCHUP_WINDOW_MS } from "../src/scheduler/Scheduler";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MAX_ZIP_BYTES } from "../src/zipUploads";
import { MockAgentd } from "./mockAgentd";
import { makeZip } from "./zipFixture";

const TOKEN = "t".repeat(64);

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let dataDir: string;
let mock: MockAgentd;
let agentdUrl: string;
let cores: Awaited<ReturnType<typeof startCore>>[] = [];
let port = 17800 + Math.floor(Math.random() * 1000);

async function boot(
  opts: {
    dev?: boolean;
    webDist?: string;
    lostTurnGraceMs?: number;
    autoSleepCheckMs?: number;
    agentReplyWaitMs?: number;
    userWaitMs?: number;
    maxTurnMs?: number;
    stuckTurnMs?: number;
    oversightFailMs?: number;
    oversightLongMs?: number;
    oversightCooldownMs?: number;
    helperTurnMs?: number;
    secrets?: MemorySecretStore;
  } = {},
) {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg = {
    ...loadConfig({}),
    dev: opts.dev ?? false,
    port: port++,
    dataDir,
    agentdUrl,
    computerMode: "remote" as const,
    secrets: "file" as const,
    webDist: opts.webDist ?? null,
  };
  const core = await startCore(cfg, {
    secrets: opts.secrets ?? new MemorySecretStore(),
    lostTurnGraceMs: opts.lostTurnGraceMs,
    autoSleepCheckMs: opts.autoSleepCheckMs,
    agentReplyWaitMs: opts.agentReplyWaitMs,
    userWaitMs: opts.userWaitMs,
    maxTurnMs: opts.maxTurnMs,
    stuckTurnMs: opts.stuckTurnMs,
    oversightFailMs: opts.oversightFailMs,
    oversightLongMs: opts.oversightLongMs,
    oversightCooldownMs: opts.oversightCooldownMs,
    helperTurnMs: opts.helperTurnMs,
  });
  cores.push(core);
  await core.agentd.waitReady(5000);
  return core;
}

function capture(core: Awaited<ReturnType<typeof startCore>>) {
  const pushes: { channel: ApiPushChannel; data: any }[] = [];
  core.hub.subscribe((channel, data) => pushes.push({ channel, data }));
  return pushes;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-core-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const primary = (core: Awaited<ReturnType<typeof startCore>>) =>
  core.store.listAgents().find((a) => a.isPrimary)!;

describe("yo-core", () => {
  it("creates the primary agent and default accounts on first run", async () => {
    const core = await boot();
    const boot1 = await core.api.bootstrap({});
    // Yo leads Work; Pip, made next to it, leads Personal (Work & Personal is on by default).
    expect(boot1.agents.map((a) => [a.name, a.space, a.isPrimary])).toEqual([
      ["Yo", "work", true],
      ["Pip", "personal", false],
    ]);
    expect(boot1.agents[0]!.role).toBe("your work assistant");
    // One account per provider Yo offers (ENABLED_PROVIDERS), Claude the default.
    expect(boot1.accounts.map((a) => a.provider).sort()).toEqual(["claude", "codex", "grok"]);
    expect(boot1.accounts.find((a) => a.isDefault)?.provider).toBe("claude");
    await until(() => core.store.listAccounts().every((a) => a.status === "authenticated"), 5000, "probe");
  });

  it("connects Grok with a device code and runs an agent on a Grok model", async () => {
    mock.requireLogin = true;
    const core = await boot();
    const pushes = capture(core);
    const grok = core.store.listAccounts().find((a) => a.provider === "grok")!;
    expect(grok.label).toBe("Grok");
    await until(() => core.store.getAccount(grok.id)?.status === "unauthenticated", 5000, "probe");

    // Sign in on Yo's computer: `grok login --device-auth` shows a link and a code, then finishes on its own.
    await core.api["account.login.start"]({ id: grok.id });
    const prompt = () =>
      pushes.find((p) => p.channel === "account.login" && p.data.accountId === grok.id && p.data.userCode);
    await until(() => !!prompt(), 5000, "device code");
    expect(mock.last("auth.login.start")).toMatchObject({ provider: "grok", method: "grok-login" });
    expect(prompt()!.data).toMatchObject({ phase: "prompt", userCode: "WXYZ-1234", needsInput: false });
    // Status flips to signed-in before models.list comes back. Reading models in that gap
    // sees [] whenever the mock socket is slow (grokLoginMs is only 120ms; the probe is the next hop).
    await until(
      () => {
        const a = core.store.getAccount(grok.id);
        return a?.status === "authenticated" && a.models.length >= 2;
      },
      5000,
      "grok signed in",
    );
    const signedIn = core.store.getAccount(grok.id)!;
    expect(signedIn.models.map((m) => m.id)).toEqual(["grok-build", "grok-4.3"]);
    // The first working subscription becomes the default.
    await until(() => !!core.store.getAccount(grok.id)?.isDefault, 5000, "grok default");
    expect(await core.api["models.list"]({ accountId: grok.id })).toHaveLength(2);

    // Pin the main agent to a Grok model: its turns start a Grok session with that model and effort.
    const agent = primary(core);
    await core.api["agent.update"]({
      id: agent.id,
      patch: { accountId: grok.id, model: "grok-build", effort: "high" },
    });
    await core.api["chat.send"]({ agentId: agent.id, text: "hello grok" });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: hello grok"));
    expect(mock.last("session.start")).toMatchObject({
      provider: "grok",
      accountId: grok.id,
      model: "grok-build",
    });

    // An xAI API key is the fallback: it's stored as the Grok account's secret.
    await core.api["account.setApiKey"]({ id: grok.id, key: " xai-test-key " });
    expect(await core.accounts.getSecrets(grok.id)).toEqual({ xaiApiKey: "xai-test-key" });
  });

  it("streams a reply into the timeline", async () => {
    const core = await boot();
    const pushes = capture(core);
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hello there" });
    await until(() =>
      core.store
        .listTimeline(agent.id)
        .some((e) => e.item.kind === "assistant_message" && e.item.status === "completed"),
    );
    const tl = core.store.listTimeline(agent.id);
    expect(tl.map((e) => e.item.kind)).toEqual(["user_message", "assistant_message"]);
    expect(tl[1]!.item.text).toBe("echo: hello there");
    // The model sees when each message was sent (a native session can last for days)...
    expect(mock.turnTexts.at(-1)).toMatch(
      /^\[\w{3}, \w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M · (work|personal) time\] hello there$/,
    );
    // ...while the chat shows exactly what was typed.
    expect(tl[0]!.item.text).toBe("hello there");
    expect(tl[1]!.source?.provider).toBe("claude");
    expect(pushes.some((p) => p.channel === "timeline.delta")).toBe(true);
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    expect(core.store.getAgent(agent.id)!.unread).toBe(1);
    expect(pushes.some((p) => p.channel === "notify" && p.data.kind === "done")).toBe(true);
    // Session start carried persona in systemAppend.
    expect(mock.last("session.start")!.systemAppend).toContain("You are Yo");
  });

  it("queues messages sent while a turn is running", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    const res = await core.api["chat.send"]({ agentId: agent.id, text: "second" });
    expect(res.turnId).toBe("queued");
    expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    await core.api["chat.interrupt"]({ agentId: agent.id });
    // Stop ends the running task only: the user's queued message isn't thrown away, it runs next (#114).
    await until(
      () => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: second"),
      10000,
      "queued message runs",
    );
    expect(mock.count("turn.send")).toBe(2);
  });

  it("saves an attached zip on the agent's computer and tells the agent where it is and what's in it", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const zip = makeZip([{ name: "site/index.html", data: "<h1>hi</h1>" }, { name: "site/app.js" }]);
    // Windows browsers call it application/x-zip-compressed; core files it as application/zip.
    const attachment = {
      name: "site.zip",
      mediaType: "application/x-zip-compressed",
      data: zip.toString("base64"),
    };
    await core.api["chat.send"]({ agentId: agent.id, text: "what's in here?", attachments: [attachment] });
    await until(() => mock.count("turn.send") === 1);
    expect(mock.written).toEqual([{ agentId: agent.id, dir: "uploads", name: "site.zip", data: zip }]);
    const text = mock.turnTexts.at(-1)!;
    expect(text).toContain("what's in here?");
    expect(text).toContain("saved on your computer at ~/uploads/site.zip and isn't extracted");
    expect(text).toContain(
      '<zip contents name="site.zip" entries="2">\nsite/index.html\nsite/app.js\n</zip contents>',
    );
    const user = core.store.listTimeline(agent.id).find((e) => e.item.kind === "user_message")!;
    expect(user.item.input).toEqual({ attachments: [{ name: "site.zip", mediaType: "application/zip" }] });

    // An older computer only takes files in ~/from-mac: the zip goes there instead.
    await until(() => core.orchestrator.activityOf(agent.id) !== "working", 5000, "first turn done");
    mock.onlyFromMac = true;
    await core.api["chat.send"]({ agentId: agent.id, text: "again", attachments: [attachment] });
    await until(() => mock.count("turn.send") === 2);
    expect(mock.written.at(-1)).toMatchObject({ dir: "from-mac", name: "site.zip" });
    expect(mock.turnTexts.at(-1)).toContain("saved on your computer at ~/from-mac/site.zip");
  });

  it("saves PDFs, spreadsheets and other files the model can't read inline, and says where (#139)", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const pdf = Buffer.from("%PDF-1.7 fake");
    const xlsx = Buffer.from("PK fake workbook");
    await core.api["chat.send"]({
      agentId: agent.id,
      text: "read these",
      attachments: [
        { name: "invoice.pdf", mediaType: "application/pdf", data: pdf.toString("base64") },
        {
          name: "deals.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          data: xlsx.toString("base64"),
        },
        // Pictures go to the model as images and small text inline: neither is saved as a file.
        { name: "shot.png", mediaType: "image/png", data: Buffer.from("png").toString("base64") },
        { name: "notes.txt", mediaType: "text/plain", data: Buffer.from("hello").toString("base64") },
      ],
    });
    await until(() => mock.count("turn.send") === 1);
    expect(mock.written.map((w) => [w.dir, w.name])).toEqual([
      ["uploads", "invoice.pdf"],
      ["uploads", "deals.xlsx"],
    ]);
    const text = mock.turnTexts.at(-1)!;
    expect(text).toContain('"invoice.pdf" (application/pdf, ');
    expect(text).toContain("It's saved on your computer at ~/uploads/invoice.pdf");
    expect(text).toContain("It's saved on your computer at ~/uploads/deals.xlsx");
    expect(text).toContain('<attached file name="notes.txt">\nhello');
    expect(text).not.toContain("can't be read directly");
  });

  it("refuses a zip that's too big or isn't a zip, before anything runs", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const big = Buffer.concat([makeZip([]), Buffer.alloc(MAX_ZIP_BYTES)]);
    await expect(
      core.api["chat.send"]({
        agentId: agent.id,
        text: "",
        attachments: [{ name: "big.zip", mediaType: "application/zip", data: big.toString("base64") }],
      }),
    ).rejects.toThrow(/"big.zip" is 20.0 MB. Zip files can be up to 20.0 MB./);
    await expect(
      core.api["chat.send"]({
        agentId: agent.id,
        text: "",
        attachments: [{ name: "fake.zip", mediaType: "", data: Buffer.from("not a zip").toString("base64") }],
      }),
    ).rejects.toThrow(/isn't a zip file/);
    expect(mock.written).toHaveLength(0);
    expect(mock.count("turn.send")).toBe(0);
    expect(core.store.listTimeline(agent.id)).toHaveLength(0);
  });

  it("lists, edits, reorders and removes the user's queued messages, pushing queue.updated", async () => {
    const core = await boot();
    const pushes = capture(core);
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    for (const text of ["first", "second", "third"]) await core.api["chat.send"]({ agentId: agent.id, text });
    let q = await core.api["queue.list"]({ agentId: agent.id });
    expect(q.map((x) => x.text)).toEqual(["first", "second", "third"]);
    expect(q[0]).toMatchObject({ attachments: 0, createdAt: expect.any(Number) });
    // Waiting messages are in "Up next", not the chat, until they start.
    expect(core.store.listTimeline(agent.id).map((e) => e.item.text)).not.toContain("first");
    const last = () => pushes.filter((p) => p.channel === "queue.updated").at(-1)?.data;
    expect(last()).toMatchObject({ agentId: agent.id, items: q });

    q = await core.api["queue.update"]({ agentId: agent.id, id: q[1]!.id, text: "  second, edited " });
    expect(q[1]!.text).toBe("second, edited");
    await expect(core.api["queue.update"]({ agentId: agent.id, id: q[1]!.id, text: " " })).rejects.toThrow(
      /can't be empty/,
    );
    q = await core.api["queue.reorder"]({ agentId: agent.id, ids: [q[2]!.id, q[0]!.id] });
    expect(q.map((x) => x.text)).toEqual(["third", "first", "second, edited"]);
    q = await core.api["queue.remove"]({ agentId: agent.id, id: q[1]!.id });
    expect(q.map((x) => x.text)).toEqual(["third", "second, edited"]);
    expect(last()!.items.map((x: { text: string }) => x.text)).toEqual(["third", "second, edited"]);
    await expect(core.api["queue.remove"]({ agentId: agent.id, id: "qmsg_gone" })).rejects.toThrow(
      /isn't waiting anymore/,
    );

    // Stop: the queue runs in the new order, each message joining the chat as it starts.
    await core.api["chat.interrupt"]({ agentId: agent.id });
    await until(
      () => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: second, edited"),
      10000,
      "queue drains",
    );
    const said = core.store
      .listTimeline(agent.id)
      .filter((e) => e.item.kind === "user_message" || e.item.kind === "assistant_message")
      .map((e) => e.item.text);
    expect(said).toEqual(["slow", "third", "echo: third", "second, edited", "echo: second, edited"]);
    expect(mock.turnTexts.join("\n")).not.toContain("first");
    expect(await core.api["queue.list"]({ agentId: agent.id })).toEqual([]);
    expect(last()!.items).toEqual([]);
  });

  it("steers a queued message into the running task", async () => {
    const core = await boot();
    mock.steerMidTurn = true;
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    // Channels (Yo Phone) follow which turn each message became.
    const turns: TurnEvent[] = [];
    core.orchestrator.onTurn((e) => turns.push(e));
    const first = await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    const running = core.orchestrator.view(agent.id);
    const sent = await core.api["chat.send"]({ agentId: agent.id, text: "use the cheaper one" });
    await core.api["chat.send"]({ agentId: agent.id, text: "later" });
    const [steer] = await core.api["queue.list"]({ agentId: agent.id });
    expect(sent).toEqual({ turnId: "queued", queuedId: steer!.id });
    const res = await core.api["queue.steer"]({ agentId: agent.id, id: steer!.id });
    expect(res.steered).toBe(true);
    expect(res.items.map((x) => x.text)).toEqual(["later"]);
    // It went into the same running task (no new task), stamped with the time like any message.
    expect(mock.steers).toHaveLength(1);
    expect(mock.steers[0]!.text).toMatch(/^\[.*\d{4}.*\] use the cheaper one$/);
    expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    expect(core.orchestrator.view(agent.id)?.activity).toBe(running?.activity);
    await until(
      () => core.store.listTimeline(agent.id).some((e) => e.item.text === "noted: use the cheaper one"),
      5000,
      "steer answered",
    );
    const bubble = core.store.listTimeline(agent.id).find((e) => e.item.text === "use the cheaper one");
    expect(bubble?.item).toMatchObject({ kind: "user_message", title: "Sent mid-task" });
    // The provider confirming the steered message doesn't end the running task.
    const sk = mock.sessionKeyOf(agent.id)!;
    mock.completeTurn(sk, mock.steers[0]!.turnId, "completed");
    await new Promise((r) => setTimeout(r, 100));
    expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    // The rest of the line still runs after the task.
    await core.api["chat.interrupt"]({ agentId: agent.id });
    await until(
      () => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: later"),
      10000,
      "queue runs",
    );
    const laterId = res.items[0]!.id;
    await until(() => turns.filter((e) => e.type === "ended").length === 2, 5000, "later ends");
    const laterTurn = turns.find((e) => e.type === "started" && e.queuedId === laterId)!.turnId;
    expect(turns).toEqual([
      // A message that runs right away also says which one it was (send's turnId already tells).
      { type: "started", agentId: agent.id, turnId: first.turnId, queuedId: expect.any(String) },
      { type: "steered", agentId: agent.id, turnId: first.turnId, queuedId: steer!.id },
      { type: "ended", agentId: agent.id, turnId: first.turnId, status: "interrupted" },
      { type: "started", agentId: agent.id, turnId: laterTurn, queuedId: laterId },
      { type: "ended", agentId: agent.id, turnId: laterTurn, status: "completed" },
    ]);
    // The reply is found by its turn.
    expect(core.store.listTimeline(agent.id).find((e) => e.item.text === "echo: later")?.turnId).toBe(
      laterTurn,
    );
  });

  it("never steers a Yo Phone message into a running task", async () => {
    const core = await boot();
    mock.steerMidTurn = true;
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    const sent = await core.orchestrator.send(agent.id, "from the phone", [], "user", undefined, "auto", {
      noSteer: true,
    });
    expect(sent.turnId).toBe("queued");
    const res = await core.api["queue.steer"]({ agentId: agent.id, id: sent.queuedId! });
    expect(res.steered).toBe(false);
    expect(res.note).toMatch(/Messages from Yo Phone get a turn of their own/);
    expect(mock.steers).toHaveLength(0);
  });

  it("moves a message to the front with a note when it can't be steered", async () => {
    const core = await boot();
    mock.steerFails = true;
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    await core.api["chat.send"]({ agentId: agent.id, text: "a" });
    await core.api["chat.send"]({ agentId: agent.id, text: "b" });
    const q = await core.api["queue.list"]({ agentId: agent.id });
    const res = await core.api["queue.steer"]({ agentId: agent.id, id: q[1]!.id });
    expect(res.steered).toBe(false);
    expect(res.note).toMatch(/couldn't take it mid-task\. It's next in line instead\./);
    expect(res.items.map((x) => x.text)).toEqual(["b", "a"]);
    expect(core.store.listTimeline(agent.id).map((e) => e.item.text)).not.toContain("b");
  });

  it("round-trips ask_user through a timeline card", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "ask me" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "pending ask");
    expect(core.orchestrator.activityOf(agent.id)).toBe("waiting");
    const req = core.store.pendingRequests()[0]!;
    expect(req.request!.kind).toBe("user_input");
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: req.request!.requestId,
      decision: "allow",
      answers: { q: "B" },
    });
    await until(() =>
      core.store.listTimeline(agent.id).some((e) => e.item.text === "got The user answered: B"),
    );
    expect(core.store.getEntry(req.id)!.request!.status).toBe("answered");
    // The card keeps what was picked, so the chat still shows the answer.
    expect(core.store.getEntry(req.id)!.request!.answers).toEqual({ q: "B" });
  });

  it("a message approval with a card number in it carries the warning, even past an 'always allow'", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    core.store.addRule({ agentId: agent.id, match: "yo:message", decision: "allow" });
    const send = (details: string) =>
      core.api["chat.send"]({
        agentId: agent.id,
        text: `tool request_approval ${JSON.stringify({ action: "Email the hotel", details, category: "message" })}`,
      });
    // Nothing sensitive: the standing rule answers.
    await send("Hi, we'll arrive around 6pm. Thanks!");
    await until(() =>
      core.store.listTimeline(agent.id).some((e) => e.item.text?.includes("APPROVED (standing rule)")),
    );
    expect(core.store.pendingRequests()).toHaveLength(0);
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    // A card number: the user is asked, and the card says what it found (never the number).
    await send("Please hold the room on card 4242 4242 4242 4242, exp 12/27.");
    await until(() => core.store.pendingRequests().length === 1, 5000, "card");
    const req = core.store.pendingRequests()[0]!.request!;
    expect(req.sensitive).toEqual([{ kind: "card", label: "a card number ending 4242" }]);
    expect(JSON.stringify(req.sensitive)).not.toContain("4242 4242");
  });

  it("a purchase approval skips its card but still warns about anything else", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const details = "Pay with card 4242 4242 4242 4242. Their form asks for SSN 123-45-6789.";
    await core.api["chat.send"]({
      agentId: agent.id,
      text: `tool request_approval ${JSON.stringify({ action: "Buy the plan", details, category: "purchase" })}`,
    });
    await until(() => core.store.pendingRequests().length === 1, 5000, "purchase");
    const req = core.store.pendingRequests()[0]!.request!;
    expect(req.sensitive).toEqual([{ kind: "ssn", label: "a Social Security number" }]);
  });

  it("stops waiting on an unanswered question, and the agent wraps up", async () => {
    const core = await boot({ userWaitMs: 300 });
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "ask me" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "pending ask");
    const req = core.store.pendingRequests()[0]!;
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text?.startsWith("got ")), 5000);
    expect(core.store.getEntry(req.id)!.request!.status).toBe("expired");
    const reply = core.store.listTimeline(agent.id).find((e) => e.item.text?.startsWith("got "))!;
    expect(reply.item.text).toMatch(/^got No answer from the user after 1 minute\. Don't guess/);
  });

  const replies = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
    core.store
      .listTimeline(agentId)
      .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
      .map((e) => e.item.text);

  it("keeps waiting on a take-over while the user is on the screen", async () => {
    const core = await boot({ userWaitMs: 300 });
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({
      agentId: agent.id,
      text: 'tool request_takeover {"reason":"Sign in to the CRM"}',
    });
    await until(() => core.store.pendingRequests().length === 1, 5000, "takeover card");
    await core.api["computer.takeover"]({ agentId: agent.id });
    await new Promise((r) => setTimeout(r, 1000));
    expect(core.store.pendingRequests()).toHaveLength(1);
    await core.api["computer.release"]({ agentId: agent.id, note: "signed in" });
    await until(() => replies(core, agent.id).length === 1, 5000, "reply");
    expect(replies(core, agent.id)[0]).toMatch(/^tool: The user took over and has handed control back/);
  });

  it("an unanswered take-over expires when the user never comes", async () => {
    const core = await boot({ userWaitMs: 300 });
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({
      agentId: agent.id,
      text: 'tool request_takeover {"reason":"Sign in to the CRM"}',
    });
    await until(() => replies(core, agent.id).length === 1, 5000, "reply");
    expect(replies(core, agent.id)[0]).toMatch(
      /^tool: The user didn't take over within 1 minute\. Stop here/,
    );
    expect(core.store.pendingRequests()).toHaveLength(0);
  });

  it("declines a provider approval nobody answered", async () => {
    const core = await boot({ userWaitMs: 300 });
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "approve this" });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "decision deny"), 5000);
    expect(mock.last("request.respond")!.message).toMatch(/NOT approved/);
    expect(core.store.pendingRequests()).toHaveLength(0);
  });

  it("stops a task that runs past the time limit", async () => {
    const core = await boot({ maxTurnMs: 300 });
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => core.orchestrator.activityOf(agent.id) !== "working", 5000, "stopped");
    expect(mock.count("turn.interrupt")).toBe(1);
    expect(core.store.listTimeline(agent.id).map((e) => e.item.text)).toContain(
      "I stopped after 1 minute so I don't run forever. Say \"continue\" and I'll pick up where I left off.",
    );
  });

  it("stops a task that froze (no events from the model for the stuck limit)", async () => {
    const core = await boot({ stuckTurnMs: 300 });
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => core.orchestrator.activityOf(agent.id) !== "working", 5000, "stopped");
    expect(mock.count("turn.interrupt")).toBe(1);
    expect(core.store.listTimeline(agent.id).map((e) => e.item.text)).toContain(
      'I stopped because a step froze for 1 minute. Say "continue" and I\'ll pick up where I left off.',
    );
    // The next message runs normally.
    await core.api["chat.send"]({ agentId: agent.id, text: "continue" });
    await until(() => replies(core, agent.id).includes("echo: continue"), 5000, "next turn");
  });

  it("doesn't stop a quiet task that is waiting on the user's card", async () => {
    const core = await boot({ stuckTurnMs: 200 });
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "ask me" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "pending ask");
    await new Promise((r) => setTimeout(r, 1000));
    expect(core.orchestrator.activityOf(agent.id)).toBe("waiting");
    expect(mock.count("turn.interrupt")).toBe(0);
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      decision: "allow",
      answers: { q: "B" },
    });
    await until(() => replies(core, agent.id).includes("got The user answered: B"), 5000, "reply");
    expect(core.store.listTimeline(agent.id).some((e) => e.item.text?.includes("froze"))).toBe(false);
  });

  it("handles provider approvals and remembers 'always allow'", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "approve this" });
    await until(() => core.store.pendingRequests().length === 1);
    const req = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: req.request!.requestId,
      decision: "allowAlways",
    });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "decision allowAlways"));
    expect(core.store.listRules()).toEqual([expect.objectContaining({ match: "Bash", decision: "allow" })]);
    // Second time the rule answers automatically.
    await core.api["chat.send"]({ agentId: agent.id, text: "approve again" });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "decision allow"));
    expect(core.store.pendingRequests()).toHaveLength(0);
  });

  it("saves memories via the remember tool and seeds them into new sessions", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "remember User loves window seats" });
    await until(() => core.store.listMemories().length === 1);
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    await core.api["agent.newSession"]({ id: agent.id });
    await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
    await until(() => mock.count("session.start") === 2);
    const sys = mock.last("session.start")!.systemAppend;
    expect(sys).toContain("User loves window seats");
    // Fresh session gets Yo's transcript for continuity.
    expect(sys).toContain("Conversation so far");
  });

  it("resumes the native session after a core restart", async () => {
    const core1 = await boot();
    await until(() => core1.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core1);
    await core1.api["chat.send"]({ agentId: agent.id, text: "first" });
    await until(() => core1.orchestrator.activityOf(agent.id) === "done");
    await core1.shutdown();
    cores = [];
    const core2 = await boot();
    await until(() => mock.count("session.stop") >= 1, 5000, "stale session stop");
    await until(() => core2.store.listAccounts().some((a) => a.status === "authenticated"));
    await core2.api["chat.send"]({ agentId: agent.id, text: "second" });
    await until(() => core2.store.listTimeline(agent.id).some((e) => e.item.text === "echo: second"));
    const start = mock.last("session.start")!;
    expect(start.resumeCursor).toMatchObject({ sessionId: expect.stringContaining("native-") });
    expect(
      core2.store.listTimeline(agent.id).filter((e) => e.item.kind === "assistant_message"),
    ).toHaveLength(2);
  });

  it("starts fresh (seeded from history) when the stored conversation is gone, e.g. after moving computers", async () => {
    const core1 = await boot();
    await until(() => core1.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core1);
    await core1.api["chat.send"]({ agentId: agent.id, text: "on the old computer" });
    await until(() => core1.orchestrator.activityOf(agent.id) === "done");
    await core1.shutdown();
    cores = [];
    mock.forgetConversations = true;
    const core2 = await boot();
    await until(() => core2.store.listAccounts().some((a) => a.status === "authenticated"));
    await core2.api["chat.send"]({ agentId: agent.id, text: "on the new computer" });
    await until(() =>
      core2.store.listTimeline(agent.id).some((e) => e.item.text === "echo: on the new computer"),
    );
    await until(() => core2.orchestrator.activityOf(agent.id) === "done");
    const starts = mock.requests.filter((r) => r.type === "session.start") as any[];
    expect(starts.at(-2).resumeCursor).toBeDefined();
    expect(starts.at(-1).resumeCursor).toBeUndefined();
    expect(starts.at(-1).systemAppend).toContain("on the old computer");
    const tl = core2.store.listTimeline(agent.id);
    // No scary error notices, and the user's message isn't duplicated.
    expect(tl.filter((e) => e.item.kind === "notice")).toHaveLength(0);
    expect(tl.filter((e) => e.item.kind === "user_message")).toHaveLength(2);
    expect(core2.orchestrator.activityOf(agent.id)).toBe("done");
  });

  it("/compact: summarizes, drops the heavy session, and seeds the next one from the summary", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["agent.compact"]({ id: agent.id });
    expect(core.store.listTimeline(agent.id).at(-1)!.item.text).toMatch(/Nothing to compact/);

    await core.api["chat.send"]({ agentId: agent.id, text: "plan the lisbon trip" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    core.store.clearUnread(agent.id);
    const sessionBefore = core.orchestrator.sessionKeyOf(agent.id);
    await core.api["agent.compact"]({ id: agent.id, focus: "flight times" });
    await until(
      () =>
        core.store.listTimeline(agent.id).some((e) => /^Compacted our conversation/.test(e.item.text ?? "")),
      5000,
      "compaction",
    );
    // The summary never shows up as a chat message, and compacting doesn't ping the user.
    const tl = core.store.listTimeline(agent.id);
    expect(tl.filter((e) => e.item.kind === "assistant_message")).toHaveLength(1);
    expect(core.store.getAgent(agent.id)!.unread).toBe(0);
    expect((mock.last("turn.send") as any).input[0].text).toContain("Pay special attention to: flight times");
    const summary = core.store.getContextSummary(agent.id)!;
    expect(summary.summary).toContain("compacting this conversation");
    expect(core.store.getSession(sessionBefore!)!.endedAt).toBeTruthy();
    expect(core.orchestrator.sessionKeyOf(agent.id)).toBeNull();

    await core.api["chat.send"]({ agentId: agent.id, text: "book it" });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: book it"));
    const start = mock.last("session.start")!;
    expect(start.resumeCursor).toBeUndefined();
    expect(start.systemAppend).toContain("# Summary of the earlier conversation");
    // Only messages after the compaction are replayed (none yet besides the one being sent).
    expect(start.systemAppend).not.toContain("# Most recent messages");
    expect(start.systemAppend).not.toContain("echo: plan the lisbon trip");
  });

  it("auto-compacts once a conversation gets heavy", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    mock.usageContextTokens = 150_000;
    await core.api["chat.send"]({ agentId: agent.id, text: "a very long task" });
    await until(
      () => core.store.listTimeline(agent.id).some((e) => /about 150k tokens/.test(e.item.text ?? "")),
      5000,
      "auto compaction",
    );
    expect(
      core.store.listTimeline(agent.id).some((e) => e.item.kind === "notice" && e.item.status === "failed"),
    ).toBe(false);
    expect(core.store.getContextSummary(agent.id)).not.toBeNull();
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
  });

  it("replays missed events after a connection drop without duplicates", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "one" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    mock.drop();
    await until(() => !core.agentd.connected);
    await until(() => core.agentd.connected, 8000, "reconnect");
    expect(mock.last("hello")!.resume.length).toBeGreaterThan(0);
    const assistants = core.store.listTimeline(agent.id).filter((e) => e.item.kind === "assistant_message");
    expect(assistants).toHaveLength(1);
  });

  it("starts a fresh seeded session when the agent switches provider", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().every((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "on claude" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done");
    const codex = core.store.listAccounts().find((a) => a.provider === "codex")!;
    await core.api["agent.update"]({ id: agent.id, patch: { accountId: codex.id, model: "gpt-6" } });
    await core.api["chat.send"]({ agentId: agent.id, text: "on codex" });
    await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: on codex"));
    const start = mock.last("session.start")!;
    expect(start.provider).toBe("codex");
    expect(start.resumeCursor).toBeUndefined();
    expect(start.systemAppend).toContain("on claude");
    expect(
      core.store
        .listTimeline(agent.id)
        .some((e) => e.item.kind === "notice" && /Switched to ChatGPT/.test(e.item.text ?? "")),
    ).toBe(true);
  });

  it("fires due routines, catches up recent misses, and skips stale ones", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const r = await core.api["routine.create"]({
      agentId: agent.id,
      name: "Morning brief",
      prompt: "brief me",
      cron: "0 8 * * *",
    });
    expect(r.nextRunAt).toBeGreaterThan(Date.now());
    const stale = await core.api["routine.create"]({
      agentId: agent.id,
      name: "Stale",
      prompt: "old",
      cron: "0 9 * * *",
    });
    core.store.updateRoutine(r.id, { nextRunAt: Date.now() - 60 * 60 * 1000 });
    core.store.updateRoutine(stale.id, { nextRunAt: Date.now() - CATCHUP_WINDOW_MS - 1000 });
    core.scheduler.tick();
    await until(
      () => core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: brief me"),
      5000,
      "routine run",
    );
    expect(core.store.listTimeline(agent.id).some((e) => e.item.text === "echo: old")).toBe(false);
    expect(core.store.getRoutine(r.id)!.nextRunAt).toBeGreaterThan(Date.now());
    expect(core.store.getRoutine(stale.id)!.nextRunAt).toBeGreaterThan(Date.now());
    // The skip isn't silent: the activity feed says why the routine didn't run.
    expect(core.store.listActivity(agent.id).map((a) => a.summary)).toContain(
      "Routine skipped (Yo was off or asleep when it was due): Stale",
    );
  });

  it("keeps a single card when agentd reconnects while a question is pending", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "ask me" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "pending ask");
    mock.drop(); // agentd re-pushes the unanswered call when the control socket comes back
    await until(() => mock.count("hello") >= 2, 8000, "reconnect");
    await new Promise((r) => setTimeout(r, 300));
    expect(core.store.pendingRequests()).toHaveLength(1);
    const req = core.store.pendingRequests()[0]!;
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: req.request!.requestId,
      decision: "allow",
      answers: { q: "A" },
    });
    await until(() =>
      core.store.listTimeline(agent.id).some((e) => e.item.text === "got The user answered: A"),
    );
  });

  it("expires pending cards and closes running steps when the provider exits mid-task", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "ask me" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "pending ask");
    const card = core.store.pendingRequests()[0]!;
    mock.exitSession(mock.sessionKeyOf(agent.id)!);
    await until(() => core.store.pendingRequests().length === 0, 5000, "card expired");
    expect(core.store.getEntry(card.id)!.request!.status).toBe("expired");
    expect(core.orchestrator.activityOf(agent.id)).not.toBe("waiting");
    expect(core.orchestrator.isBusy()).toBe(false);
    const turnId = card.turnId!;
    expect(
      core.store.listTimeline(agent.id).filter((e) => e.turnId === turnId && e.item.status === "running"),
    ).toEqual([]);
  });

  it("shows text streamed so far to a client that reconnects mid-reply", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "half the first part of a reply" });
    const streamed = () =>
      core.api["timeline.list"]({ agentId: agent.id }).then((tl) =>
        tl.find((e) => e.item.kind === "assistant_message" && e.item.status === "running"),
      );
    await until(async () => (await streamed())?.item.text === "the first part of a reply", 5000, "live text");
    // The stored row itself only gets the text once the message completes.
    const row = core.store.listTimeline(agent.id).find((e) => e.item.kind === "assistant_message")!;
    expect(row.item.text ?? "").toBe("");
  });

  it("auto-sleep runs on its own when core doesn't manage the computer (the home PC setup)", async () => {
    const core = await boot({ autoSleepCheckMs: 50 }); // computerMode "remote", like the PC
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hello there" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "reply");
    await core.api["settings.update"]({ autoSleepMinutes: 0.005 }); // 0.3 s
    await until(() => mock.count("computer.hibernate") > 0, 5000, "auto-sleep");
    expect(mock.last("computer.hibernate")?.agentId).toBe(agent.id);
  });

  it("auto-sleep puts idle computers to sleep in any computer mode, never a busy or just-woken one", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    // Busy: a reply that is still streaming keeps its computer awake, however long the idle limit.
    await core.api["chat.send"]({ agentId: agent.id, text: "half the first part of a reply" });
    const reply = () => core.store.listTimeline(agent.id).find((e) => e.item.kind === "assistant_message");
    await until(
      () => core.orchestrator.liveText(reply()?.id ?? "") === "the first part of a reply",
      5000,
      "busy",
    );
    expect(await core.orchestrator.sleepIdle(0)).toEqual([]);
    expect(mock.count("computer.hibernate")).toBe(0);
    // Idle past the limit: put to sleep (this is the path the 1-minute auto-sleep timer takes).
    mock.exitSession(mock.sessionKeyOf(agent.id)!);
    await until(() => !core.orchestrator.isBusy(), 5000, "idle");
    expect(await core.orchestrator.sleepIdle(0)).toEqual([agent.id]);
    expect(mock.last("computer.hibernate")?.agentId).toBe(agent.id);
    expect(core.orchestrator.activityOf(agent.id)).not.toBe("working");
    // Already asleep: nothing more to do.
    expect(await core.orchestrator.sleepIdle(0)).toEqual([]);
    // Woken by hand: counts as use, so it isn't put straight back to sleep.
    await core.api["computer.wake"]({ agentId: agent.id });
    expect(await core.orchestrator.sleepIdle(60_000)).toEqual([]);
    expect(mock.count("computer.hibernate")).toBe(1);
  });

  it("a sleeping agent's session stops, and its next message resumes the same conversation", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hello there" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "reply");
    const sessionKey = mock.sessionKeyOf(agent.id)!;
    expect(await core.orchestrator.sleepIdle(0)).toEqual([agent.id]);
    expect(mock.last("session.stop")?.sessionKey).toBe(sessionKey);
    expect(mock.sessionKeyOf(agent.id)).toBeUndefined();
    // Same Yo session, restarted from the native conversation's cursor (not a fresh, re-seeded one).
    await core.api["chat.send"]({ agentId: agent.id, text: "still there?" });
    await until(() => replies(core, agent.id).includes("echo: still there?"), 5000, "second reply");
    const start = mock.last("session.start")!;
    expect(start.sessionKey).toBe(sessionKey);
    expect(start.resumeCursor).toEqual({ sessionId: `native-${sessionKey}`, turns: expect.any(String) });
    expect(core.store.getSession(sessionKey)!.endedAt).toBeNull();
  });

  it("keeps the text streamed so far when the provider exits mid-reply", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "half the first part of a reply" });
    const reply = () => core.store.listTimeline(agent.id).find((e) => e.item.kind === "assistant_message");
    await until(
      () => core.orchestrator.liveText(reply()?.id ?? "") === "the first part of a reply",
      5000,
      "live",
    );
    mock.exitSession(mock.sessionKeyOf(agent.id)!);
    await until(() => reply()?.item.status === "failed", 5000, "closed");
    expect(reply()!.item.text).toBe("the first part of a reply");
  });

  it("tells the chat when core restarted during a task, and closes what it left running", async () => {
    const core1 = await boot();
    await until(() => core1.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core1);
    await core1.api["chat.send"]({ agentId: agent.id, text: "half working on it" });
    await until(() => core1.store.listTimeline(agent.id).some((e) => e.item.kind === "assistant_message"));
    await core1.shutdown();
    cores = [];
    const core2 = await boot();
    const tl = core2.store.listTimeline(agent.id);
    expect(
      tl.some((e) => e.item.kind === "notice" && /Yo restarted during this task/.test(e.item.text ?? "")),
    ).toBe(true);
    expect(tl.filter((e) => e.item.status === "running")).toEqual([]);
  });

  it("keeps a routine quiet when it has nothing to report", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const pushes = capture(core);
    const r = await core.api["routine.create"]({
      agentId: agent.id,
      name: "Watch prices",
      prompt: "quiet",
      cron: "0 8 * * *",
    });
    core.store.updateRoutine(r.id, { nextRunAt: Date.now() - 60 * 1000 });
    core.scheduler.tick();
    await until(
      () =>
        core.store.listTimeline(agent.id).some((e) => e.item.text === "Routine ran: nothing new to report."),
      5000,
      "quiet routine",
    );
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    expect(pushes.some((p) => p.channel === "notify" && p.data.agentId === agent.id)).toBe(false);
    expect(core.store.getAgent(agent.id)!.unread).toBe(0);
    expect(core.store.listTimeline(agent.id).some((e) => e.item.text === "NO_RESPONSE")).toBe(false);
  });

  it("does not keep tool screenshots in the timeline", async () => {
    const core = await boot();
    const agent = primary(core);
    const e = core.store.upsertEntry({
      id: "shot",
      agentId: agent.id,
      turnId: null,
      item: {
        id: "i1",
        kind: "tool",
        status: "completed",
        toolName: "screenshot",
        image: "iVBORw0KGgo=",
      } as any,
    });
    expect(e.item.image).toBeUndefined();
    const raw = core.store.db.prepare("SELECT item_json FROM timeline WHERE id = 'shot'").get() as any;
    expect(raw.item_json).not.toContain("iVBORw0KGgo");
  });

  it("serves the UI with a CSP that allows its inline theme script, and filters pushes by channel", async () => {
    const web = fs.mkdtempSync(path.join(os.tmpdir(), "yo-web-test-"));
    const inline = "\n      document.documentElement.className = 'dark';\n    ";
    fs.writeFileSync(
      path.join(web, "index.html"),
      `<!doctype html><html><head><script>${inline}</script><script type="module" src="./a.js"></script></head></html>`,
    );
    const core = await boot({ dev: true, webDist: web });
    const res = await fetch(`http://127.0.0.1:${core.cfg.port}/`);
    const csp = res.headers.get("content-security-policy") ?? "";
    const hash = (await import("node:crypto")).createHash("sha256").update(inline).digest("base64");
    expect(csp).toContain(`'sha256-${hash}'`);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const { default: WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${core.cfg.port}/ws?channels=notify`);
    const got: string[] = [];
    ws.on("message", (raw) => got.push(JSON.parse(raw.toString()).push));
    await new Promise((r) => ws.on("open", r));
    core.hub.push("activity.new", {
      id: "a",
      agentId: null,
      kind: "x",
      summary: "s",
      ref: null,
      ts: 0,
    } as any);
    core.hub.push("notify", { agentId: null, title: "t", body: "b", kind: "info" });
    await until(() => got.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual(["notify"]);
    ws.close();
    fs.rmSync(web, { recursive: true, force: true });
  });

  it("a sign-in that finished while Yo wasn't looking is picked up before refusing the message", async () => {
    // The friend's Grok: he signed in while his Yo restarted for an update, so core still said "not signed in".
    mock.requireLogin = true;
    const core = await boot();
    await until(() => core.store.listAccounts().every((a) => a.status === "unauthenticated"), 5000, "probe");
    mock.requireLogin = false; // the CLI is signed in now; core hasn't looked again
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "are you there" });
    await until(() => mock.count("turn.send") > 0, 5000, "turn sent");
    const texts = core.store.listTimeline(agent.id).map((e) => e.item.text ?? "");
    expect(texts.some((t) => /isn't connected yet/.test(t))).toBe(false);
  });

  it("no model: the message says where to connect one, and connecting clears the error", async () => {
    mock.requireLogin = true; // nothing signed in
    const core = await boot();
    await until(() => core.store.listAccounts().every((a) => a.status === "unauthenticated"), 5000, "probe");
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
    await until(() => core.orchestrator.activityOf(agent.id) === "error", 5000, "refused");
    const texts = () => core.store.listTimeline(agent.id).map((e) => e.item.text ?? "");
    expect(texts().some((t) => /isn't connected yet\. Connect .* in Settings → Accounts/.test(t))).toBe(true);
    expect(mock.count("turn.send")).toBe(0);

    // Sign in to Claude with Claude Code's own sign-in on Yo's computer (link, then the code Claude shows).
    const claude = core.store.listAccounts().find((a) => a.provider === "claude")!;
    await core.api["account.login.start"]({ id: claude.id });
    await until(() => mock.loginStarts === 1, 5000, "login started");
    await core.api["account.login.input"]({ id: claude.id, input: "code#s1" });
    await until(() => core.orchestrator.activityOf(agent.id) !== "error", 5000, "error cleared");
    expect(texts().some((t) => /A model is connected now/.test(t))).toBe(true);
  });

  it("a permission change reaches the running session before the next message", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "first turn");
    const started = mock.last("session.start")!;
    expect(started.runtimeMode).toBe("full-access");
    await core.api["agent.update"]({ id: agent.id, patch: { runtimeMode: "approval-required" } });
    await core.api["chat.send"]({ agentId: agent.id, text: "again" });
    await until(() => mock.count("turn.send") === 2, 5000, "second turn");
    expect(mock.last("session.set")).toMatchObject({
      sessionKey: started.sessionKey,
      runtimeMode: "approval-required",
    });
    // Once is enough: the session now runs in that mode.
    await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "second turn done");
    await core.api["chat.send"]({ agentId: agent.id, text: "third" });
    await until(() => mock.count("turn.send") === 3, 5000, "third turn");
    expect(mock.count("session.set")).toBe(1);
  });

  it("a model switch the session refuses is not saved, and the chat says so", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
    await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "first turn");
    const before = core.store.getAgent(agent.id)!.model;
    const sessionBefore = core.store.latestSession(agent.id)!.model;
    mock.failSessionSet = true;
    await core.api["agent.update"]({ id: agent.id, patch: { model: "claude-opus" } });
    expect(core.store.getAgent(agent.id)!.model).toBe("claude-opus");
    await core.api["chat.send"]({ agentId: agent.id, text: "use the new model" });
    await until(
      () =>
        core.store
          .listTimeline(agent.id)
          .some((e) => /Couldn't switch to claude-opus/.test(e.item.text ?? "")),
      5000,
      "switch error",
    );
    const note = core.store
      .listTimeline(agent.id)
      .find((e) => /Couldn't switch to claude-opus/.test(e.item.text ?? ""));
    expect(note?.item.kind).toBe("notice");
    expect(note?.item.status).toBe("failed");
    expect(note?.item.text).toMatch(/still using/);
    // The picker goes back to the model the session is actually on, and that model isn't recorded as switched.
    expect(core.store.getAgent(agent.id)!.model).toBe(before);
    expect(core.store.latestSession(agent.id)!.model).toBe(sessionBefore);
    expect([...mock.sessions.values()].some((s) => s.model === "claude-opus")).toBe(false);
    expect(mock.last("session.set")).toMatchObject({ model: "claude-opus" });
    expect(mock.count("turn.send")).toBe(1);
  });

  describe("after agentd reconnects", () => {
    const lostNotice = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
      core.store.listTimeline(agentId).some((e) => /lost connection to my computer/.test(e.item.text ?? ""));

    for (const reportsLive of [true, false]) {
      it(`keeps a turn that is waiting on a provider approval (${reportsLive ? "agentd lists live sessions" : "older agentd"})`, async () => {
        mock.reportLiveSessions = reportsLive;
        const core = await boot({ lostTurnGraceMs: 300 });
        await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
        const agent = primary(core);
        await core.api["chat.send"]({ agentId: agent.id, text: "approve this" });
        await until(() => core.store.pendingRequests().length === 1, 5000, "pending approval");
        mock.drop(); // a network blip: agentd and the provider session carry on
        await until(() => mock.count("hello") >= 2, 8000, "reconnect");
        await new Promise((r) => setTimeout(r, 800));
        expect(lostNotice(core, agent.id)).toBe(false);
        expect(core.orchestrator.activityOf(agent.id)).toBe("waiting");
        const req = core.store.pendingRequests()[0]!;
        await core.api["request.respond"]({
          agentId: agent.id,
          requestId: req.request!.requestId,
          decision: "allow",
        });
        await until(() => core.store.listTimeline(agent.id).some((e) => e.item.text === "decision allow"));
      });
    }

    it("keeps a quiet turn on a session that survived", async () => {
      const core = await boot({ lostTurnGraceMs: 300 });
      await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
      const agent = primary(core);
      await core.api["chat.send"]({ agentId: agent.id, text: "slow" }); // e.g. a long command with no output
      await until(() => mock.count("turn.send") === 1);
      mock.drop();
      await until(() => mock.count("hello") >= 2, 8000, "reconnect");
      await new Promise((r) => setTimeout(r, 800));
      expect(lostNotice(core, agent.id)).toBe(false);
      expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    });

    it('a computer that comes up after "Do this later" counts as set up', async () => {
      const core = await boot();
      core.store.updateSettings({ computerSetup: "later" });
      const pushes = capture(core);
      mock.drop(); // e.g. the first message woke it
      await until(() => core.store.getSettings().computerSetup === "done", 8000, "set up");
      expect(pushes.some((p) => p.channel === "settings.updated" && p.data.computerSetup === "done")).toBe(
        true,
      );
    });

    for (const reportsLive of [true, false]) {
      it(`keeps a long turn that had to wake the computer first (${reportsLive ? "agentd lists live sessions" : "older agentd"})`, async () => {
        mock.reportLiveSessions = reportsLive;
        const core = await boot({ lostTurnGraceMs: 300 });
        await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
        const agent = primary(core);
        await core.api["chat.send"]({ agentId: agent.id, text: "hi" });
        await until(() => core.orchestrator.activityOf(agent.id) === "done", 5000, "first turn");
        // The computer went to sleep (auto-sleep): its sessions are gone. The next message wakes it.
        mock.restart();
        await until(() => !core.agentd.connected, 5000, "disconnect");
        await core.api["chat.send"]({ agentId: agent.id, text: "slow" }); // a long task, quiet for a while
        await until(() => mock.count("turn.send") === 2, 8000, "sent after the wake-up");
        await new Promise((r) => setTimeout(r, 900));
        expect(lostNotice(core, agent.id)).toBe(false);
        expect(core.orchestrator.activityOf(agent.id)).toBe("working");
      });
    }

    it("ends a turn whose session didn't survive an agentd restart", async () => {
      const core = await boot({ lostTurnGraceMs: 300 });
      await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
      const agent = primary(core);
      await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
      await until(() => mock.count("turn.send") === 1);
      mock.restart();
      await until(() => lostNotice(core, agent.id), 8000, "lost notice");
      await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    });
  });

  it("rejects cross-origin websocket connections", async () => {
    // Dev mode lets a session-less loopback client in, so this exercises the Origin check alone.
    const core = await boot({ dev: true });
    const { default: WebSocket } = await import("ws");
    const url = `ws://127.0.0.1:${core.cfg.port}/ws`;
    const bad = new WebSocket(url, { headers: { Origin: "https://evil.example" } });
    const badResult = await new Promise<string>((resolve) => {
      bad.on("open", () => resolve("open"));
      bad.on("error", () => resolve("rejected"));
      bad.on("unexpected-response", () => resolve("rejected"));
    });
    expect(badResult).toBe("rejected");
    const good = new WebSocket(url, { headers: { Origin: `http://127.0.0.1:${core.cfg.port}` } });
    const reply = await new Promise<any>((resolve) => {
      good.on("open", () => good.send(JSON.stringify({ id: "1", method: "bootstrap", params: {} })));
      good.on("message", (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.id === "1") resolve(f);
      });
    });
    good.close();
    expect(reply.result.agents[0].name).toBe("Yo");
  });

  it("the live view closes with a reason when the computer is off", async () => {
    const core = await boot({ dev: true });
    await mock.close();
    await until(() => !core.agentd.connected, 5000, "agentd disconnected");
    const { default: WebSocket } = await import("ws");
    const closed = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${core.cfg.port}/api/vnc/agt_x`);
      const timer = setTimeout(() => reject(new Error("vnc socket stayed open")), 5000);
      ws.on("close", (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      ws.on("error", () => undefined);
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`vnc upgrade rejected: ${res.statusCode}`));
      });
    });
    expect(closed).toEqual({ code: 4404, reason: "computer is not running" });
  });

  it("signs in without races: non-blocking start, same link on re-click, refresh can't clobber, bad code errors", async () => {
    mock.requireLogin = true;
    const core = await boot();
    const pushes = capture(core);
    const claude = core.store.listAccounts().find((a) => a.provider === "claude")!;
    await until(() => core.store.getAccount(claude.id)!.status === "unauthenticated");
    await core.api["account.login.start"]({ id: claude.id });
    expect(core.store.getAccount(claude.id)!.status).toBe("signing_in");
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.url));
    // Re-clicking Connect re-shows the SAME link instead of restarting (restart would invalidate PKCE).
    await core.api["account.login.start"]({ id: claude.id });
    expect(mock.loginStarts).toBe(1);
    const urls = pushes.filter((p) => p.channel === "account.login" && p.data.url).map((p) => p.data.url);
    expect(new Set(urls).size).toBe(1);
    // A status refresh (e.g. on reconnect) must not reset "signing_in".
    await core.accounts.refresh(claude.id);
    expect(core.store.getAccount(claude.id)!.status).toBe("signing_in");
    // Wrong code -> clear error; account back to unauthenticated.
    await core.api["account.login.input"]({ id: claude.id, input: "wrong" });
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.phase === "error"));
    await until(() => core.store.getAccount(claude.id)!.status === "unauthenticated");
    // Try again (restart) -> fresh link -> right code -> authenticated. Claude Code keeps its own sign-in on
    // Yo's computer: Yo stores nothing.
    await core.api["account.login.start"]({ id: claude.id, restart: true });
    await until(() => mock.loginStarts === 2);
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.url?.endsWith("s2")));
    await core.api["account.login.input"]({ id: claude.id, input: "code#s2" });
    await until(() => core.store.getAccount(claude.id)!.status === "authenticated", 5000, "authenticated");
    expect(await core.accounts.getSecrets(claude.id)).toEqual({});
    expect(core.store.defaultAccount()!.id).toBe(claude.id);
    const start = (mock.requests as any[]).filter((r) => r.type === "auth.login.start").at(-1);
    expect(start).toMatchObject({ provider: "claude", method: "claude-cli-login" });
  });

  it("a legacy Claude token keeps working until the new sign-in, then Yo forgets it everywhere", async () => {
    mock.requireLogin = true;
    const LEGACY = `sk-ant-oat01-${"FAKE_legacy_tok-".repeat(6)}`;
    const secrets = new MemorySecretStore();
    // Saved by an older Yo's "paste a token" flow, next to an API key that must survive.
    const first = await boot({ secrets });
    const claude = first.store.listAccounts().find((a) => a.provider === "claude")!;
    await secrets.set(
      `account:${claude.id}`,
      JSON.stringify({ claudeOauthToken: LEGACY, anthropicApiKey: "k" }),
    );
    await first.shutdown();
    cores = cores.filter((c) => c !== first);

    const core = await boot({ secrets });
    const pushes = capture(core);
    // Flagged for the one-time notice; agentd still gets the token so nothing breaks mid-work.
    await until(() => !!core.store.getAccount(claude.id)!.legacyToken, 5000, "flagged");
    await until(() =>
      (mock.requests as any[]).some((r) => r.type === "account.configure" && r.accountId === claude.id),
    );
    const sent = (mock.requests as any[]).filter(
      (r) => r.type === "account.configure" && r.accountId === claude.id,
    );
    expect(sent.at(-1).secrets.claudeOauthToken).toBe(LEGACY);

    await core.api["account.login.start"]({ id: claude.id, restart: true });
    await until(() => pushes.some((p) => p.channel === "account.login" && p.data.url));
    await core.api["account.login.input"]({ id: claude.id, input: `code#s${mock.loginStarts}` });
    await until(() => core.store.getAccount(claude.id)!.status === "authenticated", 5000, "authenticated");
    await until(() => !core.store.getAccount(claude.id)!.legacyToken, 5000, "flag cleared");
    expect(await core.accounts.getSecrets(claude.id)).toEqual({ anthropicApiKey: "k" });
    // agentd re-configured without it, and the account update the app gets says so.
    const after = (mock.requests as any[]).filter(
      (r) => r.type === "account.configure" && r.accountId === claude.id,
    );
    expect(after.at(-1).secrets).toEqual({ anthropicApiKey: "k" });
    expect(
      pushes.some(
        (p) => p.channel === "account.updated" && p.data.id === claude.id && p.data.legacyToken === false,
      ),
    ).toBe(true);
  });

  it("never stores a Claude token an older agentd sends back with its sign-in result", async () => {
    mock.requireLogin = true;
    mock.legacyLoginSecrets = true;
    const core = await boot();
    const claude = core.store.listAccounts().find((a) => a.provider === "claude")!;
    await until(() => core.store.getAccount(claude.id)!.status === "unauthenticated");
    await core.api["account.login.start"]({ id: claude.id });
    await until(() => mock.loginStarts === 1);
    await core.api["account.login.input"]({ id: claude.id, input: "code#s1" });
    await until(() => core.store.getAccount(claude.id)!.status === "authenticated", 5000, "authenticated");
    expect(await core.accounts.getSecrets(claude.id)).toEqual({});
    const configs = (mock.requests as any[]).filter(
      (r) => r.type === "account.configure" && r.accountId === claude.id,
    );
    expect(configs.every((r) => !r.secrets.claudeOauthToken)).toBe(true);
  });

  it("starting sign-in while the computer is off returns immediately and boots it", async () => {
    mock.requireLogin = true;
    const core = await boot();
    const claude = core.store.listAccounts().find((a) => a.provider === "claude")!;
    await until(() => core.store.getAccount(claude.id)!.status === "unauthenticated");
    let booted = false;
    core.accounts.ensureComputer = async () => {
      booted = true;
    };
    mock.drop();
    await until(() => !core.agentd.connected);
    const t0 = Date.now();
    await core.api["account.login.start"]({ id: claude.id });
    expect(Date.now() - t0).toBeLessThan(500);
    await until(() => core.agentd.connected, 8000, "reconnect");
    await until(() => mock.loginStarts === 1, 8000, "login started after boot");
    expect(booted).toBe(true);
  });

  it("gives every existing worker a headset (migration 2) without touching uploaded images", async () => {
    const { openDb } = await import("../src/db/db");
    // Seed agents on a migrated DB, then roll back migration 2 and reopen so it runs against them.
    const db1 = openDb(dataDir);
    db1
      .prepare("INSERT INTO agents (id, name, avatar_json, created_at) VALUES (?,?,?,?)")
      .run(
        "a1",
        "Hat",
        JSON.stringify({ shape: "hex", color: "cobalt", eyes: "round", accessory: "crown" }),
        1,
      );
    db1
      .prepare("INSERT INTO agents (id, name, avatar_json, created_at) VALUES (?,?,?,?)")
      .run(
        "a2",
        "Photo",
        JSON.stringify({ shape: "bubble", color: "yo", eyes: "capsule", accessory: "none", image: "data:x" }),
        2,
      );
    // Roll back migration 2 and everything after it (later ones re-run cleanly).
    db1.exec(
      "DELETE FROM _migrations WHERE version >= 2; DROP TABLE IF EXISTS context_summaries; ALTER TABLE artifacts DROP COLUMN kind; ALTER TABLE device_grants DROP COLUMN app; ALTER TABLE artifacts DROP COLUMN issue_json; ALTER TABLE artifacts DROP COLUMN report_json; DROP INDEX idx_agents_parent; ALTER TABLE agents DROP COLUMN kind; ALTER TABLE agents DROP COLUMN parent_id; ALTER TABLE agents DROP COLUMN brief; DROP TABLE tasks; DROP TABLE playbook_runs; DROP INDEX idx_agents_space; DROP INDEX idx_memories_scope; ALTER TABLE agents DROP COLUMN space; ALTER TABLE memories DROP COLUMN space; ALTER TABLE artifacts DROP COLUMN pinned_at; ALTER TABLE artifacts DROP COLUMN page_kind;",
    );
    db1.close();
    const db2 = openDb(dataDir);
    const rows = db2.prepare("SELECT id, avatar_json FROM agents ORDER BY id").all() as {
      id: string;
      avatar_json: string;
    }[];
    db2.close();
    expect(JSON.parse(rows[0]!.avatar_json).accessory).toBe("headset");
    expect(JSON.parse(rows[1]!.avatar_json).accessory).toBe("none");
  });

  it("fires each scheduled occurrence once, even with duplicate ticks or a second core", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    let fired = 0;
    core.scheduler.setFire(async () => {
      fired++;
    });
    const r = core.scheduler.create({
      agentId: agent.id,
      name: "Daily",
      prompt: "go",
      cron: "0 8 * * *",
      runAt: null,
    });
    const due = Date.now() - 1000;
    core.store.updateRoutine(r.id, { nextRunAt: due });
    // A second process sharing the database claims the same occurrence first.
    expect(core.store.claimRoutineRun(r.id, due)).toBe(true);
    core.scheduler.tick();
    await new Promise((res) => setTimeout(res, 50));
    expect(fired).toBe(0);

    const due2 = Date.now() - 500;
    core.store.updateRoutine(r.id, { nextRunAt: due2 });
    core.scheduler.tick();
    core.scheduler.tick();
    await until(() => fired === 1);
    await new Promise((res) => setTimeout(res, 50));
    expect(fired).toBe(1);
  });

  it("reports a routine that was claimed but never started instead of re-running it", async () => {
    const core = await boot();
    const agent = primary(core);
    const r = core.scheduler.create({
      agentId: agent.id,
      name: "Report",
      prompt: "go",
      cron: "0 8 * * *",
      runAt: null,
    });
    core.store.claimRoutineRun(r.id, 12345);
    let fired = 0;
    core.scheduler.setFire(async () => {
      fired++;
    });
    core.scheduler.stop();
    core.scheduler.start(60_000);
    expect(core.store.claimedRoutineRuns()).toHaveLength(0);
    expect(
      core.store.listActivity(agent.id).some((e) => /didn't start \(Yo restarted\)/.test(e.summary)),
    ).toBe(true);
    expect(fired).toBe(0);
  });

  it("snapshots chat pictures per version: a redone file at the same path gets a new URL, old messages keep theirs", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    const imagesOf = () =>
      core.store
        .listTimeline(agent.id)
        .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
        .map((e) => e.item.images ?? {});

    mock.files.set("/home/agent/desk.png", "RED");
    await core.api["chat.send"]({ agentId: agent.id, text: "![Desk](/home/agent/desk.png)" });
    await until(
      () => imagesOf().length === 1 && !!imagesOf()[0]!["/home/agent/desk.png"],
      5000,
      "first snapshot",
    );
    mock.files.set("/home/agent/desk.png", "BLUE");
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    await core.api["chat.send"]({ agentId: agent.id, text: "again ![Desk](/home/agent/desk.png)" });
    await until(
      () => imagesOf().length === 2 && !!imagesOf()[1]!["/home/agent/desk.png"],
      5000,
      "second snapshot",
    );

    const [first, second] = imagesOf().map((m) => m["/home/agent/desk.png"]!);
    expect(first).not.toBe(second);
    const fs = await import("node:fs");
    expect(fs.readFileSync(path.join(dataDir, "chat-images", first!), "utf8")).toBe("RED");
    expect(fs.readFileSync(path.join(dataDir, "chat-images", second!), "utf8")).toBe("BLUE");
  });

  it("bug reports: drafted in the chat, refused until the user answers, then filed on GitHub", async () => {
    const filed: { url: string; body: any }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      filed.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({ number: 42, html_url: "https://github.com/JuniorSua/yo/issues/42" }),
        {
          status: 201,
        },
      );
    }) as unknown as typeof fetch;
    process.env.YO_AGENTD_TOKEN = TOKEN;
    const core = await startCore(
      {
        ...loadConfig({}),
        port: port++,
        dataDir,
        agentdUrl,
        computerMode: "remote",
        secrets: "file",
        webDist: null,
        githubApi: "https://github.test",
      },
      { secrets: new MemorySecretStore(), fetch: fakeFetch },
    );
    cores.push(core);
    await core.agentd.waitReady(5000);
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    expect((await core.api["bugReports.status"]({})).configured).toBe(false);
    await core.api["bugReports.configure"]({ token: "github_pat_fake" });
    const agent = primary(core);
    const replies = () =>
      core.store
        .listTimeline(agent.id)
        .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
        .map((e) => String(e.item.text));

    await core.api["chat.send"]({
      agentId: agent.id,
      text: `tool report_bug ${JSON.stringify({
        stage: "draft",
        title: "Chat shows an old image",
        what_happened: "Redone desk still showed $76,022",
        suspected_cause: "Same URL, cached",
        suggested_fix: "Snapshot by hash",
      })}`,
    });
    await until(() => replies().some((t) => t.includes("[bug-draft:")), 5000, "draft");
    const draftId = /\[bug-draft:(bdr_[A-Za-z0-9]+)\]/.exec(replies().at(-1)!)![1]!;
    expect(core.store.listArtifacts()).toHaveLength(0);
    expect(mock.last("session.start")!.systemAppend).toContain("Would you like me to report it?");

    // The agent tries to submit on its own, without a reply from the user: refused.
    const sessionKey = mock.sessionKeyOf(agent.id)!;
    const early = await mock.forgeToolCall(agent.id, sessionKey, "report_bug", {
      stage: "submit",
      draft_id: draftId,
    });
    expect(early).toMatch(/^Error: Not sent: the user hasn't answered yet/);

    // Another agent can't submit this conversation's draft.
    const other = await core.api["agent.create"]({
      name: "Scout",
      role: "",
      instructions: "",
      avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" },
    });
    await core.api["chat.send"]({ agentId: other.id, text: "yes" });
    await until(() => !!mock.sessionKeyOf(other.id), 5000, "other session");
    const stolen = await mock.forgeToolCall(other.id, mock.sessionKeyOf(other.id)!, "report_bug", {
      stage: "submit",
      draft_id: draftId,
    });
    expect(stolen).toMatch(/no bug report draft .* in this conversation/);
    expect(filed).toHaveLength(0);

    // A reply that isn't a yes doesn't count.
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    await core.api["chat.send"]({ agentId: agent.id, text: "what would it say?" });
    await until(() => replies().some((t) => t === "echo: what would it say?"), 5000, "question");
    const unclear = await mock.forgeToolCall(agent.id, sessionKey, "report_bug", {
      stage: "submit",
      draft_id: draftId,
    });
    expect(unclear).toMatch(/isn't a clear yes/);

    // The user says yes (the card's "Report it"), then the agent submits.
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
    await core.api["chat.send"]({ agentId: agent.id, text: "Report it" });
    await until(() => replies().some((t) => t === "echo: Report it"), 5000, "yes");
    const ok = await mock.forgeToolCall(agent.id, sessionKey, "report_bug", {
      stage: "submit",
      draft_id: draftId,
    });
    expect(ok).toContain("issue #42");
    expect(filed).toHaveLength(1);
    expect(filed[0]!.url).toBe("https://github.test/repos/JuniorSua/yo/issues");
    expect(filed[0]!.body.body).toContain("## Suggested fix\n\nSnapshot by hash");
    expect(filed[0]!.body.body).toContain("Agent: Yo on claude");
    const art = core.store.listArtifacts().find((a) => a.kind === "bug")!;
    expect(art.issue).toEqual({ number: 42, url: "https://github.com/JuniorSua/yo/issues/42" });
    expect(ok).toContain(`[artifact:${art.id}]`);
    const md = (await import("node:fs")).readFileSync(core.store.artifactFile(art.id)!.storedPath, "utf8");
    expect(md).toContain("# Bug: Chat shows an old image");
    expect(md).toContain("## Suspected cause\n\nSame URL, cached");
  });
});

describe("team chat (agent to agent)", () => {
  const AVATAR: Avatar = { shape: "bubble", color: "emerald", eyes: "capsule", accessory: "headset" };

  async function team(opts: Parameters<typeof boot>[0] = {}) {
    const core = await boot(opts);
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const yo = primary(core);
    const pepe = await core.api["agent.create"]({
      name: "Pepe",
      role: "Head of Polestar",
      instructions: "",
      avatar: AVATAR,
    });
    return { core, yo, pepe };
  }
  const said = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
    core.store
      .listTimeline(agentId)
      .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
      .map((e) => e.item.text);

  it("a teammate whose computer and session went to sleep still answers", async () => {
    const { core, yo, pepe } = await team();
    await core.api["chat.send"]({ agentId: pepe.id, text: "warm up" });
    await until(() => said(core, pepe.id).length === 1, 8000, "Pepe's first reply");
    const pepeSession = mock.sessionKeyOf(pepe.id)!;
    expect(await core.orchestrator.sleepIdle(0)).toContain(pepe.id);
    expect(mock.sessionKeyOf(pepe.id)).toBeUndefined();
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"ping"}',
    });
    // Sent at once; Pepe's answer wakes Yo a moment later.
    await until(() => said(core, yo.id).length === 2, 8000, "Pepe's reply reaches Yo");
    expect(said(core, yo.id)[0]).toMatch(/^tool: Sent to Pepe\./);
    expect(said(core, yo.id)[1]).toContain("echo: ping");
    expect(mock.sessionKeyOf(pepe.id)).toBe(pepeSession);
  });

  it("with wait: true, puts the message in the teammate's chat, runs it there, and hands the reply back", async () => {
    const { core, yo, pepe } = await team();
    const pushes = capture(core);
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"pepe","message":"hello Pepe","wait":true}',
    });
    await until(() => said(core, yo.id).length === 1, 8000, "Yo's reply");
    expect(said(core, yo.id)[0]).toBe(
      'tool: Pepe replied:\n\n<teammate_reply from="Pepe">\necho: hello Pepe\n</teammate_reply>',
    );
    // Pepe's chat shows Yo's message (from Yo, not the user) and Pepe's answer.
    const incoming = core.store.listTimeline(pepe.id).find((e) => e.item.kind === "user_message")!;
    expect(incoming.item).toMatchObject({ text: "hello Pepe", from: { agentId: yo.id, name: "Yo" } });
    expect(said(core, pepe.id)).toEqual(["echo: hello Pepe"]);
    // Pepe's model is told who is talking and that its answer goes back.
    const pepeTurn = mock.turnTexts.find((t) => t.includes("hello Pepe") && t.includes("[Message from"))!;
    expect(pepeTurn).toContain("[Message from your teammate Yo");
    expect(pepeTurn).toContain("Yo is waiting: your final message is sent back to them as your reply");
    // Pepe's side doesn't pop a notification (the exchange shows in Yo's chat), but it's marked unread.
    await until(() => core.orchestrator.activityOf(yo.id) === "done");
    expect(pushes.some((p) => p.channel === "notify" && p.data.agentId === pepe.id)).toBe(false);
    expect(core.store.getAgent(pepe.id)!.unread).toBe(1);
    expect(core.store.listActivity().some((a) => a.summary.startsWith("Yo → Pepe: hello Pepe"))).toBe(true);
    // A later fresh session for Pepe knows that message came from Yo.
    expect(core.store.recentConversation(pepe.id)[0]!.text).toBe("[Message from Yo] hello Pepe");
  });

  it("refuses a message back to an agent that is waiting on you (no deadlock)", async () => {
    const { core, yo } = await team();
    const inner = JSON.stringify({ to: "Yo", message: "and you?", wait: true });
    await core.api["chat.send"]({
      agentId: yo.id,
      text: `tool message_agent ${JSON.stringify({ to: "Pepe", message: `tool message_agent ${inner}`, wait: true })}`,
    });
    await until(() => said(core, yo.id).length === 1, 8000, "Yo's reply");
    expect(said(core, yo.id)[0]).toMatch(
      /^tool: Pepe replied:\n\n<teammate_reply from="Pepe">\ntool: Error: Yo is waiting for your reply/,
    );
  });

  it("an FYI the teammate answers with NO_RESPONSE sends nothing back; unknown names list the team", async () => {
    const { core, yo, pepe } = await team();
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"quiet","wait":false}',
    });
    await until(() => said(core, yo.id).length === 1, 8000, "Yo's reply");
    expect(said(core, yo.id)[0]).toMatch(/^tool: Sent to Pepe\. .*\(exchange xch_[a-z0-9]+\)$/);
    const notes = (id: string) =>
      core.store
        .listTimeline(id)
        .filter((e) => e.item.kind === "notice")
        .map((e) => e.item.text);
    await until(() => notes(pepe.id).includes("Nothing to send back to Yo."), 8000, "Pepe's quiet answer");
    expect(mock.turnTexts.find((t) => t.includes("[Message from"))).toContain("reply exactly NO_RESPONSE");
    await new Promise((r) => setTimeout(r, 300));
    expect(said(core, yo.id)).toHaveLength(1);
    expect(core.store.listTimeline(yo.id).some((e) => e.item.from)).toBe(false);

    await core.api["chat.send"]({ agentId: yo.id, text: 'tool message_agent {"to":"Zed","message":"hi"}' });
    await until(() => said(core, yo.id).length === 2, 8000, "second reply");
    expect(said(core, yo.id)[1]).toBe('tool: Error: No teammate named "Zed". Your teammates: Pip, Pepe.');
  });

  it("tells the asker when the teammate is stopped before replying", async () => {
    const { core, yo, pepe } = await team();
    await core.api["chat.send"]({ agentId: pepe.id, text: "slow" });
    await until(() => core.orchestrator.activityOf(pepe.id) === "working");
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"later","wait":true}',
    });
    await until(() => core.store.listTimeline(pepe.id).some((e) => e.item.text === "later"), 8000, "queued");
    await core.api["chat.interrupt"]({ agentId: pepe.id });
    await until(() => said(core, yo.id).length === 1, 12000, "Yo's reply");
    expect(said(core, yo.id)[0]).toBe("tool: Pepe was stopped before replying.");
  });

  it("Stop keeps the user's queued message but answers a teammate's as stopped", async () => {
    const { core, yo, pepe } = await team();
    await core.api["chat.send"]({ agentId: pepe.id, text: "slow" });
    await until(() => core.orchestrator.activityOf(pepe.id) === "working");
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"from yo","wait":true}',
    });
    await until(
      () => core.store.listTimeline(pepe.id).some((e) => e.item.text === "from yo"),
      8000,
      "queued",
    );
    const res = await core.api["chat.send"]({ agentId: pepe.id, text: "from the owner" });
    expect(res.turnId).toBe("queued");
    await core.api["chat.interrupt"]({ agentId: pepe.id });
    await until(() => said(core, yo.id).length === 1, 12000, "Yo's reply");
    expect(said(core, yo.id)[0]).toBe("tool: Pepe was stopped before replying.");
    // The owner's own message still runs; Yo's was dropped.
    await until(() => said(core, pepe.id).includes("echo: from the owner"), 12000, "owner's message runs");
    expect(said(core, pepe.id)).not.toContain("echo: from yo");
  });

  it("lists only the owner's queued messages; teammates' notes stay internal and still run", async () => {
    const { core, yo, pepe } = await team();
    mock.steerMidTurn = true;
    await core.api["chat.send"]({ agentId: pepe.id, text: "slow" });
    await until(() => core.orchestrator.activityOf(pepe.id) === "working");
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"from yo","wait":true}',
    });
    await until(
      () => core.store.listTimeline(pepe.id).some((e) => e.item.text === "from yo"),
      8000,
      "teammate's note queued",
    );
    await core.api["chat.send"]({ agentId: pepe.id, text: "from the owner" });
    await core.api["chat.send"]({ agentId: pepe.id, text: "after that" });
    const q = await core.api["queue.list"]({ agentId: pepe.id });
    expect(q.map((x) => x.text)).toEqual(["from the owner", "after that"]);
    // Reordering the owner's messages leaves the teammate's note where it was (first in line).
    await core.api["queue.reorder"]({ agentId: pepe.id, ids: [q[1]!.id, q[0]!.id] });
    // The running task is the owner's, so steering works; the teammate's note still runs after it.
    const res = await core.api["queue.steer"]({ agentId: pepe.id, id: q[0]!.id });
    expect(res).toMatchObject({ steered: true, items: [{ text: "after that" }] });
    const sk = mock.sessionKeyOf(pepe.id)!;
    const slow = mock.requests.find(
      (r) => r.type === "turn.send" && r.sessionKey === sk && JSON.stringify(r.input).includes("slow"),
    ) as { turnId: string };
    mock.completeTurn(sk, slow.turnId, "completed");
    await until(() => said(core, yo.id).length === 1, 12000, "Yo's reply");
    expect(said(core, yo.id)[0]).toContain("echo: from yo");
    await until(() => said(core, pepe.id).includes("echo: after that"), 12000, "owner's next message");
  });

  it("won't steer into a task answering a teammate: the message goes first in line instead", async () => {
    const { core, yo, pepe } = await team();
    mock.steerMidTurn = true;
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"slow"}',
    });
    await until(() => core.orchestrator.activityOf(pepe.id) === "working", 8000, "Pepe works for Yo");
    await core.api["chat.send"]({ agentId: pepe.id, text: "one" });
    await core.api["chat.send"]({ agentId: pepe.id, text: "two" });
    const q = await core.api["queue.list"]({ agentId: pepe.id });
    const res = await core.api["queue.steer"]({ agentId: pepe.id, id: q[1]!.id });
    expect(res.steered).toBe(false);
    expect(res.note).toBe("Pepe is answering a teammate right now. It's next in line instead.");
    expect(res.items.map((x) => x.text)).toEqual(["two", "one"]);
    expect(mock.steers).toHaveLength(0);
  });

  it("a frozen teammate is stopped, and the agent waiting on it isn't", async () => {
    const { core, yo, pepe } = await team({ stuckTurnMs: 300 });
    // Pepe's task freezes (no events), like a browser script that never returns.
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"slow","wait":true}',
    });
    await until(() => said(core, yo.id).length === 1, 8000, "Yo's reply");
    expect(said(core, yo.id)[0]).toBe("tool: Pepe was stopped before replying.");
    const notices = (id: string) => core.store.listTimeline(id).map((e) => e.item.text ?? "");
    expect(notices(pepe.id).some((t) => t.startsWith("I stopped because a step froze"))).toBe(true);
    expect(notices(yo.id).some((t) => t.includes("froze"))).toBe(false);
  });

  it("an agent waiting on a teammate's reply isn't stopped as frozen", async () => {
    const { core, yo, pepe } = await team({ stuckTurnMs: 200 });
    // Pepe needs the user first (a card, also a legitimate wait), so Yo waits quietly on message_agent.
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"ask","wait":true}',
    });
    await until(() => core.store.pendingRequests().length === 1, 5000, "Pepe's question");
    await new Promise((r) => setTimeout(r, 1000));
    expect(core.orchestrator.activityOf(yo.id)).toBe("working");
    expect(mock.count("turn.interrupt")).toBe(0);
    await core.api["request.respond"]({
      agentId: pepe.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      decision: "allow",
      answers: { q: "B" },
    });
    await until(() => said(core, yo.id).length === 1, 8000, "Yo's reply");
    expect(said(core, yo.id)[0]).toContain("got The user answered: B");
  });

  it("a reply that takes longer than the wait comes to the asker as a new message", async () => {
    const core = await boot({ agentReplyWaitMs: 300 });
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const yo = primary(core);
    const pepe = await core.api["agent.create"]({ name: "Pepe", role: "", instructions: "", avatar: AVATAR });
    // Pepe needs the user before it can answer ("ask" makes the mock call ask_user), so Yo's wait runs out.
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"ask","wait":true}',
    });
    await until(() => said(core, yo.id).length === 1, 8000, "Yo carries on");
    expect(said(core, yo.id)[0]).toMatch(/^tool: Pepe hasn't replied yet/);
    await until(() => core.store.pendingRequests().length === 1, 5000, "Pepe's question");
    await core.api["request.respond"]({
      agentId: pepe.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      decision: "allow",
      answers: { q: "B" },
    });
    // Pepe's answer reaches Yo as a message from Pepe, and Yo picks it up.
    await until(() => said(core, yo.id).length === 2, 8000, "late reply");
    const late = core.store.listTimeline(yo.id).find((e) => e.item.from)!;
    expect(late.item).toMatchObject({
      from: { agentId: pepe.id, name: "Pepe", reply: true, exchangeId: expect.stringMatching(/^xch_/) },
      text: "got The user answered: B",
    });
  });

  it("hands work over without waiting: 'Sent to Pepe' now, and Pepe's reply wakes Yo later", async () => {
    const { core, yo, pepe } = await team();
    const pushes = capture(core);
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"hello"}',
    });
    // Pepe can answer before Yo's own turn has ended: the reply then runs right after it.
    await until(() => said(core, yo.id).length >= 1, 8000, "Yo's ack");
    const ack = said(core, yo.id)[0]!;
    // Pepe hasn't worked yet, so its computer is off: the ack says the message wakes it.
    expect(ack).toMatch(
      /^tool: Sent to Pepe\. Pepe was asleep; this wakes them\. Carry on with your own work: their reply comes to you/,
    );
    const xch = exchangeIdIn(ack)!;
    expect(xch).toMatch(/^xch_/);
    // Pepe's chat has the request, tied to the same exchange.
    const incoming = core.store.listTimeline(pepe.id).find((e) => e.item.kind === "user_message")!;
    expect(incoming.item.from).toEqual({ agentId: yo.id, name: "Yo", exchangeId: xch });
    // The reply lands in Yo's chat as a message from Pepe and starts a turn there.
    await until(() => said(core, yo.id).length === 2, 8000, "Yo woken by the reply");
    const reply = core.store.listTimeline(yo.id).find((e) => e.item.from)!;
    expect(reply.item).toMatchObject({
      kind: "user_message",
      text: "echo: hello",
      from: { agentId: pepe.id, name: "Pepe", exchangeId: xch, reply: true },
    });
    const pepeTurn = mock.turnTexts.find((t) => t.includes("[Message from your teammate Yo"))!;
    expect(pepeTurn).toContain("Yo has carried on with their work");
    const yoTurn = mock.turnTexts.find((t) => t.includes("[Reply from your teammate Pepe"))!;
    expect(yoTurn).toContain(
      "[Reply from your teammate Pepe (Head of Polestar) to the message you sent them earlier.",
    );
    expect(yoTurn).toContain('<teammate_reply from="Pepe">\necho: hello\n</teammate_reply>');
    expect(said(core, yo.id)[1]).toContain("echo: hello");
    // What Yo says after the reply is for the user (a popup); Pepe's side stays quiet.
    await until(() => pushes.some((p) => p.channel === "notify" && p.data.agentId === yo.id));
    expect(pushes.some((p) => p.channel === "notify" && p.data.agentId === pepe.id)).toBe(false);
    // Nothing goes back to Pepe for Yo's answer to the reply.
    await new Promise((r) => setTimeout(r, 300));
    expect(said(core, pepe.id)).toEqual(["echo: hello"]);
  });

  it("a busy teammate gets to it next; stopping the asker later doesn't cancel the reply", async () => {
    const { core, yo, pepe } = await team();
    const pepeSlow = await core.api["chat.send"]({ agentId: pepe.id, text: "slow" });
    await until(() => mock.last("turn.send")?.turnId === pepeSlow.turnId, 5000, "Pepe busy");
    expect(core.orchestrator.view(pepe.id)?.statusLine).toBe("slow");
    await core.api["chat.send"]({ agentId: yo.id, text: 'tool message_agent {"to":"Pepe","message":"hi"}' });
    await until(() => said(core, yo.id).length === 1, 8000, "Yo's ack");
    expect(said(core, yo.id)[0]).toContain("Pepe is busy with another task, so yours is next in line.");
    // The user starts something else with Yo and stops it.
    const yoSlow = await core.api["chat.send"]({ agentId: yo.id, text: "slow" });
    await until(() => mock.last("turn.send")?.turnId === yoSlow.turnId, 5000, "Yo busy");
    await core.api["chat.interrupt"]({ agentId: yo.id });
    await until(() => core.orchestrator.activityOf(yo.id) !== "working", 12000, "Yo stopped");
    mock.completeTurn(mock.sessionKeyOf(pepe.id)!, pepeSlow.turnId!, "completed");
    await until(() => said(core, yo.id).some((t) => t?.includes("echo: hi")), 12000, "the reply still comes");
  });

  it("a teammate that couldn't finish wakes the asker so it can tell the user; a user stop doesn't", async () => {
    const { core, yo, pepe } = await team();
    const notes = () =>
      core.store
        .listTimeline(yo.id)
        .filter((e) => e.item.kind === "notice")
        .map((e) => e.item.text);
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"slow"}',
    });
    const pepeTurn = () =>
      mock.requests
        .filter((r) => r.type === "turn.send" && r.sessionKey === mock.sessionKeyOf(pepe.id))
        .at(-1) as { turnId: string } | undefined;
    await until(() => !!pepeTurn(), 8000, "Pepe works for Yo");
    const key = mock.sessionKeyOf(pepe.id)!;
    const turn = pepeTurn()!.turnId;
    await until(() => said(core, yo.id).length === 1, 8000, "Yo's ack");
    mock.emit(key, { type: "turn.completed", turnId: turn, status: "failed", error: "browser crashed" });
    await until(() => notes().includes("Pepe couldn't finish what I asked: browser crashed"), 8000, "notice");
    await until(() => said(core, yo.id).length === 2, 8000, "Yo woken");
    expect(said(core, yo.id)[1]).toContain("Pepe couldn't finish what you asked: browser crashed");

    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"slow"}',
    });
    await until(() => said(core, yo.id).length === 3, 8000, "second ack");
    await until(() => core.orchestrator.activityOf(pepe.id) === "working", 8000, "Pepe on it");
    await core.api["chat.interrupt"]({ agentId: pepe.id });
    await until(() => notes().includes("Pepe was stopped before replying."), 12000, "stop notice");
    await new Promise((r) => setTimeout(r, 300));
    expect(said(core, yo.id)).toHaveLength(3);
  });

  it("the 6-hop cap stops a chain of handoffs", async () => {
    const { core, yo, pepe } = await team();
    let text = "done";
    for (let i = 0; i < 7; i++)
      text = `tool message_agent ${JSON.stringify({ to: i % 2 ? "Yo" : "Pepe", message: text })}`;
    // The outermost call is Yo's own (to Pepe); each message makes the other agent message back.
    await core.api["chat.send"]({ agentId: yo.id, text });
    const capped = () =>
      [...said(core, yo.id), ...said(core, pepe.id)].some((t) =>
        t?.includes("passed messages back and forth too many times"),
      );
    await until(capped, 20000, "hop cap");
  });

  it("create_agent gives each new teammate the next Softie and starts its hello turn", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const yo = primary(core);
    const hire = async (name: string, role: string) => {
      const before = said(core, yo.id).length;
      await core.api["chat.send"]({
        agentId: yo.id,
        text: `tool create_agent ${JSON.stringify({ name, role })}`,
      });
      await until(() => core.store.pendingRequests().length === 1, 5000, "card");
      await core.api["request.respond"]({
        agentId: yo.id,
        requestId: core.store.pendingRequests()[0]!.request!.requestId,
        decision: "allow",
      });
      await until(() => said(core, yo.id).length === before + 1, 5000, "approved");
      return core.store.listAgents().find((a) => a.name === name)!;
    };
    const dew = await hire("Dew", "Research");
    expect(dew.avatar.softie).toEqual({ kind: "dew" });
    expect(dew.avatar.color).toBe("#4C86FF");
    expect(said(core, yo.id).at(-1)).toContain("Dew is saying hello to the user now");
    // Its first turn starts at once: hello, its job, and one question.
    await until(() => said(core, dew.id).length === 1, 8000, "Dew's hello");
    const intro = mock.turnTexts.find((t) => t.includes("you've just joined"))!;
    expect(intro).toContain("(Yo added you)");
    expect(intro).toContain("what you'll take care of as their Research");
    expect(intro).toContain("ONE multiple-choice question about your job with `ask_user`");
    expect(core.store.listTimeline(dew.id).some((e) => e.item.kind === "user_message")).toBe(false);
    const dewStart = mock.requests.find((r) => r.type === "session.start" && r.agentId === dew.id) as any;
    expect(dewStart.toolset).toBe("agent");
    // Yo leads Work and Pip leads Personal: both are front doors.
    expect(dewStart.systemAppend).toContain(
      "Yo and Pip are the main agents: the user's front door. You're Dew, a teammate (your job: Research).",
    );
    // The next one gets the next Softie.
    const pico = await hire("Pico", "Builder");
    expect(pico.avatar.softie?.kind).toBe("pico");
    // The app's own "new agent" introduces itself only when asked to.
    const quiet = await core.api["agent.create"]({
      name: "Mochi",
      role: "",
      instructions: "",
      avatar: dew.avatar,
    });
    const loud = await core.api["agent.create"]({
      name: "Clove",
      role: "Writer",
      instructions: "",
      avatar: dew.avatar,
      introduce: true,
    });
    await until(() => said(core, loud.id).length === 1, 8000, "Clove's hello");
    expect(said(core, quiet.id)).toEqual([]);
  });

  it("a teammate runs on its own subscription and model, and everyone's prompt says which", async () => {
    const core = await boot();
    await until(() =>
      core.store.listAccounts().every((a) => a.status === "authenticated" && a.models.length > 0),
    );
    const yo = primary(core);
    const grok = core.store.listAccounts().find((a) => a.provider === "grok")!;
    const claude = core.store.listAccounts().find((a) => a.provider === "claude")!;
    const pepe = await core.api["agent.create"]({
      name: "Pepe",
      role: "Inbox",
      instructions: "",
      avatar: AVATAR,
      accountId: grok.id,
      model: "grok-4.3",
    });
    await core.api["chat.send"]({ agentId: yo.id, text: 'tool message_agent {"to":"Pepe","message":"hi"}' });
    await until(() => said(core, yo.id).length === 2, 8000, "the round trip");
    const start = (id: string) =>
      mock.requests.find((r) => r.type === "session.start" && r.agentId === id) as Extract<
        import("@yo/contracts").AgentdRequest,
        { type: "session.start" }
      >;
    expect(start(pepe.id)).toMatchObject({ provider: "grok", accountId: grok.id, model: "grok-4.3" });
    expect(start(yo.id)).toMatchObject({ provider: "claude", accountId: claude.id });
    expect(start(yo.id).systemAppend).toContain(`- Pepe (Inbox): `);
    expect(start(yo.id).systemAppend).toContain(` · ${grok.label} · Grok 4.3`);
    expect(start(pepe.id).systemAppend).toContain(`You run on ${grok.label} · Grok 4.3.`);
    expect(start(pepe.id).systemAppend).toContain(`- Yo (main agent, your work assistant): `);
    expect(start(pepe.id).systemAppend).toContain(` · ${claude.label} · Sonnet 5.5`);
    // Switching Pepe's model: Pepe's session follows, and Yo hears the team changed on its next message.
    await core.api["agent.update"]({ id: pepe.id, patch: { model: "grok-build" } });
    await core.api["chat.send"]({ agentId: pepe.id, text: "again" });
    await until(() => said(core, pepe.id).length === 2, 8000, "Pepe on the new model");
    expect(mock.sessions.get(mock.sessionKeyOf(pepe.id)!)!.model).toBe("grok-build");
    await core.api["chat.send"]({ agentId: yo.id, text: "status?" });
    await until(() => said(core, yo.id).length === 3, 8000, "Yo's next turn");
    expect(mock.turnTexts.at(-1)).toContain("[Your team changed. Now: Pepe (Inbox): ");
    expect(mock.turnTexts.at(-1)).toContain(`${grok.label} · Grok Build]`);
  });

  it("the status line says what an agent is doing: a card, a teammate's request, nothing when idle", async () => {
    const { core, yo, pepe } = await team();
    expect(core.orchestrator.view(pepe.id)?.statusLine).toBeNull();
    await core.api["chat.send"]({ agentId: pepe.id, text: "ask" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "Pepe's question");
    expect(core.orchestrator.view(pepe.id)?.statusLine).toBe("Waiting for your answer: Which one?");
    await core.api["request.respond"]({
      agentId: pepe.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      decision: "allow",
      answers: { q: "A" },
    });
    await until(() => said(core, pepe.id).length === 1, 8000, "Pepe done");
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"slow"}',
    });
    await until(() => core.orchestrator.activityOf(pepe.id) === "working", 8000, "Pepe works for Yo");
    expect(core.orchestrator.view(pepe.id)?.statusLine).toBe("For Yo: slow");
    await core.api["chat.interrupt"]({ agentId: pepe.id });
    await until(() => core.orchestrator.view(pepe.id)?.statusLine === null, 12000, "idle again");
  });

  describe("team checks (the lead supervises teammates)", () => {
    const checks = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
      core.store
        .listTimeline(agentId)
        .filter((e) => e.item.kind === "notice" && e.item.text?.startsWith("Team check:"))
        .map((e) => e.item.text);
    const checkTurns = () => mock.turnTexts.filter((t) => t.includes("[Automatic team check"));
    const gaveUp = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
      said(core, agentId).filter((t) => t === "gave up").length;
    const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

    it("tells the lead once when a teammate's steps keep failing", async () => {
      const { core, yo, pepe } = await team({ oversightFailMs: 0 });
      await core.api["chat.send"]({ agentId: pepe.id, text: "fail 5" });
      await until(() => gaveUp(core, pepe.id) === 1, 8000, "Pepe gives up");
      await until(() => said(core, yo.id).length === 1, 8000, "Yo's check-in");
      await settle();
      expect(checks(core, yo.id)).toEqual([
        "Team check: Pepe has had 3 steps in a row fail over 1 minute. I'll check in.",
      ]);
      expect(checkTurns()).toHaveLength(1);
      const note = checkTurns()[0]!;
      expect(note).toContain("Pepe (Head of Polestar) has had 3 steps in a row fail");
      expect(note).toContain('Their task: "fail 5" (from the user)');
      expect(note).toContain("- browser_navigate: Timed out after 60s waiting for the page");
      expect(note).toContain("Pepe is still on this task");
      // The lead's prompt says it supervises; the teammate's doesn't.
      expect(mock.sessions.get(mock.sessionKeyOf(yo.id)!)!.systemAppend).toContain("# Leading the team");
      expect(mock.sessions.get(mock.sessionKeyOf(pepe.id)!)!.systemAppend).not.toContain("Leading the team");
    });

    it("sends at most one team check per teammate per cooldown", async () => {
      const { core, yo, pepe } = await team({ oversightFailMs: 0, oversightCooldownMs: 2000 });
      await core.api["chat.send"]({ agentId: pepe.id, text: "fail 5" });
      await until(() => gaveUp(core, pepe.id) === 1, 8000, "first task");
      await core.api["chat.send"]({ agentId: pepe.id, text: "fail 6" });
      await until(() => gaveUp(core, pepe.id) === 2, 8000, "second task");
      await settle();
      expect(checks(core, yo.id)).toHaveLength(1);
      // Once the cooldown is over, new trouble is reported again.
      await settle(2000);
      await core.api["chat.send"]({ agentId: pepe.id, text: "fail 3" });
      await until(() => checks(core, yo.id).length === 2, 8000, "second check");
      await until(() => checkTurns().length === 2, 8000, "second check turn");
    });

    it("says nothing about the lead's own trouble", async () => {
      const { core, yo } = await team({ oversightFailMs: 0, oversightCooldownMs: 0 });
      await core.api["chat.send"]({ agentId: yo.id, text: "fail 5" });
      await until(() => gaveUp(core, yo.id) === 1, 8000, "Yo gives up");
      await settle();
      expect(checks(core, yo.id)).toEqual([]);
      expect(checkTurns()).toEqual([]);
    });

    it("the lead checking in never loops back into another team check", async () => {
      // No cooldown: only the check-in marker stops the loop.
      const { core, yo, pepe } = await team({ oversightCooldownMs: 0 });
      mock.teamCheckReply = 'tool message_agent {"to":"Pepe","message":"fail 4","wait":false}';
      await core.api["chat.send"]({ agentId: pepe.id, text: "fail 4" });
      // Pepe finishes with 4 failed steps -> one check -> Yo tells Pepe to try again -> Pepe fails again.
      await until(() => gaveUp(core, pepe.id) === 2, 8000, "Pepe's second try");
      await settle(600);
      expect(checks(core, yo.id)).toEqual([
        "Team check: Pepe finished its task, but 4 steps failed along the way. I'll check in.",
      ]);
      expect(checkTurns()).toHaveLength(1);
      expect(gaveUp(core, pepe.id)).toBe(2);
    });

    it("tells the lead when a teammate's frozen task was stopped", async () => {
      const { core, yo, pepe } = await team({ stuckTurnMs: 300 });
      await core.api["chat.send"]({ agentId: pepe.id, text: "slow" });
      await until(() => checks(core, yo.id).length === 1, 8000, "team check");
      expect(checks(core, yo.id)[0]).toBe(
        "Team check: Pepe was stopped: a step froze for 1 minute with no progress. I'll check in.",
      );
      await until(() => checkTurns().length === 1, 8000, "check turn");
      expect(checkTurns()[0]).toContain("Pepe is free now.");
      expect(checkTurns()[0]).toContain("No failed steps in this task.");
    });
  });

  it("create_agent adds a teammate only after the user approves", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const yo = primary(core);
    const call = 'tool create_agent {"name":"Pepe","role":"Head of Polestar","instructions":"Own Polestar."}';
    await core.api["chat.send"]({ agentId: yo.id, text: call });
    await until(() => core.store.pendingRequests().length === 1, 5000, "card");
    const card = core.store.pendingRequests()[0]!;
    expect(card.request).toMatchObject({
      toolName: "yo:create_agent",
      title: "Add a new agent: Pepe, Head of Polestar",
      // The card shows exactly the standing instructions that would be saved.
      detail: "Own Polestar.",
    });
    await core.api["request.respond"]({
      agentId: yo.id,
      requestId: card.request!.requestId,
      decision: "deny",
    });
    await until(() => said(core, yo.id).length === 1, 5000, "denied reply");
    expect(said(core, yo.id)[0]).toMatch(/^tool: DENIED by the user/);
    expect(core.store.listAgents().map((a) => a.name)).toEqual(["Yo", "Pip"]);

    await core.api["chat.send"]({ agentId: yo.id, text: call });
    await until(() => core.store.pendingRequests().length === 1, 5000, "second card");
    await core.api["request.respond"]({
      agentId: yo.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      // "Always" isn't offered for this card; it counts as once and saves no rule.
      decision: "allowAlways",
    });
    await until(() => said(core, yo.id).length === 2, 5000, "approved reply");
    const pepe = core.store.listAgents().find((a) => a.name === "Pepe")!;
    expect(pepe).toMatchObject({ role: "Head of Polestar", instructions: "Own Polestar.", isPrimary: false });
    expect(said(core, yo.id)[1]).toContain("Pepe has joined the team as Head of Polestar");
    expect(core.store.listRules()).toHaveLength(0);
  });

  it("create_agent refuses instructions longer than the approval card shows", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const yo = primary(core);
    const long = JSON.stringify({ name: "Pepe", instructions: "x".repeat(1501) });
    await core.api["chat.send"]({ agentId: yo.id, text: `tool create_agent ${long}` });
    await until(() => said(core, yo.id).length === 1, 5000, "refusal");
    expect(said(core, yo.id)[0]).toContain("instructions: at most 1500 characters");
    expect(core.store.pendingRequests()).toHaveLength(0);
  });

  /** A stand-in phone channel for the Yo Phone tools. */
  function fakePhone(phoneTurns = false) {
    const f = {
      links: 0,
      off: 0,
      createLink: async () => {
        f.links++;
        return { link: `https://yo-phone.test/#k=${"k".repeat(42)}${f.links}` };
      },
      turnOff: async () => {
        f.off++;
      },
      isPhoneTurn: () => phoneTurns,
    };
    return f;
  }

  it("create_phone_link makes a link only after the user approves", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const phone = fakePhone();
    core.orchestrator.attachPhone(phone);
    const yo = primary(core);
    const pushes: { channel: string; data: any }[] = [];
    core.hub.subscribe((channel, data) => pushes.push({ channel, data }));
    const call = 'tool create_phone_link {"label":"my iPhone"}';
    await core.api["chat.send"]({ agentId: yo.id, text: call });
    await until(() => core.store.pendingRequests().length === 1, 5000, "card");
    expect(core.store.pendingRequests()[0]!.request).toMatchObject({
      kind: "tool_approval",
      toolName: "yo:create_phone_link",
      title: "Create a phone link for my iPhone?",
      detail: "Anyone with the link can talk to Yo as you. A new link turns off the old one.",
    });
    expect(phone.links).toBe(0);
    await core.api["request.respond"]({
      agentId: yo.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      decision: "deny",
    });
    await until(() => said(core, yo.id).length === 1, 5000, "denied reply");
    expect(said(core, yo.id)[0]).toMatch(/^tool: DENIED by the user\. No phone link was made/);
    expect(phone.links).toBe(0);

    // No label: "your phone".
    await core.api["chat.send"]({ agentId: yo.id, text: "tool create_phone_link {}" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "second card");
    expect(core.store.pendingRequests()[0]!.request?.title).toBe("Create a phone link for your phone?");
    await core.api["request.respond"]({
      agentId: yo.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      // "Always" isn't offered for this card; it counts as once and saves no rule.
      decision: "allowAlways",
    });
    await until(() => said(core, yo.id).length === 2, 5000, "approved reply");
    expect(phone.links).toBe(1);
    // The link never reaches the model: not in the tool result, not anywhere in the timeline.
    expect(said(core, yo.id)[1]).toBe("tool: Link created. It's in Settings → Phone.");
    expect(JSON.stringify(core.store.listTimeline(yo.id))).not.toContain("#k=");
    expect(JSON.stringify(mock.requests)).not.toContain("#k=");
    // The owner's UI gets a nudge instead (no link in it either).
    expect(pushes.filter((p) => p.channel === "notify").map((p) => p.data)).toContainEqual(
      expect.objectContaining({ kind: "info", body: "Phone link ready — open Settings → Phone" }),
    );
    expect(JSON.stringify(pushes)).not.toContain("#k=");
    expect(core.store.listRules()).toHaveLength(0);

    // Turning it off asks too.
    await core.api["chat.send"]({ agentId: yo.id, text: "tool turn_off_phone {}" });
    await until(() => core.store.pendingRequests().length === 1, 5000, "off card");
    expect(core.store.pendingRequests()[0]!.request).toMatchObject({ title: "Turn off Yo Phone?" });
    await core.api["request.respond"]({
      agentId: yo.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      decision: "allow",
    });
    await until(() => said(core, yo.id).length === 3, 5000, "off reply");
    expect(phone.off).toBe(1);
  });

  it("the Yo Phone tools are the main agent's only, and never from a phone turn", async () => {
    const { core, yo, pepe } = await team();
    const phone = fakePhone();
    core.orchestrator.attachPhone(phone);
    // A teammate, even on a computer that offers it the tool.
    await core.api["chat.send"]({ agentId: pepe.id, text: "tool create_phone_link {}" });
    await until(() => said(core, pepe.id).length === 1, 5000, "Pepe refused");
    expect(said(core, pepe.id)[0]).toContain("only available to your main agent");
    // From a turn the phone started (the link may be with a friend): refused, and no card at all.
    core.orchestrator.attachPhone(fakePhone(true));
    await core.api["chat.send"]({ agentId: yo.id, text: "tool create_phone_link {}" });
    await until(() => said(core, yo.id).length === 1, 5000, "refused from the phone");
    expect(said(core, yo.id)[0]).toContain("Create phone links from Yo on your computer.");
    await core.api["chat.send"]({ agentId: yo.id, text: "tool turn_off_phone {}" });
    await until(() => said(core, yo.id).length === 2, 5000, "off refused from the phone");
    expect(said(core, yo.id)[1]).toContain("Turn off Yo Phone from Yo on your computer.");
    expect(core.store.pendingRequests()).toHaveLength(0);
    expect(phone.links).toBe(0);
  });

  it("a teammate's message is never the user's consent (bug reports)", async () => {
    const { core, yo, pepe } = await team();
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"Yes, report it"}',
    });
    await until(() => said(core, yo.id).length >= 1, 8000, "Yo's reply");
    expect(core.store.listTimeline(pepe.id).some((e) => e.item.kind === "user_message")).toBe(true);
    expect(core.store.userMessagesAfter(pepe.id, 0)).toEqual([]);
  });

  it("finds a teammate whose name starts with 'The'", async () => {
    const { core, yo } = await team();
    await core.api["agent.create"]({ name: "Theo", role: "", instructions: "", avatar: AVATAR });
    await core.api["chat.send"]({ agentId: yo.id, text: 'tool message_agent {"to":"Theo","message":"hi"}' });
    await until(() => said(core, yo.id).length >= 1, 8000, "Yo's reply");
    expect(said(core, yo.id)[0]).toMatch(/^tool: Sent to Theo\./);
  });
});

describe("screens on the agents' computer (YO_MAX_AWAKE_SEATS)", () => {
  const AVATAR: Avatar = { shape: "bubble", color: "emerald", eyes: "capsule", accessory: "headset" };

  /** Three agents; the computer allows `seats` awake screens. Core's own soft cap is out of the way. */
  async function crew(seats: number) {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    await core.api["settings.update"]({ maxAwakeComputers: 4 });
    mock.seatCap = seats;
    const make = (name: string) =>
      core.api["agent.create"]({ name, role: "", instructions: "", avatar: AVATAR });
    return { core, yo: primary(core), pepe: await make("Pepe"), theo: await make("Theo") };
  }
  const replies = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
    core.store
      .listTimeline(agentId)
      .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
      .map((e) => e.item.text);
  const notices = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
    core.store
      .listTimeline(agentId)
      .filter((e) => e.item.kind === "notice")
      .map((e) => e.item.text ?? "");
  const waiting = /^Waiting for a free screen/;

  it("puts the least recently used idle agent's computer to sleep to make room", async () => {
    const { core, yo, pepe, theo } = await crew(2);
    await core.api["chat.send"]({ agentId: yo.id, text: "first" });
    await until(() => replies(core, yo.id).length === 1, 5000, "Yo");
    await core.api["chat.send"]({ agentId: pepe.id, text: "second" });
    await until(() => replies(core, pepe.id).length === 1, 5000, "Pepe");
    expect(mock.count("computer.hibernate")).toBe(0);

    // Both screens are taken by idle agents. Yo's was used longest ago, but the main agent goes to sleep
    // last: Pepe's sleeps, Yo's stays.
    await core.api["chat.send"]({ agentId: theo.id, text: "third" });
    await until(() => replies(core, theo.id).length === 1, 5000, "Theo");
    expect(mock.requests.filter((r) => r.type === "computer.hibernate").map((r) => r.agentId)).toEqual([
      pepe.id,
    ]);
    expect([...mock.awake].sort()).toEqual([yo.id, theo.id].sort());
    expect(core.orchestrator.view(pepe.id)?.computer.state).toBe("hibernated");
    expect(notices(core, theo.id).some((n) => waiting.test(n))).toBe(false);
  });

  it("never picks a busy agent or one the user controls: the new agent waits, then starts", async () => {
    const { core, yo, pepe, theo } = await crew(2);
    await core.api["chat.send"]({ agentId: yo.id, text: "slow" }); // working
    await until(() => mock.count("turn.send") === 1, 5000, "Yo working");
    await core.api["chat.send"]({ agentId: pepe.id, text: "hi" });
    await until(() => replies(core, pepe.id).length === 1, 5000, "Pepe");
    await core.api["computer.takeover"]({ agentId: pepe.id }); // the user is on Pepe's screen

    await core.api["chat.send"]({ agentId: theo.id, text: "my turn" });
    await until(() => notices(core, theo.id).some((n) => waiting.test(n)), 5000, "waiting notice");
    expect(core.orchestrator.activityOf(theo.id)).toBe("working");
    expect(mock.count("computer.hibernate")).toBe(0);
    expect(replies(core, theo.id)).toEqual([]);

    // The user hands Pepe's screen back: Pepe is idle now, so its computer sleeps and Theo starts.
    await core.api["computer.release"]({ agentId: pepe.id });
    await until(() => replies(core, theo.id).length === 1, 5000, "Theo starts");
    expect(mock.last("computer.hibernate")?.agentId).toBe(pepe.id);
    expect(mock.count("computer.hibernate")).toBe(1);
    // Said once, not on every retry; and no error.
    expect(notices(core, theo.id).filter((n) => waiting.test(n))).toHaveLength(1);
    expect(core.store.listTimeline(theo.id).some((e) => e.item.status === "failed")).toBe(false);
    await core.api["chat.interrupt"]({ agentId: yo.id });
  });

  it("a waiting agent starts when a busy one finishes, and stopping a waiting task just ends it", async () => {
    const { core, yo, pepe, theo } = await crew(1);
    await core.api["chat.send"]({ agentId: yo.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1, 5000, "Yo working");
    await core.api["chat.send"]({ agentId: pepe.id, text: "pepe here" });
    await core.api["chat.send"]({ agentId: theo.id, text: "theo here" });
    await until(
      () => [pepe.id, theo.id].every((id) => notices(core, id).some((n) => waiting.test(n))),
      5000,
      "both waiting",
    );
    // Stopped while waiting: it ends quietly and never touches the computer.
    await core.api["chat.interrupt"]({ agentId: theo.id });
    await until(() => core.orchestrator.activityOf(theo.id) !== "working", 5000, "Theo stopped");
    expect(notices(core, theo.id).some((n) => /went wrong/i.test(n))).toBe(false);

    // Yo finishes: its computer is the idle one now, so Pepe gets the screen.
    await core.api["chat.interrupt"]({ agentId: yo.id });
    await until(() => replies(core, pepe.id).length === 1, 8000, "Pepe starts");
    expect(replies(core, pepe.id)).toEqual(["echo: pepe here"]);
    expect([...mock.awake]).toEqual([pepe.id]);
    expect(mock.turnTexts.some((t) => t.includes("theo here"))).toBe(false);
  });

  it("waking a computer by hand makes room too, and says so when every screen is busy", async () => {
    const { core, yo, pepe } = await crew(1);
    await core.api["chat.send"]({ agentId: yo.id, text: "hi" });
    await until(() => replies(core, yo.id).length === 1, 5000, "Yo");
    await core.api["computer.wake"]({ agentId: pepe.id });
    expect(mock.last("computer.hibernate")?.agentId).toBe(yo.id);
    expect([...mock.awake]).toEqual([pepe.id]);

    await core.api["computer.takeover"]({ agentId: pepe.id });
    await expect(core.api["computer.wake"]({ agentId: yo.id })).rejects.toThrow(/Every screen/);
  });
});

describe("lead team checks", () => {
  async function team(opts: Parameters<typeof boot>[0] = {}) {
    const core = await boot(opts);
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const yo = primary(core);
    const pepe = await core.api["agent.create"]({
      name: "Pepe",
      role: "Head of Polestar",
      instructions: "",
      avatar: { shape: "bubble", color: "emerald", eyes: "capsule", accessory: "headset" },
    });
    mock.teamCheckReply = "quiet";
    return { core, yo, pepe };
  }
  const checks = () => mock.turnTexts.filter((t) => t.includes("[Automatic team check"));
  async function slow(core: Awaited<ReturnType<typeof startCore>>, agentId: string) {
    const sent = await core.api["chat.send"]({ agentId, text: "slow" });
    await until(() => mock.last("turn.send")?.turnId === sent.turnId);
    return { sessionKey: mock.sessionKeyOf(agentId)!, turnId: mock.last("turn.send")!.turnId };
  }
  async function settle() {
    await new Promise((r) => setTimeout(r, 100));
  }
  /** Wait on the wall clock. `until` uses Date.now(), which a test may have frozen. */
  async function untilWall(fn: () => boolean, ms = 5000, label = "condition") {
    const start = performance.now();
    while (performance.now() - start < ms) {
      if (fn()) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  it("checks a long task once, stays quiet for NO_RESPONSE, and never supervises itself", async () => {
    const { core, yo, pepe } = await team({ oversightLongMs: 80, oversightCooldownMs: 1 });
    const pushes = capture(core);
    const turn = await slow(core, pepe.id);
    await until(() => checks().length === 1);
    await until(() =>
      core.store.listTimeline(yo.id).some((e) => e.item.text === "Team check: nothing to do."),
    );
    expect(checks()[0]).toContain("Pepe (Head of Polestar) has been on one task");
    expect(mock.sessions.get(mock.sessionKeyOf(yo.id)!)!.systemAppend).toContain("# Leading the team");
    expect(core.store.getAgent(yo.id)!.unread).toBe(0);
    expect(pushes.filter((p) => p.channel === "notify" && p.data.agentId === yo.id)).toEqual([]);
    mock.emit(turn.sessionKey, { type: "turn.completed", turnId: turn.turnId, status: "completed" });
    await slow(core, yo.id);
    await settle();
    expect(checks()).toHaveLength(1);
  });

  it("updates one queued check with the final outcome despite cooldown", async () => {
    const { core, yo, pepe } = await team({ oversightLongMs: 100 });
    const leadTurn = await slow(core, yo.id);
    const turn = await slow(core, pepe.id);
    await until(() => core.store.listTimeline(yo.id).some((e) => e.item.text?.startsWith("Team check:")));
    expect(checks()).toHaveLength(0);
    mock.emit(turn.sessionKey, {
      type: "turn.completed",
      turnId: turn.turnId,
      status: "failed",
      error: "browser crashed",
    });
    await until(() => core.orchestrator.activityOf(pepe.id) === "error");
    mock.emit(leadTurn.sessionKey, { type: "turn.completed", turnId: leadTurn.turnId, status: "completed" });
    await until(() => checks().length === 1);
    expect(checks()[0]).toContain("couldn't finish its task: browser crashed");
    expect(checks()[0]).toContain("Pepe is free now");
  });

  it("drops an automatic queued check when the user presses Stop", async () => {
    const { core, yo, pepe } = await team({ oversightLongMs: 80 });
    await slow(core, yo.id);
    await slow(core, pepe.id);
    await until(() => core.store.listTimeline(yo.id).some((e) => e.item.text?.startsWith("Team check:")));
    await core.api["chat.interrupt"]({ agentId: yo.id });
    await settle();
    expect(checks()).toHaveLength(0);
  });

  it("tells the lead when a teammate freezes, with a cooldown across tasks", async () => {
    const { core, pepe } = await team({ stuckTurnMs: 120 });
    await slow(core, pepe.id);
    await until(() => checks().length === 1);
    expect(checks()[0]).toContain("was stopped: a step froze");
    await slow(core, pepe.id);
    await until(() => mock.count("turn.interrupt") === 2);
    await settle();
    expect(checks()).toHaveLength(1);
  });

  it("ignores duplicate and old-turn failures, and resets the failure streak on success", async () => {
    const { core, pepe } = await team({ oversightFailMs: 0 });
    const turn = await slow(core, pepe.id);
    const step = (id: string, status: "failed" | "completed" = "failed", turnId = turn.turnId) =>
      mock.emit(turn.sessionKey, {
        type: "item.completed",
        turnId,
        item: { id, kind: "browser", status, toolName: "browser_navigate", output: "frozen" },
      });
    step("one");
    step("one");
    step("one");
    step("old", "failed", "old-turn");
    step("success", "completed");
    step("two");
    step("three");
    await settle();
    expect(checks()).toHaveLength(0);
    step("four");
    await until(() => checks().length === 1);
    expect(checks()[0]).toContain("3 steps in a row fail");
    expect(checks()[0]).toContain("4 failed steps in this task");
  });

  it("doesn't check while waiting for the user, while the lead awaits the teammate, or on a task it handed over", async () => {
    const { core, yo, pepe } = await team({ oversightLongMs: 60, stuckTurnMs: 250 });
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"ask","wait":true}',
    });
    await until(() => core.store.pendingRequests().length === 1);
    await settle();
    expect(checks()).toHaveLength(0);
    await core.api["request.respond"]({
      agentId: pepe.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      decision: "allow",
      answers: { q: "B" },
    });
    await until(() => core.orchestrator.activityOf(yo.id) === "done");
    // Handed over without waiting: Pepe's long task, then its freeze, come back to Yo as its reply, not a check.
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool message_agent {"to":"Pepe","message":"slow"}',
    });
    await until(() => mock.count("turn.interrupt") === 1);
    await until(() =>
      core.store
        .listTimeline(yo.id)
        .some((e) => e.item.text === "Pepe was stopped before replying: a step froze"),
    );
    await settle();
    expect(checks()).toHaveLength(0);
  });

  it("never supervises work started by its own check-in", async () => {
    const { core, pepe } = await team({ stuckTurnMs: 120, oversightCooldownMs: 1 });
    mock.teamCheckReply = 'tool message_agent {"to":"Pepe","message":"slow","wait":false}';
    await slow(core, pepe.id);
    await until(() => mock.count("turn.interrupt") === 2);
    await settle();
    expect(checks()).toHaveLength(1);
  });

  it("requires sustained failures before checking in during a task", async () => {
    const { core, pepe } = await team({ oversightFailMs: 100 });
    const turn = await slow(core, pepe.id);
    const fail = (id: string) =>
      mock.emit(turn.sessionKey, {
        type: "item.completed",
        turnId: turn.turnId,
        item: { id, kind: "tool", status: "failed", output: "retry failed" },
      });
    const failed = () => core.store.listTimeline(pepe.id).filter((e) => e.item.status === "failed").length;
    // noteStep stamps the streak with Date.now(). The three failures cross the mock socket, so under
    // load they can be applied more than oversightFailMs apart and the check-in fires on the third.
    // Freeze Date only (timeouts stay real) and move it after the three have actually been counted.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const start = Date.now();
      fail("one");
      fail("two");
      fail("three");
      await untilWall(() => failed() >= 3, 5000, "three failures recorded");
      expect(checks()).toHaveLength(0);
      vi.setSystemTime(start + 100);
      fail("four");
      await untilWall(() => failed() >= 4, 5000, "fourth failure recorded");
    } finally {
      vi.useRealTimers();
    }
    await until(() => checks().length === 1);
  });

  it("preserves check-in ancestry through late replies and further delegation", async () => {
    const { core, yo, pepe } = await team({
      oversightLongMs: 120,
      oversightCooldownMs: 1,
      agentReplyWaitMs: 60,
    });
    mock.teamCheckReply = "slow";
    const theo = await core.api["agent.create"]({
      name: "Theo",
      role: "",
      instructions: "",
      avatar: { shape: "bubble", color: "emerald", eyes: "capsule", accessory: "headset" },
    });
    const pepeTurn = await slow(core, pepe.id);
    await until(() => checks().length === 1);
    const leadKey = mock.sessionKeyOf(yo.id)!;
    const leadTurnId = mock.last("turn.send")!.turnId;
    const sent = mock.forgeToolCall(yo.id, leadKey, "message_agent", {
      to: "Pepe",
      message: "ask",
      wait: true,
    });
    mock.emit(pepeTurn.sessionKey, { type: "turn.completed", turnId: pepeTurn.turnId, status: "completed" });
    await until(() => core.store.pendingRequests().length === 1);
    expect(await sent).toContain("hasn't replied yet");
    mock.emit(leadKey, { type: "turn.completed", turnId: leadTurnId, status: "completed" });
    await until(() => core.orchestrator.activityOf(yo.id) === "done");
    // Keep the late-reply turn busy on a user question, so we can inspect its outgoing message.
    mock.teamCheckReply = undefined;
    await core.api["request.respond"]({
      agentId: pepe.id,
      requestId: core.store.pendingRequests()[0]!.request!.requestId,
      decision: "allow",
      answers: { q: "B" },
    });
    await until(() => mock.turnTexts.some((t) => t.includes("[Reply from your teammate Pepe")));
    // The late reply itself is ordinary text in the mock and finishes immediately. Its runtime metadata
    // is covered by the exchange marker; also ensure there was no second automatic check when Pepe ended.
    await settle();
    expect(checks()).toHaveLength(1);
    expect(core.store.getAgent(theo.id)).toBeDefined();
  });

  it("enforces one outgoing check-in per turn even when the model tries again", async () => {
    const { core, yo, pepe } = await team({ oversightLongMs: 60 });
    mock.teamCheckReply = "slow";
    await slow(core, pepe.id);
    await until(() => checks().length === 1);
    const key = mock.sessionKeyOf(yo.id)!;
    expect(
      await mock.forgeToolCall(yo.id, key, "message_agent", { to: "Pepe", message: "first", wait: false }),
    ).toContain("Sent to Pepe");
    expect(
      await mock.forgeToolCall(yo.id, key, "message_agent", { to: "Pepe", message: "second", wait: false }),
    ).toContain("already sent its one check-in");
    expect(core.store.listTimeline(pepe.id).some((e) => e.item.text === "second")).toBe(false);
  });
});

describe("stuck and lost tasks (core audit)", () => {
  const replies = (core: Awaited<ReturnType<typeof startCore>>, agentId: string) =>
    core.store
      .listTimeline(agentId)
      .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
      .map((e) => e.item.text);

  it("ignores computer status that arrives after shutdown closed the database", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().every((a) => a.status === "authenticated"));
    let respond!: (status: AgentdResponses["computer.status"]) => void;
    const status = new Promise<AgentdResponses["computer.status"]>((resolve) => {
      respond = resolve;
    });
    const request = vi.spyOn(core.agentd, "request").mockReturnValueOnce(status);
    const syncing = (core.orchestrator as unknown as { syncComputers(): Promise<void> }).syncComputers();
    expect(request).toHaveBeenCalledWith("computer.status", {});
    await core.shutdown();
    cores = [];
    // This used to reject with "database is not open" from broadcastAll/listAgents.
    respond({ agents: [], memMB: 0, memLimitMB: 0 });
    await expect(syncing).resolves.toBeUndefined();
    request.mockRestore();
  });

  it("a stopped startup failing late cannot fail the next task", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().every((a) => a.status === "authenticated"));
    const agent = primary(core);
    let failWake!: (error: Error) => void;
    const waking = new Promise<AgentdResponses["computer.ensure"]>((_, reject) => {
      failWake = reject;
    });
    const request = vi.spyOn(core.agentd, "request").mockReturnValueOnce(waking);
    await core.api["chat.send"]({ agentId: agent.id, text: "never mind" });
    expect(request).toHaveBeenCalledWith("computer.ensure", { agentId: agent.id }, 90000);
    await core.api["chat.interrupt"]({ agentId: agent.id });
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    failWake(new Error("old wake failed"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    expect(core.store.listTimeline(agent.id).some((e) => e.item.text?.includes("old wake failed"))).toBe(
      false,
    );
    request.mockRestore();
    await core.api["chat.interrupt"]({ agentId: agent.id });
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
  });

  it("a delayed Stop acknowledgement cannot arm a timeout against the next task", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().every((a) => a.status === "authenticated"));
    const agent = primary(core);
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1);
    const first = mock.last("turn.send")!;
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    let acknowledge!: (value: AgentdResponses["turn.interrupt"]) => void;
    const response = new Promise<AgentdResponses["turn.interrupt"]>((resolve) => {
      acknowledge = resolve;
    });
    const request = vi.spyOn(core.agentd, "request").mockReturnValueOnce(response);
    const stopping = core.api["chat.interrupt"]({ agentId: agent.id });
    mock.completeTurn(first.sessionKey, first.turnId);
    await until(() => mock.count("turn.send") === 2);
    acknowledge({});
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 8200));
    expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    request.mockRestore();
    await core.api["chat.interrupt"]({ agentId: agent.id });
    await until(() => core.orchestrator.activityOf(agent.id) !== "working");
  });

  it("Stop while the computer is still waking ends the task, and it never reaches the model", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    mock.ensureDelayMs = 400;
    await core.api["chat.send"]({ agentId: agent.id, text: "never mind" });
    await until(() => mock.count("computer.ensure") === 1, 5000, "waking");
    await core.api["chat.interrupt"]({ agentId: agent.id });
    expect(core.orchestrator.activityOf(agent.id)).not.toBe("working");
    await new Promise((r) => setTimeout(r, 700)); // the computer finishes waking
    expect(mock.count("turn.send")).toBe(0);
    expect(replies(core, agent.id)).toEqual([]);
    expect(core.orchestrator.activityOf(agent.id)).not.toBe("working");

    // The next message runs normally.
    mock.ensureDelayMs = 0;
    await core.api["chat.send"]({ agentId: agent.id, text: "go" });
    await until(() => replies(core, agent.id).includes("echo: go"), 5000, "next turn");
    expect(mock.count("turn.send")).toBe(1);
  });

  it("a Stop the provider confirms late doesn't end the next task", async () => {
    const core = await boot();
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    const agent = primary(core);
    mock.ignoreInterrupt = true;
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" });
    await until(() => mock.count("turn.send") === 1, 5000, "first turn");
    const first = mock.last("turn.send")!;
    await core.api["chat.send"]({ agentId: agent.id, text: "slow" }); // queued
    await core.api["chat.interrupt"]({ agentId: agent.id });
    // Unconfirmed, core closes the first task itself after a few seconds and runs the queued one.
    await until(() => mock.count("turn.send") === 2, 12000, "queued turn starts");
    expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    // Now the provider confirms the first Stop: the second task keeps running.
    mock.completeTurn(first.sessionKey, first.turnId);
    await new Promise((r) => setTimeout(r, 200));
    expect(core.orchestrator.activityOf(agent.id)).toBe("working");
    mock.ignoreInterrupt = false;
    await core.api["chat.interrupt"]({ agentId: agent.id });
    await until(() => core.orchestrator.activityOf(agent.id) !== "working", 5000, "stopped");
  }, 20000);

  it("a restart closes steps left running that no task row covers", async () => {
    const core1 = await boot();
    const agent = primary(core1);
    core1.store.upsertEntry({
      id: "ntc_orphan",
      agentId: agent.id,
      turnId: "trn_never_started",
      item: { id: "itm_orphan", kind: "notice", status: "running", text: "Compacting our conversation…" },
    });
    await core1.shutdown();
    cores = [];
    const core2 = await boot();
    expect(core2.store.getEntry("ntc_orphan")?.item.status).toBe("failed");
    expect(core2.store.listTimeline(agent.id).filter((e) => e.item.status === "running")).toEqual([]);
  });
});

describe("one-off helpers (start_helper)", () => {
  type Core = Awaited<ReturnType<typeof startCore>>;
  async function lead(opts: Parameters<typeof boot>[0] = {}) {
    const core = await boot(opts);
    await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
    return { core, yo: primary(core) };
  }
  /** Yo starts a helper (a start_helper call in Yo's turn); resolves with it once it exists. */
  async function start(core: Core, yoId: string, brief: string, extra: Record<string, unknown> = {}) {
    const before = core.store.listHelpers(yoId).length;
    await core.api["chat.send"]({
      agentId: yoId,
      text: `tool start_helper ${JSON.stringify({ brief, ...extra })}`,
    });
    await until(() => core.store.listHelpers(yoId).length > before, 5000, "helper created");
    return core.store.listHelpers(yoId).at(-1)!;
  }
  const retired = (core: Core, id: string) => !!core.store.getAgent(id)?.archivedAt;
  const card = (core: Core, id: string) => core.store.getEntry(`hcard_${id}`)?.item.helper;
  const reportTurns = () => mock.turnTexts.filter((t) => t.includes("[Helper report"));
  const replies = (core: Core, agentId: string) =>
    core.store
      .listTimeline(agentId)
      .filter((e) => e.item.kind === "assistant_message" && e.item.status === "completed")
      .map((e) => e.item.text ?? "");
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it("runs hidden on a fresh session with the brief and Yo's memories, reports to Yo, then is retired", async () => {
    const { core, yo } = await lead();
    const pushes = capture(core);
    core.store.addMemory("Sam prefers window seats", null);
    const h = await start(core, yo.id, "find the cheapest flight to Lisbon", { title: "Lisbon flights" });
    expect(h).toMatchObject({ kind: "helper", parentId: yo.id, brief: "find the cheapest flight to Lisbon" });
    expect(h.name).toBe("Lisbon flights");
    expect(h.avatar.softie?.color).toMatch(/^#[0-9A-F]{6}$/i);
    // Hidden from the agent list (Telegram, accounts, the sidebar), visible to the app while it works.
    expect(core.store.listAgents().map((a) => a.id)).not.toContain(h.id);

    await until(() => retired(core, h.id), 5000, "retired");
    const start1 = mock.requests.find((r) => r.type === "session.start" && r.agentId === h.id) as Extract<
      import("@yo/contracts").AgentdRequest,
      { type: "session.start" }
    >;
    expect(start1.toolset).toBe("helper");
    expect(start1.resumeCursor).toBeUndefined();
    expect(start1.systemAppend).toContain("You are Yo's helper");
    expect(start1.systemAppend).toContain("find the cheapest flight to Lisbon");
    expect(start1.systemAppend).toContain("Sam prefers window seats");
    expect(start1.systemAppend).toContain('"What I learned"');
    expect(start1.systemAppend).not.toContain("# Teammates");
    expect(start1.systemAppend).not.toContain("# Conversation so far");
    // Yo's own session: helpers instead of teammates, and no create_agent of its own.
    const yoStart = mock.requests.find(
      (r) => r.type === "session.start" && r.agentId === yo.id,
    ) as typeof start1;
    expect(yoStart.toolset).toBe("primary");
    expect(yoStart.systemAppend).toContain("# Helpers");
    expect(yoStart.systemAppend).toContain("# Playbooks");
    expect(yoStart.systemAppend).not.toContain("# Teammates");

    // Its brief is its first message (from Yo); its reply goes to Yo as a helper report.
    expect(core.store.listTimeline(h.id)[0]!.item).toMatchObject({
      kind: "user_message",
      text: "find the cheapest flight to Lisbon",
      from: { agentId: yo.id, name: "Yo" },
    });
    await until(() => reportTurns().length === 1, 5000, "report to Yo");
    expect(reportTurns()[0]).toContain('Your helper "Lisbon flights"');
    expect(reportTurns()[0]).toContain(
      '<helper_report from="Lisbon flights">\necho: find the cheapest flight to Lisbon\n</helper_report>',
    );
    // Retired in order: its session stopped, its computer discarded, archived, its card final.
    const sessionKey = core.store.latestSession(h.id)!.id;
    await until(() => mock.discarded.includes(h.id), 5000, "discarded");
    const stopAt = mock.requests.findIndex((r) => r.type === "session.stop" && r.sessionKey === sessionKey);
    const discardAt = mock.requests.findIndex((r) => r.type === "computer.discard" && r.agentId === h.id);
    expect(stopAt).toBeGreaterThan(-1);
    expect(discardAt).toBeGreaterThan(stopAt);
    expect(card(core, h.id)).toMatchObject({
      id: h.id,
      title: "Lisbon flights",
      state: "done",
      summary: "echo: find the cheapest flight to Lisbon",
    });
    expect(card(core, h.id)?.endedAt).toBeGreaterThan(0);
    expect(core.store.getEntry(`hcard_${h.id}`)?.agentId).toBe(yo.id);
    expect(core.store.listTasks(yo.id, { all: true })).toEqual([
      expect.objectContaining({ title: "Lisbon flights", status: "done", helperId: h.id }),
    ]);
    expect(pushes.some((p) => p.channel === "agent.removed" && p.data.id === h.id)).toBe(true);
    expect(core.orchestrator.views().map((v) => v.id)).not.toContain(h.id);
    // No popup for the helper itself; Yo's answer is the one the user hears.
    expect(pushes.filter((p) => p.channel === "notify" && p.data.agentId === h.id)).toEqual([]);
    await expect(core.api["chat.send"]({ agentId: h.id, text: "more" })).rejects.toThrow(/has finished/);
  });

  it("refuses a third helper, and stop_helper stops one without a report", async () => {
    const { core, yo } = await lead();
    const a = await start(core, yo.id, "slow", { title: "A" });
    const b = await start(core, yo.id, "slow", { title: "B" });
    await until(() => core.orchestrator.activityOf(b.id) === "working");
    await core.api["chat.send"]({ agentId: yo.id, text: 'tool start_helper {"brief":"third"}' });
    await until(
      () => replies(core, yo.id).some((t) => t.includes("already have 2 helpers")),
      5000,
      "refused",
    );
    expect(replies(core, yo.id).at(-1)).toContain(`"A" (${a.id})`);
    expect(core.store.listHelpers(yo.id)).toHaveLength(2);

    await core.api["chat.send"]({ agentId: yo.id, text: `tool stop_helper {"id":"${a.id}"}` });
    await until(() => retired(core, a.id), 5000, "A stopped");
    expect(card(core, a.id)?.state).toBe("stopped");
    expect(core.store.taskOfHelper(a.id)?.status).toBe("cancelled");
    await until(() => mock.discarded.includes(a.id));
    await settle();
    expect(reportTurns()).toEqual([]);
    // The user stopping one (its card's Stop): Yo hears about it.
    await core.api["chat.interrupt"]({ agentId: b.id });
    await until(() => retired(core, b.id), 12000, "B stopped");
    await until(() => reportTurns().length === 1, 5000, "report");
    expect(reportTurns()[0]).toContain("was stopped by the user");
  }, 20000);

  it("a waking helper doesn't put Yo to sleep; with no free screen it waits, then starts", async () => {
    const { core, yo } = await lead();
    const pepe = await core.api["agent.create"]({
      name: "Pepe",
      role: "",
      instructions: "",
      avatar: { shape: "bubble", color: "emerald", eyes: "capsule", accessory: "headset" },
    });
    mock.seatCap = 3; // agentd's hard cap; core's soft cap stays at its default of 2
    await core.api["chat.send"]({ agentId: pepe.id, text: "slow" });
    await until(() => core.orchestrator.activityOf(pepe.id) === "working");
    const h1 = await start(core, yo.id, "slow", { title: "one" });
    await until(() => mock.awake.has(h1.id), 5000, "helper awake");
    await until(() => core.orchestrator.activityOf(yo.id) !== "working");
    // Three awake (Yo idle, Pepe and the helper busy): over the soft cap, but Yo stays awake.
    expect(mock.count("computer.hibernate")).toBe(0);
    expect([...mock.awake].sort()).toEqual([yo.id, pepe.id, h1.id].sort());

    // A second helper finds every screen taken: it never puts Yo (idle) to sleep; it waits.
    const h2 = await start(core, yo.id, "hello", { title: "two" });
    await until(() => card(core, h2.id)?.state === "waiting", 5000, "waiting card");
    expect(card(core, h2.id)?.summary).toBe("Waiting for a free screen");
    expect(mock.count("computer.hibernate")).toBe(0);
    expect(core.orchestrator.view(yo.id)?.computer.state).toBe("ready");
    // The first one finishes: its screen is discarded and the second one gets it.
    await core.api["chat.interrupt"]({ agentId: h1.id });
    await until(() => retired(core, h2.id), 15000, "second helper done");
    expect(card(core, h2.id)?.state).toBe("done");
    expect(mock.count("computer.hibernate")).toBe(0);
  }, 25000);

  it("the time limit stops a helper; its partial result goes to Yo", async () => {
    const { core, yo } = await lead({ helperTurnMs: 800 });
    const h = await start(core, yo.id, "half partial findings");
    await until(() => retired(core, h.id), 15000, "time limit");
    expect(card(core, h.id)?.state).toBe("failed");
    await until(() => reportTurns().length === 1, 5000, "report");
    expect(reportTurns()[0]).toMatch(/was stopped: it hit a helper's 1 minute time limit/);
    expect(reportTurns()[0]).toContain("partial findings");
    expect(core.store.taskOfHelper(h.id)?.status).toBe("interrupted");
  }, 25000);

  it("a frozen helper is stopped and Yo is told why", async () => {
    const { core, yo } = await lead({ stuckTurnMs: 150 });
    const h = await start(core, yo.id, "slow");
    await until(() => retired(core, h.id), 15000, "froze");
    await until(() => reportTurns().length === 1, 5000, "report");
    expect(reportTurns()[0]).toMatch(/was stopped: a step froze/);
  }, 20000);

  it("refuses team and helper tools to helpers, even from an older computer that offers them", async () => {
    const { core, yo } = await lead();
    const h = await start(core, yo.id, 'tool message_agent {"to":"Yo","message":"hi"}');
    await until(() => reportTurns().length === 1, 5000, "report");
    expect(reportTurns()[0]).toContain("message_agent isn't available to helpers");
    expect(retired(core, h.id)).toBe(true);
  });

  it("refuses the Yo Phone tools to helpers", async () => {
    const { core, yo } = await lead();
    let links = 0;
    core.orchestrator.attachPhone({
      createLink: async () => {
        links++;
        return { link: "x" };
      },
      turnOff: async () => {},
      isPhoneTurn: () => false,
    });
    await start(core, yo.id, "tool create_phone_link {}");
    await until(() => reportTurns().length === 1, 5000, "report");
    expect(reportTurns()[0]).toContain("create_phone_link isn't available to helpers");
    expect(core.store.pendingRequests()).toHaveLength(0);
    expect(links).toBe(0);
  });

  it("an 'always allow' on a helper's card applies to Yo, and the card shows in Yo's chat", async () => {
    const { core, yo } = await lead();
    const pushes = capture(core);
    const h = await start(core, yo.id, 'tool request_approval {"action":"Buy it","category":"purchase"}');
    await until(
      () => core.orchestrator.pendingRequestEntries().some((e) => e.agentId === h.id),
      5000,
      "card",
    );
    await until(() => card(core, h.id)?.state === "waiting");
    expect(card(core, h.id)?.summary).toContain("Buy it");
    // Its notification opens Yo's chat.
    expect(
      pushes.some((p) => p.channel === "notify" && p.data.kind === "needs_you" && p.data.agentId === yo.id),
    ).toBe(true);
    const req = core.orchestrator.pendingRequestEntries().find((e) => e.agentId === h.id)!;
    await core.api["request.respond"]({
      agentId: h.id,
      requestId: req.request!.requestId,
      decision: "allowAlways",
    });
    await until(() => retired(core, h.id), 5000, "done");
    await until(() => core.orchestrator.activityOf(yo.id) !== "working");
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool request_approval {"action":"Buy another","category":"purchase"}',
    });
    await until(() => replies(core, yo.id).some((t) => t.includes("APPROVED (standing rule)")), 5000, "rule");
  });

  it("a restart retires working helpers, tells Yo, and frees their screens", async () => {
    const { core: core1, yo } = await lead();
    const h = await start(core1, yo.id, "slow", { title: "long job" });
    await until(() => core1.orchestrator.activityOf(h.id) === "working");
    await until(() => !!mock.sessionKeyOf(h.id));
    await core1.shutdown();
    cores = [];
    const core2 = await boot();
    expect(retired(core2, h.id)).toBe(true);
    expect(core2.store.taskOfHelper(h.id)?.status).toBe("interrupted");
    expect(card(core2, h.id)?.state).toBe("stopped");
    await until(() => reportTurns().length === 1, 5000, "Yo told");
    expect(reportTurns()[0]).toContain("was interrupted when Yo restarted");
    await until(() => mock.discarded.includes(h.id), 5000, "discarded after reconnect");
  });

  it("check_helpers waits for a helper's report and it isn't delivered a second time", async () => {
    const { core, yo } = await lead();
    const h = await start(core, yo.id, "half the answer is 42", { title: "answer" });
    await until(() => !!core.store.listTimeline(h.id).some((e) => e.item.kind === "assistant_message"));
    await until(() => core.orchestrator.activityOf(yo.id) !== "working");
    await core.api["chat.send"]({ agentId: yo.id, text: 'tool check_helpers {"wait_seconds":5}' });
    await until(() => mock.turnTexts.some((t) => t.includes("check_helpers")));
    await settle(100);
    // Yo is waiting (not frozen); the helper finishes.
    expect(core.orchestrator.activityOf(yo.id)).toBe("working");
    const hs = mock.sessionKeyOf(h.id)!;
    const hTurn = mock.requests.find((r) => r.type === "turn.send" && r.sessionKey === hs) as {
      turnId: string;
    };
    mock.completeTurn(hs, hTurn.turnId, "completed");
    await until(
      () => replies(core, yo.id).some((t) => t.includes("<helper_report")),
      5000,
      "report via check",
    );
    expect(replies(core, yo.id).at(-1)).toContain("the answer is 42");
    await until(() => retired(core, h.id));
    await settle(300);
    expect(reportTurns()).toEqual([]);
    // Without waiting it just says how things are.
    await core.api["chat.send"]({ agentId: yo.id, text: "tool check_helpers {}" });
    await until(() => replies(core, yo.id).some((t) => t.includes("No helpers are working now.")));
  });

  it("keeps the task ledger in Yo's context: after /compact, and as a line when it changed", async () => {
    const { core, yo } = await lead();
    await core.api["chat.send"]({ agentId: yo.id, text: 'tool task_add {"title":"Book the flights"}' });
    await until(() => replies(core, yo.id).some((t) => t.includes("Added task")));
    // Its own change isn't repeated back to it.
    await core.api["chat.send"]({ agentId: yo.id, text: "next" });
    await until(() => replies(core, yo.id).includes("echo: next"));
    expect(mock.turnTexts.at(-1)).not.toContain("[Open tasks");
    // A change it didn't make (a helper's result, say) is told on its next message.
    core.store.addTask({ ownerId: yo.id, title: "Renew the passport" });
    await core.api["chat.send"]({ agentId: yo.id, text: "and then" });
    await until(() => replies(core, yo.id).includes("echo: and then"));
    expect(mock.turnTexts.at(-1)).toMatch(
      /\[Open tasks: \[tsk_\w+\] Book the flights; \[tsk_\w+\] Renew the passport\]/,
    );
    // A fresh session after /compact gets the ledger in its prompt.
    await core.api["agent.compact"]({ id: yo.id });
    await until(() =>
      core.store.listTimeline(yo.id).some((e) => /^Compacted our conversation/.test(e.item.text ?? "")),
    );
    await core.api["chat.send"]({ agentId: yo.id, text: "go on" });
    await until(() => replies(core, yo.id).includes("echo: go on"));
    const s = mock.last("session.start")!;
    expect(s.systemAppend).toContain("# Open tasks");
    expect(s.systemAppend).toContain("Renew the passport");
    expect(mock.turnTexts.at(-1)).not.toContain("[Open tasks");
  });

  it("a helper whose steps keep failing triggers a helper check to Yo", async () => {
    const { core, yo } = await lead({ oversightFailMs: 0, oversightCooldownMs: 0 });
    const h = await start(core, yo.id, "fail 3", { title: "flaky" });
    await until(() => mock.turnTexts.some((t) => t.includes("[Automatic helper check")), 5000, "check");
    const check = mock.turnTexts.find((t) => t.includes("[Automatic helper check"))!;
    expect(check).toContain(`Your helper "flaky" has had 3 steps in a row fail`);
    expect(check).toContain("stop_helper");
    expect(check).toContain(h.id);
    await until(() => reportTurns().length === 1, 5000, "report");
    // How it went is in its report, not a second check.
    expect(reportTurns()[0]).toContain("3 of its steps failed along the way");
    expect(mock.turnTexts.filter((t) => t.includes("[Automatic helper check"))).toHaveLength(1);
  });

  it("falls back to hibernating a finished helper's computer on an older agentd", async () => {
    const { core, yo } = await lead();
    mock.discardUnsupported = true;
    const h = await start(core, yo.id, "hello");
    await until(() => mock.requests.some((r) => r.type === "computer.hibernate" && r.agentId === h.id), 5000);
    expect(mock.discarded).toEqual([]);
    expect(retired(core, h.id)).toBe(true);
  });

  it("follows a playbook and logs the run; playbook_list shows how its runs went", async () => {
    const { core, yo } = await lead();
    const h = await start(core, yo.id, "quote VIN 123", {
      playbook: "~/Shared/playbooks/work/desk-quote.md",
    });
    await until(() => retired(core, h.id));
    const s = mock.requests.find((r) => r.type === "session.start" && r.agentId === h.id) as any;
    expect(s.systemAppend).toContain("Follow the playbook `~/Shared/playbooks/work/desk-quote.md`");
    expect(core.store.listPlaybookRuns("work/desk-quote.md")).toEqual([
      expect.objectContaining({ helperId: h.id, outcome: "success" }),
    ]);
    await until(() => core.orchestrator.activityOf(yo.id) !== "working");
    await core.api["chat.send"]({
      agentId: yo.id,
      text: `tool playbook_record_run {"playbook":"work/desk-quote.md","helper_id":"${h.id}","corrections":1}`,
    });
    await until(() => replies(core, yo.id).some((t) => t.includes("1 correction")));
    await core.api["chat.send"]({ agentId: yo.id, text: "tool playbook_list {}" });
    await until(() => replies(core, yo.id).some((t) => t.includes("work/desk-quote.md: 1 run")));
    // Not a playbook: refused before anything starts.
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool start_helper {"brief":"x","playbook":"../../etc/passwd"}',
    });
    await until(() => replies(core, yo.id).some((t) => t.includes("isn't a playbook")));
    expect(core.store.listHelpers(yo.id)).toHaveLength(1);
  });

  it("teammates and Yo both see the team in their prompts", async () => {
    const { core, yo } = await lead();
    const pepe = await core.api["agent.create"]({
      name: "Pepe",
      role: "Head of Polestar",
      instructions: "",
      avatar: { shape: "bubble", color: "emerald", eyes: "capsule", accessory: "headset" },
    });
    await core.api["chat.send"]({ agentId: pepe.id, text: "hi" });
    await until(() => replies(core, pepe.id).length === 1);
    const ps = mock.last("session.start")!;
    expect(ps.toolset).toBe("agent");
    expect(ps.systemAppend).toContain("# Your team\nYo and Pip are the main agents");
    await core.api["chat.send"]({ agentId: yo.id, text: "hi" });
    await until(() => replies(core, yo.id).length === 1);
    const ys = mock.last("session.start")!;
    expect(ys.systemAppend).toContain("# Your team\nYou're the main agent");
    expect(ys.systemAppend).toContain("- Pepe (Head of Polestar): ");
    expect(ys.systemAppend).toContain("# Leading the team");
  });
});
