/**
 * The morning brief (post_brief) and quick replies (suggest_replies), read the same way by core (which checks
 * the call) and the web (which draws the card and the chips from the call's input).
 */
import { type BriefItem, MorningBrief } from "./domain";

/** Rows per section: a brief, not a second inbox. */
export const BRIEF_MAX_ROWS = 5;
/** Today's calendar can be fuller than the other sections. */
export const BRIEF_MAX_TODAY = 12;
/** One to three words: what fits on a chip beside another at phone width. */
export const MAX_REPLY_CHARS = 24;

/** The quiet line the chat shows where the daily brief's request sits (nobody typed it). */
export const BRIEF_NOTICE = "Morning brief";

/** What Yo sends its main agent for the daily brief. The chat shows BRIEF_NOTICE instead of this text. */
export const MORNING_BRIEF_FRAME = [
  "Nobody typed this: it's the daily brief. The user just opened Yo for the first time today, and Yo asked for it so it's waiting when they look.",
  "Gather what you can reach (mail, calendar, your task ledger, recent chat), then call post_brief once. The card already greets them and lists everything, so don't greet them or repeat it.",
  "After it, write at most one short sentence (the one thing that matters most today, or what you couldn't check), and do nothing else. Don't call suggest_replies: the card puts Start on each thing that needs them.",
].join(" ");

const text = (v: unknown, max: number): string | undefined => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s ? s.slice(0, max) : undefined;
};

/** Text that starts like a slash command ("/new"): never sent from a chip or a brief row. */
const isCommand = (s: string) => s.startsWith("/");

const rows = (v: unknown, max: number, withStart: boolean): BriefItem[] => {
  if (!Array.isArray(v)) return [];
  const out: BriefItem[] = [];
  for (const r of v) {
    if (out.length >= max) break;
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const title = text(o.title, 140);
    // A "/…" title would read as a command once it's sent: left out, like a row without a title.
    if (!title || isCommand(title)) continue;
    const detail = text(o.detail, 280);
    const time = text(o.time, 40);
    const startText = withStart ? text(o.start, 500) : undefined;
    const start = startText && !isCommand(startText) ? startText : undefined;
    out.push({
      title,
      ...(detail ? { detail } : {}),
      ...(time ? { time } : {}),
      ...(start ? { start } : {}),
    });
  }
  return out;
};

/**
 * post_brief's input as a MorningBrief: snake_case or camelCase keys, strings trimmed, rows without a title (or
 * with one starting with "/") dropped, lists capped (5 per section, 12 for today). Never throws: anything
 * unreadable is left out.
 */
export function briefFromInput(input: unknown): MorningBrief {
  const a = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const pick = (snake: string, camel: string) => a[snake] ?? a[camel];
  const notes = pick("could_not_check", "couldNotCheck");
  const couldNotCheck: MorningBrief["couldNotCheck"] = [];
  if (Array.isArray(notes))
    for (const n of notes) {
      if (couldNotCheck.length >= BRIEF_MAX_ROWS) break;
      const o = n && typeof n === "object" ? (n as Record<string, unknown>) : {};
      const source = text(o.source, 60);
      if (source) couldNotCheck.push({ source, why: text(o.why, 200) ?? "not connected" });
    }
  return MorningBrief.parse({
    needsYou: rows(pick("needs_you", "needsYou"), BRIEF_MAX_ROWS, true),
    canWait: rows(pick("can_wait", "canWait"), BRIEF_MAX_ROWS, false),
    today: rows(a.today, BRIEF_MAX_TODAY, false),
    couldNotCheck,
  });
}

/** Nothing to show at all. */
export function briefIsEmpty(b: MorningBrief): boolean {
  return !b.needsYou.length && !b.canWait.length && !b.today.length && !b.couldNotCheck.length;
}

/**
 * suggest_replies' replies if they're usable (2 or 3, distinct, each 1–24 characters once trimmed), else a
 * plain reason they aren't.
 */
export function readReplies(input: unknown): { replies: string[] } | { problem: string } {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>).replies : undefined;
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== "string"))
    return { problem: "replies must be a list of 2 or 3 short strings." };
  const replies = (raw as string[]).map((r) => r.replace(/\s+/g, " ").trim());
  if (replies.length < 2 || replies.length > 3) return { problem: "Give 2 or 3 replies." };
  if (replies.some((r) => !r)) return { problem: "A reply can't be empty." };
  const command = replies.find(isCommand);
  if (command) return { problem: `"${command}" starts with "/": replies can't be commands.` };
  const long = replies.find((r) => r.length > MAX_REPLY_CHARS);
  if (long) return { problem: `"${long}" is longer than ${MAX_REPLY_CHARS} characters.` };
  if (new Set(replies.map((r) => r.toLowerCase())).size !== replies.length)
    return { problem: "The replies must be different." };
  return { replies };
}

/** `YYYY-MM-DD` that names a real day (round trip: Date.UTC rolls Feb 30 into March). Midnight UTC, or null. */
export function utcMidnightOf(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = Date.UTC(y, mo - 1, d);
  const back = new Date(at);
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? at : null;
}

/** The device's calendar date as `YYYY-MM-DD` (the user's "today", not the server's). */
export function localDateOf(at: Date): string {
  const mm = String(at.getMonth() + 1).padStart(2, "0");
  const dd = String(at.getDate()).padStart(2, "0");
  return `${at.getFullYear()}-${mm}-${dd}`;
}
