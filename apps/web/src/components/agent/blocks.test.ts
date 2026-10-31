import type { TimelineEntry } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import {
  briefOf,
  foldedReplies,
  pageArtifactId,
  replyChipsAt,
  TIME_BREAK_MS,
  timeBreaks,
  toBlocks,
  turnStart,
  workingRow,
} from "./blocks";

let seq = 0;
const entry = (
  createdAt: number,
  turnId: string | null,
  item: Partial<TimelineEntry["item"]> = {},
): TimelineEntry => ({
  id: `e${++seq}`,
  agentId: "agt_yo",
  turnId,
  seq,
  createdAt,
  item: { id: `i${seq}`, kind: "tool", status: "completed", ...item },
});
const user = (at: number, from?: { agentId: string; name: string }) =>
  entry(at, null, { kind: "user_message", text: "hi", ...(from ? { from } : {}) });
const reply = (at: number, turnId: string, status: "running" | "completed" = "completed") =>
  entry(at, turnId, { kind: "assistant_message", text: "ok", status });
const step = (at: number, turnId: string, status: "running" | "completed" = "completed") =>
  entry(at, turnId, { kind: "command", title: "ls", status });

describe("working row", () => {
  it("isn't needed while a step is running or a reply is streaming", () => {
    expect(workingRow(toBlocks([user(1000), step(2000, "t1", "running")]))).toBeNull();
    expect(workingRow(toBlocks([user(1000), reply(2000, "t1", "running")]))).toBeNull();
    expect(workingRow([])).toBeNull();
  });

  it("shows between steps, timed from the message that started the turn", () => {
    expect(workingRow(toBlocks([user(1000), step(2000, "t1"), reply(3000, "t1")]))).toEqual({ since: 1000 });
  });
});

describe("turn start", () => {
  it("is when a message not yet picked up was sent", () => {
    expect(turnStart(toBlocks([user(1000), reply(2000, "t1"), user(5000)]))).toBe(5000);
  });

  it("isn't reset by a steer or a teammate's note sent mid-turn", () => {
    const blocks = toBlocks([
      user(1000),
      step(2000, "t1", "running"),
      user(3000),
      user(4000, { agentId: "agt_pepe", name: "Pepe" }),
    ]);
    expect(turnStart(blocks)).toBe(1000);
  });

  it("starts at the turn's first entry when nothing set it off (a routine, a teammate's turn)", () => {
    expect(turnStart(toBlocks([reply(500, "t0"), step(7000, "t2"), reply(8000, "t2")]))).toBe(7000);
  });
});

describe("Pages (create_page)", () => {
  const page = (status: "running" | "completed" | "failed", output?: string) =>
    entry(1000, "t1", {
      kind: "tool",
      toolName: "mcp__yo__create_page",
      status,
      input: { title: "Q3" },
      output,
    });

  it("a finished create_page becomes a page card with its artifact id", () => {
    const done = page("completed", 'The page "Q3" is ready. [page:art_abc123]');
    expect(pageArtifactId(done)).toBe("art_abc123");
    expect(toBlocks([done])).toEqual([{ type: "page", key: done.id, entry: done, artifactId: "art_abc123" }]);
  });

  it("stays a step while it runs or if it failed", () => {
    expect(pageArtifactId(page("running"))).toBeNull();
    expect(pageArtifactId(page("failed", "That doesn't look like an HTML page."))).toBeNull();
    expect(toBlocks([page("running")])[0]!.type).toBe("group");
  });
});

describe("morning brief (post_brief)", () => {
  const brief = (status: "running" | "completed" | "failed") =>
    entry(1000, "t1", {
      kind: "tool",
      toolName: "mcp__yo__post_brief",
      status,
      input: {
        needs_you: [{ title: " Reply to Ana ", detail: "About Friday", start: "Reply to Ana about Friday" }],
        can_wait: [{ title: "3 newsletters" }],
        today: [{ time: "9:30 AM", title: "Standup" }],
        could_not_check: [{ source: "Mail", why: "not connected" }],
      },
    });

  it("a finished post_brief becomes a brief card, read from its input", () => {
    const done = brief("completed");
    const [b] = toBlocks([done]);
    expect(b).toMatchObject({ type: "brief", key: done.id });
    expect(b!.type === "brief" && b!.brief).toEqual({
      needsYou: [{ title: "Reply to Ana", detail: "About Friday", start: "Reply to Ana about Friday" }],
      canWait: [{ title: "3 newsletters" }],
      today: [{ time: "9:30 AM", title: "Standup" }],
      couldNotCheck: [{ source: "Mail", why: "not connected" }],
    });
  });

  it("stays a step while it runs or if core refused it", () => {
    expect(briefOf(brief("running"))).toBeNull();
    expect(briefOf(brief("failed"))).toBeNull();
    expect(toBlocks([brief("failed")])[0]!.type).toBe("group");
  });
});

describe("quick replies (suggest_replies)", () => {
  const chips = (
    turnId: string,
    replies: unknown = ["Book the 8 PM", "Show other times"],
    status = "completed",
  ) =>
    entry(1000, turnId, {
      kind: "tool",
      toolName: "mcp__yo__suggest_replies",
      status: status as "completed",
      input: { replies },
    });
  const said = (text: string) => entry(5000, null, { kind: "user_message", text });

  it("aren't a step; they show at the end of the latest turn", () => {
    const c = chips("t1");
    const rows = [user(500), step(900, "t1"), c, reply(2000, "t1")];
    expect(toBlocks(rows).map((b) => b.type)).toEqual(["user", "group", "assistant"]);
    expect(replyChipsAt(rows)).toEqual({
      entryId: c.id,
      replies: ["Book the 8 PM", "Show other times"],
      before: null,
      chosen: null,
    });
  });

  it("are gone once the user says something else, or a newer task starts", () => {
    expect(replyChipsAt([chips("t1"), reply(2000, "t1"), said("Actually, Friday")])).toBeNull();
    expect(replyChipsAt([chips("t1"), reply(2000, "t1"), reply(9000, "t9")])).toBeNull();
    // A teammate's note isn't the user answering.
    expect(replyChipsAt([chips("t1"), user(3000, { agentId: "agt_pepe", name: "Pepe" })])).not.toBeNull();
  });

  it("keep the tapped one chosen until the agent answers it", () => {
    const c = chips("t1");
    const tap = said("Book the 8 PM");
    const tapped = { entryId: c.id, text: "Book the 8 PM" };
    expect(replyChipsAt([c, reply(2000, "t1"), tap], tapped)).toMatchObject({
      before: tap.id,
      chosen: "Book the 8 PM",
    });
    expect(replyChipsAt([c, reply(2000, "t1"), tap, reply(6000, "t2")], tapped)).toBeNull();
  });

  it("only the newest set counts, and a refused or bad set draws nothing", () => {
    expect(replyChipsAt([chips("t1", ["Yes", "No"], "failed")])).toBeNull();
    expect(replyChipsAt([chips("t1", ["Only one"])])).toBeNull();
    const old = chips("t1");
    const fresh = chips("t2", ["Yes", "Not now"]);
    expect(replyChipsAt([old, said("Hmm"), fresh])?.entryId).toBe(fresh.id);
  });
});

describe("time breaks", () => {
  const day = new Date(2026, 9, 28, 9, 41).getTime();
  it("puts a time over the first message, then after a long pause", () => {
    const blocks = toBlocks([
      user(day),
      step(day + 1000, "t1"),
      reply(day + 5000, "t1"),
      user(day + 10 * 60_000),
      user(day + 10 * 60_000 + TIME_BREAK_MS),
    ]);
    expect([...timeBreaks(blocks)]).toEqual([0, 4]);
  });

  it("starts again on a new day, and skips blocks without a time", () => {
    const midnight = new Date(2026, 9, 28, 23, 50).getTime();
    expect([...timeBreaks(toBlocks([user(0), user(midnight), user(midnight + 20 * 60_000)]))]).toEqual([
      1, 2,
    ]);
  });

  it("measures the pause from the end of a long run of steps", () => {
    const blocks = toBlocks([
      user(day),
      step(day + 1000, "t1"),
      step(day + 40 * 60_000, "t1"),
      reply(day + 41 * 60_000, "t1"),
    ]);
    expect([...timeBreaks(blocks)]).toEqual([0]);
  });
});

describe("async team handoffs", () => {
  const handoff = (at: number, id: string) =>
    entry(at, "t1", {
      toolName: "mcp__yo__message_agent",
      input: { to: "Dew", message: "Is the trip booked?" },
      output: `Sent to Dew. Carry on with your own work: their reply comes to you as a new message when they finish. (exchange ${id})`,
    });
  const answer = (at: number, id: string | undefined, reply = true) =>
    entry(at, null, {
      kind: "user_message",
      text: "Booked.",
      from: { agentId: "agt_dew", name: "Dew", exchangeId: id, reply },
    });

  it("folds the teammate's later reply into its handoff row", () => {
    const ask = handoff(2000, "xch_a1");
    const back = answer(9000, "xch_a1");
    const blocks = toBlocks([user(1000), ask, reply(3000, "t1"), back, reply(10000, "t2")]);
    expect(blocks.map((b) => b.type)).toEqual(["user", "team", "assistant", "assistant"]);
    expect(blocks[1]).toMatchObject({ type: "team", reply: back });
    expect(foldedReplies([ask, back]).get("xch_a1")).toBe(back);
  });

  it("keeps a reply on its own when its handoff isn't in the chat, or it's a new request", () => {
    expect(toBlocks([answer(1000, "xch_old")]).map((b) => b.type)).toEqual(["user"]);
    const ask = handoff(2000, "xch_b2");
    // The teammate's own request in its chat carries the id but isn't a reply.
    expect(toBlocks([ask, answer(3000, "xch_b2", false)]).map((b) => b.type)).toEqual(["team", "user"]);
  });
});
