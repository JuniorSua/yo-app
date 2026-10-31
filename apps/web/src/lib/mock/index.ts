/**
 * In-memory mock of yo-core. Implements every ApiMethod and simulates realistic agent behavior
 * (streamed replies, tool activity, approvals, questions, computer lifecycle, sign-in flows).
 *
 * URL flags:  ?mock=1            enable (or VITE_MOCK=1)
 *             &onboarded=1       skip onboarding and seed a lived-in workspace
 *             &fast=1            run simulations ~7x faster (used by E2E)
 *             &theme=light       start in a given theme
 *             &mockDesktop=1     also fake the desktop app's `window.yoDesktop.device` bridge (pairing,
 *                                folder picker, pause, metrics, sharing apps — macOS "denies" Contacts;
 *                                window control needs System Settings the first time, then is allowed —
 *                                and the active window session with Stop).
 *                                Off by default: the UI runs in browser mode.
 *             &mockUpdate=…      show an update notice: web | available | downloading | ready | error |
 *                                github | server | server-browser | server-ready | server-fail
 *                                (see ./updates.ts)
 *             &mockMac=…         the Mac the first agent's computer setup checks: strong (default) | intel16 |
 *                                small | nocolima | nobrew (see ./setup.ts)
 *             &mockVm=choose     an existing ~/.colima computer: the setup chat asks to keep it or move it
 *             &mockVm=keep       that computer was kept: Settings → Computer can move it later
 *             &mockConnect=…     what "Connect your model" finds on first run: none | cli | computer
 *                                (see ./connect.ts)
 *             &mockCodexCode=off ChatGPT's one-time code is never accepted ("device code sign-in" still off in
 *                                ChatGPT's settings): the sign-in ends with the "turn it on" message
 *             &mockConsolidate=… the "Yo is now one assistant" dialog: 1 | solo | fail (see ./team.ts)
 *             &mockHost=pc       core runs on a Linux PC, not this Mac (a friend on the owner's Home PC)
 *             &mockAuth=…        browser sign-in: signed-out | unsupported (see ./auth.ts; turns on browser mode)
 *             &mockEdition=pc    the PC edition in a browser: PC wording, `yo-app`, "This PC" (see ./auth.ts)
 *             &mockRelease=1     PC edition: a newer GitHub release is out (Settings → Updates)
 *             &mockSignIn=…      Claude's account: expired (a task found the sign-in turned down) | legacy (still on a
 *                                token saved by the old "paste a token" flow: Accounts asks to sign in anew)
 *             &mockPhone=…       Settings → Phone: off (default) | ready | connected | nokey (see ./phone.ts)
 *             &mockOnePassword=… Settings → Accounts → 1Password: off (default) | connected | error
 *                                (see ./onepassword.ts)
 *             &space=…           Work & Personal: work (default: held in Work, so nothing depends on the clock) |
 *                                personal (held in Personal) | auto (follows the work hours, Mon–Fri 11–7) |
 *                                old (a core from before spaces: no switch)
 *             &spacesIntro=1     show the one-time "Meet Pip" intro (otherwise it counts as seen)
 *             &mockBrief=1       the first brief.claim (opening the chat) posts the morning brief
 *
 * Chat keywords pick a scenario: "buy/order/purchase" -> approval card, "flight/trip/travel" ->
 * ask-user card, "fail/error" -> error, "save … mac" -> exact-file approval for a change on the paired
 * Mac, "calendar" + "add/schedule" -> exact-action approval for a new Calendar event, "window" or
 * "desk screen" -> approval for a window session on the Mac (with mockDesktop, allowing it starts a
 * session the app shows with Stop), "report … bug" / "look into why" / "isn't working" -> investigation +
 * red bug-report draft that waits for "Report it" (filed as an issue) or "Not now", "ask Dew to research X" (or
 * "ask/check with/tell <teammate name>") -> an async handoff (message_agent): "Messaged Dew" now, Dew's reply in a
 * few seconds ("… and wait" waits for it; see ./team.ts), "add … agent named X" -> an
 * approval card for a new agent (create_agent), "set up Yo Phone" / "phone link" -> an approval card for a
 * phone link (create_phone_link), "sign in to github" / "log in to …" -> a 1Password sign-in with its
 * approval card (with &mockOnePassword=connected), "uber eats" -> a secure form for the code Uber texted
 * (request_secure_input; the card names auth.uber.com, the page that was opened), "bank password" -> a secure
 * form that asks for a password, "code page failed" -> a secure form whose fill then fails, "terminal" -> a
 * reply with a command to copy, "visualize" / "dashboard" / "deck" / "write a doc" / "make a design" -> a Page of that
 * kind (create_page; it lands in Make), "send my card" -> a message approval with a test card number in it and the
 * sensitive-detail warning, "suggest" -> Yo offers a next step (suggest_task: a card above the message box and
 * under Up next on the Tasks page), "brief" -> the morning brief card (post_brief), "choose" / "which one" -> a
 * question with quick replies (suggest_replies), anything else -> research-style run with todos + tools.
 */
import {
  type Account,
  type ActivityEvent,
  type AgentView,
  type ApiMethod,
  type ApiMethods,
  type ApiParams,
  type ApiPushChannel,
  type ApiPushes,
  type ApiResult,
  type Artifact,
  type Attachment,
  agentForSpace,
  BRIEF_NOTICE,
  type BugReportPreview,
  type BugReportSend,
  type BugReportSent,
  type ComputerOverview,
  cleanSecureValues,
  type Decision,
  type DeviceApp,
  type DeviceGrant,
  type DeviceOperation,
  type ExecutionStatus,
  evaluateRequirements,
  type GrantMode,
  type Item,
  isProviderEnabled,
  type LicenseState,
  type Memory,
  newId,
  type OnePasswordStatus,
  type OsPermissionState,
  type PageKind,
  parseCodexCallback,
  type QueuedRequest,
  type RouteDecision,
  type RoutePreference,
  resolveSpace,
  SECURE_INPUT_TOOL,
  type Settings,
  STEERED_TITLE,
  type TimelineEntry,
  type TodoEntry,
  teammateAvatar,
  type VmHomeStatus,
} from "@yo/contracts";
import { isUsable } from "../accounts";
import type { ConnectionStatus, PtyConnection, YoClient } from "../api";
import { nextRun } from "../cron";
import type { DeviceStatusView, WindowLease, YoDesktopBridge } from "../desktop";
import { MockAuth } from "./auth";
import { applyConnectScenario, MockConnect, mockConnectHost, mockConnectScenario } from "./connect";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  GROK_MODELS,
  MOCK_DEVICE_ID,
  type MockFile,
  mockDevice,
  mockFiles,
  mockMacPermissions,
  type SeedState,
  seed,
} from "./data";
import { MockOnePassword, mockOnePasswordScenario } from "./onepassword";
import { MockPhone, mockPhoneScenario } from "./phone";
import { createMockPty } from "./pty";
import { sampleKindHtml, samplePageHtml } from "./samplePage";
import { installedTools, type MockMac, mockMacFromQuery, mockMachine } from "./setup";
import { MockTasks } from "./tasks";
import {
  handoffAck,
  handoffMessage,
  handoffReply,
  handoffSaid,
  handoffSummary,
  handoffTarget,
  handoffTopic,
  handoffWaits,
  MockTeam,
  mockConsolidateScenario,
  teammateHello,
} from "./team";
import { MockUpdates, mockUpdateScenario } from "./updates";

type Listener = (data: any) => void;
type Handler<M extends ApiMethod> = (params: ApiParams<M>) => ApiResult<M> | Promise<ApiResult<M>>;
type Response = { decision: Decision; answers?: Record<string, string>; message?: string };

/** `&mockVm=keep`: the existing computer was kept, so Settings can offer Move later. */
function mockVmKept(): VmHomeStatus {
  return {
    state: "ready",
    choice: "reuse",
    colimaHome: "/Users/alice/.colima",
    limaHome: "/Users/alice/.colima/_lima",
    dockerConfig: "/Users/alice/Library/Application Support/Yo/docker",
    legacyDir: "/Users/alice/.colima",
    legacyKept: true,
    detail: "Using your existing computer in ~/.colima. Yo didn't move or delete it.",
  };
}

/** `&mockVm=choose`: an existing ~/.colima computer, before the person picks Keep or Move. */
function mockVmChoice(): VmHomeStatus {
  return {
    state: "choose",
    choice: null,
    colimaHome: "/Users/alice/.colima",
    limaHome: "/Users/alice/.colima/_lima",
    dockerConfig: "/Users/alice/Library/Application Support/Yo/docker",
    legacyDir: "/Users/alice/.colima",
    legacyKept: true,
    detail:
      'Yo found an existing computer in ~/.colima (Colima profile "yo"). ' +
      "You can keep using it there, or move it into Yo's folder. Yo will not delete it either way. " +
      "Keep it where it is: Yo uses ~/.colima, and nothing is moved. " +
      "Move it into Yo: Yo renames that profile into its own folder.",
  };
}

class Aborted extends Error {}

interface RunCtx {
  agentId: string;
  turnId: string;
  aborted: boolean;
  startedAt: number;
  steps: number;
  open: Set<string>;
  steer: string[];
  route: RoutePreference;
  /** The busy scenario's long task wraps up (test hook finishBusy). */
  release?: boolean;
  /** The agent's status line while this runs (AgentView.statusLine), put back after a card is answered. */
  status: string | null;
}

/** One of the user's messages waiting in "Up next" (like core's queue). */
interface MockQueued {
  id: string;
  text: string;
  attachments: Attachment[];
  route: RoutePreference;
  createdAt: number;
}

const MAC_NOTES = `# Site notes

- Hero copy: shorter headline, keep the yellow button
- Move pricing above the FAQ
- Compress hero.jpg (1.8 MB -> ~300 KB)
- Fix the broken link in the footer (/press)
`;

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "ChatGPT", grok: "Grok" };
const FREE_LICENSE: LicenseState = { required: false, active: true };

/** What Claude Code's sign-in shows on Yo's computer (fake client and state). */
const MOCK_CLAUDE_LOGIN_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=yo-mock&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&state=mockstate";

/** What Codex's own sign-in shows on Yo's computer: ChatGPT's page, which then sends the browser to localhost. */
export const MOCK_CODEX_LOGIN_URL = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_mock&redirect_uri=${encodeURIComponent(
  "http://127.0.0.1:1455/auth/callback",
)}&state=mockcodexstate&originator=yo`;

/** The address the person's browser lands on after ChatGPT's page (what they paste back). */
export const MOCK_CODEX_CALLBACK =
  "http://127.0.0.1:1455/auth/callback?code=mock_code&scope=openid&state=mockcodexstate";

/** Agentd's message when ChatGPT never confirms a one-time code (CodexAdapter's CODE_NOT_CONFIRMED). */
const MOCK_CODE_NOT_CONFIRMED =
  "ChatGPT didn't confirm the code in time. If its page said code sign-in is turned off, turn it on in ChatGPT's security settings first, then get a new code.";

export class MockClient implements YoClient {
  /** An account's status before its sign-in started (a failed sign-in goes back to it, like core's re-check). */
  private statusBeforeLogin = new Map<string, Account["status"]>();
  readonly mock = true;
  private s: SeedState;
  private listeners = new Map<string, Set<Listener>>();
  private scale: number;
  /** `&mockCodexCode=off`: ChatGPT never confirms a one-time code (its "device code sign-in" is off). */
  private codexCodeOff: boolean;
  private runs = new Map<string, RunCtx>();
  /** The user's messages waiting for each agent's running task ("Up next"). */
  private queues = new Map<string, MockQueued[]>();
  private waiters = new Map<string, (r: Response) => void>();
  private files: Record<string, MockFile[]> = mockFiles();
  private ptys = new Map<string, string>();
  /** Test hook: every chat.send, with the route the composer chose. */
  readonly sends: {
    agentId: string;
    text: string;
    route: RoutePreference | undefined;
    attachments?: { name: string; mediaType: string }[];
  }[] = [];
  /** Local state of the fake "Yo on this Mac" (only with `&mockDesktop=1`). */
  private mac: { paired: boolean; paused: boolean; connected: boolean } | null = null;
  private macListeners = new Set<() => void>();
  /** What macOS allows Yo on the fake Mac (Contacts gets "denied" when asked). */
  private macPerms = mockMacPermissions();
  /** Test hook: System Settings panes the UI asked to open. */
  readonly privacyOpened: DeviceApp[] = [];
  /** The fake Mac's active window session (R3), shown by the app with a Stop button. */
  private lease: WindowLease | null = null;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many times "Allow" was clicked for window control (the first needs System Settings). */
  private screenAsks = 0;
  /** Where submitted bug reports go (the token itself is never kept in the UI). */
  private bugFiling = { configured: false, inbox: true, repo: "JuniorSua/yo-app" };
  /** Tests: the bug inbox can't be reached (sends are saved as "will retry"). */
  bugInboxDown = false;
  private bugReportSeq = 0;
  private bugIssueSeq = 41;
  /** Bug-report drafts waiting for the user's answer, by agent. */
  private bugDrafts = new Map<string, { draftId: string; title: string }>();
  /** Update notices (`&mockUpdate=…`); test hooks for deploys and Restart. */
  readonly updates: MockUpdates;
  /** "Connect your model" walkthrough (`&mockConnect=…`): what it finds on the machine Yo runs on. */
  readonly connect: MockConnect;
  /** "Yo is now one assistant" consolidation (`&mockConsolidate=…`, see ./team.ts). */
  readonly team: MockTeam;
  /** Yo Phone (`&mockPhone=…`, see ./phone.ts). */
  readonly phone: MockPhone;
  /** The Tasks page and suggestions above the message box (see ./tasks.ts). */
  readonly tasks: MockTasks;
  /** Browser sign-in and Settings → Browsers & apps (`&mockAuth=…`, `&mockEdition=pc`, see ./auth.ts). */
  readonly auth: MockAuth;
  /** The socket has opened once (after a mock sign-in, a later open is a reconnect). */
  private authOpened = false;
  /** 1Password (`&mockOnePassword=…`, see ./onepassword.ts). */
  readonly onePassword: MockOnePassword;
  /** The next secure form's fill fails, so the card can show that (the values are still dropped). */
  private failNextSecureForm = false;
  /** `&mockBrief=1`: the first brief.claim of this page load posts the morning brief. */
  private briefPending = false;

  constructor() {
    const q = new URLSearchParams(location.search);
    const onboarded = q.get("onboarded") === "1";
    this.s = seed(onboarded);
    this.scale = q.has("fast") ? 0.15 : 1;
    this.codexCodeOff = q.get("mockCodexCode") === "off";
    this.briefPending = q.get("mockBrief") === "1";
    const theme = q.get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") this.s.settings.theme = theme;
    const space = q.get("space");
    if (space === "auto") this.s.settings.spaceManual = null;
    else if (space === "work" || space === "personal") this.s.settings.spaceManual = { space, until: null };
    // `&space=old`: a core from before Work & Personal (no spacesOn): one space, no switch.
    else if (space === "old") delete (this.s.settings as Partial<Settings>).spacesOn;
    // The one-time "Meet Pip" intro would cover the chat header in every test and screenshot: it counts as seen
    // unless `&spacesIntro=1`.
    try {
      if (q.get("spacesIntro") === "1") localStorage.removeItem("yo.spacesIntro");
      else localStorage.setItem("yo.spacesIntro", "1");
    } catch {
      /* ignore */
    }
    (window as any).__yoMock = this;
    this.auth = new MockAuth(q, {
      connected: () => {
        this.connection = "open";
        const reconnected = this.authOpened;
        this.authOpened = true;
        for (const cb of this.statusCbs) cb("open", reconnected);
      },
      disconnected: () => {
        this.connection = "closed";
        for (const cb of this.statusCbs) cb("closed", false);
      },
    });
    // Not signed in: the "socket" can't open until the sign-in screen signs in.
    if (this.auth.waiting) this.connection = "connecting";
    else this.authOpened = true;
    if (q.get("mockEdition") === "pc") {
      // The PC edition: core and the agent's computer run in Docker on this PC.
      Object.assign(this.s.execution, { corePlacement: "this-pc", runnerPlacement: "this-pc" });
      this.s.computer.host = { ...this.s.computer.host, label: "This PC", placement: "this-pc" };
    }
    if (q.get("mockDesktop") === "1") {
      this.mac = { paired: onboarded, paused: false, connected: onboarded };
      window.yoDesktop = this.desktopBridge();
    }
    this.team = new MockTeam(mockConsolidateScenario(q), this.s, {
      removed: (id) => this.emit("agent.removed", { id }),
      memory: (m) => this.emit("memory.updated", m),
      routine: (r) => this.emit("routine.updated", r),
    });
    this.updates = new MockUpdates(mockUpdateScenario(q), this.scale);
    if (q.get("mockRelease") === "1")
      this.updates.release = { version: "1.4.0", url: "https://github.com/JuniorSua/yo/releases/tag/v1.4.0" };
    this.phone = new MockPhone(mockPhoneScenario(q), this.scale);
    this.tasks = new MockTasks(onboarded, "agt_yo", {
      emit: (t) => this.emit("task.updated", t),
      send: (agentId, text) => void this.handlers["chat.send"]({ agentId, text }),
      activeAgentId: () => {
        const st = this.s.settings;
        const live = this.s.agents.filter((a) => !a.archivedAt);
        return agentForSpace(live, resolveSpace(Date.now(), st).space, st.spacesOn === true)?.id;
      },
    });
    this.onePassword = new MockOnePassword(mockOnePasswordScenario(q));
    this.updates.install(window);
    this.machine = mockMachine(mockMacFromQuery(q));
    if (q.get("mockVm") === "choose") this.vmHome = mockVmChoice();
    if (q.get("mockVm") === "keep") this.vmHome = mockVmKept();
    if (!onboarded && !this.machine.tools.colima.installed)
      Object.assign(this.s.computer, { runtime: "missing", message: "Colima/Docker CLI not installed" });
    const connectScenario = mockConnectScenario(q);
    if (!onboarded) applyConnectScenario(this.s, connectScenario);
    this.connect = new MockConnect(
      connectScenario,
      q.get("mockEdition") === "pc" && !q.has("mockHost")
        ? { platform: "linux", name: "This PC" }
        : mockConnectHost(q),
    );
    // `&mockSignIn=expired|legacy`: Claude's sign-in was turned down / still runs on a token saved by the old
    // "paste a token" flow (Accounts asks once to sign in the new way).
    const signIn = q.get("mockSignIn");
    const claude = this.s.accounts.find((a) => a.provider === "claude");
    if (claude && signIn === "expired")
      Object.assign(claude, { status: "unauthenticated", signInExpired: true, rateLimit: null });
    if (claude && signIn === "legacy") claude.legacyToken = true;
    const busy = q.get("mockBusy");
    if (onboarded && busy) this.startBusyScenario(busy);
  }

  /* ------------------------------- "Up next" queue ------------------------------- */

  private queueOf(agentId: string): MockQueued[] {
    let q = this.queues.get(agentId);
    if (!q) {
      q = [];
      this.queues.set(agentId, q);
    }
    return q;
  }

  private queueView(agentId: string): QueuedRequest[] {
    return this.queueOf(agentId).map((q) => ({
      id: q.id,
      text: q.text,
      attachments: q.attachments.length,
      createdAt: q.createdAt,
    }));
  }

  private pushQueue(agentId: string) {
    this.emit("queue.updated", { agentId, items: this.queueView(agentId) });
  }

  private queued(agentId: string, id: string): MockQueued {
    const q = this.queueOf(agentId).find((x) => x.id === id);
    if (!q) throw new Error("That message isn't waiting anymore. It may have already started.");
    return q;
  }

  private userMessage(agentId: string, text: string, attachments: Attachment[] = [], title?: string) {
    const input = attachments.length
      ? { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType })) }
      : undefined;
    this.upsert(
      this.entry(agentId, {
        id: newId("it"),
        kind: "user_message",
        status: "completed",
        text,
        input,
        ...(title ? { title } : {}),
      }),
    );
  }

  /** The next queued message starts once the running task is over (Stop included, like core). */
  private runNextQueued(agentId: string) {
    if (this.runs.has(agentId)) return;
    const next = this.queueOf(agentId).shift();
    if (!next) return;
    this.pushQueue(agentId);
    this.userMessage(agentId, next.text, next.attachments);
    void this.run(agentId, next.text, undefined, next.route);
  }

  /**
   * `&mockBusy=1`: Yo starts on a long task (it keeps going until Stop or the finishBusy() test hook), for the
   * request box's busy choices and steering. `&mockBusy=queue` also has two messages waiting in Up next.
   */
  private startBusyScenario(mode: string) {
    const yo = this.s.agents.find((a) => a.isPrimary);
    if (!yo) return;
    const ask = "Compare standing desks under $500 and pick the best three";
    this.userMessage(yo.id, ask);
    void this.run(yo.id, ask, (c) => this.longScript(c));
    if (mode === "queue") {
      const now = Date.now();
      this.queueOf(yo.id).push(
        {
          id: "qmsg_seed1",
          text: "Then draft a short email to my landlord about the move-out date",
          attachments: [],
          route: "auto",
          createdAt: now - 60_000,
        },
        {
          id: "qmsg_seed2",
          text: "Remind me to call Mom at 6",
          attachments: [],
          route: "auto",
          createdAt: now - 30_000,
        },
      );
    }
  }

  /** Test hook: the busy scenario's long task wraps up (then Up next runs). */
  finishBusy(agentId = "agt_yo") {
    const ctx = this.runs.get(agentId);
    if (ctx) ctx.release = true;
  }

  /** A long task that takes steering as it goes (the busy scenario). */
  private async longScript(ctx: RunCtx) {
    const p = await this.plan(ctx, [
      { text: "Find desks under $500", status: "in_progress" },
      { text: "Compare reviews and warranties", status: "pending" },
      { text: "Pick the best three", status: "pending" },
    ]);
    await this.step(ctx, "web", "Searched “standing desks under $500”", {
      input: { query: "standing desks under $500" },
      live: "Searching the web…",
      ms: 600,
    });
    p.set(0, "completed");
    p.set(1, "in_progress");
    const e = this.entry(
      ctx.agentId,
      { id: newId("it"), kind: "browser", status: "running", title: "Comparing prices on 12 sites…" },
      { turnId: ctx.turnId },
    );
    ctx.open.add(e.id);
    this.upsert(e);
    this.patchAgent(ctx.agentId, { preview: "Comparing prices on 12 sites…" });
    // Real time, not scaled: this task stays busy until it's released (or 10 minutes pass).
    const until = Date.now() + 10 * 60_000;
    while (!ctx.release && Date.now() < until) {
      if (ctx.aborted) throw new Aborted();
      for (const s of ctx.steer.splice(0))
        await this.say(
          ctx,
          `Got it — ${s.charAt(0).toLowerCase()}${s.slice(1).replace(/[.!]+$/, "")}. I'll factor that in as I compare.`,
        );
      await new Promise((r) => setTimeout(r, 120));
    }
    ctx.open.delete(e.id);
    this.upsert({ ...e, item: { ...e.item, title: "Compared prices on 12 sites", status: "completed" } });
    p.set(1, "completed");
    p.set(2, "completed");
    await this.say(
      ctx,
      "My top three: **Flexispot E7** ($449), **Uplift V2 Commercial** ($499 on sale) and **Fezibo Electric** ($229). " +
        "All have 5-year+ warranties.",
    );
  }

  /* ------------------------- First agent's computer setup ------------------------- */

  /** The fake Mac the setup chat checks (`&mockMac=…`). */
  private machine = mockMachine("strong" as MockMac);
  /** Existing ~/.colima VM (`&mockVm=choose`), then the choice the user made. */
  private vmHome: VmHomeStatus | null = null;

  /** Test hook: the user ran the copy-paste install steps; the next re-check finds everything. */
  installTools() {
    this.machine = { ...this.machine, tools: installedTools() };
    if (this.s.computer.runtime === "missing")
      Object.assign(this.s.computer, { runtime: "stopped", message: null });
    this.emit("computer.updated", this.s.computer);
  }

  /** Test hook: a new memory reading from the agent computer (in use, cache, out-of-memory kills). */
  setComputerMemory(patch: Pick<Partial<ComputerOverview>, "memMB" | "cacheMB" | "oomKills">) {
    Object.assign(this.s.computer, patch);
    this.emit("computer.updated", this.s.computer);
  }

  /* ------------------------------ YoClient API ------------------------------ */

  status(): ConnectionStatus {
    return this.connection;
  }

  private statusCbs = new Set<(s: ConnectionStatus, reconnected: boolean) => void>();

  onStatus(cb: (s: ConnectionStatus, reconnected: boolean) => void) {
    this.statusCbs.add(cb);
    // Not signed in yet (`&mockAuth=…`): it opens once the sign-in screen signs in.
    if (!this.auth.waiting) setTimeout(() => cb("open", false), 0);
    return () => this.statusCbs.delete(cb);
  }

  /** Test hook: the connection drops and comes back (like a core restart). */
  simulateReconnect() {
    for (const cb of this.statusCbs) cb("closed", false);
    for (const cb of this.statusCbs) cb("open", true);
  }

  private connection: ConnectionStatus = "open";
  /** Test hook: how many times the UI asked to reconnect right away. */
  reconnectRequests = 0;

  /** Test hook: the connection drops and stays down until `reconnectNow` (or `simulateReconnect`). */
  simulateDisconnect() {
    this.connection = "closed";
    for (const cb of this.statusCbs) cb("closed", false);
  }

  reconnectNow() {
    this.reconnectRequests++;
    if (this.connection === "open") return;
    this.connection = "open";
    for (const cb of this.statusCbs) cb("open", true);
  }

  on<C extends ApiPushChannel>(channel: C, cb: (data: ApiPushes[C]) => void) {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    set.add(cb as Listener);
    return () => set.delete(cb as Listener);
  }

  async call<M extends ApiMethod>(method: M, params: ApiParams<M>): Promise<ApiResult<M>> {
    await new Promise((r) => setTimeout(r, 12 + Math.random() * 25));
    // While this browser isn't signed in, nothing gets through (like a socket that can't open).
    for (let w = this.auth.waiting; w; w = this.auth.waiting) await w;
    const h = (this.handlers as Record<string, Handler<any>>)[method];
    if (!h) throw new Error(`mock: unknown method ${method}`);
    const result = await h(params ?? {});
    return structuredClone(result);
  }

  openPty(ptyId: string): PtyConnection {
    return createMockPty(this.agent(this.ptys.get(ptyId) ?? "")?.name ?? "Yo");
  }

  vncUrl(agentId: string) {
    return `mock://vnc/${agentId}`;
  }
  fileUrl(agentId: string, path: string) {
    return `data:text/plain;charset=utf-8,${encodeURIComponent(`Mock file from ${agentId}: ${path}\n`)}`;
  }
  chatImageUrl(name: string) {
    return this.imageUrl("", `snapshot-${name}`);
  }
  imageUrl(_agentId: string, path: string, _version?: string) {
    if (path.includes("missing")) return "data:image/png;base64,broken";
    const name = path.split("/").pop() ?? path;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450"><rect width="800" height="450" fill="#2b2d31"/><text x="400" y="232" fill="#c3c2bc" font-family="sans-serif" font-size="22" text-anchor="middle">${name.replace(/[<&>"]/g, "")}</text></svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  async version() {
    // Core is down (a restart, a server update): the check gets no answer.
    if (this.connection === "closed") return null;
    return this.updates.version();
  }
  /** The HTML of Pages made in this session (create_page). */
  private pages = new Map<string, string>();
  pageUrl(id: string) {
    const a = this.s.artifacts.find((x) => x.id === id);
    const html = this.pages.get(id) ?? sampleKindHtml(a?.title ?? "Page", a?.pageKind);
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }
  artifactUrl(id: string) {
    const a = this.s.artifacts.find((x) => x.id === id);
    return `data:text/plain;charset=utf-8,${encodeURIComponent(`# ${a?.title ?? id}\n\nThis is a mock artifact.\n`)}`;
  }

  /* -------------------------------- Internals ------------------------------- */

  private emit<C extends ApiPushChannel>(channel: C, data: ApiPushes[C]) {
    // Like core's Orchestrator: a model got connected, so agents stuck on "connect a model" leave the error.
    if (channel === "account.updated" && isUsable(data as Account)) this.modelConnected();
    const set = this.listeners.get(channel);
    if (!set) return;
    const copy = structuredClone(data);
    for (const cb of set) cb(copy);
  }

  /** Agents whose last message was refused for want of a connected model. */
  private needsModel = new Set<string>();

  /** Core's runTurn refuses a message when no usable model is connected (AccountService.resolveFor). */
  private refuseWithoutModel(agentId: string): boolean {
    const a = this.agent(agentId);
    const pinned = this.account(a?.accountId);
    if (pinned ? isUsable(pinned) : this.s.accounts.some(isUsable)) return false;
    const acc = pinned ?? this.defaultAccount();
    this.notice(
      agentId,
      acc
        ? `${acc.label} isn't connected yet. Connect your subscription in Settings → Accounts, then send this again.`
        : "No model is connected yet. Connect your Claude, ChatGPT or Grok plan in Settings → Accounts, then send this again.",
      true,
    );
    this.needsModel.add(agentId);
    this.patchAgent(agentId, { activity: "error" });
    return true;
  }

  private modelConnected() {
    for (const id of this.needsModel) {
      this.notice(id, "A model is connected now. Send your message again and I'll get started.");
      this.patchAgent(id, { activity: "idle" });
    }
    this.needsModel.clear();
  }

  private sleep(ms: number, ctx?: RunCtx) {
    return new Promise<void>((resolve, reject) =>
      setTimeout(() => (ctx?.aborted ? reject(new Aborted()) : resolve()), ms * this.scale),
    );
  }

  private agent(id: string): AgentView | undefined {
    return this.s.agents.find((a) => a.id === id);
  }

  /**
   * Tests: mark Yo as working so Settings refuses to move the computer.
   * `false` settles every working agent, including the seeded helper that is mid-task.
   */
  markWorking(on = true) {
    if (!on) {
      for (const a of this.s.agents) {
        if (a.activity === "working") this.patchAgent(a.id, { activity: "idle" });
      }
      return;
    }
    const yo = this.s.agents.find((a) => a.isPrimary) ?? this.s.agents[0];
    if (!yo) return;
    this.patchAgent(yo.id, { activity: "working" });
  }

  private patchAgent(id: string, patch: Partial<AgentView>) {
    const a = this.agent(id);
    if (!a) return;
    Object.assign(a, patch);
    this.emit("agent.updated", a);
  }

  private account(id: string | null | undefined): Account | undefined {
    return this.s.accounts.find((a) => a.id === id);
  }

  private defaultAccount(): Account | undefined {
    return this.s.accounts.find((a) => a.isDefault) ?? this.s.accounts[0];
  }

  private timeline(agentId: string) {
    let t = this.s.timelines[agentId];
    if (!t) {
      t = [];
      this.s.timelines[agentId] = t;
    }
    return t;
  }

  private upsert(entry: TimelineEntry) {
    const t = this.timeline(entry.agentId);
    const i = t.findIndex((e) => e.id === entry.id);
    if (i >= 0) t[i] = entry;
    else t.push(entry);
    this.emit("timeline.upsert", entry);
  }

  private entry(agentId: string, item: Item, extra: Partial<TimelineEntry> = {}): TimelineEntry {
    return {
      id: newId("ent"),
      agentId,
      turnId: null,
      seq: this.s.seq++,
      createdAt: Date.now(),
      item,
      ...extra,
    };
  }

  /** Like core's helper retire: close its cards, archive it, and update its card in the parent's chat. */
  private retireHelper(id: string, state: "done" | "failed" | "stopped", summary: string) {
    const helper = this.agent(id);
    if (!helper) return;
    const ctx = this.runs.get(id);
    if (ctx) ctx.aborted = true;
    for (const e of this.timeline(id))
      if (e.request?.status === "pending") {
        this.upsert({
          ...e,
          request: { ...e.request, status: "expired" },
          item: { ...e.item, status: "failed" },
        });
        this.waiters.delete(e.request.requestId);
      }
    this.patchAgent(id, {
      activity: "idle",
      archivedAt: Date.now(),
      preview: null,
      computer: { state: "off", lease: "agent" },
    });
    const card = helper.parentId
      ? this.timeline(helper.parentId).find((e) => e.item.helper?.id === id)
      : undefined;
    if (card?.item.helper)
      this.upsert({
        ...card,
        item: {
          ...card.item,
          status: "completed",
          helper: { ...card.item.helper, state, summary, endedAt: Date.now() },
        },
      });
  }

  private logActivity(ev: Omit<ActivityEvent, "id" | "ts">) {
    const full: ActivityEvent = { ...ev, id: newId("act"), ts: Date.now() };
    this.s.activity.unshift(full);
    this.emit("activity.new", full);
  }

  private notice(agentId: string, title: string, failed = false) {
    this.upsert(
      this.entry(agentId, {
        id: newId("it"),
        kind: "notice",
        status: failed ? "failed" : "completed",
        title,
      }),
    );
  }

  /* ------------------------------ Run primitives ----------------------------- */

  private async step(
    ctx: RunCtx,
    kind: Item["kind"],
    title: string,
    opts: {
      input?: unknown;
      output?: string;
      ms?: number;
      toolName?: string;
      fail?: boolean;
      live?: string;
    } = {},
  ) {
    const e = this.entry(
      ctx.agentId,
      {
        id: newId("it"),
        kind,
        status: "running",
        title: opts.live ?? title,
        input: opts.input,
        toolName: opts.toolName,
      },
      { turnId: ctx.turnId },
    );
    ctx.open.add(e.id);
    this.upsert(e);
    this.patchAgent(ctx.agentId, { preview: opts.live ?? title });
    if (kind === "command" && opts.output) {
      await this.sleep(350, ctx);
      for (const line of opts.output.split("\n")) {
        if (!line) continue;
        this.emit("timeline.delta", {
          agentId: ctx.agentId,
          entryId: e.id,
          delta: `${line}\n`,
          stream: "command_output",
        });
        e.item.output = `${e.item.output ?? ""}${line}\n`;
        await this.sleep(160, ctx);
      }
    }
    await this.sleep(opts.ms ?? 1100, ctx);
    ctx.steps++;
    ctx.open.delete(e.id);
    this.upsert({
      ...e,
      item: { ...e.item, title, status: opts.fail ? "failed" : "completed", output: opts.output },
    });
  }

  private async plan(ctx: RunCtx, todos: TodoEntry[]) {
    const e = this.entry(
      ctx.agentId,
      { id: newId("it"), kind: "todo", status: "running", title: "Plan", todos },
      { turnId: ctx.turnId },
    );
    this.upsert(e);
    this.patchAgent(ctx.agentId, { todos });
    return {
      set: (i: number, status: TodoEntry["status"]) => {
        const next = (e.item.todos ?? []).map((t, j) => (j === i ? { ...t, status } : t));
        e.item = {
          ...e.item,
          todos: next,
          status: next.every((t) => t.status === "completed") ? "completed" : "running",
        };
        this.upsert({ ...e });
        this.patchAgent(ctx.agentId, { todos: next });
      },
    };
  }

  private async say(ctx: RunCtx, text: string) {
    const a = this.agent(ctx.agentId);
    const acc = this.account(a?.accountId) ?? this.defaultAccount();
    const e = this.entry(
      ctx.agentId,
      { id: newId("it"), kind: "assistant_message", status: "running", text: "" },
      { turnId: ctx.turnId, source: { provider: acc?.provider ?? "claude", model: a?.model ?? null } },
    );
    ctx.open.add(e.id);
    this.upsert(e);
    let i = 0;
    while (i < text.length) {
      if (ctx.aborted) throw new Aborted();
      const n = 2 + Math.floor(Math.random() * 6);
      const delta = text.slice(i, i + n);
      i += n;
      e.item.text = `${e.item.text}${delta}`;
      this.emit("timeline.delta", { agentId: ctx.agentId, entryId: e.id, delta, stream: "text" });
      await new Promise((r) => setTimeout(r, 22 * this.scale));
    }
    ctx.open.delete(e.id);
    this.upsert({ ...e, item: { ...e.item, status: "completed" } });
    return e;
  }

  private request(ctx: RunCtx, req: NonNullable<TimelineEntry["request"]>): Promise<Response> {
    const e = this.entry(
      ctx.agentId,
      {
        id: newId("it"),
        kind: "tool",
        status: "running",
        toolName: req.toolName ?? "ask_user",
        title: req.title,
      },
      { turnId: ctx.turnId, request: req },
    );
    this.upsert(e);
    const a = this.agent(ctx.agentId);
    this.patchAgent(ctx.agentId, {
      activity: "waiting",
      preview:
        req.kind === "user_input"
          ? `Asked: ${req.questions?.[0]?.question ?? req.title}`
          : `Needs your OK: ${req.title}`,
      statusLine:
        req.kind === "user_input"
          ? `Waiting for your answer: ${req.title}`
          : `Waiting for your OK: ${req.title}`,
    });
    this.emit("notify", {
      agentId: ctx.agentId,
      title: `${a?.name ?? "Yo"} needs you`,
      body: req.kind === "user_input" ? (req.questions?.[0]?.question ?? req.title) : req.title,
      kind: "needs_you",
    });
    if (req.kind === "tool_approval")
      this.logActivity({
        agentId: ctx.agentId,
        kind: "approval",
        summary: `Asked: ${req.title}`,
        ref: req.requestId,
      });
    return new Promise((resolve) => {
      this.waiters.set(req.requestId, (r) => {
        this.patchAgent(ctx.agentId, { activity: "working", statusLine: ctx.status });
        resolve(r);
      });
    });
  }

  private async withComputer(ctx: RunCtx) {
    const a = this.agent(ctx.agentId);
    if (!a || a.computer.state === "ready") return;
    this.patchAgent(ctx.agentId, {
      computer: { ...a.computer, state: "booting" },
      preview: "Waking up its computer…",
    });
    await this.sleep(1400, ctx);
    this.patchAgent(ctx.agentId, { computer: { ...a.computer, state: "ready" } });
  }

  private async run(
    agentId: string,
    text: string,
    script?: (ctx: RunCtx) => Promise<void>,
    route: RoutePreference = "auto",
    /** A teammate answering a handoff: no popup, like core (its reply shows in the asker's chat). */
    quiet = false,
  ) {
    const ctx: RunCtx = {
      agentId,
      turnId: newId("turn"),
      aborted: false,
      startedAt: Date.now(),
      steps: 0,
      open: new Set(),
      steer: [],
      route,
      // Like core: the request's first line until something more specific comes along.
      status: text.split("\n")[0]!.slice(0, 60) || null,
    };
    this.runs.set(agentId, ctx);
    const a = this.agent(agentId);
    this.patchAgent(agentId, {
      activity: "working",
      preview: "Thinking…",
      statusLine: ctx.status,
      lastActiveAt: Date.now(),
    });
    this.logActivity({
      agentId,
      kind: "run.started",
      summary: `Started: ${text.slice(0, 80)}`,
      ref: ctx.turnId,
    });
    try {
      await this.sleep(500, ctx);
      await this.withComputer(ctx);
      await (script ?? this.pickScript(text, agentId))(ctx);
      for (const s of ctx.steer.splice(0)) {
        await this.sleep(400, ctx);
        await this.say(
          ctx,
          `Got it — ${s.charAt(0).toLowerCase()}${s.slice(1)} is noted, and I'll factor it in from here.`,
        );
      }
      const secs = Math.round((Date.now() - ctx.startedAt) / 1000);
      const last = this.timeline(agentId)
        .filter((e) => e.item.kind === "assistant_message")
        .at(-1);
      const preview = (last?.item.text ?? "Done")
        .replace(/[*#|`>_]/g, "")
        .split("\n")[0]!
        .slice(0, 90);
      this.patchAgent(agentId, {
        activity: "done",
        preview,
        unread: (a?.unread ?? 0) + 1,
        lastActiveAt: Date.now(),
      });
      if (!quiet)
        this.emit("notify", { agentId, title: `${a?.name ?? "Yo"} is done`, body: preview, kind: "done" });
      this.logActivity({
        agentId,
        kind: "run.completed",
        summary: `Finished “${text.slice(0, 60)}” · ${ctx.steps} steps · ${secs}s`,
        ref: ctx.turnId,
      });
      setTimeout(() => {
        if (this.agent(agentId)?.activity === "done" && !this.runs.has(agentId))
          this.patchAgent(agentId, { activity: "idle" });
      }, 5000);
    } catch (err) {
      if (err instanceof Aborted) {
        for (const id of ctx.open) {
          const e = this.timeline(agentId).find((x) => x.id === id);
          if (e)
            this.upsert({
              ...e,
              item: { ...e.item, status: e.item.kind === "assistant_message" ? "completed" : "failed" },
            });
        }
        this.notice(agentId, "Stopped · you interrupted the run");
        this.patchAgent(agentId, { activity: "idle", preview: "Stopped" });
      } else {
        this.notice(agentId, String((err as Error).message ?? err), true);
        this.patchAgent(agentId, { activity: "error", preview: "Something went wrong" });
        this.logActivity({
          agentId,
          kind: "run.failed",
          summary: String((err as Error).message ?? err),
          ref: ctx.turnId,
        });
      }
    } finally {
      this.runs.delete(agentId);
      const agent = this.agent(agentId);
      this.patchAgent(agentId, { statusLine: null });
      if (agent?.todos.length) this.patchAgent(agentId, { todos: agent.todos });
      this.runNextQueued(agentId);
    }
  }

  private pickScript(text: string, agentId: string): (ctx: RunCtx) => Promise<void> {
    const t = text.toLowerCase();
    const draft = this.bugDrafts.get(agentId);
    if (draft && /^\s*(report it|yes|yep|yeah|sure|ok|okay|go ahead|please do)\b/.test(t))
      return (c) => this.bugSubmitScript(c, draft);
    if (draft && /^\s*(not now|no|nope|nah)\b/.test(t))
      return (c) =>
        this.say(c, "Okay, I won't report it. Just say so if you change your mind.").then(() => {});
    if (/\b(report|file)\b[\s\S]*\bbug\b|\blook into why\b|\bisn'?t working\b/.test(t))
      return (c) => this.bugReportScript(c);
    const teammate = handoffTarget(text, this.s.agents, agentId);
    if (teammate) return (c) => this.teamScript(c, teammate, text);
    if (/\bbrief\b/.test(t)) return (c) => this.briefScript(c);
    if (/\bchoose\b|\bwhich one\b/.test(t)) return (c) => this.repliesScript(c);
    if (/\bcode page failed\b/.test(t)) return (c) => this.secureFormFailScript(c);
    if (/\bbank password\b/.test(t)) return (c) => this.secureFormPasswordScript(c);
    if (/\buber ?eats\b/.test(t)) return (c) => this.secureFormScript(c);
    const signInTo = /\b(?:sign|log) in(?:to| to) ([a-z0-9-]+(?:\.[a-z]{2,})?)\b/i.exec(text);
    if (signInTo) return (c) => this.onePasswordScript(c, signInTo[1]!.toLowerCase());
    if (/\bset up yo phone\b|\bphone link\b/i.test(text)) {
      const label = /\bon (my [\w' -]{1,30}?)[.?!]*$/i.exec(text.trim())?.[1];
      return (c) => this.phoneLinkScript(c, label && label.toLowerCase() !== "my phone" ? label : undefined);
    }
    const hire = /\b(?:add|hire|create)\b[\s\S]*?\bagent\b[\s\S]*?\bnamed\s+([A-Z][\w-]*)/i.exec(text);
    if (hire) return (c) => this.hireScript(c, hire[1]!, text);
    if (/\bsuggest\b/.test(t)) return (c) => this.suggestScript(c);
    if (/\bsend my card\b/.test(t)) return (c) => this.cardToHotelScript(c);
    if (/\b(buy|order|purchase|checkout)\b/.test(t)) return (c) => this.shopScript(c, text);
    if (/\b(flight|flights|trip|travel|vacation|hotel)\b/.test(t)) return (c) => this.tripScript(c);
    if (/\b(fail|error|crash)\b/.test(t)) return (c) => this.errorScript(c);
    if (/\bscreenshot\b/.test(t)) return (c) => this.screenshotScript(c);
    if (/\bwindow\b|\bdesk screen\b/.test(t)) return (c) => this.windowSessionScript(c);
    if (/\b(save|write)\b[\s\S]*\bmac\b/.test(t)) return (c) => this.macWriteScript(c);
    if (/\bcalendar\b/.test(t) && /\b(add|schedule)\b/.test(t)) return (c) => this.calendarAddScript(c);
    if (
      /\b(visuali[sz]e|chart|graph|dashboard|deck|slides|make (?:me )?a (?:web )?page|make (?:me )?a design|write (?:me )?a doc)\b/.test(
        t,
      )
    )
      return (c) => this.pageScript(c, text);
    if (/\bterminal\b/.test(t)) return (c) => this.terminalScript(c);
    if (/\bdraft\b/.test(t)) return (c) => this.draftScript(c);
    if (/\bdinner party\b/.test(t)) return (c) => this.partyScript(c);
    if (/\btext sam\b/.test(t)) return (c) => this.samTextScript(c, false);
    if (/\bmake it 4 ?pm\b/.test(t)) return (c) => this.samTextScript(c, true);
    return (c) => this.researchScript(c, text);
  }

  /** suggest_task: Yo offers a next step; it shows above the message box and under Up next on the Tasks page. */
  private async suggestScript(ctx: RunCtx) {
    await this.step(ctx, "reasoning", "Looked for something useful to take on", { ms: 500 });
    const pick = this.tasks.nextChatSuggestion();
    const output = this.tasks.suggest(ctx.agentId, pick);
    await this.step(ctx, "tool", `Suggested "${pick.title}"`, {
      toolName: "mcp__yo__suggest_task",
      input: pick,
      output,
      ms: 400,
    });
    await this.say(
      ctx,
      output.startsWith("Suggested")
        ? "I added one idea above the message box. Tap Start if you'd like me to do it."
        : "I've already got a few ideas waiting for you on the Tasks page.",
    );
  }

  /** Several questions on one card, one of them "pick any". */
  private async partyScript(ctx: RunCtx) {
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "user_input",
      toolName: "AskUserQuestion",
      title: "How many people are coming?",
      questions: [
        {
          question: "How many people are coming?",
          header: "Guests",
          options: [
            { label: "2–4" },
            { label: "5–8", description: "Most recipes serve 6" },
            { label: "9 or more" },
          ],
          multiSelect: false,
        },
        {
          question: "Any food needs I should plan around?",
          header: "Diet",
          options: [
            { label: "Vegetarian" },
            { label: "Gluten-free" },
            { label: "Nut allergy" },
            { label: "None", description: "Anything goes" },
          ],
          multiSelect: true,
        },
      ],
      status: "pending",
    });
    const [guests, diet] = Object.values(r.answers ?? {});
    await this.say(
      ctx,
      `Got it: **${guests ?? "a few"} guests**, planning around **${diet ?? "nothing special"}**.\n\n` +
        "| Course | Dish | Prep |\n|---|---|---|\n" +
        "| Starter | Roasted tomato soup | 25 min |\n| Main | Mushroom risotto | 40 min |\n" +
        "| Side | Lemon green beans | 10 min |\n| Dessert | Olive oil cake | 55 min |",
    );
  }

  /** A message to send, then a revised version: the second card highlights what changed. */
  private async samTextScript(ctx: RunCtx, revised: boolean) {
    const text = revised
      ? "Hi Sam! Are we still on for coffee Friday at 4pm at the Blue Door cafe? Let me know if that works."
      : "Hi Sam! Are we still on for coffee Friday at 3pm? Let me know if that works.";
    await this.say(ctx, revised ? "Updated the time and added the place:" : "Here's a text for Sam:");
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "yo:message",
      title: "Text Sam",
      detail: text,
      input: { category: "message", recipient: "Sam" },
      status: "pending",
    });
    await this.say(ctx, r.decision === "deny" ? "Okay, I didn't send it." : "Sent to Sam.");
  }

  /** The morning brief (post_brief): a card with Needs you (each with Start), Can wait, Today, Couldn't check. */
  private async briefScript(ctx: RunCtx) {
    await this.step(ctx, "tool", "Checked your mail", { ms: 600, live: "Checking your mail…" });
    await this.step(ctx, "tool", "Checked your calendar", { ms: 500, live: "Checking your calendar…" });
    await this.step(ctx, "tool", "Posted the morning brief", {
      toolName: "mcp__yo__post_brief",
      input: {
        needs_you: [
          {
            title: "Reply to Dana about the launch date",
            detail: "She asked twice; the team is waiting on your call before Friday.",
            start: "Draft a reply to Dana about the launch date",
          },
          {
            title: "Decide on the Lisbon hotel hold",
            detail: "The hold at Casa Alfama expires at 6 PM today.",
            start: "Help me decide on the Lisbon hotel hold before 6 PM",
          },
        ],
        can_wait: [
          { title: "3 newsletters", detail: "Morning Brew, The Verge, Platformer" },
          { title: "Receipt from Bluebottle", detail: "$14.50, nothing to do" },
        ],
        today: [
          { time: "9:30 AM", title: "Team standup", detail: "Zoom" },
          { time: "12:30 PM", title: "Lunch with Priya", detail: "Tartine, Valencia St" },
          { time: "4:00 PM", title: "Dentist", detail: "Dr. Moreno" },
        ],
        could_not_check: [{ source: "Slack", why: "it isn't connected yet" }],
      },
      output:
        "The brief card is on screen (2 need them, 2 can wait, 3 on today's calendar). Don't repeat what it lists: write at most one short sentence after it, then stop.",
      live: "Putting your brief together…",
      ms: 700,
    });
    await this.say(ctx, "The Lisbon hold is the one with a clock on it: it lapses at 6 PM.");
  }

  /** A question with obvious answers: quick replies (suggest_replies) under it. */
  private async repliesScript(ctx: RunCtx) {
    await this.step(ctx, "browser", "Checked tables at Nopa", { ms: 700, live: "Checking tables at Nopa…" });
    await this.step(ctx, "tool", "Offered quick replies", {
      toolName: "mcp__yo__suggest_replies",
      input: { replies: ["Book the 8 PM", "Show other times", "Not this week"] },
      output:
        "The buttons are on screen. Ask your question in one short sentence without listing the replies.",
      ms: 300,
    });
    await this.say(ctx, "Nopa has a table for two at **8 PM** tonight. Want me to book it?");
  }

  /**
   * A Page (create_page): it opens in the page viewer and lands in Make. "Visualize…" makes the posting-activity
   * chart; "Make a dashboard / deck / doc / design / web page about X" makes that kind, titled X.
   */
  private async pageScript(ctx: RunCtx, text: string) {
    await this.step(ctx, "reasoning", "Thought about how to show it", { ms: 500 });
    const t = text.toLowerCase();
    const kind: PageKind = /\bdashboard\b/.test(t)
      ? "dashboard"
      : /\b(deck|slides)\b/.test(t)
        ? "slides"
        : /\bdoc\b/.test(t)
          ? "doc"
          : /\bdesign\b/.test(t)
            ? "design"
            : "page";
    const about = /\b(?:about|of|for)\s+(.+?)[.?!]*$/i
      .exec(text.trim())?.[1]
      ?.replace(/^(?:my|our|the)\s+/i, "");
    const title =
      /\b(visuali[sz]e|chart|graph)\b/.test(t) || !about
        ? "Posting activity by hour"
        : `${about[0]!.toUpperCase()}${about.slice(1)}`.slice(0, 80);
    const html =
      kind === "page" || kind === "dashboard" ? samplePageHtml(title) : sampleKindHtml(title, kind);
    const art: Artifact = {
      id: newId("art"),
      agentId: ctx.agentId,
      title,
      path: "Posting-activity-by-hour.html",
      mime: "text/html",
      size: html.length,
      createdAt: Date.now(),
      kind: "page",
      pageKind: kind,
      pinnedAt: null,
    };
    this.pages.set(art.id, html);
    this.s.artifacts.unshift(art);
    this.emit("artifact.new", art);
    await this.step(ctx, "tool", `Made the page “${title}”`, {
      toolName: "mcp__yo__create_page",
      input: { title, kind },
      output: `The page "${title}" is ready; the user sees it in the chat and on their Make page. [page:${art.id}]`,
      live: "Making a page…",
      ms: 900,
    });
    await this.say(
      ctx,
      title === "Posting activity by hour"
        ? "Here's your posting activity as a page. **7 pm** is your best hour."
        : `Here it is: **${title}**. It's in Make too.`,
    );
  }

  /** A message with a (made-up, test) card number in it: the approval card warns before it goes out. */
  private async cardToHotelScript(ctx: RunCtx) {
    await this.say(ctx, "Here's the email to the hotel with your card to hold the room:");
    const detail =
      "Hi, please hold our room for Friday, Oct 30 on this card: 4242 4242 4242 4242, exp 12/27. Thanks!";
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "yo:message",
      title: "Email the hotel",
      detail,
      input: { category: "message", recipient: "Front desk, Harbor Hotel" },
      sensitive: [{ kind: "card", label: "a card number ending 4242" }],
      status: "pending",
    });
    await this.say(ctx, r.decision === "deny" ? "Okay, I didn't send it." : "Sent to the hotel.");
  }

  /** A reply that tells you to run something: a fenced command to copy. */
  private async terminalScript(ctx: RunCtx) {
    await this.say(
      ctx,
      "Sure. Open **Terminal** and paste this:\n\n" +
        "```sh\nbrew install --cask yo && open -a Yo\n```\n\n" +
        "When it finishes, Yo opens on its own. Tell me if you see an error.",
    );
  }

  /** A reply with a message to send: an untagged fence, shown as a wrapped text card with Copy. */
  private async draftScript(ctx: RunCtx) {
    await this.say(
      ctx,
      "Yes. Michael replied **\"Sure\"** at 5:29 PM. Here's a draft reply. **I haven't sent it.**\n\n" +
        "```\nGreat, Michael! You can see transparent pricing on the Polestar 4 here: https://www.polestar.com/us/polestar-4/pricing-and-specs/ . Want me to hold a test drive for Saturday morning?\n```\n\n" +
        "Want me to change anything before you send it?",
    );
  }

  private async researchScript(ctx: RunCtx, text: string) {
    const topic = text.replace(/[?.!]+$/, "").slice(0, 60);
    const p = await this.plan(ctx, [
      { text: "Search for good sources", status: "in_progress" },
      { text: "Read and compare the top results", status: "pending" },
      { text: "Write up the answer", status: "pending" },
    ]);
    await this.step(ctx, "reasoning", "Thought about the approach", { ms: 700 });
    await this.step(ctx, "web", `Searched “${topic}”`, {
      input: { query: topic },
      live: "Searching the web…",
    });
    p.set(0, "completed");
    p.set(1, "in_progress");
    await this.step(ctx, "browser", "Opened en.wikipedia.org", {
      input: { url: "https://en.wikipedia.org/wiki/Special:Search" },
      live: "Opening en.wikipedia.org…",
      ms: 1500,
    });
    await this.step(ctx, "browser", "Opened news.ycombinator.com", {
      input: { url: "https://news.ycombinator.com" },
      live: "Opening news.ycombinator.com…",
      ms: 1300,
    });
    await this.step(ctx, "command", "Ran `ls ~/Downloads`", {
      input: { command: "ls ~/Downloads" },
      output: "receipt-112-4471.pdf\nprices.csv",
      live: "Running `ls ~/Downloads`…",
      ms: 500,
    });
    p.set(1, "completed");
    p.set(2, "in_progress");
    await this.step(ctx, "file_change", "Created ~/Documents/notes.md", {
      input: { path: "/home/agent/Documents/notes.md" },
      ms: 600,
    });
    p.set(2, "completed");
    await this.say(
      ctx,
      `Here's what I found about **${topic}**:\n\n` +
        "- **Short answer:** the consensus from recent sources is clear, and the details below back it up.\n" +
        "- **Best source:** the Wikipedia overview, cross-checked with two independent write-ups.\n" +
        "- **Worth knowing:** opinions differ on cost, so I noted the trade-offs.\n\n" +
        "| Source | Takeaway |\n|---|---|\n| Wikipedia | Solid background and history |\n| Hacker News | Practical, first-hand experiences |\n\n" +
        "I saved my notes to `~/Documents/notes.md` on my computer. Want me to turn this into a one-page brief?",
    );
  }

  /**
   * message_agent, as core does it (./team.ts): an async handoff by default. The row says "Sent to Dew" at once
   * and the asker's turn ends; Dew works on it in its own chat, and its reply comes back to the asker later as a
   * message from Dew that starts a short turn. "… and wait" (wait: true) keeps the row waiting for the reply.
   */
  private async teamScript(ctx: RunCtx, teammate: AgentView, text: string) {
    const me = this.agent(ctx.agentId);
    const topic = handoffTopic(text, teammate.name);
    const message = handoffMessage(teammate.name, topic);
    const wait = handoffWaits(text);
    const exchangeId = newId("xch");
    const e = this.entry(
      ctx.agentId,
      {
        id: newId("it"),
        kind: "tool",
        status: wait ? "running" : "completed",
        toolName: "mcp__yo__message_agent",
        title: `Messaged ${teammate.name}`,
        input: { to: teammate.name, message, ...(wait ? { wait: true } : {}) },
        ...(wait ? {} : { output: handoffAck(teammate.name, exchangeId, this.runs.has(teammate.id)) }),
      },
      { turnId: ctx.turnId },
    );
    this.upsert(e);
    ctx.steps++;
    const from = { agentId: ctx.agentId, name: me?.name ?? "Yo" };
    const work = this.teammateWorks(from, teammate, message, topic, wait ? null : exchangeId);
    if (!wait) {
      await this.say(ctx, handoffSaid(teammate.name));
      void work.then((reply) => this.replyArrives(ctx.agentId, teammate, topic, exchangeId, reply));
      return;
    }
    ctx.open.add(e.id);
    this.patchAgent(ctx.agentId, { preview: `Waiting for ${teammate.name}…` });
    const reply = await work;
    ctx.open.delete(e.id);
    this.upsert({
      ...e,
      item: {
        ...e.item,
        status: "completed",
        output:
          reply === null
            ? `${teammate.name} was stopped before replying.`
            : `${teammate.name} replied:\n\n${reply}`,
      },
    });
    if (reply !== null) await this.say(ctx, handoffSummary(teammate.name, topic));
  }

  /**
   * The teammate's side of a handoff: the message lands in its chat (after the task it's on) and it works on it
   * there. Resolves with its reply, or null if it was stopped first.
   */
  private async teammateWorks(
    from: { agentId: string; name: string },
    teammate: AgentView,
    message: string,
    topic: string,
    exchangeId: string | null,
  ): Promise<string | null> {
    await this.sleep(600);
    while (this.runs.has(teammate.id)) await this.sleep(500);
    this.upsert(
      this.entry(teammate.id, {
        id: newId("it"),
        kind: "user_message",
        status: "completed",
        text: message,
        from: { ...from, ...(exchangeId ? { exchangeId } : {}) },
      }),
    );
    let reply: string | null = null;
    const answer = async (c: RunCtx) => {
      c.status = `For ${from.name}: ${topic || "a request"}`;
      this.patchAgent(teammate.id, { statusLine: c.status });
      await this.step(c, "web", `Searched for ${topic || "it"}`, { live: "Searching…", ms: 1400 });
      await this.step(c, "browser", "Read three sources", { toolName: "browser", ms: 1200 });
      const text = handoffReply(topic);
      await this.say(c, text);
      reply = text;
    };
    await this.run(teammate.id, message, answer, "auto", true);
    return reply;
  }

  /** An async handoff's reply comes back: a message from the teammate in the asker's chat, then a short turn. */
  private async replyArrives(
    askerId: string,
    teammate: AgentView,
    topic: string,
    exchangeId: string,
    reply: string | null,
  ) {
    if (reply === null) {
      this.notice(askerId, `${teammate.name} was stopped before replying.`);
      return;
    }
    while (this.runs.has(askerId)) await this.sleep(500);
    this.upsert(
      this.entry(askerId, {
        id: newId("it"),
        kind: "user_message",
        status: "completed",
        text: reply,
        from: { agentId: teammate.id, name: teammate.name, exchangeId, reply: true },
      }),
    );
    await this.run(askerId, reply, async (c) => {
      c.status = `Reading ${teammate.name}'s reply`;
      this.patchAgent(askerId, { statusLine: c.status });
      await this.say(c, handoffSummary(teammate.name, topic));
    });
  }

  /** A new teammate's first turn: hello, then one multiple-choice question about its job. */
  private async helloScript(ctx: RunCtx) {
    const a = this.agent(ctx.agentId);
    if (!a) return;
    const intro = teammateHello(a);
    ctx.status = "Saying hello";
    this.patchAgent(a.id, { statusLine: ctx.status });
    await this.say(ctx, intro.hello);
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "user_input",
      toolName: "ask_user",
      title: intro.question.question,
      questions: [intro.question],
      status: "pending",
    });
    const answer = r.message || Object.values(r.answers ?? {})[0] || intro.question.options[0]!.label;
    await this.say(ctx, intro.next(answer));
  }

  private opPush(s: OnePasswordStatus): OnePasswordStatus {
    this.emit("onePassword.updated", s);
    return s;
  }

  /** A 1Password sign-in: search, open the page, the user's OK, then the login is typed (never shown). */
  private async onePasswordScript(ctx: RunCtx, site: string) {
    const host = site.includes(".") ? site : `${site}.com`;
    const first = host.split(".")[0]!;
    const name = first === "github" ? "GitHub" : first.replace(/^./, (c) => c.toUpperCase());
    if (!this.onePassword.connected) {
      await this.say(
        ctx,
        `I need to sign in to ${host}. 1Password isn't connected, so could you take over my screen and sign in? Or connect 1Password in Settings → Accounts and I'll do it myself next time.`,
      );
      return;
    }
    await this.step(ctx, "tool", `Found the 1Password login “${name}”`, {
      toolName: "onepassword_search",
      input: { query: host },
      ms: 700,
    });
    await this.step(ctx, "browser", `Opened ${host}/login`, {
      input: { url: `https://${host}/login` },
      live: `Opening ${host}…`,
      ms: 1100,
    });
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "yo:1password",
      title: `Sign in to ${host} with 1Password?`,
      detail: `Yo types the username and password from your 1Password login "${name}" into the page on ${host} and submits it. Yo never sees them.`,
      input: { site: host, login: name },
      status: "pending",
    });
    if (r.decision === "deny") {
      await this.say(ctx, `Okay, I won't sign in to ${host}.`);
      return;
    }
    await this.step(ctx, "tool", `Filled the username and password from “${name}” on ${host}`, {
      toolName: "onepassword_fill",
      input: { item_ref: "1p:vlt_yo/itm_demo" },
      ms: 900,
    });
    this.onePassword.recordUse({
      at: Date.now(),
      item: name,
      site: host,
      fields: ["username", "password"],
      agentName: "Yo",
    });
    this.opPush(this.onePassword.status());
    await this.say(ctx, `I'm signed in to ${host}. What should I do there?`);
  }

  /**
   * request_secure_input: Uber texts a code, the user types it into the secure form, and it goes into the page.
   * Like core, the value is never kept: request.respond only marks the card answered.
   */
  private async secureFormScript(ctx: RunCtx) {
    await this.step(ctx, "browser", "Opened auth.uber.com", {
      input: { url: "https://auth.uber.com/login" },
      live: "Opening uber.com…",
      ms: 1000,
    });
    await this.step(ctx, "browser", "Entered your phone number and asked Uber for a code", { ms: 900 });
    // The page that was opened, not the broader site. The card's key line uses this host.
    const site = "auth.uber.com";
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "user_input",
      toolName: SECURE_INPUT_TOOL,
      title: `One-time code for ${site}`,
      detail: "Uber texted a code to sign you in.",
      input: { site },
      secureForm: {
        site,
        reason: "Uber texted a code to sign you in.",
        fields: [{ kind: "one_time_code", label: "Code from the text message" }],
      },
      status: "pending",
    });
    if (r.decision === "deny") {
      await this.say(ctx, "Okay, I didn't sign in to Uber Eats. Tell me if you'd like to try again.");
      return;
    }
    await this.step(ctx, "browser", "Took a snapshot of auth.uber.com", { ms: 700 });
    await this.say(ctx, "I'm signed in to Uber Eats. What would you like to order?");
  }

  /**
   * A password field: the card's caution and the agent's reason are separate, so a convincing reason can't
   * pretend to be the app telling you which site this is.
   */
  private async secureFormPasswordScript(ctx: RunCtx) {
    const site = "online.bank.example";
    const reason =
      "GitHub security: your account is locked. Enter the password for github.com to verify you are the owner.";
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "user_input",
      toolName: SECURE_INPUT_TOOL,
      title: `Password for ${site}`,
      detail: reason,
      input: { site },
      secureForm: {
        site,
        reason,
        fields: [{ kind: "password", label: "GitHub password" }],
      },
      status: "pending",
    });
    if (r.decision === "deny") {
      await this.say(ctx, "Okay, I didn't sign in.");
      return;
    }
    await this.say(ctx, "Signed in to the bank.");
  }

  /** The fill fails after the user submits. The card says so, and the value is not kept. */
  private async secureFormFailScript(ctx: RunCtx) {
    this.failNextSecureForm = true;
    const site = "auth.example.com";
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "user_input",
      toolName: SECURE_INPUT_TOOL,
      title: `One-time code for ${site}`,
      detail: "The page asked for a code.",
      input: { site },
      secureForm: {
        site,
        reason: "The page asked for a code.",
        fields: [{ kind: "one_time_code", label: "Code from the text message" }],
      },
      status: "pending",
    });
    if (r.decision === "deny") {
      await this.say(ctx, "Okay, I didn't type the code.");
      return;
    }
    await this.say(ctx, "I couldn't type the code into the page. Ask me to try again.");
  }

  /** create_phone_link: the user approves a card, then Yo hands over the link. */
  private async phoneLinkScript(ctx: RunCtx, label?: string) {
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "yo:create_phone_link",
      title: `Create a phone link for ${label ?? "your phone"}?`,
      detail: "Anyone with the link can talk to Yo as you. A new link turns off the old one.",
      ...(label ? { input: { label } } : {}),
      status: "pending",
    });
    if (r.decision === "deny") {
      await this.say(ctx, "Okay, I didn't make a phone link.");
      return;
    }
    // Like core: the link never goes into the chat, only into Settings → Phone.
    this.phone.pair();
    await this.say(
      ctx,
      "Done. Your phone link is in Settings → Phone. Open it on your phone, then tap Share → Add to Home Screen. Keep it to yourself: anyone with it can talk to me as you.",
    );
  }

  /** create_agent: the user approves a card, then the new agent joins the sidebar. */
  private async hireScript(ctx: RunCtx, name: string, text: string) {
    const role = /\brole\b(?:\s+(?:is|will be|as))?\s+([^.,;]+)/i.exec(text)?.[1]?.trim() ?? "";
    const label = role ? `${name}, ${role}` : name;
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "yo:create_agent",
      title: `Add a new agent: ${label}`,
      detail: role ? `${name} will join as ${role} and report back to me.` : `${name} will join the team.`,
      input: { name, ...(role ? { role } : {}) },
      status: "pending",
    });
    if (r.decision === "deny") {
      await this.say(ctx, `Okay, I won't add ${name}.`);
      return;
    }
    this.handlers["agent.create"]({
      name,
      role,
      instructions: "",
      avatar: teammateAvatar(this.s.agents),
      introduce: true,
    });
    await this.say(ctx, `${name} has joined the team and is saying hello. I'll hand ${name} work from here.`);
  }

  private async shopScript(ctx: RunCtx, text: string) {
    const what =
      text.replace(/^.*?\b(buy|order|purchase)\b\s*(me\s*)?/i, "").replace(/[?.!]+$/, "") || "that";
    await this.step(ctx, "browser", "Opened amazon.com", {
      input: { url: "https://www.amazon.com" },
      live: "Opening amazon.com…",
      ms: 1300,
    });
    await this.step(ctx, "browser", `Searched Amazon for “${what.slice(0, 40)}”`, {
      input: { url: `https://www.amazon.com/s?k=${encodeURIComponent(what)}` },
      ms: 1200,
    });
    await this.step(ctx, "tool", "Compared 12 listings", { toolName: "compare", ms: 900 });
    await this.say(
      ctx,
      `Found a great option: **${what}** for **$24.99** with free delivery tomorrow. I need your OK to buy it.`,
    );
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "request_approval",
      title: `Buy ${what.slice(0, 48)} for $24.99`,
      detail: "Amazon.com · Visa ending 4242 · Arrives tomorrow",
      input: { category: "purchase", total: "$24.99" },
      status: "pending",
    });
    await this.afterApproval(ctx, r);
  }

  private async afterPublish(ctx: RunCtx, r: Response) {
    if (r.decision === "deny") {
      await this.say(ctx, "Okay, it stays on my computer for now. Say the word and I'll publish it.");
      return;
    }
    await this.step(ctx, "browser", "Opened rsvp-saturday.pages.dev", {
      input: { url: "https://rsvp-saturday.pages.dev" },
      live: "Publishing…",
      ms: 1400,
    });
    await this.say(
      ctx,
      "It's live at **rsvp-saturday.pages.dev**. I'll tell you when the first RSVP comes in.",
    );
  }

  private async afterApproval(ctx: RunCtx, r: Response) {
    if (r.decision === "deny") {
      await this.say(ctx, "No problem — I didn't buy anything. Want me to keep an eye on the price instead?");
      return;
    }
    await this.step(ctx, "browser", "Placed the order on amazon.com", {
      input: { url: "https://www.amazon.com/gp/buy/thankyou" },
      live: "Checking out…",
      ms: 1400,
    });
    await this.say(
      ctx,
      "Done! Order **#112-4471903** is confirmed. I saved the receipt to `~/Downloads` on my computer.",
    );
  }

  private async tripScript(ctx: RunCtx) {
    await this.step(ctx, "browser", "Opened google.com/travel/flights", {
      input: { url: "https://www.google.com/travel/flights" },
      live: "Opening Google Flights…",
      ms: 1400,
    });
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "user_input",
      toolName: "ask_user",
      title: "A quick question",
      questions: [
        {
          question: "Which dates work best for you?",
          header: "Dates",
          options: [
            { label: "Oct 10 – 14", description: "Cheapest · from $312" },
            { label: "Oct 17 – 21", description: "More nonstop options" },
            { label: "I'm flexible" },
          ],
          multiSelect: false,
        },
      ],
      status: "pending",
    });
    const answer = r.message || Object.values(r.answers ?? {})[0] || "those dates";
    await this.step(ctx, "web", `Searched flights for ${answer}`, { ms: 1200 });
    await this.say(
      ctx,
      `Great — **${answer}**. Here are the best nonstop options:\n\n` +
        "| Airline | Depart | Price |\n|---|---|---|\n| JetBlue | 7:05 AM | **$318** |\n| Delta | 9:40 AM | $352 |\n| United | 1:15 PM | $361 |\n\n" +
        "Window seats are open on all three. Want me to hold the JetBlue one?",
    );
  }

  private async screenshotScript(ctx: RunCtx) {
    await this.step(ctx, "browser", "Took a screenshot", { ms: 500 });
    await this.say(
      ctx,
      "Here it is:\n\n![Desk – 27mo/7.5k](/data/home/agents/agt_yo/desk/desk.png)\n\nAnd one that no longer exists:\n\n![Old desk](~/desk/gone-missing.png)",
    );
  }

  /** report_bug, stage 1: investigate, then a red draft with a suspected cause and a fix, and ask. */
  private async bugReportScript(ctx: RunCtx) {
    await this.step(ctx, "reasoning", "Thought about what to check first", { ms: 600 });
    await this.step(ctx, "command", "Ran `tail -n 3 ~/.yo/logs/agentd.log`", {
      input: { command: "tail -n 3 ~/.yo/logs/agentd.log" },
      output:
        'GET /files?path=/home/agent/desk/desk.png 200 etag "9f2c"\nGET /files?path=/home/agent/desk/desk.png 304 Not Modified\nGET /files?path=/home/agent/desk/desk.png 304 Not Modified',
      live: "Reading the logs…",
      ms: 500,
    });
    await this.step(ctx, "browser", "Reopened the chat picture", {
      input: { url: "http://localhost/api/chat-images/desk.png" },
      live: "Reopening the picture…",
      ms: 800,
    });
    const title = "Chat shows an old image after overwrite";
    const draftId = newId("bdr");
    await this.step(ctx, "tool", "Drafted a bug report", {
      toolName: "mcp__yo__report_bug",
      input: {
        stage: "draft",
        title,
        what_happened:
          "I redid the desk screenshot at the same path and embedded it again, but the new message still showed the old picture ($76,022).",
        expected: "The new message shows the new picture ($74,168); older messages keep theirs.",
        steps: ["Embed ~/desk/desk.png in a reply", "Overwrite desk.png", "Embed it again in a new reply"],
        evidence:
          'GET /files?path=/home/agent/desk/desk.png 304 Not Modified (same URL and ETag "9f2c" before and after)',
        suspected_cause:
          "Both messages point at the same image URL, so the app keeps showing its cached copy after the file changes.",
        suggested_fix:
          "Give each embedded picture its own address (e.g. by content hash) when the message is written, so a redone picture never reuses the old one.",
        area: "chat",
        severity: "medium",
      },
      output: `Draft saved [bug-draft:${draftId}]. Nothing has been sent.`,
      ms: 900,
    });
    this.bugDrafts.set(ctx.agentId, { draftId, title });
    await this.say(
      ctx,
      "I looked into it: the picture is cached under the same address, so a redone screenshot keeps showing the old one. " +
        "I'd fix it by giving every embedded picture its own address when the message is written.\n\n**Would you like me to report it?**",
    );
  }

  /** report_bug, stage 2 (after "Report it"): filed as an issue, or saved with an "Open on GitHub" link. */
  private async bugSubmitScript(ctx: RunCtx, draft: { draftId: string; title: string }) {
    this.bugDrafts.delete(ctx.agentId);
    const { configured, inbox, repo } = this.bugFiling;
    const number = configured ? ++this.bugIssueSeq : undefined;
    const reportId = !configured && inbox && !this.bugInboxDown ? this.nextReportId() : undefined;
    const issueUrl = number
      ? `https://github.com/${repo}/issues/${number}`
      : `https://github.com/${repo}/issues/new?title=${encodeURIComponent(draft.title)}&labels=bug,from-yo&body=${encodeURIComponent("## What happened\n\nThe chat showed an old image after overwrite.")}`;
    const art: Artifact = {
      id: newId("art"),
      agentId: ctx.agentId,
      title: `Bug: ${draft.title}`,
      path: "bug-reports/bug-2026-10-01-chat-shows-an-old-image-after-overwrite.md",
      mime: "text/markdown",
      size: 1840,
      createdAt: Date.now(),
      kind: "bug",
      ...(number || !inbox ? { issue: number ? { number, url: issueUrl } : { url: issueUrl } } : {}),
      ...(inbox && !number
        ? {
            report: reportId
              ? { status: "sent" as const, reportId, sentAt: Date.now(), attempts: 1 }
              : { status: "pending" as const, attempts: 1, nextTryAt: Date.now() + 60_000 },
          }
        : {}),
    };
    this.s.artifacts.unshift(art);
    this.emit("artifact.new", art);
    await this.step(ctx, "tool", "Sent the bug report", {
      toolName: "mcp__yo__report_bug",
      input: { stage: "submit", draft_id: draft.draftId },
      output: number
        ? `Reported: filed as GitHub issue #${number} (${issueUrl}) [artifact:${art.id}].`
        : reportId
          ? `Reported: sent to the developer as ${reportId} [artifact:${art.id}].`
          : inbox
            ? `Saved the bug report [artifact:${art.id}]. Yo's bug inbox couldn't take it right now, so Yo will keep trying for up to a day.`
            : `Saved the bug report [artifact:${art.id}], but it wasn't sent: GitHub filing isn't set up (Settings → Bug reports).`,
      ms: 1200,
    });
    await this.say(
      ctx,
      number
        ? `Done — it's filed as issue #${number}.`
        : reportId
          ? `Done — it's sent as ${reportId}.`
          : inbox
            ? "Saved it. I'll keep trying to send it."
            : "Saved it. GitHub filing isn't set up, so tap **Open on GitHub** on the card to send it.",
    );
  }

  private nextReportId() {
    const n = ++this.bugReportSeq;
    return `YO-${(0x4b7c2 + n * 7919).toString(36).toUpperCase().padStart(6, "Q").slice(-6)}`;
  }

  /** The draft (from the chat) or the form's fields, as core would read them. */
  private bugReportOf(p: BugReportSend) {
    if (p.draftId) {
      const entry = Object.values(this.s.timelines)
        .flat()
        .find(
          (e) =>
            e.item.toolName === "mcp__yo__report_bug" &&
            String(e.item.output ?? "").includes(`[bug-draft:${p.draftId}]`),
        );
      const input = (entry?.item.input ?? {}) as Record<string, any>;
      if (!entry) throw new Error("That bug report draft is gone.");
      return { agentId: entry.agentId, source: "agent" as const, f: input };
    }
    const what = p.report?.what_happened?.trim();
    if (!what) throw new Error("Say what happened first.");
    const agentId =
      (p.agentId && this.s.agents.find((a) => a.id === p.agentId)?.id) ??
      this.s.agents.find((a) => a.isPrimary)?.id ??
      this.s.agents[0]!.id;
    const title = what.split("\n")[0]!.slice(0, 80);
    return { agentId, source: "user" as const, f: { title, what_happened: what, ...p.report } };
  }

  private bugPreview(p: BugReportSend): BugReportPreview {
    const { source, f } = this.bugReportOf(p);
    const sec = (h: string, b?: string) => `## ${h}\n\n${b?.trim() || "_Not provided._"}\n`;
    const reportMd = [
      `# Bug: ${f.title}`,
      "",
      `${source === "user" ? "Reported by the user (Settings → Bug reports)" : "Reported by Yo (Yo's agent)"} on ${new Date().toISOString()}.\n`,
      sec("What happened", f.what_happened),
      sec("Expected", f.expected),
      sec("Steps to reproduce", (f.steps ?? []).map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")),
      ...(source === "agent"
        ? [sec("Suspected cause", f.suspected_cause), sec("Suggested fix", f.suggested_fix)]
        : []),
      sec(
        "Environment",
        "- Yo 0.1.312 (build 312-abc1234)\n- Yo core on Darwin 25.0.0 (darwin/arm64), Node 22.12.0",
      ),
    ].join("\n");
    const files = [
      { name: "report.md", bytes: reportMd.length },
      { name: "environment.json", bytes: 1184 },
      { name: "core-log.txt", bytes: 38_912 },
      ...(p.includeChat ? [{ name: "chat-excerpt.json", bytes: 14_336 }] : []),
    ];
    return { title: f.title, files, reportMd };
  }

  private bugSend(p: BugReportSend): BugReportSent {
    const { agentId, f } = this.bugReportOf(p);
    if (p.draftId) {
      const done = this.s.artifacts.find((a) => a.report?.draftId === p.draftId);
      if (done) return { status: done.report!.status, artifactId: done.id, reportId: done.report!.reportId };
      for (const [k, v] of this.bugDrafts) if (v.draftId === p.draftId) this.bugDrafts.delete(k);
    }
    const reportId = this.bugInboxDown ? undefined : this.nextReportId();
    const slug = String(f.title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
    const art: Artifact = {
      id: newId("art"),
      agentId,
      title: `Bug: ${f.title}`,
      path: `bug-reports/bug-${new Date().toISOString().slice(0, 10)}-${slug || "bug"}.md`,
      mime: "text/markdown",
      size: 1840,
      createdAt: Date.now(),
      kind: "bug",
      report: {
        ...(reportId
          ? { status: "sent" as const, reportId, sentAt: Date.now() }
          : { status: "pending" as const, nextTryAt: Date.now() + 60_000 }),
        attempts: 1,
        includeChat: p.includeChat,
        ...(p.draftId ? { draftId: p.draftId } : {}),
      },
    };
    this.s.artifacts.unshift(art);
    this.emit("artifact.new", art);
    return { status: reportId ? "sent" : "pending", artifactId: art.id, ...(reportId ? { reportId } : {}) };
  }

  private async errorScript(ctx: RunCtx) {
    await this.step(ctx, "command", "Ran `curl https://example.invalid`", {
      input: { command: "curl https://example.invalid" },
      output: "curl: (6) Could not resolve host: example.invalid",
      fail: true,
      ms: 600,
    });
    this.notice(ctx.agentId, "Network error · couldn't reach example.invalid", true);
    await this.say(
      ctx,
      "I couldn't reach that site — it looks like the domain doesn't exist. Want me to try another source?",
    );
  }

  /** Save a notes file into the shared ~/Projects/Site folder on the paired Mac (exact-file approval). */
  private async macWriteScript(ctx: RunCtx) {
    const stop = async (target: RouteDecision["target"], reason: RouteDecision["reason"], text: string) => {
      this.decideRoute(ctx, target, null, "files.write", reason, text);
      await this.say(ctx, text);
    };
    if (ctx.route === "agent-computer")
      return stop(
        "agent-computer",
        "route-restricted",
        "You asked me to stay in my private workspace for this message, so I didn't touch your Mac. The notes are in `~/Documents/site-notes.md` on my computer.",
      );
    if (!this.s.settings.macAccess)
      return stop(
        "agent-computer",
        "disabled",
        "Mac access is turned off in Settings → Devices & access, so I can't save to your Mac.",
      );
    const device = this.s.execution.devices.find((d) => !d.revokedAt);
    if (!device)
      return stop("agent-computer", "needs-pairing", "No Mac is paired with Yo yet, so I can't save there.");
    if (!device.online || device.paused)
      return stop(
        "agent-computer",
        device.paused ? "paused" : "offline",
        `${device.name} is ${device.paused ? "paused" : "offline"}, so I can't save there right now.`,
      );
    const grant = this.s.execution.grants.find(
      (g) => g.deviceId === device.id && !g.revokedAt && g.kind !== "app" && g.mode === "read-write",
    );
    if (!grant)
      return stop(
        "agent-computer",
        "grant-read-only",
        `Nothing on ${device.name} is shared with “Read and change” access, so I can't save there.`,
      );
    if (!this.s.settings.macWrites)
      return stop(
        "agent-computer",
        "disabled",
        "Changing files on your Mac is turned off. Turn on “Allow approved changes” in Settings → Devices & access and ask again.",
      );

    await this.step(ctx, "file_change", "Wrote site-notes.md", { ms: 600 });
    const displayPath = `${grant.displayPath}/notes.md`;
    const bytes = new TextEncoder().encode(MAC_NOTES).length;
    const op = this.recordOperation({
      id: newId("op"),
      agentId: ctx.agentId,
      turnId: ctx.turnId,
      deviceId: device.id,
      grantId: grant.id,
      capability: "files.write",
      displayPath,
      status: "awaiting-approval",
      reason: null,
      bytes,
      sha256: "9f2c4b1e7d0a3c5e8f6b2d4a1c3e5f7a9b0d2c4e6f8a1b3c5d7e9f0a2b4c6d8e",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.decideRoute(
      ctx,
      "device",
      device.id,
      "files.write",
      "dedicated-command",
      `Saving ${displayPath} on ${device.name} (needs your approval)`,
    );
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "mac_write_file",
      title: `Replace “notes.md” on ${device.name}`,
      detail: `${displayPath} on ${device.name}`,
      deviceWrite: {
        operationId: op.id,
        deviceName: device.name,
        displayPath,
        bytes,
        sha256: op.sha256!,
        replaces: { bytes: 2_048, modifiedAt: Date.now() - 2 * 24 * 3600_000 },
        preview: MAC_NOTES,
        expiresAt: Date.now() + 10 * 60_000,
      },
      status: "pending",
    });
    if (r.decision === "deny") {
      this.recordOperation({ ...op, status: "denied", reason: "user declined", updatedAt: Date.now() });
      await this.say(
        ctx,
        `OK — I didn't change ${displayPath}. The notes are still on my computer if you want them.`,
      );
      return;
    }
    this.recordOperation({ ...op, status: "dispatching", updatedAt: Date.now() });
    await this.sleep(700, ctx);
    this.recordOperation({ ...op, status: "succeeded", updatedAt: Date.now() });
    this.logActivity({
      agentId: ctx.agentId,
      kind: "device",
      summary: `Saved ${displayPath} on ${device.name}`,
      ref: op.id,
    });
    await this.say(ctx, `Saved — \`${displayPath}\` on ${device.name} now has the updated notes.`);
  }

  /** Add an event to the shared Calendar on the paired Mac (exact-action approval, like core's). */
  private async calendarAddScript(ctx: RunCtx) {
    const stop = async (target: RouteDecision["target"], reason: RouteDecision["reason"], text: string) => {
      this.decideRoute(ctx, target, null, "calendar.write", reason, text);
      await this.say(ctx, text);
    };
    if (ctx.route === "agent-computer")
      return stop(
        "agent-computer",
        "route-restricted",
        "You asked me to stay in my private workspace for this message, so I didn't touch your Calendar.",
      );
    if (!this.s.settings.macAccess)
      return stop(
        "agent-computer",
        "disabled",
        "Mac access is turned off in Settings → Devices & access, so I can't use your Calendar.",
      );
    const device = this.s.execution.devices.find((d) => !d.revokedAt);
    if (!device) return stop("agent-computer", "needs-pairing", "No Mac is paired with Yo yet.");
    if (!device.online || device.paused)
      return stop(
        "agent-computer",
        device.paused ? "paused" : "offline",
        `${device.name} is ${device.paused ? "paused" : "offline"}, so I can't reach its Calendar right now.`,
      );
    const grant = this.s.execution.grants.find(
      (g) => g.deviceId === device.id && !g.revokedAt && g.kind === "app" && g.app === "calendar",
    );
    if (!grant)
      return stop(
        "agent-computer",
        "needs-grant",
        "Your Calendar isn't shared with Yo. You can allow it in Settings → Devices & access → Apps.",
      );
    if (grant.mode !== "read-write")
      return stop(
        "agent-computer",
        "grant-read-only",
        "Calendar is shared read-only. You can allow changes in Settings → Devices & access.",
      );
    if (!this.s.settings.macWrites)
      return stop(
        "agent-computer",
        "disabled",
        "Changes on your Mac are turned off. Turn on “Allow approved changes” in Settings → Devices & access and ask again.",
      );

    await this.step(ctx, "tool", "Checked Calendar", { toolName: "mac_calendar_events", ms: 500 });
    const title = "Add “Call Alex” to Home";
    const op = this.recordOperation({
      id: newId("op"),
      agentId: ctx.agentId,
      turnId: ctx.turnId,
      deviceId: device.id,
      grantId: grant.id,
      capability: "calendar.write",
      displayPath: `Calendar: ${title}`,
      status: "awaiting-approval",
      reason: null,
      bytes: null,
      sha256: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.decideRoute(
      ctx,
      "device",
      device.id,
      "calendar.write",
      "dedicated-command",
      `${title} on ${device.name} (needs your approval)`,
    );
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "mac_calendar_add",
      title: `${title} on ${device.name}`,
      deviceAction: {
        operationId: op.id,
        deviceName: device.name,
        app: "calendar",
        lines: [
          { label: "Calendar", value: "Home · iCloud" },
          { label: "Title", value: "Call Alex" },
          { label: "When", value: "Fri, Oct 2, 10:00 AM – 10:30 AM" },
          { label: "Invites", value: "None (nobody is notified)" },
        ],
        expiresAt: Date.now() + 10 * 60_000,
      },
      status: "pending",
    });
    if (r.decision === "deny") {
      this.recordOperation({ ...op, status: "denied", reason: "user declined", updatedAt: Date.now() });
      await this.say(ctx, "OK — I didn't add it. Your Calendar is unchanged.");
      return;
    }
    this.recordOperation({ ...op, status: "dispatching", updatedAt: Date.now() });
    await this.sleep(700, ctx);
    this.recordOperation({ ...op, status: "succeeded", updatedAt: Date.now() });
    this.logActivity({
      agentId: ctx.agentId,
      kind: "device",
      summary: `Added “Call Alex” to Home on ${device.name}`,
      ref: op.id,
    });
    await this.say(ctx, "Added it.");
  }

  /**
   * Use one window on the paired Mac (R3): ask for a session on “CDK Desking” in Chrome for 10 minutes.
   * Allowing it starts the session on the fake Mac (the app shows it with Stop).
   */
  private async windowSessionScript(ctx: RunCtx) {
    const stop = async (target: RouteDecision["target"], reason: RouteDecision["reason"], text: string) => {
      this.decideRoute(ctx, target, null, "window.control", reason, text);
      await this.say(ctx, text);
    };
    if (ctx.route === "agent-computer")
      return stop(
        "agent-computer",
        "route-restricted",
        "You asked me to stay in my private workspace for this message, so I didn't use any window on your Mac.",
      );
    if (!this.s.settings.macAccess)
      return stop(
        "agent-computer",
        "disabled",
        "Mac access is turned off in Settings → Devices & access, so I can't use a window on your Mac.",
      );
    if (!this.s.settings.macControl)
      return stop(
        "agent-computer",
        "disabled",
        "Window control is off. Turn on “Let Yo use a window you approve” in Settings → Devices & access and ask again.",
      );
    const device = this.s.execution.devices.find((d) => !d.revokedAt);
    if (!device) return stop("agent-computer", "needs-pairing", "No Mac is paired with Yo yet.");
    if (!device.online || device.paused)
      return stop(
        "agent-computer",
        device.paused ? "paused" : "offline",
        `${device.name} is ${device.paused ? "paused" : "offline"}, so I can't use its windows right now.`,
      );
    const grant = this.s.execution.grants.find(
      (g) => g.deviceId === device.id && !g.revokedAt && g.kind === "app" && g.app === "screen",
    );

    await this.step(ctx, "tool", `Listed windows on ${device.name}`, { toolName: "mac_windows", ms: 500 });
    const title = "Use “Chrome” window";
    const op = this.recordOperation({
      id: newId("op"),
      agentId: ctx.agentId,
      turnId: ctx.turnId,
      deviceId: device.id,
      grantId: grant?.id ?? "grt_windowcontrol",
      capability: "window.control",
      displayPath: `Window control: ${title}`,
      status: "awaiting-approval",
      reason: null,
      bytes: null,
      sha256: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    this.decideRoute(
      ctx,
      "device",
      device.id,
      "window.control",
      "dedicated-command",
      `${title} on ${device.name} (needs your approval)`,
    );
    const r = await this.request(ctx, {
      requestId: newId("req"),
      kind: "tool_approval",
      toolName: "mac_window_session",
      title: `${title} on ${device.name}`,
      deviceAction: {
        operationId: op.id,
        deviceName: device.name,
        app: "screen",
        lines: [
          { label: "App", value: "Chrome" },
          { label: "Window", value: "CDK Desking" },
          { label: "For", value: "Fill in the quote" },
          { label: "Allowed", value: "See, click and type in this window only" },
          { label: "Time", value: "Up to 10 min" },
          { label: "Stop", value: "Anytime: Stop in the banner or menu bar, or ⌃⌥⌘ ." },
        ],
        expiresAt: Date.now() + 5 * 60_000,
      },
      status: "pending",
    });
    if (r.decision === "deny") {
      this.recordOperation({ ...op, status: "denied", reason: "user declined", updatedAt: Date.now() });
      await this.say(ctx, "OK — I won't use the window. Nothing on your Mac was touched.");
      return;
    }
    this.recordOperation({ ...op, status: "succeeded", updatedAt: Date.now() });
    this.startLease({
      leaseId: newId("lease"),
      windowId: 4211,
      title: "CDK Desking",
      control: true,
      expiresAt: Date.now() + 10 * 60_000,
    });
    this.logActivity({
      agentId: ctx.agentId,
      kind: "device",
      summary: `Started using “CDK Desking” in Chrome on ${device.name} (up to 10 min)`,
      ref: op.id,
    });
    await this.say(ctx, "Using the window now.");
  }

  /* ------------------------------ Devices (mock) ----------------------------- */

  private executionStatus(): ExecutionStatus {
    const e = this.s.execution;
    e.flags = {
      devices: this.s.settings.macAccess,
      deviceWrites: this.s.settings.macWrites,
      control: this.s.settings.macControl,
    };
    return e;
  }

  private decideRoute(
    ctx: RunCtx,
    target: RouteDecision["target"],
    deviceId: string | null,
    capability: string,
    reason: RouteDecision["reason"],
    summary: string,
  ) {
    const r: RouteDecision = {
      id: newId("route"),
      agentId: ctx.agentId,
      turnId: ctx.turnId,
      target,
      deviceId,
      capability,
      reason,
      summary,
      createdAt: Date.now(),
    };
    this.s.routes.unshift(r);
    this.emit("route.decided", r);
  }

  private recordOperation(op: DeviceOperation): DeviceOperation {
    const i = this.s.operations.findIndex((o) => o.id === op.id);
    if (i >= 0) this.s.operations[i] = op;
    else this.s.operations.unshift(op);
    this.emit("operation.updated", op);
    return op;
  }

  private revokeGrant(grantId: string) {
    const g = this.s.execution.grants.find((x) => x.id === grantId);
    if (!g) throw new Error("Unknown grant");
    if (!g.revokedAt) {
      g.revokedAt = Date.now();
      this.emit("grant.updated", g);
      this.logActivity({
        agentId: null,
        kind: "device",
        summary: `Stopped sharing ${g.displayPath}`,
        ref: g.id,
      });
      this.macChanged();
    }
  }

  private unpairDevice(deviceId: string) {
    const d = this.s.execution.devices.find((x) => x.id === deviceId);
    if (!d) throw new Error("Unknown device");
    d.revokedAt = Date.now();
    d.online = false;
    this.emit("device.updated", d);
    for (const g of this.s.execution.grants) {
      if (g.deviceId === deviceId && !g.revokedAt) {
        g.revokedAt = Date.now();
        this.emit("grant.updated", g);
      }
    }
    this.logActivity({ agentId: null, kind: "device", summary: `Unpaired ${d.name}`, ref: null });
    if (deviceId === MOCK_DEVICE_ID && this.mac) {
      this.mac = { ...this.mac, paired: false, connected: false };
      this.endLease("unpaired");
    }
    this.macChanged();
  }

  private macChanged() {
    for (const l of this.macListeners) l();
  }

  private macStatus(): DeviceStatusView {
    const m = this.mac ?? { paired: false, paused: false, connected: false };
    return {
      supported: true,
      signedIn: true,
      needsEnrollment: false,
      paired: m.paired,
      deviceId: m.paired ? MOCK_DEVICE_ID : null,
      deviceName: "Studio MacBook",
      connected: m.paired && m.connected,
      paused: m.paused,
      helper: { available: true, version: "0.3.0" },
      grants: m.paired
        ? this.s.execution.grants.filter((g) => g.deviceId === MOCK_DEVICE_ID && !g.revokedAt)
        : [],
      permissions: this.macPerms,
      lease: this.lease,
    };
  }

  /** Start a window session on the fake Mac (after the user allowed it), ending on its own at expiry. */
  private startLease(lease: WindowLease) {
    this.endLease(null);
    this.lease = lease;
    this.leaseTimer = setTimeout(() => this.endLease("expired"), lease.expiresAt - Date.now());
    this.macChanged();
  }

  /** End the window session (Stop, expiry); like the Mac, tell core so the agent stops using it. */
  private endLease(reason: string | null) {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    if (!this.lease) return;
    const title = this.lease.title;
    this.lease = null;
    if (reason)
      this.logActivity({
        agentId: null,
        kind: "device",
        summary: `Window session on “${title}” ended (${reason})`,
        ref: null,
      });
    this.macChanged();
  }

  /** macOS answered for one app: remember it here and in core's view of the Mac. */
  private setMacPermission(key: string, state: OsPermissionState) {
    this.macPerms = { ...this.macPerms, [key]: state };
    const d = this.s.execution.devices.find((x) => x.id === MOCK_DEVICE_ID && !x.revokedAt);
    if (d) {
      d.permissions = { ...this.macPerms };
      this.emit("device.updated", d);
    }
  }

  /**
   * The fake "Allow": macOS says no to Contacts and yes to Calendar, Reminders, Notes and Mail. Window
   * control ("screen") needs System Settings the first time ("needs-settings": nothing is shared) and is
   * allowed the next time, as if the user had turned Yo on there.
   */
  private allowMacApp(app: DeviceApp, mode: GrantMode): DeviceStatusView & { osStatus: string } {
    if (!this.mac?.paired) throw new Error("Pair this Mac first.");
    let osStatus: string;
    if (app === "screen") {
      osStatus = this.screenAsks++ === 0 ? "needs-settings" : "granted";
      if (osStatus === "granted") {
        this.setMacPermission("screenRecording", "granted");
        if (mode === "read-write") this.setMacPermission("accessibility", "granted");
      }
    } else if (app === "notes" || app === "mail") {
      // Apple Events: macOS asks on first use and has no status to read back.
      osStatus = "granted";
    } else {
      const state: OsPermissionState = app === "contacts" ? "denied" : "granted";
      this.setMacPermission(app === "calendar" ? "calendars" : app, state);
      osStatus = state;
    }
    if (osStatus === "granted") {
      const label = app === "screen" ? "Window control" : app[0]!.toUpperCase() + app.slice(1);
      const existing = this.s.execution.grants.find(
        (g) => g.deviceId === MOCK_DEVICE_ID && !g.revokedAt && g.kind === "app" && g.app === app,
      );
      if (existing) {
        if (existing.mode !== mode) {
          existing.mode = mode;
          existing.revision++;
          this.emit("grant.updated", existing);
        }
      } else {
        const g: DeviceGrant = {
          id: newId("grt"),
          deviceId: MOCK_DEVICE_ID,
          kind: "app",
          app,
          displayPath: label,
          name: label,
          mode,
          expiresAt: null,
          revision: 1,
          createdAt: Date.now(),
          revokedAt: null,
        };
        this.s.execution.grants.push(g);
        this.emit("grant.updated", g);
        this.logActivity({ agentId: null, kind: "device", summary: `Shared ${label}`, ref: g.id });
      }
    }
    this.macChanged();
    return { ...this.macStatus(), osStatus };
  }

  /** A stand-in for the desktop preload's `window.yoDesktop` (device part), driven by this mock's state. */
  private desktopBridge(): YoDesktopBridge {
    const later = <T>(fn: () => T, ms = 250) =>
      new Promise<T>((resolve, reject) =>
        setTimeout(() => {
          try {
            resolve(structuredClone(fn()));
          } catch (e) {
            reject(e);
          }
        }, ms * this.scale),
      );
    const need = () => {
      if (!this.mac?.paired) throw new Error("Pair this Mac first.");
      return this.mac;
    };
    let picks = 0;
    return {
      platform: "darwin",
      notify: () => {},
      openExternal: (url) => window.open(url, "_blank", "noopener,noreferrer"),
      onNavigate: () => () => {},
      device: {
        status: () => later(() => this.macStatus(), 30),
        // The real app shows a native confirmation first; the mock confirms after a short pause.
        pair: () =>
          later(() => {
            if (!this.mac) throw new Error("not available");
            if (!this.mac.paired) {
              this.mac = { ...this.mac, paired: true, connected: true };
              const d = mockDevice();
              d.pairedAt = Date.now();
              d.lastSeenAt = Date.now();
              d.permissions = { ...this.macPerms };
              this.s.execution.devices = [...this.s.execution.devices.filter((x) => x.id !== d.id), d];
              this.emit("device.updated", d);
              this.logActivity({ agentId: null, kind: "device", summary: `Paired ${d.name}`, ref: null });
              this.macChanged();
            }
            return this.macStatus();
          }, 900),
        unpair: () =>
          later(() => {
            if (this.mac?.paired) this.unpairDevice(MOCK_DEVICE_ID);
            return this.macStatus();
          }, 600),
        chooseFolder: (mode) =>
          later(() => {
            need();
            const picksList = [
              { name: "Receipts", displayPath: "~/Desktop/Receipts", kind: "dir" as const },
              { name: "budget.xlsx", displayPath: "~/Documents/budget.xlsx", kind: "file" as const },
            ];
            const pick = picksList[picks++ % picksList.length]!;
            const g: DeviceGrant = {
              id: `grt_mockpick${String(picks).padStart(4, "0")}`,
              deviceId: MOCK_DEVICE_ID,
              ...pick,
              mode,
              expiresAt: null,
              revision: 1,
              createdAt: Date.now(),
              revokedAt: null,
            };
            this.s.execution.grants.push(g);
            this.emit("grant.updated", g);
            this.logActivity({
              agentId: null,
              kind: "device",
              summary: `Shared ${g.displayPath}`,
              ref: g.id,
            });
            this.macChanged();
            return this.macStatus();
          }, 700),
        setMode: (grantId, mode) =>
          later(() => {
            need();
            const g = this.s.execution.grants.find((x) => x.id === grantId && !x.revokedAt);
            if (g && g.mode !== mode) {
              g.mode = mode;
              g.revision++;
              this.emit("grant.updated", g);
              this.macChanged();
            }
            return this.macStatus();
          }, 400),
        revoke: (grantId) =>
          later(() => {
            this.revokeGrant(grantId);
            return this.macStatus();
          }),
        // The real app shows macOS's own prompt first; the mock answers after a short pause.
        allowApp: (app, mode) => later(() => this.allowMacApp(app, mode), 600),
        openPrivacy: (app) =>
          later(() => {
            this.privacyOpened.push(app);
          }, 40),
        stopLease: () => later(() => this.endLease("stopped by the user"), 60),
        setPaused: (paused) =>
          later(() => {
            const m = need();
            this.mac = { ...m, paused };
            if (paused) this.endLease("access paused");
            const d = this.s.execution.devices.find((x) => x.id === MOCK_DEVICE_ID);
            if (d) {
              d.paused = paused;
              this.emit("device.updated", d);
            }
            this.macChanged();
            return this.macStatus();
          }, 120),
        metrics: () =>
          later(
            () => ({
              at: Date.now(),
              procs: [
                { type: "Browser", name: null, memMB: 118, cpu: 0.4 },
                { type: "GPU", name: "GPU Process", memMB: 64, cpu: 0.2 },
                { type: "Tab", name: "Yo", memMB: 182, cpu: 1.1 },
                { type: "Utility", name: "Network Service", memMB: 21, cpu: 0 },
              ],
              totalMB: 385,
            }),
            40,
          ),
        onChanged: (cb) => {
          this.macListeners.add(cb);
          return () => this.macListeners.delete(cb);
        },
      },
    };
  }

  /* --------------------------------- Handlers -------------------------------- */

  private handlers: { [M in ApiMethod]: Handler<M> } = {
    bootstrap: () => ({
      version: "2.0.0-mock",
      settings: this.s.settings,
      agents: this.s.agents.filter((a) => !a.archivedAt),
      accounts: this.s.accounts,
      computer: this.s.computer,
      execution: this.executionStatus(),
    }),

    "settings.update": (p) => {
      Object.assign(this.s.settings, p);
      this.emit("settings.updated", this.s.settings);
      return this.s.settings;
    },

    "agent.create": (p) => {
      const acc = this.account(p.accountId) ?? this.defaultAccount();
      const model = p.model ?? acc?.models.find((m) => m.isDefault)?.id ?? acc?.models[0]?.id ?? null;
      const a: AgentView = {
        id: newId("agt"),
        name: p.name,
        role: p.role,
        instructions: p.instructions,
        avatar: p.avatar,
        accountId: acc?.id ?? null,
        model,
        effort: p.effort ?? "medium",
        runtimeMode: p.runtimeMode ?? this.s.settings.defaultRuntimeMode,
        isPrimary: false,
        pinned: false,
        createdAt: Date.now(),
        archivedAt: null,
        activity: "idle",
        unread: 0,
        preview: null,
        computer: { state: "off", lease: "agent" },
        todos: [],
        lastActiveAt: null,
      };
      this.s.agents.push(a);
      this.s.timelines[a.id] = [];
      this.emit("agent.updated", a);
      this.logActivity({ agentId: a.id, kind: "system", summary: `Created ${a.name}`, ref: null });
      // Like core: a new teammate says hello and asks its one question right away.
      if (p.introduce) void this.run(a.id, "", (c) => this.helloScript(c));
      return a;
    },

    "agent.update": ({ id, patch }) => {
      const a = this.agent(id);
      if (!a) throw new Error("agent not found");
      const prevAcc = this.account(a.accountId);
      Object.assign(a, patch);
      const nextAcc = this.account(a.accountId);
      if (patch.accountId !== undefined && prevAcc && nextAcc && prevAcc.provider !== nextAcc.provider) {
        const model = nextAcc.models.find((m) => m.id === a.model)?.label ?? a.model ?? "";
        this.notice(
          id,
          `Switched to ${PROVIDER_LABEL[nextAcc.provider]} · ${model} — memory kept, fresh session started`,
        );
      }
      this.emit("agent.updated", a);
      return a;
    },

    "agent.archive": ({ id }) => {
      const a = this.agent(id);
      // Like core: the Work and Personal agents (Yo, Pip) can't be archived; turning spaces off is the way.
      if (a?.space) throw new Error("Turn off Work & Personal in Settings instead.");
      if (a) a.archivedAt = Date.now();
      this.s.agents = this.s.agents.filter((x) => x.id !== id);
      this.emit("agent.removed", { id });
      return { ok: true };
    },

    "team.consolidatePlan": () => this.team.plan(),
    "team.consolidate": ({ agentIds }) => this.team.consolidate(agentIds),

    "agent.markRead": ({ id }) => {
      const a = this.agent(id);
      if (a?.unread) this.patchAgent(id, { unread: 0 });
      return { ok: true };
    },

    "agent.newSession": ({ id }) => {
      this.notice(id, "New session · memory and instructions carried over");
      return { ok: true };
    },

    "agent.compact": ({ id, focus }) => {
      this.notice(
        id,
        `Compacted our conversation (about 42k tokens of context → a 180-word summary${focus ? `, focused on ${focus}` : ""}). I'll continue from my notes on a fresh, lighter session.`,
      );
      return { ok: true };
    },

    "timeline.list": ({ agentId, before, limit }) => {
      let t = [...this.timeline(agentId)].sort((a, b) => a.seq - b.seq);
      if (before !== undefined) t = t.filter((e) => e.seq < before);
      if (limit) t = t.slice(-limit);
      return t;
    },

    "workspace.search": ({ query, limit = 40 }) => {
      if (typeof query !== "string" || query.length > 200)
        throw new Error("Search must be at most 200 characters");
      const size = Number.isFinite(limit) ? Math.max(1, Math.min(60, Math.floor(limit))) : 40;
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const content: import("@yo/contracts").WorkspaceSearchResult[] = [
        ...Object.values(this.s.timelines)
          .flat()
          .filter((e) => ["user_message", "assistant_message"].includes(e.item.kind) && !e.item.from)
          .map((e) => ({
            kind: "message" as const,
            id: e.id,
            agentId: e.agentId,
            title: (e.item.text ?? "").slice(0, 90),
            snippet: e.item.text ?? "",
            updatedAt: e.createdAt,
          })),
        ...this.s.memories.map((m) => ({
          kind: "memory" as const,
          id: m.id,
          agentId: m.agentId,
          title: m.content.slice(0, 90),
          snippet: m.content,
          updatedAt: m.updatedAt,
        })),
        ...this.s.routines.map((r) => ({
          kind: "routine" as const,
          id: r.id,
          agentId: r.agentId,
          title: r.name,
          snippet: `${r.name} ${r.prompt}`,
          updatedAt: r.createdAt,
        })),
        ...this.s.artifacts.map((f) => ({
          kind: "file" as const,
          id: f.id,
          agentId: f.agentId,
          title: f.title,
          snippet: f.title,
          updatedAt: f.createdAt,
        })),
      ];
      return content
        .filter(
          (r) =>
            r.snippet.toLowerCase().includes(q) &&
            (!r.agentId || this.s.agents.some((a) => a.id === r.agentId && !a.archivedAt)),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, size)
        .map((r) => {
          const start = Math.max(0, r.snippet.toLowerCase().indexOf(q) - 65);
          return { ...r, snippet: r.snippet.slice(start, start + 240) };
        });
    },
    "timeline.around": ({ agentId, entryId }) => {
      const rows = this.timeline(agentId);
      const i = rows.findIndex((e) => e.id === entryId);
      if (i < 0) throw new Error("Message not found in this conversation");
      return rows.slice(Math.max(0, i - 30), i + 70);
    },

    // `&mockBrief=1`: the first open of the chat posts the morning brief (like core: a quiet notice, then the run).
    "brief.claim": () => {
      if (!this.briefPending || this.s.settings.morningBrief === false) return { posted: false };
      const s = this.s.settings;
      const lead = agentForSpace(this.s.agents, resolveSpace(Date.now(), s).space, s.spacesOn === true);
      if (!lead || this.runs.has(lead.id)) return { posted: false };
      this.briefPending = false;
      this.notice(lead.id, BRIEF_NOTICE);
      void this.run(lead.id, BRIEF_NOTICE, (c) => this.briefScript(c));
      return { posted: true };
    },

    "chat.send": ({ agentId, text, attachments, route }) => {
      this.sends.push({
        agentId,
        text,
        route,
        ...(attachments?.length
          ? { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType })) }
          : {}),
      });
      // Like core: while a task runs, the user's message waits in "Up next" (and joins the chat as it starts).
      if (this.runs.has(agentId)) {
        const id = newId("qmsg");
        this.queueOf(agentId).push({
          id,
          text,
          attachments: attachments ?? [],
          route: route ?? "auto",
          createdAt: Date.now(),
        });
        this.pushQueue(agentId);
        return { turnId: "queued", queuedId: id };
      }
      this.userMessage(agentId, text, attachments ?? []);
      this.needsModel.delete(agentId);
      if (this.refuseWithoutModel(agentId)) return { turnId: "pending" };
      void this.run(agentId, text, undefined, route ?? "auto");
      return { turnId: "pending" };
    },

    "queue.list": ({ agentId }) => this.queueView(agentId),
    "queue.update": ({ agentId, id, text }) => {
      const q = this.queued(agentId, id);
      if (!text.trim() && !q.attachments.length) throw new Error("A message can't be empty.");
      q.text = text.trim();
      this.pushQueue(agentId);
      return this.queueView(agentId);
    },
    "queue.remove": ({ agentId, id }) => {
      const q = this.queued(agentId, id);
      this.queues.set(
        agentId,
        this.queueOf(agentId).filter((x) => x !== q),
      );
      this.pushQueue(agentId);
      return this.queueView(agentId);
    },
    "queue.reorder": ({ agentId, ids }) => {
      const list = this.queueOf(agentId);
      const rank = (q: MockQueued) => {
        const i = ids.indexOf(q.id);
        return i < 0 ? ids.length + list.indexOf(q) : i;
      };
      this.queues.set(
        agentId,
        [...list].sort((a, b) => rank(a) - rank(b)),
      );
      this.pushQueue(agentId);
      return this.queueView(agentId);
    },
    "queue.steer": ({ agentId, id }) => {
      const q = this.queued(agentId, id);
      this.queues.set(
        agentId,
        this.queueOf(agentId).filter((x) => x !== q),
      );
      const running = this.runs.get(agentId);
      if (!running) {
        this.userMessage(agentId, q.text, q.attachments);
        void this.run(agentId, q.text, undefined, q.route);
      } else {
        this.userMessage(agentId, q.text, q.attachments, STEERED_TITLE);
        running.steer.push(q.text);
      }
      this.pushQueue(agentId);
      return { steered: true, items: this.queueView(agentId) };
    },

    "chat.interrupt": ({ agentId }) => {
      if (this.agent(agentId)?.kind === "helper") {
        this.retireHelper(agentId, "stopped", "You stopped this helper before it finished.");
        return { ok: true };
      }
      const ctx = this.runs.get(agentId);
      if (ctx) {
        ctx.aborted = true;
        for (const e of this.timeline(agentId)) {
          if (e.request?.status === "pending") {
            this.upsert({
              ...e,
              request: { ...e.request, status: "expired" },
              item: { ...e.item, status: "failed" },
            });
            this.waiters.delete(e.request.requestId);
            const opId = e.request.deviceWrite?.operationId ?? e.request.deviceAction?.operationId;
            const op = this.s.operations.find((o) => o.id === opId);
            if (op?.status === "awaiting-approval")
              this.recordOperation({
                ...op,
                status: "cancelled",
                reason: "run stopped",
                updatedAt: Date.now(),
              });
          }
        }
      }
      return { ok: true };
    },

    "request.respond": ({ agentId, requestId, decision, answers, message, secureValues }) => {
      const e = this.timeline(agentId).find((x) => x.request?.requestId === requestId);
      if (!e?.request) throw new Error("request not found");
      if (e.request.secureForm) {
        // Like core: the values are checked, then dropped. A failed fill is shown as a failure, not Submitted.
        if (e.request.status !== "pending") throw new Error("This request is no longer pending.");
        if (decision !== "deny") {
          const clean = cleanSecureValues(e.request.secureForm.fields, secureValues);
          if ("error" in clean) throw new Error(clean.error);
        }
        const fail = decision !== "deny" && this.failNextSecureForm;
        this.failNextSecureForm = false;
        const status = decision === "deny" ? "denied" : fail ? "failed" : "answered";
        const output =
          decision === "deny"
            ? "Cancelled"
            : fail
              ? "Couldn't fill the page. Nothing was saved. Ask to try again."
              : "Submitted";
        this.upsert({
          ...e,
          item: { ...e.item, status: fail ? "failed" : "completed", output },
          request: { ...e.request, status },
        });
        this.logActivity({
          agentId,
          kind: "approval",
          summary: `${decision === "deny" ? "Cancelled" : fail ? "Couldn't fill" : "Submitted"}: ${e.request.title}`,
          ref: requestId,
        });
        const w = this.waiters.get(requestId);
        this.waiters.delete(requestId);
        w?.({ decision });
        return { ok: true };
      }
      const status =
        e.request.kind === "user_input" ? "answered" : decision === "deny" ? "denied" : "allowed";
      this.upsert({
        ...e,
        item: { ...e.item, status: "completed" },
        request: {
          ...e.request,
          status,
          input: answers || message ? { ...(e.request.input as object), answers, message } : e.request.input,
          ...(answers && decision !== "deny" ? { answers } : {}),
        },
      });
      // Exact-action approvals for Mac changes never become saved rules.
      if (decision === "allowAlways" && !e.request.deviceWrite && !e.request.deviceAction) {
        const input = e.request.input as { category?: string; site?: string } | undefined;
        // Like core: a 1Password "Always allow" is for that one site.
        const cat =
          e.request.toolName === "yo:1password" && input?.site
            ? `yo:1password:${input.site}`
            : (input?.category ?? e.request.toolName ?? "tool");
        this.s.rules.push({
          id: newId("rule"),
          agentId,
          match: cat,
          decision: "allow",
          createdAt: Date.now(),
        });
      }
      this.logActivity({
        agentId,
        kind: "approval",
        summary: `${status === "answered" ? "Answered" : status === "allowed" ? "Allowed" : "Denied"}: ${e.request.title}`,
        ref: requestId,
      });
      const w = this.waiters.get(requestId);
      this.waiters.delete(requestId);
      if (w) w({ decision, answers, message });
      else {
        // A seeded request (no turn waiting on it): Pico's "Publish the RSVP page", or a purchase.
        const publish = (e.request.input as { category?: string } | undefined)?.category === "publish";
        void this.run(agentId, e.request.title, (ctx) =>
          publish ? this.afterPublish(ctx, { decision }) : this.afterApproval(ctx, { decision }),
        );
      }
      return { ok: true };
    },

    "account.list": () => this.s.accounts,

    "account.add": ({ provider, label }) => {
      // Like core: only the providers Yo offers.
      if (!isProviderEnabled(provider)) throw new Error("That provider isn't available in Yo.");
      const n = this.s.accounts.filter((a) => a.provider === provider).length + 1;
      const acc: Account = {
        id: newId("acc"),
        provider,
        label: label || `${PROVIDER_LABEL[provider]} ${n}`,
        status: "unauthenticated",
        email: null,
        plan: null,
        message: null,
        isDefault: false,
        models: provider === "claude" ? CLAUDE_MODELS : provider === "codex" ? CODEX_MODELS : GROK_MODELS,
        rateLimit: null,
        createdAt: Date.now(),
      };
      this.s.accounts.push(acc);
      this.emit("account.updated", acc);
      return acc;
    },

    "account.remove": ({ id }) => {
      this.s.accounts = this.s.accounts.filter((a) => a.id !== id);
      this.emit("account.removed", { id });
      return { ok: true };
    },

    "account.refresh": ({ id }) => {
      const a = this.account(id);
      if (!a) throw new Error("account not found");
      return a;
    },

    "account.setDefault": ({ id }) => {
      for (const a of this.s.accounts) {
        const was = a.isDefault;
        a.isDefault = a.id === id;
        if (was !== a.isDefault) this.emit("account.updated", a);
      }
      return { ok: true };
    },

    "account.login.start": ({ id, method }) => {
      const a = this.account(id);
      if (!a) throw new Error("account not found");
      if (a.status !== "signing_in") this.statusBeforeLogin.set(id, a.status);
      a.status = "signing_in";
      a.message = null;
      this.emit("account.updated", a);
      // Like core: the sign-in runs on Yo's computer, which starts first if it's off.
      if (!this.s.computer.connected)
        this.emit("account.login", { accountId: id, phase: "prompt", message: "Starting Yo's computer…" });
      setTimeout(() => {
        if (a.provider === "claude") {
          // Claude Code's own `claude auth login` on Yo's computer: its link, then the code Claude's page shows.
          this.emit("account.login", {
            accountId: id,
            phase: "prompt",
            url: MOCK_CLAUDE_LOGIN_URL,
            needsInput: true,
            message:
              "Sign in on Claude's page with the account that has your plan and click Authorize. Then copy the code Claude shows and paste it here.",
          });
        } else if (a.provider === "grok") {
          // `grok login --device-auth` on Yo's computer: the link already carries the code; confirm it.
          this.emit("account.login", {
            accountId: id,
            phase: "prompt",
            url: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234",
            userCode: "WXYZ-1234",
            needsInput: false,
            message: "Open the link, sign in with your Grok account and confirm the code.",
          });
          // Not scaled by &fast: the code has to stay on screen long enough to read (and for E2E to see it).
          setTimeout(() => this.finishLogin(a, "Grok account"), 5000);
        } else if (method === "code") {
          // A one-time code (device code) on Yo's computer: confirmed on ChatGPT's page.
          this.emit("account.login", {
            accountId: id,
            phase: "prompt",
            url: "https://auth.openai.com/codex/device",
            userCode: "K7QX-2MFD",
            needsInput: false,
            message: "Open the link, sign in to ChatGPT and enter the code.",
          });
          // Not scaled by &fast: the code has to stay on screen long enough to read (and for E2E to see it).
          setTimeout(() => {
            if (!this.codexCodeOff) return this.finishLogin(a, "ChatGPT Plus");
            // "Device code sign-in" still off in ChatGPT's settings: ChatGPT never confirms the code.
            if (a.status !== "signing_in") return;
            a.status = this.statusBeforeLogin.get(id) ?? "unauthenticated";
            this.emit("account.updated", a);
            this.emit("account.login", { accountId: id, phase: "error", message: MOCK_CODE_NOT_CONFIRMED });
          }, 5000);
        } else {
          // Codex's own sign-in page; the person pastes back the address their browser lands on.
          this.emit("account.login", {
            accountId: id,
            phase: "prompt",
            url: MOCK_CODEX_LOGIN_URL,
            needsInput: true,
            message:
              "Sign in on ChatGPT's page and click Continue. Then copy the address your browser lands on and paste it here.",
          });
        }
      }, 700 * this.scale);
      return { ok: true };
    },

    "account.login.input": ({ id, input }) => {
      const a = this.account(id);
      if (!a) throw new Error("account not found");
      if (a.provider === "codex") {
        // Like agentd: only the address ChatGPT sent the browser to, with this sign-in's state, is accepted.
        const check = parseCodexCallback(input, MOCK_CODEX_LOGIN_URL);
        if (!check.ok) throw new Error(check.error);
        setTimeout(() => this.finishLogin(a, "ChatGPT Plus"), 600 * this.scale);
        return { ok: true };
      }
      setTimeout(() => {
        if (input.trim().length < 4 || /bad|wrong/i.test(input)) {
          // Like Claude Code: a code Claude turns down ends this sign-in (the one it had, if any, stays); Try
          // again gets a fresh link.
          if (a.status === "signing_in") {
            a.status = this.statusBeforeLogin.get(id) ?? "unauthenticated";
            this.emit("account.updated", a);
          }
          this.emit("account.login", {
            accountId: id,
            phase: "error",
            message:
              "Claude didn't accept that code (error 400). Codes expire quickly and only work with the newest sign-in link. Press Try again for a fresh link, then paste the whole code.",
          });
        } else this.finishLogin(a, a.provider === "claude" ? "Max" : "Pro");
      }, 900 * this.scale);
      return { ok: true };
    },

    "account.login.cancel": ({ id }) => {
      const a = this.account(id);
      if (a && a.status === "signing_in") {
        a.status = "unauthenticated";
        this.emit("account.updated", a);
      }
      return { ok: true };
    },

    "account.setApiKey": ({ id }) => {
      const a = this.account(id);
      if (!a) throw new Error("account not found");
      const plan = { claude: "Anthropic API key", codex: "OpenAI API key", grok: "xAI API key" }[a.provider];
      Object.assign(a, { status: "authenticated", plan, message: null });
      this.emit("account.updated", a);
      this.emit("account.login", { accountId: id, phase: "done" });
      return a;
    },

    "connect.detect": () => this.connect.detect(),

    "models.list": ({ accountId }) => this.account(accountId)?.models ?? [],

    "computer.overview": () => this.s.computer,

    "setup.requirements": () => {
      const report = evaluateRequirements(this.machine, "local");
      if (this.vmHome) report.vmHome = this.vmHome;
      return report;
    },

    "setup.vmHome.choose": ({ choice }) => {
      const keep = choice === "reuse";
      this.vmHome = {
        state: "ready",
        choice,
        colimaHome: keep ? "/Users/alice/.colima" : "/Users/alice/Library/Application Support/Yo/colima",
        limaHome: keep ? "/Users/alice/.colima/_lima" : "/Users/alice/Library/Application Support/Yo/lima",
        dockerConfig: "/Users/alice/Library/Application Support/Yo/docker",
        legacyDir: "/Users/alice/.colima",
        detail: keep
          ? "Using your existing computer in ~/.colima. Yo didn't move or delete it."
          : "Your existing computer now lives in Yo's folder. It was renamed, not deleted.",
        legacyKept: keep,
      };
      return this.vmHome;
    },

    "computer.start": () => {
      const c = this.s.computer;
      if (c.runtime === "running" || c.runtime === "starting") return c;
      if (!this.machine.tools.colima.installed) {
        Object.assign(c, {
          runtime: "error",
          message:
            "Colima isn't available. Reinstall Yo (it includes Colima), or for a development build run: brew install colima docker docker-compose. Then press Try again.",
        });
        this.emit("computer.updated", c);
        return c;
      }
      const steps: [number, Partial<typeof c>][] = [
        [0, { runtime: "starting", message: "Starting the Colima virtual machine…" }],
        [1800, { message: "Building Yo's computer image (Chromium, desktop, tools)…" }],
        [2600, { imageReady: true, message: "Connecting to Yo's computer…" }],
        [1500, { runtime: "running", connected: true, message: null, memMB: 1420, cacheMB: 310 }],
      ];
      let at = 0;
      for (const [delay, patch] of steps) {
        at += delay;
        setTimeout(() => {
          Object.assign(c, patch);
          this.emit("computer.updated", c);
          if (c.runtime === "running") {
            const yo = this.s.agents.find((a) => a.isPrimary);
            if (yo) this.patchAgent(yo.id, { computer: { state: "ready", lease: "agent" } });
            this.logActivity({ agentId: null, kind: "system", summary: "Yo's computer started", ref: null });
          }
        }, at * this.scale);
      }
      Object.assign(c, steps[0]![1]);
      return c;
    },

    "computer.stop": () => {
      Object.assign(this.s.computer, { runtime: "stopped", connected: false, memMB: null, message: null });
      for (const a of this.s.agents) this.patchAgent(a.id, { computer: { state: "off", lease: "agent" } });
      this.emit("computer.updated", this.s.computer);
      return this.s.computer;
    },

    "computer.wake": ({ agentId }) => {
      const a = this.agent(agentId);
      if (!a) throw new Error("agent not found");
      this.patchAgent(agentId, { computer: { ...a.computer, state: "booting" } });
      setTimeout(() => {
        this.patchAgent(agentId, {
          computer: { ...a.computer, state: "ready" },
          activity: a.activity === "sleeping" ? "idle" : a.activity,
        });
      }, 1600 * this.scale);
      return { ok: true };
    },

    "computer.takeover": ({ agentId }) => {
      const a = this.agent(agentId);
      if (!a) throw new Error("agent not found");
      this.patchAgent(agentId, { computer: { ...a.computer, lease: "user" } });
      this.notice(agentId, "You took control of the computer");
      this.logActivity({
        agentId,
        kind: "takeover",
        summary: `You took control of ${a.name}'s computer`,
        ref: null,
      });
      return { ok: true };
    },

    "computer.release": ({ agentId }) => {
      const a = this.agent(agentId);
      if (!a) throw new Error("agent not found");
      this.patchAgent(agentId, { computer: { ...a.computer, lease: "agent" } });
      this.notice(agentId, `You handed control back to ${a.name}`);
      return { ok: true };
    },

    "computer.files": ({ path }) => {
      const p = path === "~" || !path ? "/home/agent" : path.replace(/\/$/, "");
      return this.files[p] ?? [];
    },

    "pty.open": ({ agentId }) => {
      const id = newId("pty");
      this.ptys.set(id, agentId);
      return { ptyId: id };
    },

    "memory.list": ({ agentId }) =>
      this.s.memories
        .filter((m) => (agentId === undefined ? true : m.agentId === agentId))
        .sort((a, b) => b.updatedAt - a.updatedAt),

    "memory.add": ({ content, agentId, space }) => {
      const m: Memory = {
        id: newId("mem"),
        agentId: agentId ?? null,
        content,
        space: space ?? null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.s.memories.unshift(m);
      this.emit("memory.updated", m);
      return m;
    },

    "memory.update": ({ id, content, space }) => {
      const m = this.s.memories.find((x) => x.id === id);
      if (!m) throw new Error("memory not found");
      // `space` absent leaves it where it is; null moves it to Everywhere.
      Object.assign(m, { content, updatedAt: Date.now() }, space !== undefined && { space });
      this.emit("memory.updated", m);
      return m;
    },

    "memory.delete": ({ id }) => {
      this.s.memories = this.s.memories.filter((m) => m.id !== id);
      return { ok: true };
    },

    "routine.list": ({ agentId }) => this.s.routines.filter((r) => !agentId || r.agentId === agentId),

    "routine.create": ({ agentId, name, prompt, cron, runAt }) => {
      const r = {
        id: newId("rt"),
        agentId,
        name,
        prompt,
        cron: cron ?? null,
        runAt: runAt ?? null,
        timezone: this.s.settings.timezone,
        enabled: true,
        nextRunAt: cron ? nextRun(cron) : (runAt ?? null),
        lastRunAt: null,
        createdAt: Date.now(),
      };
      this.s.routines.push(r);
      this.emit("routine.updated", r);
      return r;
    },

    "routine.update": ({ id, patch }) => {
      const r = this.s.routines.find((x) => x.id === id);
      if (!r) throw new Error("routine not found");
      Object.assign(r, patch);
      r.nextRunAt = r.enabled ? (r.cron ? nextRun(r.cron) : r.runAt) : null;
      this.emit("routine.updated", r);
      return r;
    },

    "routine.delete": ({ id }) => {
      this.s.routines = this.s.routines.filter((r) => r.id !== id);
      this.emit("routine.removed", { id });
      return { ok: true };
    },

    "routine.runNow": ({ id }) => {
      const r = this.s.routines.find((x) => x.id === id);
      if (!r) throw new Error("routine not found");
      r.lastRunAt = Date.now();
      this.emit("routine.updated", r);
      this.logActivity({
        agentId: r.agentId,
        kind: "routine",
        summary: `Routine “${r.name}” ran`,
        ref: r.id,
      });
      this.notice(r.agentId, `Routine · ${r.name}`);
      if (!this.runs.has(r.agentId)) void this.run(r.agentId, r.prompt);
      return { ok: true };
    },

    "activity.list": ({ agentId, limit }) =>
      this.s.activity.filter((a) => !agentId || a.agentId === agentId).slice(0, limit ?? 200),

    "approvals.pending": () =>
      Object.values(this.s.timelines)
        .flat()
        .filter((e) => e.request?.status === "pending"),

    "rules.list": () => this.s.rules,

    "rules.delete": ({ id }) => {
      this.s.rules = this.s.rules.filter((r) => r.id !== id);
      return { ok: true };
    },

    "artifact.pin": ({ id, pinned }) => {
      const a = this.s.artifacts.find((x) => x.id === id);
      if (!a) throw new Error("That isn't in Make any more.");
      a.pinnedAt = pinned ? Date.now() : null;
      this.emit("artifact.new", { ...a });
      return { ...a };
    },
    "tasks.list": ({ agentId }) => this.tasks.list(agentId),
    "tasks.create": (p) => this.tasks.create(p),
    "tasks.start": ({ id }) => this.tasks.start(id),
    "tasks.update": ({ id, status }) => this.tasks.update(id, status),
    "artifacts.list": ({ agentId }) =>
      this.s.artifacts
        .filter((a) => !agentId || a.agentId === agentId)
        .sort((a, b) => b.createdAt - a.createdAt),

    // Yo is free since 2.0, like the real core: every license call says so.
    "license.status": () => FREE_LICENSE,
    "license.activate": () => FREE_LICENSE,
    "license.refresh": () => FREE_LICENSE,
    "license.deactivate": () => FREE_LICENSE,
    "bugReports.status": () => ({ ...this.bugFiling, defaultRepo: "JuniorSua/yo-app" }),
    "bugReports.preview": (p) => this.bugPreview(p),
    "bugReports.send": async (p) => {
      await this.sleep(700);
      return this.bugSend(p);
    },
    "bugReports.configure": ({ token, repo }) => {
      if (token !== undefined) this.bugFiling.configured = !!token?.trim();
      if (repo !== undefined) {
        const r = repo?.trim() || "JuniorSua/yo-app";
        if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('Repository must look like "owner/name".');
        this.bugFiling.repo = r;
      }
      return { ...this.bugFiling, defaultRepo: "JuniorSua/yo-app" };
    },

    "channels.phone.status": () => this.phone.status(),
    "channels.phone.pair": () => this.phone.pair(),
    "channels.phone.configure": ({ relayUrl, registerKey }) => this.phone.configure(relayUrl, registerKey),
    "channels.phone.off": () => this.phone.off(),
    "onePassword.status": () => this.onePassword.status(),
    "onePassword.connect": async ({ token }) => this.opPush(await this.onePassword.connect(token)),
    "onePassword.test": async () => this.opPush(await this.onePassword.test()),
    "onePassword.disconnect": () => this.opPush(this.onePassword.disconnect()),

    "execution.status": () => this.executionStatus(),

    // Only the desktop app's main process can finish pairing; the challenge itself is inert here.
    "devices.pair.start": () => ({
      challenge: "mock-pairing-challenge",
      expiresAt: Date.now() + 5 * 60_000,
      coreId: "core_mock",
      corePublicKey: "",
      coreLabel: "Yo on This Mac",
    }),

    "devices.unpair": ({ deviceId }) => {
      this.unpairDevice(deviceId);
      return { ok: true };
    },

    "devices.rename": ({ deviceId, name }) => {
      const d = this.s.execution.devices.find((x) => x.id === deviceId);
      if (!d) throw new Error("Unknown device");
      const clean = name.trim().slice(0, 80);
      if (!clean) throw new Error("Name can't be empty");
      d.name = clean;
      this.emit("device.updated", d);
      return d;
    },

    "grants.revoke": ({ grantId }) => {
      this.revokeGrant(grantId);
      return { ok: true };
    },

    "operations.list": ({ agentId, limit }) =>
      this.s.operations
        .filter((o) => !agentId || o.agentId === agentId)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit ?? 100),

    "routes.list": ({ agentId, limit }) =>
      this.s.routes.filter((r) => r.agentId === agentId).slice(0, limit ?? 50),

    "auth.clients.list": () => this.auth.list(),
    "auth.clients.revoke": ({ id }) => this.auth.revoke(id),
    "auth.clients.rename": ({ id, label }) => this.auth.rename(id, label),
    "auth.signInLink.create": () => this.auth.createLink(),

    "host.openExternal": ({ url }) => {
      (window as any).__yoLastExternal = url;
      return { ok: true };
    },

    "update.applyServer": ({ rev }) => {
      this.updates.applyServer(rev, {
        drop: () => this.simulateDisconnect(),
        back: () => {
          this.connection = "open";
          for (const cb of this.statusCbs) cb("open", true);
        },
      });
      return { ok: true };
    },
  } satisfies { [M in keyof ApiMethods]: Handler<M> };

  private finishLogin(a: Account, plan: string) {
    if (a.status !== "signing_in") return;
    Object.assign(a, {
      status: "authenticated",
      // Signed in with Claude Code itself: core forgets any old saved token.
      ...(a.provider === "claude" ? { legacyToken: false, signInSavedAt: null } : {}),
      plan,
      // The Grok CLI doesn't report who is signed in.
      email:
        a.provider === "grok"
          ? null
          : a.provider === "codex"
            ? "sam@example.com"
            : (a.email ?? "sam@example.com"),
      message: null,
    });
    this.emit("account.updated", a);
    this.emit("account.login", { accountId: a.id, phase: "done" });
  }
}
