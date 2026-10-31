import type { TimelineEntry } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { toBlocks } from "./blocks";
import { isTeamEntry, teamCall, teamReply } from "./team";

let seq = 0;
const entry = (item: Partial<TimelineEntry["item"]>): TimelineEntry => ({
  id: `e${++seq}`,
  agentId: "agt_yo",
  turnId: "t1",
  seq,
  createdAt: 0,
  item: { id: `i${seq}`, kind: "tool", status: "completed", ...item },
});
const ask = (output?: string, status: "running" | "completed" | "failed" = "completed") =>
  entry({
    toolName: "mcp__yo__message_agent",
    status,
    input: { to: "Pepe", message: "Is the trip booked?" },
    output,
  });

describe("team chat entries", () => {
  it("recognizes message_agent on every provider, and Claude's SendMessage", () => {
    expect(isTeamEntry(ask())).toBe(true);
    expect(isTeamEntry(entry({ toolName: "yo.message_agent" }))).toBe(true);
    expect(isTeamEntry(entry({ toolName: "SendMessage" }))).toBe(true);
    expect(isTeamEntry(entry({ toolName: "mcp__yo__remember" }))).toBe(false);
    expect(isTeamEntry(entry({ kind: "assistant_message", toolName: "message_agent" }))).toBe(false);
  });

  it("reads the call defensively", () => {
    expect(teamCall(ask())).toEqual({
      toId: null,
      toName: "Pepe",
      message: "Is the trip booked?",
      legacy: false,
      exchangeId: null,
    });
    expect(teamCall(entry({ toolName: "mcp__yo__message_agent", input: { to: 7, message: ["x"] } }))).toEqual(
      {
        toId: null,
        toName: "7",
        message: "",
        legacy: false,
        exchangeId: null,
      },
    );
    const legacy = entry({
      toolName: "SendMessage",
      input: { to: "agt-munk13hydqcci066v7-c2", message: "Welcome" },
    });
    expect(teamCall(legacy)).toMatchObject({
      toId: "agt_munk13hydqcci066v7",
      message: "Welcome",
      legacy: true,
    });
    expect(teamCall(entry({ toolName: "SendMessage", input: { to: "uds:/tmp/x.sock" } })).toId).toBeNull();
  });

  it("tells where the exchange is from core's result", () => {
    expect(teamReply(ask(undefined, "running"))).toEqual({ state: "waiting" });
    expect(teamReply(ask("Pepe replied:\n\nYes, **booked**.\n\nAll set."))).toEqual({
      state: "replied",
      text: "Yes, **booked**.\n\nAll set.",
    });
    expect(teamReply(ask("Delivered to Pepe. They aren't expected to answer you."))).toEqual({
      state: "delivered",
    });
    expect(teamReply(ask("Pepe hasn't replied yet (still working on it). Carry on…"))).toEqual({
      state: "later",
    });
    expect(teamReply(ask("Pepe was stopped before replying."))).toEqual({
      state: "stopped",
      text: undefined,
    });
    expect(teamReply(ask("Pepe was stopped before replying. What they said so far:\n\nHalf"))).toEqual({
      state: "stopped",
      text: "Half",
    });
    expect(teamReply(ask('Error: No teammate named "Zed".', "failed"))).toEqual({
      state: "failed",
      text: 'No teammate named "Zed".',
    });
    expect(teamReply(entry({ toolName: "SendMessage", output: '{"success":true}' }))).toEqual({
      state: "delivered",
    });
  });

  it("an async handoff is pending until the reply comes, and names its exchange", () => {
    const sent = ask(
      "Sent to Pepe. Pepe is busy with another task, so yours is next in line. Carry on with your own work: their reply comes to you as a new message when they finish. (exchange xch_mh2k9abc01)",
    );
    expect(teamReply(sent)).toEqual({ state: "later" });
    expect(teamCall(sent).exchangeId).toBe("xch_mh2k9abc01");
    // wait: true answers inline, with no exchange to match later.
    expect(teamCall(ask("Pepe replied:\n\nYes")).exchangeId).toBeNull();
  });

  it("is its own block, never folded into the steps", () => {
    const blocks = toBlocks([
      entry({ kind: "user_message", text: "ask Pepe" }),
      entry({ kind: "command", title: "Ran ls" }),
      ask("Pepe replied:\n\nYes"),
      entry({ kind: "browser", title: "Opened x" }),
    ]);
    expect(blocks.map((b) => b.type)).toEqual(["user", "group", "team", "group"]);
  });

  it("shows a marked-off reply without the markers core adds for the model", () => {
    const out =
      'Pepe replied:\n\n<teammate_reply from="Pepe">\nThe page title is "Example Domain".\n</teammate_reply>';
    expect(teamReply(ask(out))).toEqual({ state: "replied", text: 'The page title is "Example Domain".' });
  });
});
