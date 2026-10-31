import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Avatar, BRIEF_NOTICE, briefFromInput, MORNING_BRIEF_FRAME } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { Hub } from "../src/hub";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { claimBrief } from "../src/tools/brief";
import { createYoTools } from "../src/tools/yoTools";
import { MockAgentd } from "./mockAgentd";

const DAY = 24 * 60 * 60_000;
const AVATAR: Avatar = { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" };

function tools() {
  return createYoTools({
    store: new Store(openMemoryDb()),
    hub: new Hub(),
    scheduler: null as never,
    dataDir: os.tmpdir(),
    fetchFile: async () => Buffer.from(""),
    bugReports: null as never,
  });
}

describe("post_brief", () => {
  it("reads snake_case, trims, drops rows without a title and caps each list", () => {
    const b = briefFromInput({
      needs_you: [
        {
          title: "  Reply to Ana  ",
          detail: " About Friday's\n ship date ",
          start: "Reply to Ana about Friday",
        },
        { title: "   " },
        ...Array.from({ length: 8 }, (_, i) => ({ title: `Row ${i}` })),
      ],
      can_wait: [{ title: "3 newsletters", start: "ignored: only Needs you has Start" }],
      today: Array.from({ length: 20 }, (_, i) => ({ time: `${i + 1}:00 PM`, title: `Event ${i}` })),
      could_not_check: [{ source: "Mail", why: "not connected" }, { why: "no source" }],
    });
    expect(b.needsYou).toHaveLength(5);
    expect(b.needsYou[0]).toEqual({
      title: "Reply to Ana",
      detail: "About Friday's ship date",
      start: "Reply to Ana about Friday",
    });
    expect(b.canWait).toEqual([{ title: "3 newsletters" }]);
    expect(b.today).toHaveLength(12);
    expect(b.today[0]).toEqual({ time: "1:00 PM", title: "Event 0" });
    expect(b.couldNotCheck).toEqual([{ source: "Mail", why: "not connected" }]);
  });

  it("leaves out rows and Start text that start like a command", () => {
    const b = briefFromInput({
      needs_you: [
        { title: "/new", start: "Reset" },
        { title: "Pay the water bill", start: "/compact" },
      ],
      today: [{ title: "/new session" }, { time: "9:30 AM", title: "Standup" }],
    });
    expect(b.needsYou).toEqual([{ title: "Pay the water bill" }]);
    expect(b.today).toEqual([{ time: "9:30 AM", title: "Standup" }]);
  });

  it("says the card is up and asks for at most one sentence; an empty brief is refused", async () => {
    const t = tools();
    const out = await t("agt_yo", "post_brief", {
      needs_you: [{ title: "Reply to Ana" }],
      today: [{ time: "9:30 AM", title: "Standup" }],
    });
    expect(out).toContain("on screen");
    expect(out).toContain("at most one short sentence");
    await expect(t("agt_yo", "post_brief", { needs_you: [{ title: " " }] })).rejects.toThrow(/empty/);
  });
});

describe("suggest_replies", () => {
  it("takes 2 or 3 distinct replies of at most 24 characters", async () => {
    const t = tools();
    expect(await t("agt_yo", "suggest_replies", { replies: ["Book the 8 PM", "Show other times"] })).toBe(
      "The buttons are on screen. Ask your question in one short sentence without listing the replies.",
    );
    await expect(t("agt_yo", "suggest_replies", { replies: ["Yes"] })).rejects.toThrow(/2 or 3/);
    await expect(t("agt_yo", "suggest_replies", { replies: ["a", "b", "c", "d"] })).rejects.toThrow(/2 or 3/);
    await expect(
      t("agt_yo", "suggest_replies", { replies: ["Yes", "This one is far too long to fit"] }),
    ).rejects.toThrow(/24 characters/);
    await expect(t("agt_yo", "suggest_replies", { replies: ["Yes", " yes "] })).rejects.toThrow(/different/);
    await expect(t("agt_yo", "suggest_replies", { replies: ["Yes", ""] })).rejects.toThrow(/empty/);
    await expect(t("agt_yo", "suggest_replies", {})).rejects.toThrow(/list/);
    await expect(t("agt_yo", "suggest_replies", { replies: ["Yes", "/new"] })).rejects.toThrow(/commands/);
  });
});

describe("brief.claim", () => {
  function setup(opts: { createdDaysAgo?: number } = {}) {
    const store = new Store(openMemoryDb());
    store.updateSettings({ onboarded: true, computerSetup: "done", timezone: "UTC", spacesOn: false });
    const yo = store.createAgent({
      name: "Yo",
      role: "",
      instructions: "",
      avatar: AVATAR,
      accountId: null,
      model: null,
      effort: null,
      runtimeMode: "full-access",
      isPrimary: true,
      pinned: true,
    });
    const created = yo.createdAt;
    const now = created + (opts.createdDaysAgo ?? 3) * DAY;
    const sent: { agentId: string; text: string }[] = [];
    const deps = {
      store,
      now: () => now,
      send: async (agentId: string, text: string) => {
        sent.push({ agentId, text });
      },
    };
    const today = new Date(now).toISOString().slice(0, 10);
    return { store, yo, deps, sent, today, now };
  }

  it("posts once per local day, for the active space's main agent", async () => {
    const { deps, sent, today, yo } = setup();
    expect(await claimBrief(deps, today)).toEqual({ posted: true });
    expect(sent).toEqual([{ agentId: yo.id, text: MORNING_BRIEF_FRAME }]);
    // Another tab, a reload, the phone: already claimed.
    expect(await claimBrief(deps, today)).toEqual({ posted: false });
    expect(sent).toHaveLength(1);
  });

  it("posts again the next day", async () => {
    const { deps, sent, store, now } = setup();
    const day1 = new Date(now).toISOString().slice(0, 10);
    expect((await claimBrief(deps, day1)).posted).toBe(true);
    const later = { ...deps, store, now: () => now + DAY };
    const day2 = new Date(now + DAY).toISOString().slice(0, 10);
    expect((await claimBrief(later, day2)).posted).toBe(true);
    // And never back to a day before the last one claimed.
    expect((await claimBrief(later, day1)).posted).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it("doesn't post when it's off", async () => {
    const { deps, sent, store, today } = setup();
    store.updateSettings({ morningBrief: false });
    expect(await claimBrief(deps, today)).toEqual({ posted: false });
    expect(sent).toHaveLength(0);
    store.updateSettings({ morningBrief: true });
    expect((await claimBrief(deps, today)).posted).toBe(true);
  });

  it("doesn't post on the user's first day, or before setup is finished", async () => {
    const first = setup({ createdDaysAgo: 0 });
    expect(await claimBrief(first.deps, first.today)).toEqual({ posted: false });
    const setupLeft = setup();
    setupLeft.store.updateSettings({ computerSetup: "pending" });
    expect(await claimBrief(setupLeft.deps, setupLeft.today)).toEqual({ posted: false });
    expect([...first.sent, ...setupLeft.sent]).toHaveLength(0);
  });

  it("refuses a date that isn't real or is more than a day from the server's", async () => {
    const { deps, sent, now } = setup();
    for (const bad of ["2026-02-30", "28/10/2026", "", new Date(now + 3 * DAY).toISOString().slice(0, 10)])
      expect(await claimBrief(deps, bad)).toEqual({ posted: false });
    expect(await claimBrief(deps, 42)).toEqual({ posted: false });
    expect(sent).toHaveLength(0);
  });

  it("lets a later open try again when the request couldn't be sent", async () => {
    const { deps, today, store } = setup();
    const failing = {
      ...deps,
      send: async () => {
        throw new Error("Yo is locked");
      },
    };
    expect(await claimBrief(failing, today)).toEqual({ posted: false });
    expect((await claimBrief({ ...deps, store }, today)).posted).toBe(true);
  });
});

describe("brief.claim in core", () => {
  const TOKEN = "t".repeat(64);
  let dataDir: string;
  let mock: MockAgentd;
  let core: Awaited<ReturnType<typeof startCore>> | null = null;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-brief-test-"));
    mock = new MockAgentd(TOKEN);
  });
  afterEach(async () => {
    await core?.shutdown().catch(() => {});
    core = null;
    await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("sends the framed request with a quiet notice in the chat, not a bubble from the user", async () => {
    process.env.YO_AGENTD_TOKEN = TOKEN;
    core = await startCore(
      {
        ...loadConfig({}),
        dev: false,
        port: 20700 + Math.floor(Math.random() * 500),
        dataDir,
        agentdUrl: await mock.listen(),
        computerMode: "remote" as const,
        secrets: "file" as const,
        webDist: null,
      },
      { secrets: new MemorySecretStore() },
    );
    await core.agentd.waitReady(5000);
    const c = core;
    const t0 = Date.now();
    while (!c.store.listAccounts().some((a) => a.status === "authenticated") && Date.now() - t0 < 5000)
      await new Promise((r) => setTimeout(r, 20));
    c.store.updateSettings({ onboarded: true, computerSetup: "done", spacesOn: false });
    const yo = c.store.listAgents().find((a) => a.isPrimary)!;
    // Yo has been around for a while.
    c.store.db.prepare("UPDATE agents SET created_at = ? WHERE id = ?").run(Date.now() - 5 * DAY, yo.id);
    const d = new Date();
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    c.store.updateSettings({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    expect(await c.api["brief.claim"]({ localDate: local })).toEqual({ posted: true });
    expect(await c.api["brief.claim"]({ localDate: local })).toEqual({ posted: false });
    const start = Date.now();
    while (!mock.turnTexts.some((t) => t.includes("Nobody typed this")) && Date.now() - start < 5000)
      await new Promise((r) => setTimeout(r, 20));
    expect(mock.turnTexts.some((t) => t.includes(MORNING_BRIEF_FRAME))).toBe(true);
    const rows = c.store.listTimeline(yo.id, undefined, 50);
    expect(rows.some((e) => e.item.kind === "notice" && e.item.title === BRIEF_NOTICE)).toBe(true);
    expect(rows.some((e) => e.item.kind === "user_message" && e.item.text?.includes("Nobody typed"))).toBe(
      false,
    );
  });
});
