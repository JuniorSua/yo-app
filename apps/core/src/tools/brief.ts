import {
  BRIEF_NOTICE,
  briefFromInput,
  briefIsEmpty,
  MORNING_BRIEF_FRAME,
  readReplies,
  utcMidnightOf,
} from "@yo/contracts";
import type { Store } from "../db/store";
import type { Orchestrator } from "../orchestrator/Orchestrator";
import { activeSpaceAgent } from "../team/spaces";

const DAY_MS = 24 * 60 * 60_000;
/** The last local date a brief was claimed for (`YYYY-MM-DD`), in the settings table's private keys. */
const CLAIM_KV = "morningBriefDate";

/** post_brief: check the brief; the card draws from the call's input (web: components/agent/BriefCard). */
export function postBrief(args: Record<string, unknown>): string {
  const brief = briefFromInput(args);
  if (briefIsEmpty(brief))
    throw new Error(
      "The brief is empty. Add what needs the user (needs_you), what can wait (can_wait), today's calendar (today), or what you couldn't check (could_not_check).",
    );
  const counts = [
    brief.needsYou.length && `${brief.needsYou.length} need${brief.needsYou.length === 1 ? "s" : ""} them`,
    brief.canWait.length && `${brief.canWait.length} can wait`,
    brief.today.length && `${brief.today.length} on today's calendar`,
  ].filter(Boolean);
  return `The brief card is on screen${counts.length ? ` (${counts.join(", ")})` : ""}. Don't repeat what it lists: write at most one short sentence after it, then stop.`;
}

/** suggest_replies: 2–3 distinct replies of at most 24 characters; the chips draw from the call's input. */
export function suggestReplies(args: Record<string, unknown>): string {
  const r = readReplies(args);
  if ("problem" in r)
    throw new Error(
      `Not shown: ${r.problem} suggest_replies takes 2 or 3 different replies, each at most 24 characters.`,
    );
  return "The buttons are on screen. Ask your question in one short sentence without listing the replies.";
}

/** The calendar date of `at` in a time zone, as `YYYY-MM-DD` (the server's own zone if it's unknown). */
function dateIn(at: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export interface BriefClaimDeps {
  store: Pick<Store, "getSettings" | "listAgents" | "getKv" | "setKv">;
  /** Sends the active space's main agent the framed request (shown as a quiet notice, queued like chat.send). */
  send: (agentId: string, text: string) => Promise<unknown>;
  now?: () => number;
}

/**
 * How the brief's request goes to the agent: as a routine the chat shows as BRIEF_NOTICE (queued behind a running
 * task). Yo Phone passes `noSteer` so it's a turn of its own, whose reply goes back to the phone.
 */
export function sendBriefRequest(
  orchestrator: Pick<Orchestrator, "send">,
  agentId: string,
  text: string,
  opts: { noSteer?: boolean } = {},
) {
  return orchestrator.send(agentId, text, [], "routine", BRIEF_NOTICE, "auto", {
    notice: BRIEF_NOTICE,
    ...opts,
  });
}

/**
 * brief.claim: the chat of the active space's main agent opened. Posts the daily brief when it's on, `localDate`
 * is a real date within a day of the server's, today's hasn't been claimed (by any tab or device), it isn't
 * the user's first day with Yo, and the agent exists. `posted` = this call started it.
 */
export async function claimBrief(d: BriefClaimDeps, localDate: unknown): Promise<{ posted: boolean }> {
  const no = { posted: false };
  const now = d.now?.() ?? Date.now();
  const s = d.store.getSettings();
  if (s.morningBrief === false || !s.onboarded || s.computerSetup === "pending") return no;
  if (typeof localDate !== "string") return no;
  const day = utcMidnightOf(localDate);
  // Every place on Earth is within a day of UTC's date: further out is a wrong clock, which would claim a
  // day that hasn't come yet and turn the real one away.
  if (day === null || Math.abs(day - Math.floor(now / DAY_MS) * DAY_MS) > DAY_MS) return no;
  const agent = activeSpaceAgent(d.store, now);
  if (!agent) return no;
  // The first day belongs to the welcome: no brief until the day after Yo was set up.
  const first = d.store.listAgents().find((a) => a.isPrimary) ?? agent;
  if (dateIn(first.createdAt, s.timezone) >= localDate) return no;
  const last = d.store.getKv<string>(CLAIM_KV);
  if (last && last >= localDate) return no;
  // Claimed before anything awaits, so a second tab or device asking at the same moment is turned away.
  d.store.setKv(CLAIM_KV, localDate);
  try {
    await d.send(agent.id, MORNING_BRIEF_FRAME);
  } catch {
    // Not sent (Yo is locked, say): today's brief is still there to claim.
    d.store.setKv(CLAIM_KV, last);
    return no;
  }
  return { posted: true };
}
