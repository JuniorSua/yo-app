/**
 * The Tasks page on the core: the ledger as the user sees it (tasks.*), and the suggestions Yo offers
 * (suggest_task). Every change is pushed to the apps as task.updated by the store's listener (see main.ts).
 */
import type { ApiMethods, LedgerTask } from "@yo/contracts";
import type { Store } from "../db/store";
import type { Orchestrator } from "../orchestrator/Orchestrator";
import { activeSpaceAgent } from "../team/spaces";

/** How long a checked-off task stays under Resolved. */
export const RESOLVED_FOR_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many suggestions wait for the user at once, per agent. */
export const MAX_OPEN_SUGGESTIONS = 3;

/** Statuses that mean the task is gone for good: a new suggestion with its title is fine again. */
const CLOSED = new Set<LedgerTask["status"]>(["done", "cancelled", "interrupted"]);

/** Only these can be started: a suggestion, or a task the user saved for Up next (not Yo's own to-dos). */
const startable = (t: LedgerTask) => t.status === "suggested" || (t.status === "open" && t.origin === "user");

/**
 * What the user may do to a task from the Tasks page (tasks.update): hide a suggestion, reopen a finished task,
 * or check off one that's on the go. Anything else is refused in words the app shows.
 */
export function taskMoveProblem(from: LedgerTask["status"], to: "done" | "hidden" | "open"): string | null {
  if (from === to) return null;
  if (to === "hidden") return from === "suggested" ? null : "Only a suggestion can be hidden.";
  if (to === "open") return from === "done" ? null : "Only a finished task can be reopened.";
  if (from === "suggested") return "A suggestion can't be checked off. Start it or hide it.";
  return ["review", "waiting", "in_progress", "open"].includes(from)
    ? null
    : "That task can't be checked off.";
}

const titleKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * suggest_task: Yo offers to take something on. Refused (in words the agent reads) when the same title is
 * already on the list, was hidden by the user, or when enough suggestions are already waiting.
 */
export function suggestTask(
  store: Store,
  agentId: string,
  p: { title: string; why: string; prompt: string },
): string {
  const tasks = store.listTasks(agentId, { all: true });
  const key = titleKey(p.title);
  const same = tasks.find((t) => !CLOSED.has(t.status) && titleKey(t.title) === key);
  if (same)
    return same.status === "hidden"
      ? `Not suggested: the user hid "${same.title}" before. Don't offer it again.`
      : `Not suggested: "${same.title}" is already on the list (${same.status.replace("_", " ")}).`;
  const waiting = tasks.filter((t) => t.status === "suggested");
  if (waiting.length >= MAX_OPEN_SUGGESTIONS)
    return `Not suggested: ${waiting.length} suggestions are already waiting for the user (${waiting
      .map((t) => `"${t.title}"`)
      .join(", ")}). Wait until they start or hide one.`;
  const t = store.addTask({
    ownerId: agentId,
    title: p.title,
    status: "suggested",
    origin: "suggestion",
    why: p.why,
    prompt: p.prompt,
  });
  return `Suggested "${t.title}" (${t.id}). The user sees it under Up next and above the message box; if they tap Start, you get its title as their message, and your plan is kept as the task's note.`;
}

type TaskMethods = Pick<ApiMethods, "tasks.list" | "tasks.create" | "tasks.start" | "tasks.update">;
type Handlers = {
  [M in keyof TaskMethods]: (params: TaskMethods[M]["params"]) => Promise<TaskMethods[M]["result"]>;
};

/** What the Tasks API needs from the store (Yo Phone passes its own narrow view). */
export type TasksStore = Pick<
  Store,
  "getTask" | "updateTask" | "addTask" | "listTaskPage" | "getAgent" | "getSettings" | "listAgents"
>;

export function createTasksApi(d: {
  store: TasksStore;
  orchestrator: Pick<Orchestrator, "send">;
  now?: () => number;
}): Handlers {
  const { store } = d;
  const now = d.now ?? Date.now;

  const taskOf = (id: string) => {
    const t = store.getTask(String(id));
    if (!t) throw new Error("That task isn't on the list any more.");
    return t;
  };

  /**
   * Start: the owner gets, as the user's message (queued if it's busy), exactly what the user saw: the title of a
   * suggestion, or the title and details the user wrote. A suggestion's plan (Yo's own words) goes on the task as
   * its note, so Yo sees it in its ledger but never as the user's voice. The task is Working.
   */
  const start = async (t: LedgerTask): Promise<LedgerTask> => {
    if (!startable(t))
      throw new Error(
        t.status === "open"
          ? "That one is on Yo's own list. It isn't started from here."
          : "That task has already started.",
      );
    const text = t.origin === "user" ? t.prompt?.trim() || t.title : t.title;
    const plan =
      t.origin === "suggestion" && !t.note?.trim() && t.prompt?.trim() ? t.prompt.trim() : undefined;
    // Marked first, so a second tap (or another window) can't start it twice while the message is on its way.
    const started = store.updateTask(t.id, { status: "in_progress", ...(plan ? { note: plan } : {}) })!;
    try {
      await d.orchestrator.send(t.ownerId, text, [], "user");
    } catch (e) {
      store.updateTask(t.id, { status: t.status, ...(plan ? { note: t.note } : {}) });
      throw e;
    }
    return started;
  };

  return {
    "tasks.list": async ({ agentId }) => {
      const owner = agentId ? store.getAgent(agentId) : activeSpaceAgent(store, now());
      if (!owner) return [];
      return store.listTaskPage(owner.id, now() - RESOLVED_FOR_MS);
    },
    "tasks.create": async ({ title, note, start: startNow }) => {
      const clean = String(title ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      if (!clean) throw new Error("Give the task a title.");
      const details = note?.trim() ? note.trim().slice(0, 2000) : null;
      const owner = activeSpaceAgent(store, now());
      if (!owner) throw new Error("There's no agent to give it to yet.");
      const t = store.addTask({
        ownerId: owner.id,
        title: clean,
        note: details,
        status: "open",
        origin: "user",
        // What Start sends: the title, and the note when there is one (both the user's own words).
        prompt: details ? `${clean}\n\n${details}` : null,
      });
      if (!startNow) return t;
      try {
        return await start(t);
      } catch (e) {
        // "Start now" didn't reach Yo: the user sees the error, and no half-made task is left on the list.
        store.updateTask(t.id, { status: "cancelled" });
        throw e;
      }
    },
    "tasks.start": async ({ id }) => start(taskOf(id)),
    "tasks.update": async ({ id, status }) => {
      if (status !== "done" && status !== "hidden" && status !== "open")
        throw new Error("A task can only be checked off, hidden or reopened here.");
      const t = taskOf(id);
      const problem = taskMoveProblem(t.status, status);
      if (problem) throw new Error(problem);
      return t.status === status ? t : store.updateTask(t.id, { status })!;
    },
  };
}
