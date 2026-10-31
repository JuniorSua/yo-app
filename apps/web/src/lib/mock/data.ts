import { helperAvatar, softieAvatar, YO_AVATAR } from "@yo/avatar";
import type {
  Account,
  ActivityEvent,
  AgentView,
  ApprovalRule,
  Artifact,
  ComputerOverview,
  DeviceGrant,
  DeviceOperation,
  ExecutionStatus,
  Memory,
  ModelInfo,
  OsPermissionState,
  PairedDevice,
  RouteDecision,
  Routine,
  Settings,
  TimelineEntry,
} from "@yo/contracts";
import { DEFAULT_SETTINGS } from "@yo/contracts";
import { nextRun } from "../cron";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    description: "Most capable for long, complex tasks",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    description: "Fast and smart for everyday work",
    isDefault: true,
    efforts: ["low", "medium", "high"],
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    description: "Quickest, lightest on your limits",
    efforts: ["low", "medium"],
  },
];

export const CODEX_MODELS: ModelInfo[] = [
  {
    id: "gpt-5-codex",
    label: "GPT-5 Codex",
    description: "Tuned for agentic work",
    isDefault: true,
    efforts: ["minimal", "low", "medium", "high"],
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    description: "General reasoning",
    efforts: ["minimal", "low", "medium", "high"],
  },
  { id: "gpt-5-mini", label: "GPT-5 mini", description: "Fast and inexpensive", efforts: ["low", "medium"] },
];

/** What grok 1.0.46 lists in ACP initialize (`_meta.modelState`); a signed-in account may list more. */
export const GROK_MODELS: ModelInfo[] = [
  {
    id: "grok-4.6",
    label: "Grok 4.6",
    description: "SpaceXAI's latest frontier model",
    isDefault: true,
    efforts: ["low", "medium", "high", "xhigh"],
  },
  { id: "grok-4.5", label: "Grok 4.5", efforts: ["low", "medium", "high"] },
];

export interface MockFile {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: number;
}

export interface SeedState {
  settings: Settings;
  accounts: Account[];
  agents: AgentView[];
  timelines: Record<string, TimelineEntry[]>;
  memories: Memory[];
  routines: Routine[];
  activity: ActivityEvent[];
  artifacts: Artifact[];
  rules: ApprovalRule[];
  computer: ComputerOverview;
  /** Paired devices, grants and kill switches as core would report them. */
  execution: ExecutionStatus;
  operations: DeviceOperation[];
  routes: RouteDecision[];
  seq: number;
}

export function seed(onboarded: boolean): SeedState {
  const now = Date.now();
  let seq = 1;
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    userName: onboarded ? "Sam" : "",
    onboarded,
    theme: "dark",
    // A lived-in workspace has Mac access on (changes stay off); a fresh install starts with both off.
    macAccess: onboarded,
    macWrites: false,
    // A fresh install sets up the agent's computer in the first agent's chat.
    computerSetup: onboarded ? "done" : "pending",
    // Held in Work by hand, so screenshots and tests don't depend on the clock (`&space=` changes it).
    spaceManual: { space: "work", until: null },
  };

  const accounts: Account[] = [
    {
      id: "acc_claude",
      provider: "claude",
      label: "Claude",
      status: "authenticated",
      email: "sam@example.com",
      plan: "Max",
      message: null,
      isDefault: true,
      models: CLAUDE_MODELS,
      rateLimit: { status: "ok", utilization: 0.23 },
      createdAt: now - 30 * DAY,
    },
    {
      id: "acc_codex",
      provider: "codex",
      label: "ChatGPT",
      status: "unauthenticated",
      email: null,
      plan: null,
      message: "Sign in with your ChatGPT account",
      isDefault: false,
      models: CODEX_MODELS,
      rateLimit: null,
      createdAt: now - 30 * DAY,
    },
    {
      id: "acc_grok",
      provider: "grok",
      label: "Grok",
      status: "unauthenticated",
      email: null,
      plan: null,
      message: "Not signed in to Grok.",
      isDefault: false,
      models: GROK_MODELS,
      rateLimit: null,
      createdAt: now - 30 * DAY,
    },
  ];

  const base = {
    instructions: "",
    accountId: "acc_claude",
    model: "claude-sonnet-4-5",
    effort: "medium",
    runtimeMode: "full-access" as const,
    pinned: false,
    archivedAt: null,
    todos: [],
    unread: 0,
    preview: null,
    lastActiveAt: null,
  };

  const yo: AgentView = {
    ...base,
    id: "agt_yo",
    name: "Yo",
    role: "Your personal agent",
    instructions: "You are Yo, the user's personal AI agent.",
    avatar: YO_AVATAR,
    isPrimary: true,
    pinned: true,
    space: "work",
    createdAt: now - 30 * DAY,
    activity: "idle",
    computer: { state: onboarded ? "ready" : "off", lease: "agent" },
    preview: onboarded ? "Here's your brief on the M4 MacBook Air deals." : null,
    lastActiveAt: onboarded ? now - 14 * MIN : null,
  };

  const agents: AgentView[] = [yo];
  const timelines: Record<string, TimelineEntry[]> = { agt_yo: [] };

  const entry = (
    agentId: string,
    t: number,
    item: TimelineEntry["item"],
    extra: Partial<TimelineEntry> = {},
  ): TimelineEntry => ({
    id: `ent_${seq}`,
    agentId,
    turnId: extra.turnId ?? null,
    seq: seq++,
    createdAt: t,
    item,
    ...extra,
  });

  if (!onboarded) {
    return {
      settings,
      accounts,
      agents,
      timelines,
      memories: [],
      routines: [],
      activity: [],
      artifacts: [],
      rules: [],
      computer: {
        runtime: "stopped",
        host: { kind: "local", label: "This Mac", url: "http://127.0.0.1:7801", placement: "this-mac" },
        connected: false,
        message: "Colima is installed. Yo's computer hasn't been set up yet.",
        memMB: null,
        memLimitMB: 5120,
        imageReady: false,
      },
      ...seedExecution(settings, false, now),
      seq,
    };
  }

  // Two teammates in Work, each on its own subscription: Dew finished a brief, Pico waits for an OK.
  agents.push(
    {
      ...base,
      id: "agt_research",
      name: "Dew",
      role: "Research",
      instructions: "Research what I ask and bring back a short answer with sources.",
      avatar: softieAvatar("dew"),
      isPrimary: false,
      createdAt: now - 12 * DAY,
      activity: "done",
      unread: 1,
      computer: { state: "ready", lease: "agent" },
      preview: "Brief ready: 5 best standing desks under $600",
      lastActiveAt: now - 3 * MIN,
      todos: [
        { text: "Collect candidate desks", status: "completed" },
        { text: "Read long-term reviews", status: "completed" },
        { text: "Write the brief", status: "completed" },
      ],
    },
    {
      ...base,
      id: "agt_pico",
      name: "Pico",
      role: "Builder",
      instructions: "Build and fix small apps, sites and scripts, and test them before you report back.",
      avatar: softieAvatar("pico"),
      accountId: "acc_codex",
      model: "gpt-5-codex",
      isPrimary: false,
      createdAt: now - 9 * DAY,
      activity: "waiting",
      unread: 1,
      computer: { state: "ready", lease: "agent" },
      preview: "Needs your OK to publish the RSVP page",
      lastActiveAt: now - 1 * MIN,
    },
  );

  // Pip, the Personal-time agent core creates next to Yo.
  agents.push({
    ...base,
    id: "agt_home",
    name: "Pip",
    role: "your personal-time agent",
    avatar: softieAvatar("mochi"),
    isPrimary: false,
    pinned: true,
    space: "personal",
    createdAt: now - 30 * DAY,
    activity: "idle",
    computer: { state: "hibernated", lease: "agent" },
    preview: "Want me to keep a running list of Yo ideas?",
    lastActiveAt: now - 15 * HOUR,
  });

  // --- Yo: a finished research turn ---
  const t0 = now - 16 * MIN;
  const turn = "turn_seed_1";
  timelines.agt_yo = [
    entry("agt_yo", t0, {
      id: "it_u1",
      kind: "user_message",
      status: "completed",
      text: 'Find me the best deal on a 15" M4 MacBook Air with 24GB RAM. Check Apple refurb too.',
    }),
    entry(
      "agt_yo",
      t0 + 2000,
      {
        id: "it_todo1",
        kind: "todo",
        status: "completed",
        title: "Plan",
        todos: [
          { text: "Check Apple, Amazon, Best Buy and B&H", status: "completed" },
          { text: "Check Apple Certified Refurbished", status: "completed" },
          { text: "Compare total price incl. tax & shipping", status: "completed" },
        ],
      },
      { turnId: turn },
    ),
    entry(
      "agt_yo",
      t0 + 4000,
      {
        id: "it_w1",
        kind: "web",
        status: "completed",
        title: "Searched “MacBook Air 15 M4 24GB price”",
        input: { query: "MacBook Air 15 M4 24GB price" },
      },
      { turnId: turn },
    ),
    entry(
      "agt_yo",
      t0 + 9000,
      {
        id: "it_b1",
        kind: "browser",
        status: "completed",
        title: "Opened apple.com",
        input: { url: "https://www.apple.com/shop/buy-mac/macbook-air" },
      },
      { turnId: turn },
    ),
    entry(
      "agt_yo",
      t0 + 18000,
      {
        id: "it_b2",
        kind: "browser",
        status: "completed",
        title: "Opened amazon.com",
        input: { url: "https://www.amazon.com/s?k=macbook+air+m4+15" },
      },
      { turnId: turn },
    ),
    entry(
      "agt_yo",
      t0 + 27000,
      {
        id: "it_b3",
        kind: "browser",
        status: "completed",
        title: "Opened bhphotovideo.com",
        input: { url: "https://www.bhphotovideo.com" },
      },
      { turnId: turn },
    ),
    entry(
      "agt_yo",
      t0 + 36000,
      {
        id: "it_c1",
        kind: "command",
        status: "completed",
        title: "Ran `python3 compare.py prices.csv`",
        input: { command: "python3 compare.py prices.csv" },
        output:
          "store,price,shipping,total\napple-refurb,1269,0,1269\namazon,1349,0,1349\nbhphoto,1399,0,1399\n",
      },
      { turnId: turn },
    ),
    entry(
      "agt_yo",
      t0 + 41000,
      {
        id: "it_a1",
        kind: "assistant_message",
        status: "completed",
        text:
          "The best deal right now is **Apple Certified Refurbished** — same warranty as new, and $80 cheaper than Amazon.\n\n" +
          '| Store | Config | Total |\n|---|---|---|\n| Apple Refurbished | 15" · M4 · 24GB · 512GB | **$1,269** |\n' +
          '| Amazon | 15" · M4 · 24GB · 512GB | $1,349 |\n| B&H Photo | 15" · M4 · 24GB · 512GB | $1,399 |\n\n' +
          "Want me to watch the price and ping you if it drops below $1,200?",
      },
      { turnId: turn, source: { provider: "claude", model: "claude-sonnet-4-5" } },
    ),
  ];

  // --- Pico asks Dew (message_agent): both sides of one team chat ---
  const k0 = now - 3 * HOUR;
  const askDew =
    "Hi! Which of the venues you found can seat 12 on Saturday night? I'm putting the address on the RSVP page.";
  const dewReply =
    "Two can seat 12 on Saturday:\n\n- **Casa Lupe:** private room at 8 PM, $35 a head\n- **Barra Verde:** long patio table at 7:30 PM, no minimum\n\n**Still open:** Casa Lupe holds the room until Thursday.";
  timelines.agt_pico = [
    entry("agt_pico", k0, {
      id: "c_u2",
      kind: "user_message",
      status: "completed",
      text: "Ask Dew which venue fits 12 people on Saturday, then start the RSVP page.",
    }),
    entry(
      "agt_pico",
      k0 + 3000,
      {
        id: "c_m1",
        kind: "tool",
        status: "completed",
        toolName: "mcp__yo__message_agent",
        title: "Messaged Dew",
        input: { to: "Dew", message: askDew },
        output: `Dew replied:\n\n${dewReply}`,
      },
      { turnId: "turn_c2" },
    ),
    entry(
      "agt_pico",
      k0 + 21000,
      {
        id: "c_a2",
        kind: "assistant_message",
        status: "completed",
        text: "Dew checked: **Casa Lupe** has a private room for 12 at 8 PM, held until Thursday. I'm putting it on the RSVP page.",
      },
      { turnId: "turn_c2", source: { provider: "codex", model: "gpt-5-codex" } },
    ),
  ];
  timelines.agt_research = [
    entry("agt_research", k0 + 3500, {
      id: "t_u2",
      kind: "user_message",
      status: "completed",
      text: askDew,
      from: { agentId: "agt_pico", name: "Pico" },
    }),
    entry(
      "agt_research",
      k0 + 6000,
      {
        id: "t_r2",
        kind: "tool",
        status: "completed",
        title: "Read venues.md",
        toolName: "Read",
      },
      { turnId: "turn_t2" },
    ),
    entry(
      "agt_research",
      k0 + 19000,
      { id: "t_a2", kind: "assistant_message", status: "completed", text: dewReply },
      { turnId: "turn_t2", source: { provider: "claude", model: "claude-sonnet-4-5" } },
    ),
  ];

  // --- Dew: a done brief ---
  const r0 = now - 9 * MIN;
  timelines.agt_research.push(
    entry("agt_research", r0, {
      id: "r_u1",
      kind: "user_message",
      status: "completed",
      text: "Research the best standing desks under $600. I care about stability at max height.",
    }),
    entry(
      "agt_research",
      r0 + 3000,
      { id: "r_w1", kind: "web", status: "completed", title: "Searched “standing desk wobble test 2026”" },
      { turnId: "turn_r1" },
    ),
    entry(
      "agt_research",
      r0 + 12000,
      {
        id: "r_b1",
        kind: "browser",
        status: "completed",
        title: "Opened rtings.com",
        input: { url: "https://www.rtings.com/office/reviews/best/standing-desks" },
      },
      { turnId: "turn_r1" },
    ),
    entry(
      "agt_research",
      r0 + 40000,
      {
        id: "r_f1",
        kind: "file_change",
        status: "completed",
        title: "Created ~/Documents/standing-desks.md",
        input: { path: "/home/agent/Documents/standing-desks.md" },
      },
      { turnId: "turn_r1" },
    ),
    entry(
      "agt_research",
      r0 + 42000,
      {
        id: "r_t1",
        kind: "tool",
        status: "completed",
        toolName: "save_artifact",
        title: "Saved Standing desks brief",
        input: {
          path: "/home/agent/Documents/standing-desks.md",
          title: "Standing desks brief",
          artifactId: "art_1",
        },
      },
      { turnId: "turn_r1" },
    ),
    entry(
      "agt_research",
      r0 + 45000,
      {
        id: "r_a1",
        kind: "assistant_message",
        status: "completed",
        text:
          "Here's the short version — the **Uplift V2** is the stability winner, but the **Flexispot E7** is the best value.\n\n" +
          '1. **Uplift V2 Commercial** — $599, least wobble at 48"\n2. **Flexispot E7** — $429, great motor, slight sway\n' +
          "3. **Vari Electric** — $595, easiest assembly\n\nFull brief with sources is in your Artifacts.",
      },
      { turnId: "turn_r1", source: { provider: "claude", model: "claude-sonnet-4-5" } },
    ),
  );

  // --- Pico: built the RSVP page and waits for the OK to publish it ---
  const s0 = now - 4 * MIN;
  timelines.agt_pico.push(
    entry("agt_pico", s0, {
      id: "s_u1",
      kind: "user_message",
      status: "completed",
      text: "Looks good. Build the RSVP page and put it online.",
    }),
    entry(
      "agt_pico",
      s0 + 3000,
      {
        id: "s_f1",
        kind: "file_change",
        status: "completed",
        title: "Created ~/rsvp/index.html",
        input: { path: "/home/agent/rsvp/index.html" },
      },
      { turnId: "turn_s1" },
    ),
    entry(
      "agt_pico",
      s0 + 8000,
      {
        id: "s_b1",
        kind: "browser",
        status: "completed",
        title: "Opened localhost:5173",
        input: { url: "http://localhost:5173" },
      },
      { turnId: "turn_s1" },
    ),
    entry(
      "agt_pico",
      s0 + 10000,
      {
        id: "s_a1",
        kind: "assistant_message",
        status: "completed",
        text: "The RSVP page works: guests pick a dish, and every answer lands in a sheet. I just need your OK to publish it at **rsvp-saturday.pages.dev**.",
      },
      { turnId: "turn_s1", source: { provider: "codex", model: "gpt-5-codex" } },
    ),
    entry(
      "agt_pico",
      s0 + 11000,
      { id: "s_req1", kind: "tool", status: "running", toolName: "request_approval", title: "Approval" },
      {
        turnId: "turn_s1",
        request: {
          requestId: "req_seed_1",
          kind: "tool_approval",
          toolName: "request_approval",
          title: "Publish the RSVP page",
          detail: "Cloudflare Pages · free · rsvp-saturday.pages.dev",
          input: { category: "publish", url: "https://rsvp-saturday.pages.dev" },
          status: "pending",
        },
      },
    ),
  );

  // --- Pip: a quiet evening chat about the weekend and the Yo app ---
  const p0 = now - 15 * HOUR - 10 * MIN;
  timelines.agt_home = [
    entry("agt_home", p0, {
      id: "p_u1",
      kind: "user_message",
      status: "completed",
      text: "Anything fun this weekend? Something low-key near home.",
    }),
    entry(
      "agt_home",
      p0 + 9000,
      {
        id: "p_a1",
        kind: "assistant_message",
        status: "completed",
        text: "Saturday's sunny and 79°F: a slow morning at the **Coconut Grove farmers market**, then the bay walk at sunset. Sunday looks rainy, so I saved two movies you'd both like.",
      },
      { source: { provider: "claude", model: "claude-sonnet-4-5" } },
    ),
    entry("agt_home", p0 + 8 * MIN, {
      id: "p_u2",
      kind: "user_message",
      status: "completed",
      text: "Perfect. Also an idea for Yo: let me snooze a routine for a day.",
    }),
    entry(
      "agt_home",
      p0 + 8 * MIN + 7000,
      {
        id: "p_a2",
        kind: "assistant_message",
        status: "completed",
        text: "Love it, noted: **Snooze a routine for a day** is on your Yo ideas list. Want me to keep a running list of Yo ideas?",
      },
      { source: { provider: "claude", model: "claude-sonnet-4-5" } },
    ),
  ];

  seedHelpers(now, agents, timelines, base, entry);

  const memories: Memory[] = [
    {
      id: "mem_1",
      agentId: null,
      content: "Prefers window seats and nonstop flights.",
      space: null,
      createdAt: now - 20 * DAY,
      updatedAt: now - 20 * DAY,
    },
    {
      id: "mem_2",
      agentId: null,
      content: "Lives in Miami, FL (Eastern time).",
      space: null,
      createdAt: now - 28 * DAY,
      updatedAt: now - 28 * DAY,
    },
    {
      id: "mem_3",
      agentId: null,
      content: "Budget-conscious: always check refurbished options first.",
      space: "personal",
      createdAt: now - 10 * DAY,
      updatedAt: now - 10 * DAY,
    },
    {
      id: "mem_4",
      agentId: "agt_pico",
      content: "Pays for domains and hosting with the Visa ending 4242.",
      space: null,
      createdAt: now - 8 * DAY,
      updatedAt: now - 8 * DAY,
    },
    {
      id: "mem_5",
      agentId: "agt_yo",
      content: "Weekly review happens Friday at 4 PM.",
      space: "work",
      createdAt: now - 15 * DAY,
      updatedAt: now - 15 * DAY,
    },
    {
      id: "mem_6",
      agentId: null,
      content: "Works on AI side projects in the evenings; likes concise answers.",
      space: "personal",
      createdAt: now - 3 * DAY,
      updatedAt: now - 3 * DAY,
    },
  ];

  const mkRoutine = (r: Omit<Routine, "nextRunAt" | "timezone" | "createdAt" | "runAt">): Routine => ({
    ...r,
    runAt: null,
    timezone: settings.timezone,
    createdAt: now - 7 * DAY,
    nextRunAt: r.enabled && r.cron ? nextRun(r.cron) : null,
  });
  const routines: Routine[] = [
    mkRoutine({
      id: "rt_1",
      agentId: "agt_yo",
      name: "Morning brief",
      prompt: "Summarize my day: calendar, deadlines and anything that needs a reply.",
      cron: "0 8 * * 1-5",
      enabled: true,
      lastRunAt: now - 5 * HOUR,
    }),
    mkRoutine({
      id: "rt_2",
      agentId: "agt_yo",
      name: "MacBook price watch",
      prompt: 'Check the price of the 15" M4 MacBook Air 24GB and tell me if it drops below $1,200.',
      cron: "0 */6 * * *",
      enabled: true,
      lastRunAt: now - 2 * HOUR,
    }),
    mkRoutine({
      id: "rt_3",
      agentId: "agt_research",
      name: "AI news digest",
      prompt: "Read the top AI news of the week and send me a 5-bullet digest with links.",
      cron: "0 17 * * 5",
      enabled: false,
      lastRunAt: now - 7 * DAY,
    }),
  ];

  const activity: ActivityEvent[] = [
    {
      id: "act_1",
      agentId: "agt_pico",
      ts: now - 3 * MIN,
      kind: "approval",
      summary: "Asked to publish the RSVP page",
      ref: "req_seed_1",
    },
    {
      id: "act_2",
      agentId: "agt_research",
      ts: now - 8 * MIN,
      kind: "run.completed",
      summary: "Finished “Standing desks under $600” · 14 steps · 2m 10s",
      ref: null,
    },
    {
      id: "act_3",
      agentId: "agt_yo",
      ts: now - 15 * MIN,
      kind: "run.completed",
      summary: "Found the best MacBook Air deal · 7 steps · 41s",
      ref: null,
    },
    {
      id: "act_4",
      agentId: "agt_yo",
      ts: now - 2 * HOUR,
      kind: "routine",
      summary: "Routine “MacBook price watch” ran · no change",
      ref: "rt_2",
    },
    {
      id: "act_4b",
      agentId: "agt_yo",
      ts: now - 3 * HOUR,
      kind: "device",
      summary: "Read ~/Documents/Taxes/2025-summary.csv on Studio MacBook",
      ref: "op_seed_3",
    },
    {
      id: "act_5",
      agentId: "agt_yo",
      ts: now - 5 * HOUR,
      kind: "routine",
      summary: "Routine “Morning brief” ran",
      ref: "rt_1",
    },
    {
      id: "act_6",
      agentId: "agt_yo",
      ts: now - 26 * HOUR,
      kind: "memory",
      summary: "Remembered: prefers window seats and nonstop flights",
      ref: "mem_1",
    },
    {
      id: "act_7",
      agentId: "agt_research",
      ts: now - 2 * DAY,
      kind: "run.completed",
      summary: "Compared 6 dinner venues for Saturday · 22 steps · 4m 02s",
      ref: null,
    },
    {
      id: "act_8",
      agentId: "agt_yo",
      ts: now - 2 * DAY - 3 * HOUR,
      kind: "takeover",
      summary: "You took control to sign in to United",
      ref: null,
    },
    {
      id: "act_9",
      agentId: null,
      ts: now - 3 * DAY,
      kind: "system",
      summary: "Yo's computer updated to image 0.1.0",
      ref: null,
    },
    {
      id: "act_10",
      agentId: "agt_yo",
      ts: now - 3 * DAY - HOUR,
      kind: "run.failed",
      summary: "Couldn't reach delta.com (timeout) · retried later",
      ref: null,
    },
  ];

  const artifacts: Artifact[] = [
    {
      id: "art_1",
      agentId: "agt_research",
      title: "Standing desks brief",
      path: "/home/agent/Documents/standing-desks.md",
      mime: "text/markdown",
      size: 8421,
      createdAt: now - 8 * MIN,
    },
    {
      id: "art_2",
      agentId: "agt_research",
      title: "Dinner venues shortlist",
      path: "/home/agent/Documents/venues.pdf",
      mime: "application/pdf",
      size: 412_331,
      createdAt: now - 2 * DAY,
    },
    {
      id: "art_3",
      agentId: "agt_yo",
      title: "MacBook price comparison",
      path: "/home/agent/Documents/macbook-prices.csv",
      mime: "text/csv",
      size: 1204,
      createdAt: now - 15 * MIN,
    },
    {
      id: "art_4",
      agentId: "agt_yo",
      title: "Q4 goals draft",
      path: "/home/agent/Documents/q4-goals.docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 23_880,
      createdAt: now - 4 * DAY,
    },
    {
      id: "art_5",
      agentId: "agt_yo",
      title: "Desk setup moodboard",
      path: "/home/agent/Pictures/desk-moodboard.png",
      mime: "image/png",
      size: 1_830_221,
      createdAt: now - 5 * DAY,
    },
    // Pages of each kind (create_page), for the Make gallery. Their HTML is mock/samplePage.ts.
    {
      id: "art_6",
      agentId: "agt_yo",
      title: "Monthly budget at a glance",
      path: "Monthly-budget-at-a-glance.html",
      mime: "text/html",
      size: 9_214,
      createdAt: now - 40 * MIN,
      kind: "page",
      pageKind: "dashboard",
    },
    {
      id: "art_7",
      agentId: "agt_yo",
      title: "Kyoto in five slides",
      path: "Kyoto-in-five-slides.html",
      mime: "text/html",
      size: 6_120,
      createdAt: now - 3 * HOUR,
      kind: "page",
      pageKind: "slides",
    },
    {
      id: "art_8",
      agentId: "agt_yo",
      title: "Moving checklist",
      path: "Moving-checklist.html",
      mime: "text/html",
      size: 4_388,
      createdAt: now - DAY,
      kind: "page",
      pageKind: "doc",
    },
    {
      id: "art_9",
      agentId: "agt_yo",
      title: "Spring menu home page",
      path: "Spring-menu-home-page.html",
      mime: "text/html",
      size: 7_902,
      createdAt: now - 2 * DAY - 3 * HOUR,
      kind: "page",
      pageKind: "design",
    },
    {
      id: "art_10",
      agentId: "agt_yo",
      title: "Farmers market weekend",
      path: "Farmers-market-weekend.html",
      mime: "text/html",
      size: 5_031,
      createdAt: now - 3 * DAY - 5 * HOUR,
      kind: "page",
      pageKind: "page",
    },
  ];

  const rules: ApprovalRule[] = [
    {
      id: "rule_1",
      agentId: null,
      match: "mcp__playwright__browser_navigate",
      decision: "allow",
      createdAt: now - 10 * DAY,
    },
    { id: "rule_2", agentId: "agt_pico", match: "message", decision: "deny", createdAt: now - 6 * DAY },
  ];

  return {
    settings,
    accounts,
    agents,
    timelines,
    memories,
    routines,
    activity,
    artifacts,
    rules,
    computer: {
      runtime: "running",
      host: { kind: "local", label: "This Mac", url: "http://127.0.0.1:7801", placement: "this-mac" },
      connected: true,
      message: null,
      memMB: 1840,
      memLimitMB: 5120,
      cacheMB: 2350,
      oomKills: 0,
      imageReady: true,
    },
    ...seedExecution(settings, true, now),
    seq,
  };
}

/** Ids of the seeded helpers (tests use them). */
export const MOCK_HELPERS = { gift: "agt_hlp_gift", table: "agt_hlp_table" } as const;

/**
 * Yo's one-off helpers: Yo sent two for a two-part request. The gift helper is done (retired, so archived and
 * gone from bootstrap); the table helper is still working on its own computer. Their cards (`hcard_<id>`) sit in
 * Yo's timeline, as core keeps them.
 */
function seedHelpers(
  now: number,
  agents: AgentView[],
  timelines: Record<string, TimelineEntry[]>,
  base: Omit<
    AgentView,
    "id" | "name" | "role" | "avatar" | "isPrimary" | "createdAt" | "activity" | "computer"
  >,
  entry: (
    agentId: string,
    t: number,
    item: TimelineEntry["item"],
    extra?: Partial<TimelineEntry>,
  ) => TimelineEntry,
) {
  const h0 = now - 6 * MIN;
  const gift = {
    id: MOCK_HELPERS.gift,
    title: "Find a birthday gift for Maria under $50",
    avatar: helperAvatar(MOCK_HELPERS.gift),
  };
  const table = {
    id: MOCK_HELPERS.table,
    title: "Book a table for 4 on Friday at 8 PM",
    avatar: helperAvatar(MOCK_HELPERS.table),
  };
  const helperBase = { ...base, kind: "helper" as const, parentId: "agt_yo", isPrimary: false };
  agents.push(
    {
      ...helperBase,
      id: gift.id,
      name: gift.title,
      role: "Yo's helper",
      instructions: "",
      avatar: gift.avatar,
      createdAt: h0 + 4000,
      archivedAt: h0 + 3 * MIN,
      activity: "done",
      computer: { state: "off", lease: "agent" },
      lastActiveAt: h0 + 3 * MIN,
    },
    {
      ...helperBase,
      id: table.id,
      name: table.title,
      role: "Yo's helper",
      instructions: "",
      avatar: table.avatar,
      createdAt: h0 + 5000,
      activity: "working",
      computer: { state: "ready", lease: "agent" },
      preview: "Checking times at Joe's Stone Crab",
      lastActiveAt: now - 20_000,
    },
  );
  timelines.agt_yo!.push(
    entry("agt_yo", h0, {
      id: "it_u_helpers",
      kind: "user_message",
      status: "completed",
      text: "Two things: find a birthday gift for Maria under $50, and book a table for 4 at Joe's Stone Crab on Friday at 8.",
    }),
    entry(
      "agt_yo",
      h0 + 3000,
      {
        id: "it_a_helpers",
        kind: "assistant_message",
        status: "completed",
        text: "On it. I sent two helpers so both happen at once. Their progress shows below, and I'll sum up when they're done.",
      },
      { turnId: "turn_helpers", source: { provider: "claude", model: "claude-sonnet-4-5" } },
    ),
    entry(
      "agt_yo",
      h0 + 4000,
      {
        id: `hcard_${gift.id}`,
        kind: "notice",
        status: "completed",
        title: gift.title,
        helper: {
          ...gift,
          state: "done",
          startedAt: h0 + 4000,
          endedAt: h0 + 3 * MIN,
          summary:
            "Found 3 good picks under $50 (Maria likes cooking and plants):\n\n" +
            "1. **Le Creuset mini cocotte**, $42 at Williams Sonoma, arrives Thursday\n" +
            "2. **Self-watering herb garden kit**, $38 at Amazon, arrives Wednesday\n" +
            "3. **Salt Fat Acid Heat** (signed copy), $35 at Books & Books\n\n" +
            "My pick is the cocotte. Nothing was bought.",
        },
      },
      { id: `hcard_${gift.id}`, turnId: "turn_helpers" },
    ),
    entry(
      "agt_yo",
      h0 + 5000,
      {
        id: `hcard_${table.id}`,
        kind: "notice",
        status: "running",
        title: table.title,
        helper: { ...table, state: "working", startedAt: h0 + 5000 },
      },
      { id: `hcard_${table.id}`, turnId: "turn_helpers" },
    ),
  );
  timelines[table.id] = [
    entry(table.id, h0 + 5000, {
      id: "hl_u1",
      kind: "user_message",
      status: "completed",
      text: "Book a table for 4 at Joe's Stone Crab (Miami Beach) on Friday at 8 PM, under Sam.",
    }),
    entry(
      table.id,
      h0 + 9000,
      {
        id: "hl_b1",
        kind: "browser",
        status: "completed",
        title: "Opened opentable.com",
        input: { url: "https://www.opentable.com/r/joes-stone-crab-miami-beach" },
      },
      { turnId: "turn_hl1" },
    ),
  ];
}

export function mockFiles(now = Date.now()): Record<string, MockFile[]> {
  const f = (dir: string, name: string, size: number, ago: number): MockFile => ({
    name,
    path: `${dir}/${name}`,
    type: "file",
    size,
    mtime: now - ago,
  });
  const d = (dir: string, name: string, ago: number): MockFile => ({
    name,
    path: `${dir}/${name}`,
    type: "dir",
    size: 0,
    mtime: now - ago,
  });
  const H = "/home/agent";
  return {
    [H]: [
      d(H, "Desktop", DAY),
      d(H, "Documents", 8 * MIN),
      d(H, "Downloads", 15 * MIN),
      d(H, "Pictures", 5 * DAY),
      f(H, "notes.md", 2210, HOUR),
    ],
    [`${H}/Desktop`]: [],
    [`${H}/Documents`]: [
      f(`${H}/Documents`, "standing-desks.md", 8421, 8 * MIN),
      f(`${H}/Documents`, "macbook-prices.csv", 1204, 15 * MIN),
      f(`${H}/Documents`, "lisbon-itinerary.pdf", 412_331, 2 * DAY),
      f(`${H}/Documents`, "q4-goals.docx", 23_880, 4 * DAY),
    ],
    [`${H}/Downloads`]: [
      f(`${H}/Downloads`, "receipt-112-4471.pdf", 88_120, 15 * MIN),
      f(`${H}/Downloads`, "prices.csv", 980, 16 * MIN),
    ],
    [`${H}/Pictures`]: [f(`${H}/Pictures`, "desk-moodboard.png", 1_830_221, 5 * DAY)],
  };
}

export const MOCK_DEVICE_ID = "dev_studiomacbook01";

export function mockDevice(now = Date.now()): PairedDevice {
  return {
    id: MOCK_DEVICE_ID,
    name: "Studio MacBook",
    platform: "macos",
    osVersion: "macOS 26.0",
    appVersion: "0.1.0",
    helperVersion: "0.3.0",
    pairedAt: now - 6 * DAY,
    lastSeenAt: now - 20_000,
    online: true,
    paused: false,
    revokedAt: null,
    capabilities: [
      "files.list",
      "files.read",
      "files.write",
      "contacts.read",
      "calendar.read",
      "calendar.write",
      "reminders.read",
      "reminders.write",
      "notes.read",
      "notes.write",
      "mail.read",
      "mail.draft",
      "window.observe",
      "window.control",
    ],
    permissions: mockMacPermissions(),
  };
}

/**
 * What macOS allows Yo on the mock Mac: Calendar and Reminders yes, Contacts never asked, and neither
 * Screen Recording nor Accessibility turned on yet. (Notes and Mail have no status: macOS asks on use.)
 */
export function mockMacPermissions(): Record<string, OsPermissionState> {
  return {
    calendars: "granted",
    contacts: "not-requested",
    reminders: "granted",
    accessibility: "not-requested",
    screenRecording: "not-requested",
  };
}

/**
 * Devices fixture: one paired Mac ("Studio MacBook", online) sharing ~/Documents/Taxes (read only) and
 * ~/Projects/Site (read and change), plus Calendar (read and change), Reminders (read only) and Notes (read
 * and change) — Contacts, Mail and window control aren't shared (window control is off) — and a few recent
 * operations, one of which lost its result.
 * A fresh install has nothing paired.
 */
export function seedExecution(
  settings: Settings,
  onboarded: boolean,
  now = Date.now(),
): { execution: ExecutionStatus; operations: DeviceOperation[]; routes: RouteDecision[] } {
  const flags = {
    devices: settings.macAccess,
    deviceWrites: settings.macWrites,
    control: settings.macControl,
  };
  if (!onboarded)
    return {
      execution: { corePlacement: "this-mac", runnerPlacement: "this-mac", flags, devices: [], grants: [] },
      operations: [],
      routes: [],
    };
  const grants: DeviceGrant[] = [
    {
      id: "grt_taxes2025docs",
      deviceId: MOCK_DEVICE_ID,
      kind: "dir",
      displayPath: "~/Documents/Taxes",
      name: "Taxes",
      mode: "read",
      expiresAt: null,
      revision: 1,
      createdAt: now - 5 * DAY,
      revokedAt: null,
    },
    {
      id: "grt_projectsite01",
      deviceId: MOCK_DEVICE_ID,
      kind: "dir",
      displayPath: "~/Projects/Site",
      name: "Site",
      mode: "read-write",
      expiresAt: null,
      revision: 2,
      createdAt: now - 3 * DAY,
      revokedAt: null,
    },
    {
      id: "grt_appcalendar01",
      deviceId: MOCK_DEVICE_ID,
      kind: "app",
      app: "calendar",
      displayPath: "Calendar",
      name: "Calendar",
      mode: "read-write",
      expiresAt: null,
      revision: 1,
      createdAt: now - 2 * DAY,
      revokedAt: null,
    },
    {
      id: "grt_appreminders1",
      deviceId: MOCK_DEVICE_ID,
      kind: "app",
      app: "reminders",
      displayPath: "Reminders",
      name: "Reminders",
      mode: "read",
      expiresAt: null,
      revision: 1,
      createdAt: now - 2 * DAY,
      revokedAt: null,
    },
    {
      id: "grt_appnotes00001",
      deviceId: MOCK_DEVICE_ID,
      kind: "app",
      app: "notes",
      displayPath: "Notes",
      name: "Notes",
      mode: "read-write",
      expiresAt: null,
      revision: 1,
      createdAt: now - DAY,
      revokedAt: null,
    },
  ];
  const op = (
    id: string,
    agentId: string,
    grantId: string,
    capability: DeviceOperation["capability"],
    displayPath: string,
    status: DeviceOperation["status"],
    ago: number,
    extra: Partial<DeviceOperation> = {},
  ): DeviceOperation => ({
    id,
    agentId,
    turnId: null,
    deviceId: MOCK_DEVICE_ID,
    grantId,
    capability,
    displayPath,
    status,
    reason: null,
    bytes: null,
    sha256: null,
    createdAt: now - ago,
    updatedAt: now - ago + 1500,
    ...extra,
  });
  const site = "grt_projectsite01";
  const taxes = "grt_taxes2025docs";
  const operations: DeviceOperation[] = [
    op(
      "op_seed_1",
      "agt_yo",
      site,
      "files.write",
      "~/Projects/Site/index.html",
      "unknown-outcome",
      40 * MIN,
      {
        reason: "The Mac went offline before confirming the save.",
        bytes: 4_812,
      },
    ),
    op("op_seed_2", "agt_yo", site, "files.read", "~/Projects/Site/index.html", "succeeded", 42 * MIN, {
      bytes: 4_640,
    }),
    op(
      "op_seed_3",
      "agt_yo",
      taxes,
      "files.read",
      "~/Documents/Taxes/2025-summary.csv",
      "succeeded",
      3 * HOUR,
      {
        bytes: 2_310,
      },
    ),
    op("op_seed_4", "agt_yo", taxes, "files.list", "~/Documents/Taxes", "succeeded", 3 * HOUR + 2 * MIN),
    op("op_seed_5", "agt_research", taxes, "files.read", "~/Documents/Taxes/W-2.pdf", "failed", DAY, {
      reason: "Not a text file",
    }),
    op("op_seed_6", "agt_yo", "grt_appcalendar01", "calendar.read", "Calendar", "succeeded", 50 * MIN),
    op(
      "op_seed_7",
      "agt_yo",
      "grt_appcalendar01",
      "calendar.write",
      "Calendar: Add “Dentist” to Home",
      "succeeded",
      52 * MIN,
    ),
    op("op_seed_8", "agt_yo", "grt_appnotes00001", "notes.read", "Notes", "succeeded", 55 * MIN),
  ];
  return {
    execution: {
      corePlacement: "this-mac",
      runnerPlacement: "this-mac",
      flags,
      devices: [mockDevice(now)],
      grants,
    },
    operations,
    routes: [],
  };
}
