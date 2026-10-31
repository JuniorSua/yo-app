import { z } from "zod";
import { ComputerState, LeaseHolder, ModelInfo } from "./agentd";
import { Item, PendingRequest, ProviderKind, RateLimitInfo, RuntimeMode, TodoEntry } from "./events";
import { DEFAULT_WORK_HOURS, Space, SpaceManual, WorkHours } from "./spaces";

/* --------------------------------- Avatar --------------------------------- */

export const AVATAR_SHAPES = [
  "bubble",
  "squircle",
  "pebble",
  "hex",
  "drop",
  "cloud",
  "burst",
  "tablet",
  "cupcat",
] as const;
/** CupCat cups (inspired by the CupCats collection: cats sitting in cups). */
export const CUP_STYLES = ["liner", "mug", "pot", "sundae"] as const;
/** Little treats a CupCat can wear by its ear. */
export const CUP_TOPPINGS = ["none", "cherry", "macaron", "blueberry", "flower", "cactus"] as const;
export const AVATAR_EYES = ["capsule", "round", "sleepy", "happy"] as const;
export const AVATAR_FINISHES = ["flat", "dimensional"] as const;
/** "Living" characters: the original 3D renders, animated (see packages/avatar/src/living). */
export const LIVING_CHARACTERS = ["violet", "lagoon", "coral"] as const;
/** Procedural Three.js creatures (round 2). Retired in Yo 2: saved ones show as a Softie (packages/avatar). */
export const CREATURE_KINDS = ["sprout", "pebble", "mimi"] as const;
export type CreatureKind = (typeof CREATURE_KINDS)[number];
/** Yo 2's characters ("Softies", packages/avatar/src/softies): Yo leads; the others are teammates. */
export const SOFTIE_KINDS = ["yo", "dew", "pico", "mochi", "clove", "kiki"] as const;
export type SoftieKind = (typeof SOFTIE_KINDS)[number];

export const AVATAR_ACCESSORIES = [
  "none",
  "headset",
  "glasses",
  "beanie",
  "crown",
  "antenna",
  "bowtie",
  "earbuds",
  "chef",
  "cap",
] as const;

/** 12 hues; each has a matching eye color in packages/avatar. */
export const AVATAR_COLORS = [
  { id: "yo", name: "Yo Yellow", hex: "#FFD43B", eye: "#1A1400" },
  { id: "white", name: "Staff White", hex: "#F4F4F2", eye: "#111111" },
  { id: "violet", name: "Violet", hex: "#8B5CF6", eye: "#12062E" },
  { id: "emerald", name: "Emerald", hex: "#10B981", eye: "#022C1E" },
  { id: "orange", name: "Forge Orange", hex: "#F97316", eye: "#2B1100" },
  { id: "cyan", name: "Cyber Cyan", hex: "#06B6D4", eye: "#01262D" },
  { id: "cobalt", name: "Cobalt", hex: "#3B82F6", eye: "#07183A" },
  { id: "pink", name: "Neon Pink", hex: "#EC4899", eye: "#2E0718" },
  { id: "red", name: "Crimson", hex: "#EF4444", eye: "#2E0707" },
  { id: "lime", name: "Lime", hex: "#A3E635", eye: "#1A2605" },
  { id: "bronze", name: "Caramel", hex: "#B08968", eye: "#24160B" },
  { id: "slate", name: "Slate", hex: "#64748B", eye: "#0B1220" },
] as const;

export const Avatar = z.object({
  shape: z.enum(AVATAR_SHAPES),
  color: z.string(),
  eyes: z.enum(AVATAR_EYES),
  accessory: z.enum(AVATAR_ACCESSORIES),
  /** Optional uploaded image (data URL). Overrides the drawn avatar. */
  image: z.string().optional(),
  /**
   * Rendering finish. Absent/"flat" = the original flat Yo Buddies look (all saved avatars keep it);
   * "dimensional" = the satin 3D look (Violet Copilot direction). Opt-in only.
   */
  finish: z.enum(AVATAR_FINISHES).optional(),
  /** CupCat only: which cup it sits in, and its color (palette id or hex). */
  cup: z.object({ style: z.enum(CUP_STYLES), color: z.string() }).optional(),
  /** CupCat only: a small treat worn by the ear. */
  topping: z.enum(CUP_TOPPINGS).optional(),
  /**
   * CupCat only: which of the 15 collectible CupCats this is (rolled with weighted odds, not customizable).
   * See packages/avatar/src/cupcat-variants.ts.
   */
  variant: z.string().optional(),
  /**
   * Living character (opt-in). When present it's drawn from the original render with motion tied to the
   * agent's state; body/headset are colour ids from packages/avatar/src/living/characters.ts. The other
   * fields stay filled with a close drawn fallback (shape/colour) for anything that can't show it.
   */
  living: z
    .object({ character: z.enum(LIVING_CHARACTERS), body: z.string(), headset: z.string() })
    .optional(),
  /**
   * Creature (opt-in): Sprout, Pebble or Mimi, animated from the agent's activity. Like `living`, the other
   * fields stay filled with a close drawn fallback (shape/colour) for anything that can't show it. In light
   * mode the primary agent's creature can also tint the whole UI (its hue).
   */
  creature: z.object({ kind: z.enum(CREATURE_KINDS), tint: z.string().optional() }).optional(),
  /**
   * Yo 2's character, and an optional colour (hex) so two teammates can share a shape. When absent, the app
   * picks a Softie from the older fields (colour, creature, living character), so saved avatars need no
   * migration. An uploaded `image` still wins. The older fields stay filled with a close fallback.
   */
  softie: z.object({ kind: z.enum(SOFTIE_KINDS), color: z.string().optional() }).optional(),
});
export type Avatar = z.infer<typeof Avatar>;

export const AgentActivity = z.enum(["idle", "working", "waiting", "done", "error", "sleeping"]);
export type AgentActivity = z.infer<typeof AgentActivity>;

/* --------------------------------- Domain --------------------------------- */

export const AgentKind = z.enum(["agent", "helper"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** A helper's state as its card in the parent's chat shows it (TimelineEntry item.helper). */
export const HelperState = z.enum(["waiting", "working", "done", "failed", "stopped"]);
export type HelperState = z.infer<typeof HelperState>;

/** The task ledger: what the main agent has open, kept outside its conversation so compaction can't lose it. */
export const LedgerTaskStatus = z.enum([
  "open",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
  "interrupted",
  /** Finished work the user should look at ("Ready for review" on the Tasks page). */
  "review",
  /** Something Yo offers to do (suggest_task): "Up next" on the Tasks page and above the message box. */
  "suggested",
  /** A suggestion the user hid. Kept so Yo doesn't suggest the same thing again. */
  "hidden",
]);
export type LedgerTaskStatus = z.infer<typeof LedgerTaskStatus>;

/** What a page made with create_page is: a web page, a dashboard, slides, a doc, or a design. */
export const PageKind = z.enum(["page", "dashboard", "slides", "doc", "design"]);
export type PageKind = z.infer<typeof PageKind>;

export const LedgerTask = z.object({
  id: z.string(),
  ownerId: z.string(),
  title: z.string(),
  status: LedgerTaskStatus,
  helperId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /**
   * "asked": Yo put it on its ledger (task_add: the user asked in chat, or Yo noted it); "suggestion": Yo offered it
   * (suggest_task); "user": the user added it on the Tasks page. Absent = asked.
   */
  origin: z.enum(["asked", "suggestion", "user"]).optional(),
  /** Suggestions: one line on why Yo thinks it's worth doing. */
  why: z.string().nullable().optional(),
  /**
   * Tasks the user added: their title and details, sent together by Start. Suggestions: Yo's plan, which Start
   * puts on the task as its note (Start sends only the title, what the user saw).
   */
  prompt: z.string().nullable().optional(),
});
export type LedgerTask = z.infer<typeof LedgerTask>;

/**
 * One row of the morning brief (post_brief). Start sends "Take care of: {title}" (what the row shows); `start` is
 * only Yo's own note on how it would do it (it stays in its post_brief call).
 */
export const BriefItem = z.object({
  title: z.string(),
  detail: z.string().optional(),
  /** Today's calendar rows: the time ("9:30 AM"). */
  time: z.string().optional(),
  start: z.string().optional(),
});
export type BriefItem = z.infer<typeof BriefItem>;

/** The morning brief card: what needs the user, what can wait, today's calendar, and what Yo couldn't check. */
export const MorningBrief = z.object({
  needsYou: z.array(BriefItem).default([]),
  canWait: z.array(BriefItem).default([]),
  today: z.array(BriefItem).default([]),
  couldNotCheck: z.array(z.object({ source: z.string(), why: z.string() })).default([]),
});
export type MorningBrief = z.infer<typeof MorningBrief>;

export const Agent = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  instructions: z.string(),
  avatar: Avatar,
  accountId: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  runtimeMode: RuntimeMode,
  isPrimary: z.boolean(),
  pinned: z.boolean(),
  createdAt: z.number(),
  archivedAt: z.number().nullable(),
  /**
   * "helper": a one-off helper the main agent started for one job (start_helper). It has its own screen,
   * reports back to its parent, and is archived when done. Hidden from the agent list. Absent from older
   * cores (= "agent").
   */
  kind: AgentKind.optional(),
  /** Helpers only: the agent that started it and gets its report. */
  parentId: z.string().nullable().optional(),
  /** Helpers only: the job it was given. */
  brief: z.string().nullable().optional(),
  /**
   * The space this agent is the main agent of (Yo: "work", Pip: "personal"), or null for any other agent.
   * Absent from older cores.
   */
  space: Space.nullable().optional(),
});
export type Agent = z.infer<typeof Agent>;

export const AgentView = Agent.extend({
  activity: AgentActivity,
  unread: z.number(),
  preview: z.string().nullable(),
  computer: z.object({ state: ComputerState, lease: LeaseHolder }),
  todos: z.array(TodoEntry),
  lastActiveAt: z.number().nullable(),
  /**
   * One line on what it's doing now, for the sidebar ("Checking times at Joe's Stone Crab", "Waiting for your
   * OK: Book the 8 PM table"). Null when it isn't working or waiting. Absent from older cores.
   */
  statusLine: z.string().nullable().optional(),
});
export type AgentView = z.infer<typeof AgentView>;

export const Account = z.object({
  id: z.string(),
  provider: ProviderKind,
  label: z.string(),
  /**
   * "unverified": a sign-in was saved before Yo's computer could check it (the "Connect your model"
   * walkthrough). Yo treats it as usable and checks it when its computer starts.
   */
  status: z.enum([
    "authenticated",
    "unauthenticated",
    "unknown",
    "error",
    "not_installed",
    "signing_in",
    "unverified",
  ]),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  message: z.string().nullable(),
  isDefault: z.boolean(),
  models: z.array(ModelInfo),
  rateLimit: RateLimitInfo.nullable(),
  createdAt: z.number(),
  /**
   * The provider turned this account's saved sign-in down during a task (expired or signed out). Status is then
   * "unauthenticated" until the user signs in again. Absent from older cores.
   */
  signInExpired: z.boolean().optional(),
  /**
   * When a legacy Claude sign-in token was saved (older cores used it for a "may expire soon" heads-up). No
   * longer set: Claude Code keeps its own sign-in now. Kept so older cores' accounts still parse.
   */
  signInSavedAt: z.number().nullable().optional(),
  /**
   * Claude only: the account still runs on a sign-in token Yo saved with the old "paste a token" flow. It keeps
   * working; Settings asks the user to sign in once the new way (Claude Code keeps its own sign-in), after
   * which core forgets the token. Absent from older cores.
   */
  legacyToken: z.boolean().optional(),
});
export type Account = z.infer<typeof Account>;

export const TimelineEntry = z.object({
  id: z.string(),
  agentId: z.string(),
  turnId: z.string().nullable(),
  seq: z.number(),
  createdAt: z.number(),
  item: Item,
  /** Present on request cards (approvals/questions). */
  request: PendingRequest.extend({
    status: z.enum(["pending", "allowed", "denied", "answered", "expired", "failed"]),
  }).optional(),
  /** Which model/account produced this (assistant messages). */
  source: z.object({ provider: ProviderKind, model: z.string().nullable() }).optional(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const Memory = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  content: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /**
   * Which space's agents see it in their prompt: "work", "personal", or null for Everywhere (core facts like
   * the owner's name and home). `recall` searches every space. Absent from older cores (= Everywhere).
   */
  space: Space.nullable().optional(),
});
export type Memory = z.infer<typeof Memory>;

export const Routine = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string(),
  prompt: z.string(),
  cron: z.string().nullable(),
  runAt: z.number().nullable(),
  timezone: z.string(),
  enabled: z.boolean(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  createdAt: z.number(),
});
export type Routine = z.infer<typeof Routine>;

export const ActivityEvent = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  ts: z.number(),
  kind: z.enum([
    "run.started",
    "run.completed",
    "run.failed",
    "approval",
    "routine",
    "memory",
    "takeover",
    "system",
    "device",
  ]),
  summary: z.string(),
  ref: z.string().nullable(),
});
export type ActivityEvent = z.infer<typeof ActivityEvent>;

export const ApprovalRule = z.object({
  id: z.string(),
  agentId: z.string().nullable(),
  /** Tool name or Yo approval category (e.g. "purchase", "mcp__playwright__browser_click"). */
  match: z.string(),
  decision: z.enum(["allow", "deny"]),
  createdAt: z.number(),
});
export type ApprovalRule = z.infer<typeof ApprovalRule>;

export const Artifact = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  path: z.string(),
  mime: z.string(),
  size: z.number(),
  createdAt: z.number(),
  /**
   * "bug" = a bug report Yo filed for the developer (shown in red). "page" = a visual page the agent made
   * (create_page): a self-contained HTML page that opens in Yo's sandboxed page viewer. Absent on older cores.
   */
  kind: z.enum(["file", "bug", "page"]).optional(),
  /** Pages only: what kind of page it is (the Make page's filters). Absent = "page". */
  pageKind: PageKind.optional(),
  /** When the user pinned it in Your files (pinned files come first). Absent or null = not pinned. */
  pinnedAt: z.number().nullable().optional(),
  /** Bug reports only: the GitHub issue it was filed as (`number` set), or a prefilled new-issue link. */
  issue: z.object({ url: z.string(), number: z.number().optional() }).optional(),
  /**
   * Bug reports sent to Yo's bug inbox (no GitHub account needed): "sent" with the inbox's id ("YO-ABC123"),
   * "pending" while Yo retries (for up to a day), or "failed" (then `issue.url` is the prefilled link fallback).
   */
  report: z
    .object({
      status: z.enum(["sent", "pending", "failed"]),
      reportId: z.string().optional(),
      sentAt: z.number().optional(),
      nextTryAt: z.number().optional(),
      attempts: z.number().optional(),
      /** The chat draft it was sent from (the red card finds its result by this). */
      draftId: z.string().optional(),
      /** Whether the user let the recent chat go with it. */
      includeChat: z.boolean().optional(),
      error: z.string().optional(),
    })
    .optional(),
});
export type Artifact = z.infer<typeof Artifact>;

export const ComputerHost = z.object({
  kind: z.enum(["local", "remote"]),
  label: z.string(),
  url: z.string(),
  /** Where the agent computer physically runs (from config). */
  placement: z.enum(["this-mac", "this-pc", "home-pc", "custom-remote"]).optional(),
});
export type ComputerHost = z.infer<typeof ComputerHost>;

export const ComputerOverview = z.object({
  runtime: z.enum(["missing", "stopped", "starting", "running", "error"]),
  host: ComputerHost,
  connected: z.boolean(),
  message: z.string().nullable(),
  /** Memory in use, not counting file cache the kernel frees when needed. */
  memMB: z.number().nullable(),
  memLimitMB: z.number().nullable(),
  /** File cache on top of memMB, freed when needed (absent from older cores and agentd). */
  cacheMB: z.number().nullable().optional(),
  /** Programs killed for lack of memory since the computer started (absent from older cores and agentd). */
  oomKills: z.number().nullable().optional(),
  imageReady: z.boolean(),
});
export type ComputerOverview = z.infer<typeof ComputerOverview>;

export const Settings = z.object({
  userName: z.string(),
  /** Post the morning brief the first time the user opens Yo each day. Absent = on. */
  morningBrief: z.boolean().optional(),
  timezone: z.string(),
  theme: z.enum(["dark", "light", "system"]),
  onboarded: z.boolean(),
  maxAwakeComputers: z.number(),
  autoSleepMinutes: z.number(),
  notifications: z.boolean(),
  defaultRuntimeMode: RuntimeMode,
  /** Kill switch: Yo may use paired Macs at all (still only folders the user picked there). */
  macAccess: z.boolean(),
  /** Kill switch: approved writes to picked folders on the Mac. */
  macWrites: z.boolean(),
  /** Kill switch: approved sessions where Yo sees and uses one window on the Mac (R3). */
  macControl: z.boolean(),
  /**
   * The first agent's "let's set up my computer" chat: "pending" until the user finishes it ("done") or picks
   * "Do this later" ("later"). Core marks installs from before this chat, and home-server cores, "done".
   */
  computerSetup: z.enum(["pending", "later", "done"]),
  /**
   * Names (any case) of agents the "Yo is now one assistant" consolidation must leave alone because the owner
   * hands them over by hand. Pepe is the owner's own: Yo takes him over in a chat, then the owner deletes him.
   */
  consolidateSkip: z.array(z.string()),
  /** Work & Personal spaces (see ./spaces.ts): on by default; off = one Work space, as before. */
  spacesOn: z.boolean(),
  /** When it's Work time (index 0 = Sunday); everything else is Personal. */
  workHours: WorkHours,
  /** A space picked by hand, or null to follow the work hours. */
  spaceManual: SpaceManual.nullable(),
});
export type Settings = z.infer<typeof Settings>;

/**
 * This machine's IANA time zone ("Europe/Lisbon"), or null when the runtime can't tell. Onboarding saves the
 * user's (DEFAULT_SETTINGS' New York is only a placeholder), and the agent's computer runs on the Mac's.
 */
export function localTimeZone(
  read: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  try {
    const tz = read();
    if (!tz || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(tz)) return null;
    new Intl.DateTimeFormat("en-US", { timeZone: tz }); // throws on a zone this runtime doesn't know
    return tz;
  } catch {
    return null;
  }
}

export const DEFAULT_SETTINGS: Settings = {
  userName: "",
  morningBrief: true,
  timezone: "America/New_York",
  theme: "dark",
  onboarded: false,
  maxAwakeComputers: 2,
  autoSleepMinutes: 30,
  notifications: true,
  defaultRuntimeMode: "full-access",
  macAccess: false,
  macWrites: false,
  macControl: false,
  computerSetup: "pending",
  consolidateSkip: ["Pepe"],
  spacesOn: true,
  workHours: DEFAULT_WORK_HOURS,
  spaceManual: null,
};
