/**
 * Telegram channel against a fake Bot API (injected fetch), a real Store/Hub and a fake orchestrator.
 */
import { type AgentActivity, type Decision, newId, type PendingRequest } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkHtml, escapeHtml, escClip, TelegramChannel, type TgUpdate } from "../src/channels/telegram";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { Hub } from "../src/hub";
import { redact } from "../src/log";
import { MemorySecretStore } from "../src/secrets/SecretStore";

const TOKEN = "123456789:AAH-fake_token_for_tests_0123456789abc";
const OWNER = 4242;
const STRANGER = 777;

async function until(fn: () => boolean, ms = 3000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Minimal Bot API: records every call; getUpdates serves `updates` then idles briefly. */
class FakeTelegram {
  calls: { method: string; params: any; token: string }[] = [];
  updates: TgUpdate[] = [];
  tokenOk = true;
  /** message_id of the last sendMessage. */
  lastId = 99;

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const [, token = "", method = ""] = /\/bot([^/]+)\/(\w+)$/.exec(String(input)) ?? [];
    const params = JSON.parse(String(init?.body ?? "{}"));
    this.calls.push({ method, params, token });
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (!this.tokenOk) return reply({ ok: false, error_code: 401, description: "Unauthorized" }, 401);
    switch (method) {
      case "getMe":
        return reply({
          ok: true,
          result: { id: 1, is_bot: true, first_name: "Yo", username: "yo_test_bot" },
        });
      case "getUpdates": {
        if (!this.updates.length) {
          await new Promise((r) => setTimeout(r, 15));
          if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        }
        return reply({ ok: true, result: this.updates.splice(0) });
      }
      case "sendMessage":
        return reply({ ok: true, result: { message_id: ++this.lastId, chat: { id: params.chat_id } } });
      default:
        return reply({ ok: true, result: true });
    }
  }) as typeof fetch;

  of(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
  /** Calls that put something in a chat (not polling or token checks). */
  get chatCalls() {
    return this.calls.filter((c) => !["getMe", "getUpdates", "deleteWebhook"].includes(c.method));
  }
}

let store: Store;
let hub: Hub;
let tg: FakeTelegram;
let secrets: MemorySecretStore;
let channel: TelegramChannel;
let orch: ReturnType<typeof fakeOrchestrator>;
let primaryId: string;
let updateId = 1;

function fakeOrchestrator() {
  const o = {
    sent: [] as { agentId: string; text: string }[],
    responded: [] as {
      agentId: string;
      requestId: string;
      decision: Decision;
      answers?: Record<string, string>;
      message?: string;
    }[],
    interrupted: [] as string[],
    send: async (agentId: string, text: string) => {
      o.sent.push({ agentId, text });
      return { turnId: "trn_1" };
    },
    // Like the real one: resolve the request and push the updated card.
    respond: async (
      agentId: string,
      requestId: string,
      decision: Decision,
      answers?: Record<string, string>,
      message?: string,
    ) => {
      const e = store.pendingRequests().find((x) => x.request?.requestId === requestId);
      if (!e) throw new Error("This request is no longer pending.");
      o.responded.push({ agentId, requestId, decision, answers, message });
      const done = store.setRequestStatus(
        e.id,
        decision === "deny" ? "denied" : answers ? "answered" : "allowed",
      );
      hub.push("timeline.upsert", done!);
    },
    interrupt: async (agentId: string) => {
      o.interrupted.push(agentId);
    },
    pendingRequestEntries: () => store.pendingRequests(),
    activity: new Map<string, AgentActivity>(),
    activityOf: (agentId: string): AgentActivity => o.activity.get(agentId) ?? "idle",
  };
  return o;
}

function makeChannel() {
  return new TelegramChannel({ store, hub, orchestrator: orch, secrets, fetch: tg.fetch, sendGapMs: 0 });
}

const msg = (chatId: number, text: string, extra: Record<string, unknown> = {}): TgUpdate => ({
  update_id: updateId++,
  message: {
    message_id: updateId,
    chat: { id: chatId, type: "private", first_name: "Junior" },
    text,
    ...extra,
  },
});
const press = (chatId: number, data: string, messageId = 1): TgUpdate => ({
  update_id: updateId++,
  callback_query: {
    id: `cb${updateId}`,
    data,
    message: { message_id: messageId, chat: { id: chatId, type: "private" } },
  },
});

async function deliver(u: TgUpdate) {
  await channel.handleUpdate(u);
  await channel.idle();
}

async function configureAndPair() {
  await channel.api["channels.telegram.configure"]({ token: TOKEN });
  const { code } = await channel.api["channels.telegram.pairCode"]({});
  await deliver(msg(OWNER, `/pair ${code}`));
  expect(channel.status().paired?.chatId).toBe(OWNER);
  tg.calls = [];
}

function addRequest(request: Omit<PendingRequest, "requestId"> & { requestId?: string }, toolName?: string) {
  const req = { requestId: request.requestId ?? newId("call"), ...request };
  const entry = store.upsertEntry({
    id: newId("req"),
    agentId: primaryId,
    turnId: null,
    item: { id: newId("itm"), kind: "tool", status: "running", title: req.title, toolName },
    request: { ...req, status: "pending" },
  });
  hub.push("timeline.upsert", entry);
  return entry;
}

function sentTexts() {
  return tg.of("sendMessage").map((p) => p.text as string);
}

beforeEach(() => {
  store = new Store(openMemoryDb());
  hub = new Hub();
  tg = new FakeTelegram();
  secrets = new MemorySecretStore();
  orch = fakeOrchestrator();
  primaryId = store.createAgent({
    name: "Yo",
    role: "",
    instructions: "",
    avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "none" },
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "full-access",
    isPrimary: true,
    pinned: true,
  }).id;
  channel = makeChannel();
});

afterEach(async () => {
  await channel.stop();
});

describe("telegram channel", () => {
  it("does nothing until a bot token is configured", async () => {
    await channel.start();
    hub.push("notify", { agentId: primaryId, title: "Yo", body: "Done", kind: "done" });
    addRequest({ kind: "tool_approval", title: "Buy milk", toolName: "yo:purchase" });
    await deliver(msg(OWNER, "/pair ABCDEF"));
    await deliver(msg(OWNER, "hello"));
    expect(tg.calls).toEqual([]);
    expect(orch.sent).toEqual([]);
    expect(channel.status()).toMatchObject({ configured: false, polling: false, paired: null });
    await expect(channel.api["channels.telegram.pairCode"]({})).rejects.toThrow(/token first/);
  });

  it("checks the token with getMe, keeps it in the secret store and out of logs", async () => {
    await expect(channel.api["channels.telegram.configure"]({ token: "nope" })).rejects.toThrow(/BotFather/);
    tg.tokenOk = false;
    await expect(channel.api["channels.telegram.configure"]({ token: TOKEN })).rejects.toThrow(
      /didn't accept/,
    );
    expect(await secrets.get("telegram-bot-token")).toBeNull();

    tg.tokenOk = true;
    const s = await channel.api["channels.telegram.configure"]({ token: TOKEN });
    expect(s).toMatchObject({ configured: true, bot: { username: "yo_test_bot" }, paired: null });
    expect(await secrets.get("telegram-bot-token")).toBe(TOKEN);
    expect(JSON.stringify(store.getKv("telegram"))).not.toContain(TOKEN);
    expect(redact(`POST https://api.telegram.org/bot${TOKEN}/getUpdates failed`)).not.toContain(TOKEN);

    const off = await channel.api["channels.telegram.configure"]({ clear: true });
    expect(off.configured).toBe(false);
    expect(await secrets.get("telegram-bot-token")).toBeNull();
  });

  it("long-polls getUpdates, advances the offset and stops cleanly", async () => {
    await secrets.set("telegram-bot-token", TOKEN);
    await channel.start();
    await until(() => tg.of("getUpdates").length > 0, 3000, "first poll");
    expect(tg.of("getUpdates")[0]).toMatchObject({ offset: 0, timeout: 50 });
    tg.updates.push(msg(STRANGER, "hi"));
    const last = updateId - 1;
    await until(() => tg.of("getUpdates").some((p) => p.offset === last + 1), 3000, "offset advance");
    expect(store.getKv<{ offset: number }>("telegram")?.offset).toBe(last + 1);
    await channel.stop();
    const n = tg.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(tg.calls.length).toBe(n);
    expect(tg.chatCalls).toEqual([]);
  });

  it("pairs only with the right one-time code", async () => {
    await channel.api["channels.telegram.configure"]({ token: TOKEN });
    // No code waiting: ignored, no reply.
    await deliver(msg(STRANGER, "/pair ABCDEF"));
    expect(tg.chatCalls).toEqual([]);

    const { code, link } = await channel.api["channels.telegram.pairCode"]({});
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(link).toBe(`https://t.me/yo_test_bot?start=${code}`);
    await deliver(msg(STRANGER, "/pair WRONG1"));
    expect(channel.status().paired).toBeNull();
    expect(tg.of("sendMessage")).toEqual([expect.objectContaining({ chat_id: STRANGER })]);
    expect(sentTexts()[0]).toMatch(/didn't match/);

    await deliver(msg(OWNER, `/start ${code.toLowerCase()}`));
    expect(channel.status().paired).toEqual({ chatId: OWNER, name: "Junior" });
    expect(sentTexts().at(-1)).toMatch(/Connected to Yo/);

    // The code is single-use.
    tg.calls = [];
    await deliver(msg(STRANGER, `/pair ${code}`));
    expect(channel.status().paired?.chatId).toBe(OWNER);
    expect(tg.chatCalls).toEqual([]);

    await channel.api["channels.telegram.unpair"]({});
    expect(channel.status().paired).toBeNull();
  });

  it("locks a chat out after too many wrong tries, without using up the owner's", async () => {
    await channel.api["channels.telegram.configure"]({ token: TOKEN });
    const { code } = await channel.api["channels.telegram.pairCode"]({});
    for (let i = 0; i < 5; i++) await deliver(msg(STRANGER, "/pair AAAAAA"));
    await deliver(msg(STRANGER, `/pair ${code}`));
    expect(channel.status().paired).toBeNull();
    await deliver(msg(OWNER, `/pair ${code}`));
    expect(channel.status().paired?.chatId).toBe(OWNER);
  });

  it("only registers a token for log scrubbing once it looks like a bot token", async () => {
    await expect(
      channel.api["channels.telegram.configure"]({ token: "just some words typed by mistake" }),
    ).rejects.toThrow(/doesn't look like/);
    expect(redact("just some words typed by mistake")).toBe("just some words typed by mistake");
  });

  it("forgets replies owed to Telegram when the agent stops without one", async () => {
    await configureAndPair();
    await deliver(msg(OWNER, "look into this"));
    // Stopped from the Mac: no "done" notification, the agent just goes idle.
    hub.push("agent.updated", { ...store.getAgent(primaryId)!, activity: "idle" } as any);
    await new Promise((r) => setImmediate(r));
    tg.calls = [];
    // A later chat started at the Mac must not be forwarded as Telegram's reply.
    store.upsertEntry({
      id: newId("usr"),
      agentId: primaryId,
      turnId: null,
      item: { id: newId("itm"), kind: "user_message", status: "completed", text: "at my desk" },
    });
    store.upsertEntry({
      id: newId("ast"),
      agentId: primaryId,
      turnId: "trn_2",
      item: { id: newId("itm"), kind: "assistant_message", status: "completed", text: "desk reply" },
    });
    hub.push("notify", { agentId: primaryId, title: "Yo", body: "desk reply", kind: "done" });
    await channel.idle();
    expect(sentTexts()).toEqual([]);
  });

  it("doesn't touch the store if core shuts down before its idle check runs", async () => {
    await configureAndPair();
    await deliver(msg(OWNER, "look into this"));
    orch.activityOf = () => {
      throw new Error("database is not open");
    };
    hub.push("agent.updated", { ...store.getAgent(primaryId)!, activity: "idle" } as any);
    await channel.stop();
    await new Promise((r) => setImmediate(r)); // would surface as an uncaught exception
  });

  it("keeps a reply owed while a queued Telegram message starts right after", async () => {
    await configureAndPair();
    await deliver(msg(OWNER, "first"));
    // Between two turns the agent is briefly "done", then working on the queued message.
    orch.activity.set(primaryId, "working");
    hub.push("agent.updated", { ...store.getAgent(primaryId)!, activity: "done" } as any);
    await new Promise((r) => setImmediate(r));
    store.upsertEntry({
      id: newId("ast"),
      agentId: primaryId,
      turnId: "trn_1",
      item: { id: newId("itm"), kind: "assistant_message", status: "completed", text: "the answer" },
    });
    tg.calls = [];
    hub.push("notify", { agentId: primaryId, title: "Yo", body: "the answer", kind: "done" });
    await channel.idle();
    expect(sentTexts()).toEqual(["<b>Yo</b>\nthe answer"]);
  });

  it("ignores messages and button presses from other chats", async () => {
    await configureAndPair();
    const e = addRequest({ kind: "tool_approval", title: "Send email", toolName: "yo:send" });
    await channel.idle();
    const approve = tg.of("sendMessage")[0].reply_markup.inline_keyboard[0][0].callback_data;
    tg.calls = [];
    await deliver(msg(STRANGER, "hello"));
    await deliver(press(STRANGER, approve));
    expect(orch.sent).toEqual([]);
    expect(orch.responded).toEqual([]);
    expect(tg.chatCalls).toEqual([]);
    expect(store.getEntry(e.id)?.request?.status).toBe("pending");
  });

  it("sends approvals with buttons and resolves them through orchestrator.respond", async () => {
    await configureAndPair();
    const e = addRequest({
      kind: "tool_approval",
      title: "Buy <cheap> milk & eggs",
      toolName: "yo:purchase",
      input: { category: "purchase", total: "$4" },
    });
    await channel.idle();
    const [card] = tg.of("sendMessage");
    expect(card.chat_id).toBe(OWNER);
    expect(card.parse_mode).toBe("HTML");
    expect(card.text).toContain("Yo needs your approval");
    expect(card.text).toContain("Buy &lt;cheap&gt; milk &amp; eggs");
    const kb = card.reply_markup.inline_keyboard as { text: string; callback_data: string }[][];
    // No one-tap "Always allow" on a phone; the Yo app still offers it.
    expect(kb.flat().map((b) => b.text)).toEqual(["Approve", "Deny"]);
    for (const b of kb.flat()) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);

    const cardId = tg.lastId;
    await deliver(press(OWNER, kb[0]![0]!.callback_data, cardId));
    expect(orch.responded).toEqual([
      expect.objectContaining({ agentId: primaryId, requestId: e.request!.requestId, decision: "allow" }),
    ]);
    expect(store.getEntry(e.id)?.request?.status).toBe("allowed");
    const [edit] = tg.of("editMessageText");
    expect(edit).toMatchObject({ chat_id: OWNER, message_id: cardId, reply_markup: { inline_keyboard: [] } });
    expect(edit.text).toContain("Approved ✓ by you");
    expect(tg.of("answerCallbackQuery")[0].text).toMatch(/Approved/);
    // Only one edit: the resolved push from respond() doesn't relabel it "in Yo".
    expect(tg.of("editMessageText")).toHaveLength(1);
  });

  it("treats a button as stale once the request was handled elsewhere", async () => {
    await configureAndPair();
    const e = addRequest({ kind: "tool_approval", title: "Post tweet", toolName: "yo:post" });
    await channel.idle();
    const deny = tg.of("sendMessage")[0].reply_markup.inline_keyboard[0][1].callback_data;

    // Resolved in the Yo UI: the card is relabelled and its buttons removed.
    hub.push("timeline.upsert", store.setRequestStatus(e.id, "allowed")!);
    await channel.idle();
    expect(tg.of("editMessageText")[0].text).toContain("Approved in Yo");

    await deliver(press(OWNER, deny));
    expect(orch.responded).toEqual([]);
    expect(tg.of("answerCallbackQuery").at(-1).text).toMatch(/expired/);

    // Resolved without us seeing the push: the store is checked before responding.
    const e2 = addRequest({ kind: "tool_approval", title: "Post again", toolName: "yo:post" });
    await channel.idle();
    const approve2 = tg.of("sendMessage").at(-1).reply_markup.inline_keyboard[0][0].callback_data;
    store.setRequestStatus(e2.id, "denied");
    await deliver(press(OWNER, approve2));
    expect(orch.responded).toEqual([]);
    expect(tg.of("answerCallbackQuery").at(-1).text).toMatch(/Already handled/);
  });

  it("never offers buttons for Mac changes or takeovers", async () => {
    await configureAndPair();
    addRequest(
      {
        kind: "tool_approval",
        title: "Save notes.txt",
        toolName: "mac_write_file",
        deviceWrite: {
          operationId: "op1",
          deviceName: "Mac",
          displayPath: "~/notes.txt",
          bytes: 3,
          sha256: "x",
          replaces: null,
          preview: "hi",
          expiresAt: Date.now() + 60_000,
        },
      },
      "mac_write_file",
    );
    addRequest({ kind: "tool_approval", title: "Add event", toolName: "mac_write_file" }, "mac_write_file");
    addRequest({ kind: "user_input", title: "Take over", toolName: "request_takeover", detail: "2FA code" });
    await channel.idle();
    const sent = tg.of("sendMessage");
    expect(sent).toHaveLength(3);
    for (const s of sent) expect(s.reply_markup).toBeUndefined();
    expect(sent[0].text).toContain("Open Yo to review this change on your Mac");
    expect(sent[1].text).toContain("Open Yo to review this change on your Mac");
    expect(sent[2].text).toContain("Open Yo to take over");
  });

  it("answers questions with option buttons or a free-text reply", async () => {
    await configureAndPair();
    const q1 = addRequest(
      {
        kind: "user_input",
        title: "Which size?",
        questions: [
          { question: "Which size?", options: [{ label: "Small" }, { label: "Large" }], multiSelect: false },
        ],
      },
      "ask_user",
    );
    await channel.idle();
    const kb = tg.of("sendMessage")[0].reply_markup.inline_keyboard;
    expect(kb.flat().map((b: any) => b.text)).toEqual(["Small", "Large"]);
    await deliver(press(OWNER, kb[1][0].callback_data, tg.lastId));
    expect(orch.responded[0]).toMatchObject({
      requestId: q1.request!.requestId,
      decision: "allow",
      answers: { "Which size?": "Large" },
      message: "Large",
    });

    const q2 = addRequest(
      {
        kind: "user_input",
        title: "Name?",
        questions: [{ question: "Name?", options: [], multiSelect: false }],
      },
      "ask_user",
    );
    await channel.idle();
    await deliver(msg(OWNER, "Call it Bob", { reply_to_message: { message_id: tg.lastId } }));
    expect(orch.responded[1]).toMatchObject({ requestId: q2.request!.requestId, message: "Call it Bob" });
    expect(orch.sent).toEqual([]);
    expect(tg.of("editMessageText").at(-1).text).toContain("Answered ✓ by you: Call it Bob");
  });

  it("sends chat to the current agent and returns its full reply in chunks", async () => {
    await configureAndPair();
    await deliver(msg(OWNER, "write me an essay"));
    expect(orch.sent).toEqual([{ agentId: primaryId, text: "write me an essay" }]);
    expect(tg.of("sendChatAction")).toHaveLength(1);

    const long = `${"Line with <tags> & stuff.\n".repeat(400)}The end.`;
    store.upsertEntry({
      id: newId("ast"),
      agentId: primaryId,
      turnId: "trn_1",
      item: { id: newId("itm"), kind: "assistant_message", status: "completed", text: long },
    });
    hub.push("notify", { agentId: primaryId, title: "Yo", body: long.slice(0, 140), kind: "done" });
    await channel.idle();
    const texts = sentTexts();
    expect(texts.length).toBeGreaterThan(2);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(4096);
    expect(texts[0]!.startsWith("<b>Yo</b>\n")).toBe(true);
    const joined = texts.join("\n").replace("<b>Yo</b>\n", "");
    expect(joined.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).toBe(long);

    // A chat the owner started in the Yo app: they're at their Mac, so the phone stays quiet.
    tg.calls = [];
    const userMessage = (title?: string) =>
      store.upsertEntry({
        id: newId("usr"),
        agentId: primaryId,
        turnId: null,
        item: {
          id: newId("itm"),
          kind: "user_message",
          status: "completed",
          text: "hi",
          ...(title ? { title } : {}),
        },
      });
    userMessage();
    hub.push("notify", { agentId: primaryId, title: "Yo", body: "Answered on the Mac", kind: "done" });
    hub.push("notify", { agentId: primaryId, title: "Yo", body: "fyi", kind: "info" });
    await channel.idle();
    expect(sentTexts()).toEqual([]);

    // A routine's result (and any problem) is forwarded as a notification.
    userMessage("Routine · Morning brief");
    hub.push("notify", { agentId: primaryId, title: "Yo", body: "Routine finished", kind: "done" });
    hub.push("notify", { agentId: primaryId, title: "Yo", body: "It broke", kind: "error" });
    await channel.idle();
    expect(sentTexts()).toEqual(["<b>Yo</b>\nRoutine finished", "<b>Yo</b> hit a problem\nIt broke"]);
  });

  it("caps very long replies", async () => {
    await configureAndPair();
    await deliver(msg(OWNER, "go"));
    store.upsertEntry({
      id: newId("ast"),
      agentId: primaryId,
      turnId: "trn_1",
      item: { id: newId("itm"), kind: "assistant_message", status: "completed", text: "x".repeat(50_000) },
    });
    hub.push("notify", { agentId: primaryId, title: "Yo", body: "x", kind: "done" });
    await channel.idle();
    const texts = sentTexts();
    expect(texts).toHaveLength(4);
    expect(texts.at(-1)).toContain("the rest is in Yo");
  });

  it("picks agents with /agents, /use and stops with /stop", async () => {
    const helper = store.createAgent({
      name: "Shopper",
      role: "",
      instructions: "",
      avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "none" },
      accountId: null,
      model: null,
      effort: null,
      runtimeMode: "full-access",
      isPrimary: false,
      pinned: false,
    });
    await configureAndPair();
    await deliver(msg(OWNER, "/agents"));
    const kb = tg.of("sendMessage")[0].reply_markup.inline_keyboard;
    expect(kb.flat().map((b: any) => b.text)).toEqual(["● Yo", "Shopper"]);
    await deliver(press(OWNER, kb[1][0].callback_data));
    expect(channel.status().activeAgentId).toBe(helper.id);
    await deliver(msg(OWNER, "find socks"));
    expect(orch.sent.at(-1)).toEqual({ agentId: helper.id, text: "find socks" });

    await deliver(msg(OWNER, "/use yo"));
    expect(channel.status().activeAgentId).toBe(primaryId);
    await deliver(msg(OWNER, "/stop"));
    expect(orch.interrupted).toEqual([primaryId]);
    await deliver(msg(OWNER, "/use nobody"));
    expect(sentTexts().at(-1)).toMatch(/No agent called/);
  });
});

describe("telegram formatting", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe(`&lt;a href="x"&gt;&amp;&lt;/a&gt;`);
    // Clipped after escaping, so "<<<…" can't grow 4x past Telegram's limit, and never inside an entity.
    expect(escClip("<".repeat(1500), 1500).length).toBeLessThanOrEqual(1500);
    expect(escClip("ab&cd", 5)).toBe("ab…");
    expect(escClip("short & sweet", 100)).toBe("short &amp; sweet");
  });

  it("chunks without splitting entities and prefers line breaks", () => {
    const chunks = chunkHtml("&".repeat(30), "", 12);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(12);
      expect(c).toMatch(/^(&amp;)+$/);
    }
    expect(chunks.join("")).toBe("&amp;".repeat(30));
    expect(chunkHtml("aaaaaa\nbbbbbb\ncc", "", 15)).toEqual(["aaaaaa\nbbbbbb", "cc"]);
    expect(chunkHtml("", "<b>x</b>\n")).toEqual(["<b>x</b>\n"]);
  });
});
