// What the Tasks screen and the morning brief show, worked out away from the DOM so the order, the counts and the
// clipping can be tested (phone/test/tasks.test.js). The same rules as the desktop's apps/web/src/lib/tasks.ts and
// BriefCard.tsx. Plain ESM, no DOM.

/** Statuses a phone task can have (protocol v2.3 `tasks`). Anything else from the core is left out. */
export const TASK_STATUSES = ["review", "waiting", "in_progress", "open", "done", "suggested", "hidden"];
/** How many tasks a phone keeps (the core sends at most 40). */
export const MAX_TASKS = 40;
/** How long a checked-off task stays under Resolved (the desktop's window). */
export const RESOLVED_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Active's groups, top to bottom. "todo": what Yo put on its own list and hasn't started. */
export const ACTIVE_GROUPS = ["review", "waiting", "in_progress", "todo", "done"];
export const GROUP_LABEL = {
  review: "Ready for review",
  waiting: "Needs input",
  in_progress: "Working",
  todo: "To do",
  done: "Resolved",
};
const STATUS_WORD = {
  review: "Ready",
  waiting: "Needs input",
  in_progress: "Working",
  done: "Done",
  open: "Saved",
  suggested: "Suggested",
};

const clip = (v, max) => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/**
 * The core's `tasks.items`, checked and clipped: known statuses only, strings clipped (title 200, note/why 300),
 * at most 40. Bad rows are dropped, never shown half-read.
 * @param {unknown} items
 */
export function normalizeTasks(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const t of items) {
    if (!t || typeof t !== "object") continue;
    const id = typeof t.id === "string" ? t.id.slice(0, 100) : "";
    const title = clip(t.title, 200);
    if (!id || !title || seen.has(id) || !TASK_STATUSES.includes(t.status)) continue;
    seen.add(id);
    const note = clip(t.note, 300);
    const why = clip(t.why, 300);
    const origin = ["asked", "suggestion", "user"].includes(t.origin) ? t.origin : undefined;
    const updatedAt = Number(t.updatedAt);
    out.push({
      id,
      title,
      status: t.status,
      ...(note ? { note } : {}),
      ...(why ? { why } : {}),
      ...(origin ? { origin } : {}),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    });
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

/** A task the user added and saved for later (Up next, with Start), as against Yo's own open to-dos. */
export const savedByUser = (t) => t.status === "open" && t.origin === "user";

/** The coloured word on a row: Yo's own open tasks read "To do", the user's saved ones "Saved". */
export function statusWord(t) {
  return t.status === "open" && !savedByUser(t) ? GROUP_LABEL.todo : STATUS_WORD[t.status];
}

const newestFirst = (a, b) => b.updatedAt - a.updatedAt;

/** Whether a task shows on the Tasks screen at all (a done one only for a week). */
export function onScreen(t, now = Date.now()) {
  if (t.status === "hidden") return false;
  return t.status !== "done" || !t.updatedAt || now - t.updatedAt <= RESOLVED_FOR_MS;
}

/** Active's groups in order, each newest first. Empty groups are left out. */
export function activeGroups(tasks, now = Date.now()) {
  const inGroup = (t, id) => (id === "todo" ? t.status === "open" && !savedByUser(t) : t.status === id);
  return ACTIVE_GROUPS.flatMap((id) => {
    const list = tasks.filter((t) => inGroup(t, id) && onScreen(t, now)).sort(newestFirst);
    return list.length ? [{ id, label: GROUP_LABEL[id], tasks: list }] : [];
  });
}

/** Up next: Yo's suggestions, then the tasks the user saved for later, each newest first. */
export function upNext(tasks) {
  return {
    suggestions: tasks.filter((t) => t.status === "suggested").sort(newestFirst),
    saved: tasks.filter(savedByUser).sort(newestFirst),
  };
}

/** The Tasks tab's badge: what's ready for review or needs the user. */
export function tasksBadge(tasks) {
  return tasks.filter((t) => t.status === "review" || t.status === "waiting").length;
}

/**
 * A task as it looks right after the user acts on it, before the core's answer: checked off or hidden. The core's
 * next `tasks` list replaces it either way. Start isn't shown ahead: Yo may be too busy to take it, so the row
 * waits ("Starting…") until the core's list has it under way (startLanded).
 */
export function afterAction(t, action) {
  if (action === "done") return { ...t, status: "done", updatedAt: Date.now() };
  if (action === "hide") return { ...t, status: "hidden" };
  return t;
}

/** How long a Start waits for the core's list to show it under way before the phone says it didn't start. */
export const START_WAIT_MS = 20_000;

/** Whether the core's list shows a task the user started as under way (Working, or already past it). */
export function startLanded(tasks, id) {
  const t = Array.isArray(tasks) ? tasks.find((x) => x.id === id) : null;
  return !!t && ["in_progress", "review", "waiting", "done"].includes(t.status);
}

// ---------------------------------------------------------------- morning brief

/** Rows a brief section shows before "Show N more" (one over isn't worth a "Show 1 more"). */
export const BRIEF_FOLD_AT = 3;

const briefItems = (v, max = 12) =>
  (Array.isArray(v) ? v : [])
    .filter((x) => x && typeof x === "object" && typeof x.title === "string" && x.title.trim())
    .slice(0, max)
    .map((x) => {
      const detail = clip(x.detail, 300);
      const time = clip(x.time, 20);
      return { title: clip(x.title, 200), ...(detail ? { detail } : {}), ...(time ? { time } : {}) };
    });

/**
 * A reply's `brief` (the core's normalized MorningBrief), checked and clipped, or null when it isn't one.
 * Yo's own `start` notes are dropped: Start sends what the row shows.
 * @param {unknown} b
 */
export function normalizeBrief(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const couldNotCheck = (Array.isArray(b.couldNotCheck) ? b.couldNotCheck : [])
    .filter((x) => x && typeof x === "object" && typeof x.source === "string" && x.source.trim())
    .slice(0, 8)
    .map((x) => ({ source: clip(x.source, 60), why: clip(x.why, 200) }));
  const out = {
    needsYou: briefItems(b.needsYou),
    canWait: briefItems(b.canWait),
    today: briefItems(b.today, 16),
    couldNotCheck,
  };
  return out;
}

/** "Good morning." / "Good afternoon." / "Good evening.", for the hour the brief came. */
export function briefGreeting(hour) {
  if (hour >= 4 && hour < 12) return "Good morning.";
  if (hour >= 12 && hour < 17) return "Good afternoon.";
  return "Good evening.";
}

/** How many rows a section shows, and how many "Show N more" would reveal (0 when it isn't folded). */
export function briefFold(rows, open = false) {
  const folded = !open && rows > BRIEF_FOLD_AT + 1;
  return { shown: folded ? BRIEF_FOLD_AT : rows, more: folded ? rows - BRIEF_FOLD_AT : 0 };
}

/**
 * Whether a reply's text shows under its brief card. A brief-only turn's text (`briefText`) is just the card's
 * titles in words, for phones without the card: this one draws the card, so that text is left out.
 */
export const briefTextShows = (m) => !m.briefText && !!String(m.text ?? "").trim();

/** What Start sends for a "Needs you" row (exactly what the row shows, like the desktop). */
export const briefStartText = (item) => `Take care of: ${item.title}`;

/** A reply's `replies` (suggest_replies): 2–3 short strings, else null (then the phone guesses its own chips). */
export function normalizeReplies(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const r of v) {
    const s = clip(r, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out.length ? out : null;
}
