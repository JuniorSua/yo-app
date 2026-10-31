import type { Account, AgentView } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import {
  accountFor,
  applyAccountUpdate,
  chatFor,
  offeredAccounts,
  sortAgents,
  trackWorkingSince,
} from "./app";

describe("working clock", () => {
  const a = (activity: AgentView["activity"]) => ({ id: "agt_1", activity }) as AgentView;

  it("starts when an agent gets busy and keeps running through a question", () => {
    const started = trackWorkingSince({}, a("idle"), a("working"), 1000);
    expect(started).toEqual({ agt_1: 1000 });
    expect(trackWorkingSince(started, a("working"), a("waiting"), 5000)).toBe(started);
    expect(trackWorkingSince(started, a("waiting"), a("working"), 9000)).toBe(started);
  });

  it("stops when it's done, and doesn't guess for an agent already busy when the app loaded", () => {
    expect(trackWorkingSince({ agt_1: 1000 }, a("working"), a("done"), 9000)).toEqual({});
    expect(trackWorkingSince({}, a("working"), a("working"), 9000)).toEqual({});
    expect(trackWorkingSince({}, undefined, a("working"), 9000)).toEqual({ agt_1: 9000 });
  });
});

const acc = (over: Partial<Account>): Account => ({
  id: "acc_claude",
  provider: "claude",
  label: "Claude",
  email: null,
  plan: null,
  status: "authenticated",
  message: null,
  isDefault: false,
  models: [],
  rateLimit: null,
  createdAt: 0,
  ...over,
});

const agent = (accountId: string | null) => ({ id: "agt_1", accountId }) as AgentView;

const claude = acc({ id: "acc_claude", isDefault: true });
const codex = acc({ id: "acc_codex", provider: "codex", label: "ChatGPT" });
const grok = acc({ id: "acc_grok", provider: "grok", label: "Grok" });
/** An account of a provider this app doesn't offer (an older or newer core may send one). */
const other = acc({ id: "acc_other", provider: "gemini" as Account["provider"], label: "Other" });

describe("Grok accounts", () => {
  it("reach the UI next to Claude and ChatGPT, and pushes about them are applied", () => {
    expect(offeredAccounts([claude, grok, codex]).map((a) => a.id)).toEqual([
      "acc_claude",
      "acc_grok",
      "acc_codex",
    ]);
    expect(applyAccountUpdate([claude], grok).map((a) => a.id)).toEqual(["acc_claude", "acc_grok"]);
    expect(applyAccountUpdate([claude, grok], { ...grok, status: "error" })[1]?.status).toBe("error");
  });

  it("are used by an agent pinned to one", () => {
    expect(accountFor(agent("acc_grok"), offeredAccounts([claude, codex, grok]))?.id).toBe("acc_grok");
  });
});

describe("accounts of providers Yo doesn't offer", () => {
  it("never reach the UI", () => {
    expect(offeredAccounts([claude, other, codex]).map((a) => a.id)).toEqual(["acc_claude", "acc_codex"]);
  });

  it("are dropped, not added, when a push updates them", () => {
    expect(applyAccountUpdate([claude], other)).toEqual([claude]);
    expect(applyAccountUpdate([claude, other], { ...other, status: "error" })).toEqual([claude]);
    expect(applyAccountUpdate([claude], codex).map((a) => a.id)).toEqual(["acc_claude", "acc_codex"]);
  });

  it("leave an agent pinned to one on the default account", () => {
    const shown = offeredAccounts([claude, codex, other]);
    expect(accountFor(agent("acc_other"), shown)?.id).toBe("acc_claude");
  });

  it("show 'Choose model' (no account) when the old default was the hidden one", () => {
    const shown = offeredAccounts([
      { ...claude, isDefault: false },
      { ...other, isDefault: true },
    ]);
    expect(accountFor(agent("acc_other"), shown)).toBeUndefined();
    expect(accountFor(agent(null), shown)).toBeUndefined();
  });
});

describe("Yo's one-off helpers", () => {
  const view = (id: string, extra: Partial<AgentView> = {}) =>
    ({
      id,
      isPrimary: false,
      pinned: false,
      createdAt: 1,
      lastActiveAt: null,
      archivedAt: null,
      ...extra,
    }) as AgentView;
  const agents = {
    agt_yo: view("agt_yo", { isPrimary: true }),
    agt_pepe: view("agt_pepe", { kind: "agent", lastActiveAt: 5 }),
    agt_old: view("agt_old"),
    agt_h1: view("agt_h1", { kind: "helper", parentId: "agt_yo", lastActiveAt: 99 }),
  };

  it("never show in the roster (sidebar, palette, pages)", () => {
    expect(sortAgents(agents).map((a) => a.id)).toEqual(["agt_yo", "agt_pepe", "agt_old"]);
  });

  it("send their news to the chat that started them", () => {
    expect(chatFor(agents, "agt_h1")).toBe("agt_yo");
    expect(chatFor(agents, "agt_pepe")).toBe("agt_pepe");
    expect(chatFor(agents, "agt_gone")).toBe("agt_gone");
  });
});

describe("the main agents (Work & Personal)", () => {
  const view = (id: string, extra: Partial<AgentView> = {}) =>
    ({
      id,
      isPrimary: false,
      pinned: false,
      createdAt: 1,
      lastActiveAt: null,
      archivedAt: null,
      ...extra,
    }) as AgentView;

  it("lead the roster: the Work agent, then the Personal agent, then pinned and recent teammates", () => {
    const agents = {
      agt_pepe: view("agt_pepe", { pinned: true, lastActiveAt: 50 }),
      agt_home: view("agt_home", { space: "personal", pinned: true, lastActiveAt: 99 }),
      agt_old: view("agt_old", { lastActiveAt: 70 }),
      agt_yo: view("agt_yo", { isPrimary: true, space: "work", pinned: true }),
    };
    expect(sortAgents(agents).map((a) => a.id)).toEqual(["agt_yo", "agt_home", "agt_pepe", "agt_old"]);
  });

  it("an older core (no spaces): the primary still comes first", () => {
    const agents = {
      agt_old: view("agt_old", { lastActiveAt: 70 }),
      agt_yo: view("agt_yo", { isPrimary: true }),
    };
    expect(sortAgents(agents).map((a) => a.id)).toEqual(["agt_yo", "agt_old"]);
  });
});
