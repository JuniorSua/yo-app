import { exchangeIdIn, type TimelineEntry } from "@yo/contracts";
import { asText, outputText } from "./bugFields";

/**
 * Agent-to-agent messages ("team chat"). message_agent tool items come from the model (input) and core
 * (output), so they're read defensively like report_bug's. Claude's own SendMessage (used before Yo had
 * message_agent) is shown the same way, minus the reply, which Yo never saw.
 */

export function isTeamEntry(e: TimelineEntry) {
  if (e.item.kind !== "tool" || !e.item.toolName) return false;
  return /(^|__|[./:])message_agent$/.test(e.item.toolName) || e.item.toolName === "SendMessage";
}

export interface TeamCall {
  /** The teammate's agent id when it's known (legacy SendMessage names a session, not an agent). */
  toId: string | null;
  /** The name the agent wrote, or null when it can't be told. */
  toName: string | null;
  message: string;
  /** Claude's built-in SendMessage (no reply was recorded). */
  legacy: boolean;
  /**
   * The exchange an async handoff opened ("Sent to Dew … (exchange xch_…)"): the teammate's reply comes later as a
   * user_message with this `from.exchangeId` (and `from.reply`). Null for wait:true calls and older cores.
   */
  exchangeId: string | null;
}

export function teamCall(e: TimelineEntry): TeamCall {
  const input = (e.item.input && typeof e.item.input === "object" ? e.item.input : {}) as Record<
    string,
    unknown
  >;
  const message = asText(input.message) ?? "";
  if (e.item.toolName === "SendMessage") {
    // Sessions were named after the agent: "agt-munk13hydqcci066v7-c2" is agent agt_munk13hydqcci066v7.
    const to = asText(input.to) ?? "";
    const m = /^agt-([a-z0-9]+)/i.exec(to);
    return { toId: m ? `agt_${m[1]}` : null, toName: null, message, legacy: true, exchangeId: null };
  }
  return {
    toId: null,
    toName: asText(input.to, 80) ?? null,
    message,
    legacy: false,
    exchangeId: exchangeIdIn(outputText(e.item.output)),
  };
}

export type TeamReply =
  | { state: "waiting" }
  | { state: "replied"; text: string }
  | { state: "delivered" }
  | { state: "later" }
  | { state: "stopped"; text?: string }
  | { state: "failed"; text: string };

/** Core marks a teammate's words off for the asking model (<teammate_reply from="…">); people see just the words. */
export function stripReplyMarkers(text: string): string {
  return text
    .replace(/<teammate_reply\b[^>]*>\n?/g, "")
    .replace(/\n?<\/teammate_reply>/g, "")
    .trim();
}

/** Where the exchange is, from the tool's status and core's result text. */
export function teamReply(e: TimelineEntry): TeamReply {
  if (e.item.status === "running") return { state: "waiting" };
  const out = stripReplyMarkers(outputText(e.item.output));
  if (e.item.toolName === "SendMessage")
    return /"success"\s*:\s*false/.test(out) || e.item.status === "failed"
      ? { state: "failed", text: "Couldn't deliver it." }
      : { state: "delivered" };
  const replied = /^[^\n]{1,80}? replied:\n+([\s\S]*)$/.exec(out);
  if (replied) return { state: "replied", text: replied[1]!.trim() };
  if (/^Delivered to /.test(out)) return { state: "delivered" };
  // An async handoff ("Sent to Dew."): the reply comes later as a new message.
  if (/^Sent to |hasn't replied yet|^This task ended\./.test(out)) return { state: "later" };
  if (/was stopped before replying|^The user stopped this task/.test(out))
    return { state: "stopped", text: out.split("What they said so far:")[1]?.trim() || undefined };
  if (e.item.status === "failed" || /^Error:|couldn't finish/.test(out))
    return { state: "failed", text: out.replace(/^Error:\s*/, "") || "Something went wrong." };
  return out ? { state: "replied", text: out } : { state: "delivered" };
}
