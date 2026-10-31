/**
 * Mock Tasks (tasks.*, suggest_task): Yo's ledger as the Tasks page shows it. The Work agent (Yo) starts with a
 * lived-in list: two ready for review, one needing input, one working, one of Yo's own to-dos, one done today, two
 * suggestions and one the user saved for later. Starting one posts what the user saw (a suggestion's title, or
 * the title and details they wrote) into the chat as their message (the chat.send path), like core.
 */
import { type LedgerTask, newId } from "@yo/contracts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Like core: at most this many suggestions wait at once, per agent. */
const MAX_OPEN_SUGGESTIONS = 3;
const RESOLVED_FOR_MS = 7 * DAY;

function seedTasks(ownerId: string, now: number): LedgerTask[] {
  const t = (
    title: string,
    status: LedgerTask["status"],
    ago: number,
    extra: Partial<LedgerTask> = {},
  ): LedgerTask => ({
    id: newId("tsk"),
    ownerId,
    title,
    status,
    helperId: null,
    note: null,
    createdAt: now - ago - HOUR,
    updatedAt: now - ago,
    origin: "asked",
    why: null,
    prompt: null,
    ...extra,
  });
  return [
    t("Compare the M4 MacBook Air deals", "review", 14 * MIN, {
      note: "Best price is $899 at B&H, with a free sleeve.",
    }),
    t("Draft a reply to the landlord about the lease", "review", 2 * HOUR, {
      note: "Draft is in the chat. It asks to renew for 12 months at the same rent.",
    }),
    t("Book the dentist for next week", "waiting", 40 * MIN, {
      note: "Tuesday 9:30 or Thursday 2:00?",
    }),
    t("Plan the Lisbon weekend", "in_progress", 3 * MIN, {
      note: "Checking flights for Oct 17–20.",
    }),
    t("Follow up on the bike repair quote", "open", 2 * HOUR, {
      note: "The shop said they'd call back today.",
    }),
    t("Renew the car registration", "done", 5 * HOUR, { note: "Paid $86. The receipt is in your files." }),
    t("Watch the price of the Sony WH-1000XM5", "suggested", 20 * MIN, {
      origin: "suggestion",
      why: "They're $50 off at two stores this week, and you looked at them twice.",
      prompt: "Watch the price of the Sony WH-1000XM5 and tell me if it drops under $300.",
    }),
    t("Send Sam the notes from Tuesday's call", "suggested", 90 * MIN, {
      origin: "suggestion",
      why: "You told Sam you'd send them by Friday.",
      prompt: "Draft a short email to Sam with the notes from Tuesday's call.",
    }),
    t("Find a gift for Mia's birthday", "open", 1 * DAY, {
      origin: "user",
      note: "Under $40. She likes ceramics.",
      prompt: "Find a gift for Mia's birthday\n\nUnder $40. She likes ceramics.",
    }),
  ];
}

/** What Yo suggests when the mock chat asks it to (a message with "suggest"). */
const CHAT_SUGGESTIONS = [
  {
    title: "Check the gym membership renewal",
    why: "It renews on the 1st at the old price unless you cancel.",
    prompt: "Check when my gym membership renews and what it'll cost.",
  },
  {
    title: "Draft a thank-you note to the Lees",
    why: "You stayed with them last weekend.",
    prompt: "Draft a short thank-you note to the Lees for last weekend.",
  },
  {
    title: "Find a quieter flight home on Sunday",
    why: "Your Sunday flight has a 50-minute layover.",
    prompt: "Look for a Sunday flight home with a longer layover or none.",
  },
];

const titleKey = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export class MockTasks {
  private tasks: LedgerTask[];
  private chatPick = 0;

  constructor(
    onboarded: boolean,
    workAgentId: string,
    private d: {
      /** task.updated */
      emit: (t: LedgerTask) => void;
      /** Post a message into an agent's chat as the user (the mock's chat.send). */
      send: (agentId: string, text: string) => void;
      /** The active space's main agent. */
      activeAgentId: () => string | undefined;
    },
  ) {
    this.tasks = onboarded ? seedTasks(workAgentId, Date.now()) : [];
  }

  list(agentId?: string): LedgerTask[] {
    const owner = agentId ?? this.d.activeAgentId();
    const since = Date.now() - RESOLVED_FOR_MS;
    return this.tasks
      .filter(
        (t) =>
          t.ownerId === owner &&
          !["cancelled", "interrupted", "hidden"].includes(t.status) &&
          (t.status !== "done" || t.updatedAt >= since),
      )
      .map((t) => ({ ...t }));
  }

  private get(id: string): LedgerTask {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) throw new Error("That task isn't on the list any more.");
    return t;
  }

  private set(t: LedgerTask, patch: Partial<LedgerTask>): LedgerTask {
    Object.assign(t, patch, { updatedAt: Date.now() });
    const copy = { ...t };
    this.d.emit(copy);
    return copy;
  }

  start(id: string): LedgerTask {
    const t = this.get(id);
    if (t.status === "open" && t.origin !== "user")
      throw new Error("That one is on Yo's own list. It isn't started from here.");
    if (t.status !== "suggested" && t.status !== "open") throw new Error("That task has already started.");
    // Like core: the user's message is what they saw; a suggestion's plan becomes its note.
    const text = t.origin === "user" ? t.prompt?.trim() || t.title : t.title;
    const plan = t.origin === "suggestion" && !t.note && t.prompt ? t.prompt : undefined;
    const started = this.set(t, { status: "in_progress", ...(plan ? { note: plan } : {}) });
    this.d.send(t.ownerId, text);
    return started;
  }

  create(p: { title: string; note?: string; start: boolean }): LedgerTask {
    const title = p.title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (!title) throw new Error("Give the task a title.");
    const owner = this.d.activeAgentId();
    if (!owner) throw new Error("There's no agent to give it to yet.");
    const note = p.note?.trim() || null;
    const now = Date.now();
    const t: LedgerTask = {
      id: newId("tsk"),
      ownerId: owner,
      title,
      status: "open",
      helperId: null,
      note,
      createdAt: now,
      updatedAt: now,
      origin: "user",
      why: null,
      prompt: note ? `${title}\n\n${note}` : null,
    };
    this.tasks.push(t);
    this.d.emit({ ...t });
    return p.start ? this.start(t.id) : { ...t };
  }

  update(id: string, status: "done" | "hidden" | "open"): LedgerTask {
    const t = this.get(id);
    if (t.status === status) return { ...t };
    // The moves core allows (tasks.ts taskMoveProblem).
    const ok =
      status === "hidden"
        ? t.status === "suggested"
        : status === "open"
          ? t.status === "done"
          : ["review", "waiting", "in_progress", "open"].includes(t.status);
    if (!ok) throw new Error("That task can't be moved there.");
    return this.set(t, { status });
  }

  /** suggest_task, as core runs it: refuses a duplicate or a fourth waiting suggestion. Returns the tool result. */
  suggest(ownerId: string, p: { title: string; why: string; prompt: string }): string {
    const mine = this.tasks.filter((t) => t.ownerId === ownerId);
    const same = mine.find(
      (t) =>
        !["done", "cancelled", "interrupted"].includes(t.status) && titleKey(t.title) === titleKey(p.title),
    );
    if (same) return `Not suggested: "${same.title}" is already on the list.`;
    const waiting = mine.filter((t) => t.status === "suggested");
    if (waiting.length >= MAX_OPEN_SUGGESTIONS)
      return `Not suggested: ${waiting.length} suggestions are already waiting for the user.`;
    const now = Date.now();
    const t: LedgerTask = {
      id: newId("tsk"),
      ownerId,
      title: p.title,
      status: "suggested",
      helperId: null,
      note: null,
      createdAt: now,
      updatedAt: now,
      origin: "suggestion",
      why: p.why,
      prompt: p.prompt,
    };
    this.tasks.push(t);
    this.d.emit({ ...t });
    return `Suggested "${t.title}" (${t.id}).`;
  }

  /** The next suggestion the mock chat makes (one it hasn't made yet). */
  nextChatSuggestion() {
    return CHAT_SUGGESTIONS[this.chatPick++ % CHAT_SUGGESTIONS.length]!;
  }

  /** The tasks a chat's agent owes (task_list in the mock, and tests). */
  all(): LedgerTask[] {
    return this.tasks.map((t) => ({ ...t }));
  }
}
