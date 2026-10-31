/**
 * The Tasks page's lists, worked out away from the screen so the order and the counts can be tested: Active
 * (grouped by what each task needs from the user, then Yo's own to-dos) and Up next (Yo's suggestions, then the
 * tasks the user saved for later).
 */
import type { LedgerTask, LedgerTaskStatus } from "@yo/contracts";

/** How long a checked-off task stays under Resolved (core lists the same window). */
export const RESOLVED_FOR_MS = 7 * 24 * 60 * 60 * 1000;

/** Active's groups, top to bottom. "todo": what Yo put on its own list (task_add) and hasn't started. */
export const ACTIVE_GROUPS = ["review", "waiting", "in_progress", "todo", "done"] as const;
export type ActiveGroupId = (typeof ACTIVE_GROUPS)[number];

export const GROUP_LABEL: Record<ActiveGroupId, string> = {
  review: "Ready for review",
  waiting: "Needs input",
  in_progress: "Working",
  todo: "To do",
  done: "Resolved",
};

/** The coloured word on a row, before its note. */
export const STATUS_WORD: Partial<Record<LedgerTaskStatus, string>> = {
  review: "Ready",
  waiting: "Needs input",
  in_progress: "Working",
  done: "Done",
  open: "Saved",
  suggested: "Suggested",
};

/** A task the user added and saved for later (Up next, with Start), as against Yo's own open to-dos. */
export const savedByUser = (t: LedgerTask) => t.status === "open" && t.origin === "user";

/** The coloured word for a row: Yo's own open tasks read "To do", the user's saved ones "Saved". */
export function statusWord(t: LedgerTask): string | undefined {
  return t.status === "open" && !savedByUser(t) ? GROUP_LABEL.todo : STATUS_WORD[t.status];
}

export interface ActiveGroup {
  id: ActiveGroupId;
  label: string;
  tasks: LedgerTask[];
}

const newestFirst = (a: LedgerTask, b: LedgerTask) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;

/** Whether a task belongs on the Tasks page at all (a done one only for a week). */
export function onPage(t: LedgerTask, now = Date.now()): boolean {
  if (t.status === "cancelled" || t.status === "interrupted" || t.status === "hidden") return false;
  return t.status !== "done" || now - t.updatedAt <= RESOLVED_FOR_MS;
}

/** Active's groups in order, each newest first. Empty groups are left out. */
export function activeGroups(tasks: readonly LedgerTask[], now = Date.now()): ActiveGroup[] {
  const inGroup = (t: LedgerTask, id: ActiveGroupId) =>
    id === "todo" ? t.status === "open" && !savedByUser(t) : t.status === id;
  return ACTIVE_GROUPS.flatMap((id) => {
    const list = tasks.filter((t) => inGroup(t, id) && onPage(t, now)).sort(newestFirst);
    return list.length ? [{ id, label: GROUP_LABEL[id], tasks: list }] : [];
  });
}

/** Up next: Yo's suggestions, then the tasks the user saved for later, each newest first. */
export function upNext(tasks: readonly LedgerTask[]): { suggestions: LedgerTask[]; saved: LedgerTask[] } {
  return {
    suggestions: tasks.filter((t) => t.status === "suggested").sort(newestFirst),
    saved: tasks.filter(savedByUser).sort(newestFirst),
  };
}

/** The suggestion shown above an agent's message box: its newest. */
export function latestSuggestion(tasks: readonly LedgerTask[] | undefined, agentId: string) {
  return tasks?.filter((t) => t.status === "suggested" && t.ownerId === agentId).sort(newestFirst)[0];
}

/** A task.updated push applied to a loaded list: kept up to date, added, or dropped once it's off the page. */
export function applyTaskUpdate(list: readonly LedgerTask[], t: LedgerTask, now = Date.now()): LedgerTask[] {
  const rest = list.filter((x) => x.id !== t.id);
  if (!onPage(t, now)) return rest;
  const i = list.findIndex((x) => x.id === t.id);
  if (i < 0) return [...list, t];
  const next = [...list];
  next[i] = t;
  return next;
}

/** Which list the page shows, kept between visits. */
export type TasksView = "active" | "upnext";
export const TASKS_VIEW_KEY = "yo.tasksView";

export function rememberedView(): TasksView {
  try {
    return localStorage.getItem(TASKS_VIEW_KEY) === "upnext" ? "upnext" : "active";
  } catch {
    return "active";
  }
}

export function rememberView(view: TasksView) {
  try {
    localStorage.setItem(TASKS_VIEW_KEY, view);
  } catch {
    /* storage refused: it opens on Active next time */
  }
}
