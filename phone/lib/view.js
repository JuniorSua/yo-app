// What the chat screen says about Yo (presence, the live "working" card, quick replies) and the composer and
// keyboard math. Plain ESM, no DOM, so it's unit tested in phone/test/view.test.js.

import { helpersLabel } from "./pics.js";

/** Yo counts as online if the core beat the relay this recently. */
export const ONLINE_MS = 5 * 60 * 1000;
/** A "working" status older than this is stale (the core sends one at least every 15 s while it works). */
export const WORKING_STALE_MS = 5 * 60 * 1000;

const tidy = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(…|\.\.\.)$/, "")
    .trim();

/** "just now", "4 min ago", "2 hr ago", else null (the caller shows a date). */
export function agoLabel(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  return null;
}

/** How long Yo has been at it: "" under a minute, then "3m", "1h 5m". */
export function elapsedLabel(since, now = Date.now()) {
  const mins = Math.floor((now - since) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return "";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * The live card shown while Yo works (null when it doesn't).
 * @param {{ working: null | { state: string, detail?: string, since?: number, at?: number, stopping?: boolean },
 *   helpers?: number, agent?: string, now?: number }} p
 */
export function workingView({ working, helpers = 0, agent = "Yo", now = Date.now() }) {
  if (!working || now - (working.at ?? now) > WORKING_STALE_MS) return null;
  const helperText = helpersLabel(helpers).replace("working", "helping");
  if (working.state === "queued")
    return {
      tone: "queued",
      title: "Up next",
      step: `${agent} will get to this after the current task`,
      elapsed: "",
      helpers: "",
      canStop: false,
    };
  if (working.stopping)
    return { tone: "stopping", title: "Stopping…", step: "", elapsed: "", helpers: "", canStop: false };
  const step = tidy(working.detail).slice(0, 120);
  return {
    tone: "working",
    title: `${agent} is working`,
    step: step && !/^thinking$/i.test(step) ? step : "Thinking it through",
    elapsed: elapsedLabel(working.since ?? now, now),
    helpers: helperText,
    canStop: true,
  };
}

/**
 * The header's presence line, its dot, and the banner under the header (if any).
 * @param {{ seen: undefined | null | number, netDown?: boolean, working?: any, helpers?: number, agent?: string,
 *   queuedToSend?: number, now?: number }} p
 */
export function presenceView({
  seen,
  netDown = false,
  working = null,
  helpers = 0,
  agent = "Yo",
  queuedToSend = 0,
  now = Date.now(),
}) {
  const online = typeof seen === "number" && now - seen < ONLINE_MS;
  const helperText = helpersLabel(helpers);
  let tone;
  let text;
  if (netDown) {
    tone = "reconnecting";
    text = "Reconnecting…";
  } else if (seen === undefined) {
    tone = "connecting";
    text = "Connecting…";
  } else if (working && online) {
    tone = "working";
    text =
      working.state === "queued"
        ? "Busy · you're next"
        : working.stopping
          ? "Stopping…"
          : tidy(working.detail) && !/^thinking$/i.test(tidy(working.detail))
            ? tidy(working.detail)
            : "Working on it";
  } else if (online) {
    tone = "online";
    text = helperText ? `Online · ${helperText}` : "Online";
  } else {
    tone = "offline";
    const ago = typeof seen === "number" ? agoLabel(seen, now) : null;
    text = typeof seen === "number" ? `Away · seen ${ago ?? "a while ago"}` : "Away";
  }
  let banner = null;
  if (netDown)
    banner = {
      tone: "net",
      text: queuedToSend
        ? "No connection. Your message will send by itself when you're back."
        : "No connection. Trying again…",
    };
  else if (seen !== undefined && !online)
    banner = {
      tone: "away",
      text: `${agent}'s computer is offline. It'll get your messages when it's back.`,
    };
  return { tone, text, online, banner };
}

const YES_NO =
  /^(want|wanna|should|shall|do you|would you|can i|could i|may i|is that|is this|are you|does that|did you|ok|okay|sound good|ready|good to go)\b/i;
const MAX_CHIP = 32;

/**
 * Quick-reply chips under Yo's last message. The ones Yo picked itself (v2.3 `replies`) when the reply has them;
 * else, when it asks something, the names of the options it listed ("1. **Via Carota** · …"), or "Yes, please" /
 * "No, thanks" for a yes-or-no question. Empty otherwise.
 * @param {Array<any>} messages
 */
export function quickReplies(messages) {
  const last = messages.at(-1);
  if (last?.k !== "yo" || last.peek) return [];
  if (Array.isArray(last.replies) && last.replies.length) return last.replies.slice(0, 3);
  const text = String(last.text ?? "").trim();
  if (!text.endsWith("?")) return [];
  const lastLine = text.split("\n").filter(Boolean).at(-1) ?? "";
  const question = lastLine.split(/(?<=[.!])\s+/).at(-1) ?? "";
  const options = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(?:\d+[.)]|[-*])\s+\*\*([^*]{1,60})\*\*/.exec(line);
    if (m) options.push(m[1].trim());
  }
  if (options.length >= 2 && options.length <= 5 && options.every((o) => o.length <= MAX_CHIP))
    return options.slice(0, 4);
  if (YES_NO.test(question)) return ["Yes, please", "No, thanks"];
  return [];
}

/** The phone's own date, "YYYY-MM-DD" (sent in `hello` so the core knows when the user's day starts). */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Where the app box goes so the composer sits right on the keyboard: the visual viewport's height and offset.
 * Before iOS reports the keyboard (it does so only after its animation), the last keyboard height seen is used,
 * so the composer moves with the keyboard instead of after it and iOS has no reason to scroll the page.
 * @param {{ innerHeight: number, vvHeight?: number, vvTop?: number, focused?: boolean, lastKb?: number }} p
 */
export function fitViewport({ innerHeight, vvHeight, vvTop = 0, focused = false, lastKb = 0 }) {
  const h = Math.round(vvHeight ?? innerHeight);
  const kb = Math.max(0, Math.round(innerHeight - h));
  if (kb > 120) return { height: h, top: Math.max(0, Math.round(vvTop)), kbOpen: true, kb };
  // Keyboard on its way: use the last height we saw (a phone's keyboard is about the same each time).
  if (focused && lastKb > 120 && lastKb < innerHeight * 0.7)
    return { height: Math.round(innerHeight - lastKb), top: 0, kbOpen: true, kb: lastKb, guess: true };
  return { height: h, top: Math.max(0, Math.round(vvTop)), kbOpen: false, kb: 0 };
}

/**
 * Whether this is a phone held sideways (show "Turn your phone upright"). It goes by the screen, never the window's
 * shape: an Android keyboard can make a portrait window wider than tall. Tablets (shorter side 500+) and mouse
 * devices are never "sideways".
 * @param {{ orientationType?: string, legacyOrientation?: number, screenW: number, screenH: number,
 *   innerW: number, innerH: number, coarse: boolean }} p
 */
export function isPhoneSideways({
  orientationType,
  legacyOrientation,
  screenW,
  screenH,
  innerW,
  innerH,
  coarse,
}) {
  if (!coarse || Math.min(screenW, screenH) >= 500) return false;
  if (typeof orientationType === "string" && orientationType) return orientationType.startsWith("landscape");
  if (typeof legacyOrientation === "number") return Math.abs(legacyOrientation) === 90;
  return innerW > innerH && innerH < 500;
}

/**
 * The composer's text box height: whole lines between 1 and `max`, from the content's scroll height (measured
 * with the box at height 0, so the box's own height never inflates it).
 */
export function composerHeight(scrollHeight, { lineHeight = 22, padY = 20, max = 5 } = {}) {
  const lines = Math.max(1, Math.min(max, Math.round((scrollHeight - padY) / lineHeight)));
  return { lines, height: lines * lineHeight + padY, scroll: scrollHeight - padY > max * lineHeight + 1 };
}
