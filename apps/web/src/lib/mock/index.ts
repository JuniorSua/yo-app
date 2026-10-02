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
 *             &mockUpdate=…      show an update notice: web | available | downloading | ready | error
 *                                (see ./updates.ts)
 *             &mockMac=…         the Mac the first agent's computer setup checks: strong (default) | intel16 |
 *                                small | nocolima | nobrew (see ./setup.ts)
 *             &mockConnect=…     what "Connect your model" finds on first run: none | cli | computer |
 *                                codexError (see ./connect.ts)
 *
 * Chat keywords pick a scenario: "buy/order/purchase" -> approval card, "flight/trip/travel" ->
 * ask-user card, "fail/error" -> error, "save … mac" -> exact-file approval for a change on the paired
 * Mac, "calendar" + "add/schedule" -> exact-action approval for a new Calendar event, "window" or
 * "desk screen" -> approval for a window session on the Mac (with mockDesktop, allowing it starts a
 * session the app shows with Stop), "report … bug" / "look into why" / "isn't working" -> investigation +
 * red bug-report draft that waits for "Report it" (filed as an issue) or "Not now", anything else ->
 * research-style run with todos + tools.
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
  type Decision,
  type DeviceApp,
  type DeviceGrant,
  type DeviceOperation,
  type ExecutionStatus,
  evaluateRequirements,
  type GrantMode,
  type Item,
  isProviderEnabled,
  newId,
  type OsPermissionState,
  type RouteDecision,
  type RoutePreference,
  type TimelineEntry,
  type TodoEntry,
} from "@yo/contracts";
import type { ConnectionStatus, PtyConnection, YoClient } from "../api";
import { nextRun } from "../cron";
import type { DeviceStatusView, WindowLease, YoDesktopBridge } from "../desktop";
import { applyConnectScenario, MockConnect, markConnected, mockConnectScenario } from "./connect";
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  MOCK_DEVICE_ID,
  type MockFile,
  mockDevice,
  mockFiles,
  mockMacPermissions,
  type SeedState,
  seed,
} from "./data";
import { createMockPty } from "./pty";
import { installedTools, type MockMac, mockMacFromQuery, mockMachine } from "./setup";
import { MockUpdates, mockUpdateScenario } from "./updates";

type Listener = (data: any) => void;
type Handler<M extends ApiMethod> = (params: ApiParams<M>) => ApiResult<M> | Promise<ApiResult<M>>;
type Response = { decision: Decision; answers?: Record<string, string>; message?: string };

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
}

const MAC_NOTES = `# Site notes

- Hero copy: shorter headline, keep the yellow button
- Move pricing above the FAQ
- Compress hero.jpg (1.8 MB -> ~300 KB)
- Fix the broken link in the footer (/press)
`;

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "ChatGPT" };

export class MockClient implements YoClient {
  readonly mock = true;
  private s: SeedState;
  private listeners = new Map<string, Set<Listener>>();
  private scale: number;
  private runs = new Map<string, RunCtx>();
  private waiters = new Map<string, (r: Response) => void>();
  private files: Record<string, MockFile[]> = mockFiles();
  private ptys = new Map<string, string>();
  /** Test hook: every chat.send, with the route the composer chose. */
  readonly sends: { agentId: string; text: string; route: RoutePreference | undefined }[] = [];
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
  private bugFiling = { configured: true, repo: "JuniorSua/yo-app" };
  private bugIssueSeq = 41;
  /** Bug-report drafts waiting for the user's answer, by agent. */
  private bugDrafts = new Map<string, { draftId: string; title: string }>();
  /** Update notices (`&mockUpdate=…`); test hooks for deploys and Restart. */
  readonly updates: MockUpdates;
  /** "Connect your model" walkthrough (`&mockConnect=…`); test hooks for the Terminal side. */
  readonly connect: MockConnect;

  constructor() {
    const q = new URLSearchParams(location.search);
    const onboarded = q.get("onboarded") === "1";
    this.s = seed(onboarded);
    this.scale = q.has("fast") ? 0.15 : 1;
    const theme = q.get("theme");
    if (theme === "light" || theme === "dark" || theme === "system") this.s.settings.theme = theme;
    if (q.get("legacyGrok") === "1") this.seedLegacyGrok();
    (window as any).__yoMock = this;
    if (q.get("mockDesktop") === "1") {
      this.mac = { paired: onboarded, paused: false, connected: onboarded };
      window.yoDesktop = this.desktopBridge();
    }
    this.updates = new MockUpdates(mockUpdateScenario(q), this.scale);
    this.updates.install(window);
    this.machine = mockMachine(mockMacFromQuery(q));
    if (!onboarded && !this.machine.tools.colima.installed)
      Object.assign(this.s.computer, { runtime: "missing", message: "Colima/Docker CLI not installed" });
    const connectScenario = mockConnectScenario(q);
    if (!onboarded) applyConnectScenario(this.s, connectScenario);
    this.connect = new MockConnect(connectScenario, !q.has("fast"), (provider, accountId) => {
      const a = markConnected(this.s.accounts, provider, this.s.computer.connected, accountId);
      if (!a) return null;
      this.emit("account.updated", a);
      const def = this.s.accounts.find((x) => x.isDefault);
      if (!def || (def.status !== "authenticated" && def.status !== "unverified"))
        for (const x of this.s.accounts) {
          const was = x.isDefault;
          x.isDefault = x.id === a.id;
          if (was !== x.isDefault) this.emit("account.updated", x);
        }
      return a;
    });
  }

  /* ------------------------- First agent's computer setup ------------------------- */

  /** The fake Mac the setup chat checks (`&mockMac=…`). */
  private machine = mockMachine("strong" as MockMac);

  /** Test hook: the user ran the copy-paste install steps; the next re-check finds everything. */
  installTools() {
    this.machine = { ...this.machine, tools: installedTools() };
    if (this.s.computer.runtime === "missing")
      Object.assign(this.s.computer, { runtime: "stopped", message: null });
    this.emit("computer.updated", this.s.computer);
  }

  /**
   * Test hook (`&legacyGrok=1`): what an older core sends, a signed-in Grok account (Yo no longer offers Grok)
   * with Yo still pinned to it on a Grok model. The UI must hide it and fall back to the default account.
   */
  private seedLegacyGrok() {
    this.s.accounts.push({
      id: "acc_grok",
      provider: "grok",
      label: "Grok",
      status: "authenticated",
      email: null,
      plan: "SuperGrok",
      message: null,
      isDefault: false,
      models: [{ id: "grok-4", label: "Grok 4", isDefault: true }],
      rateLimit: null,
      createdAt: Date.now(),
    });
    const yo = this.s.agents.find((a) => a.isPrimary);
    if (yo) Object.assign(yo, { accountId: "acc_grok", model: "grok-4", effort: "high" });
  }

  /* ------------------------------ YoClient API ------------------------------ */

  status(): ConnectionStatus {
    return "open";
  }

  private statusCbs = new Set<(s: ConnectionStatus, reconnected: boolean) => void>();

  onStatus(cb: (s: ConnectionStatus, reconnected: boolean) => void) {
    this.statusCbs.add(cb);
    setTimeout(() => cb("open", false), 0);
    return () => this.statusCbs.delete(cb);
  }

  /** Test hook: the connection drops and comes back (like a core restart). */
  simulateReconnect() {
    for (const cb of this.statusCbs) cb("closed", false);
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
    return this.updates.version();
  }
  artifactUrl(id: string) {
    const a = this.s.artifacts.find((x) => x.id === id);
    return `data:text/plain;charset=utf-8,${encodeURIComponent(`# ${a?.title ?? id}\n\nThis is a mock artifact.\n`)}`;
  }

  /* -------------------------------- Internals ------------------------------- */

  private emit<C extends ApiPushChannel>(channel: C, data: ApiPushes[C]) {
    const set = this.listeners.get(channel);
    if (!set) return;
    const copy = structuredClone(data);
    for (const cb of set) cb(copy);
  }

  private sleep(ms: number, ctx?: RunCtx) {
    return new Promise<void>((resolve, reject) =>
      setTimeout(() => (ctx?.aborted ? reject(new Aborted()) : resolve()), ms * this.scale),
    );
  }

  private agent(id: string): AgentView | undefined {
    return this.s.agents.find((a) => a.id === id);
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
        this.patchAgent(ctx.agentId, { activity: "working" });
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
    };
    this.runs.set(agentId, ctx);
    const a = this.agent(agentId);
    this.patchAgent(agentId, { activity: "working", preview: "Thinking…", lastActiveAt: Date.now() });
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
      if (agent?.todos.length) this.patchAgent(agentId, { todos: agent.todos });
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
    if (/\b(buy|order|purchase|checkout)\b/.test(t)) return (c) => this.shopScript(c, text);
    if (/\b(flight|flights|trip|travel|vacation|hotel)\b/.test(t)) return (c) => this.tripScript(c);
    if (/\b(fail|error|crash)\b/.test(t)) return (c) => this.errorScript(c);
    if (/\bscreenshot\b/.test(t)) return (c) => this.screenshotScript(c);
    if (/\bwindow\b|\bdesk screen\b/.test(t)) return (c) => this.windowSessionScript(c);
    if (/\b(save|write)\b[\s\S]*\bmac\b/.test(t)) return (c) => this.macWriteScript(c);
    if (/\bcalendar\b/.test(t) && /\b(add|schedule)\b/.test(t)) return (c) => this.calendarAddScript(c);
    return (c) => this.researchScript(c, text);
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
    const { configured, repo } = this.bugFiling;
    const number = configured ? ++this.bugIssueSeq : undefined;
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
      issue: number ? { number, url: issueUrl } : { url: issueUrl },
    };
    this.s.artifacts.unshift(art);
    this.emit("artifact.new", art);
    await this.step(ctx, "tool", "Sent the bug report", {
      toolName: "mcp__yo__report_bug",
      input: { stage: "submit", draft_id: draft.draftId },
      output: number
        ? `Reported: filed as GitHub issue #${number} (${issueUrl}) [artifact:${art.id}].`
        : `Saved the bug report [artifact:${art.id}], but it wasn't sent: GitHub filing isn't set up (Settings → Bug reports).`,
      ms: 1200,
    });
    await this.say(
      ctx,
      number
        ? `Done — it's filed as issue #${number}.`
        : "Saved it. GitHub filing isn't set up, so tap **Open on GitHub** on the card to send it.",
    );
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
        "You asked me to stay on my own computer for this message, so I didn't touch your Mac. The notes are in `~/Documents/site-notes.md` on my computer.",
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
        "You asked me to stay on my own computer for this message, so I didn't touch your Calendar.",
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
        "You asked me to stay on my own computer for this message, so I didn't use any window on your Mac.",
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
      version: "0.1.0-mock",
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
      if (a) a.archivedAt = Date.now();
      this.s.agents = this.s.agents.filter((x) => x.id !== id);
      this.emit("agent.removed", { id });
      return { ok: true };
    },

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

    "chat.send": ({ agentId, text, attachments, route }) => {
      this.sends.push({ agentId, text, route });
      const input = attachments?.length
        ? { attachments: attachments.map((a) => ({ name: a.name, mediaType: a.mediaType })) }
        : undefined;
      this.upsert(
        this.entry(agentId, { id: newId("it"), kind: "user_message", status: "completed", text, input }),
      );
      const running = this.runs.get(agentId);
      if (running) {
        running.steer.push(text);
        return { turnId: running.turnId };
      }
      void this.run(agentId, text, undefined, route ?? "auto");
      return { turnId: "pending" };
    },

    "chat.interrupt": ({ agentId }) => {
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

    "request.respond": ({ agentId, requestId, decision, answers, message }) => {
      const e = this.timeline(agentId).find((x) => x.request?.requestId === requestId);
      if (!e?.request) throw new Error("request not found");
      const status =
        e.request.kind === "user_input" ? "answered" : decision === "deny" ? "denied" : "allowed";
      this.upsert({
        ...e,
        item: { ...e.item, status: "completed" },
        request: {
          ...e.request,
          status,
          input: answers || message ? { ...(e.request.input as object), answers, message } : e.request.input,
        },
      });
      // Exact-action approvals for Mac changes never become saved rules.
      if (decision === "allowAlways" && !e.request.deviceWrite && !e.request.deviceAction) {
        const cat =
          (e.request.input as { category?: string } | undefined)?.category ?? e.request.toolName ?? "tool";
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
      else void this.run(agentId, e.request.title, (ctx) => this.afterApproval(ctx, { decision }));
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
        models: provider === "claude" ? CLAUDE_MODELS : CODEX_MODELS,
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

    "account.login.start": ({ id }) => {
      const a = this.account(id);
      if (!a) throw new Error("account not found");
      a.status = "signing_in";
      a.message = null;
      this.emit("account.updated", a);
      setTimeout(() => {
        if (a.provider === "claude") {
          this.emit("account.login", {
            accountId: id,
            phase: "prompt",
            url: "https://claude.ai/oauth/authorize?code=true&client_id=yo-mock&response_type=code&scope=user%3Ainference",
            needsInput: true,
            message: "Authorize Yo in your browser, then paste the code you get back here.",
          });
        } else {
          this.emit("account.login", {
            accountId: id,
            phase: "prompt",
            url: "https://auth.openai.com/codex/device",
            userCode: "K7QX-2MFD",
            needsInput: false,
            message: "Open the link and enter this code to sign in with ChatGPT.",
          });
          // Not scaled by &fast: the code has to stay on screen long enough to read (and for E2E to see it).
          setTimeout(() => this.finishLogin(a, "ChatGPT Plus"), 5000);
        }
      }, 700 * this.scale);
      return { ok: true };
    },

    "account.login.input": ({ id, input }) => {
      const a = this.account(id);
      if (!a) throw new Error("account not found");
      setTimeout(() => {
        if (input.trim().length < 4 || /bad|wrong/i.test(input)) {
          this.emit("account.login", {
            accountId: id,
            phase: "error",
            message: "That code didn't work. Try again.",
          });
          this.emit("account.login", {
            accountId: id,
            phase: "prompt",
            url: "https://claude.ai/oauth/authorize?code=true&client_id=yo-mock",
            needsInput: true,
            message: "Authorize Yo in your browser, then paste the code you get back here.",
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
      Object.assign(a, { status: "authenticated", plan: "API key", message: null });
      this.emit("account.updated", a);
      this.emit("account.login", { accountId: id, phase: "done" });
      return a;
    },

    "connect.detect": () => this.connect.detect(),
    "connect.claudeToken": ({ token, accountId }) => this.connect.claudeToken(token, accountId),
    "connect.codexImport": ({ accountId }) => this.connect.codexImport(accountId),

    "models.list": ({ accountId }) => this.account(accountId)?.models ?? [],

    "computer.overview": () => this.s.computer,

    "setup.requirements": () => evaluateRequirements(this.machine, "local"),

    "computer.start": () => {
      const c = this.s.computer;
      if (c.runtime === "running" || c.runtime === "starting") return c;
      if (!this.machine.tools.colima.installed) {
        Object.assign(c, {
          runtime: "error",
          message: "Colima is not installed. Run: brew install colima docker docker-compose",
        });
        this.emit("computer.updated", c);
        return c;
      }
      const steps: [number, Partial<typeof c>][] = [
        [0, { runtime: "starting", message: "Starting the Colima virtual machine…" }],
        [1800, { message: "Building Yo's computer image (Chromium, desktop, tools)…" }],
        [2600, { imageReady: true, message: "Connecting to Yo's computer…" }],
        [1500, { runtime: "running", connected: true, message: null, memMB: 1420 }],
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

    "memory.add": ({ content, agentId }) => {
      const m = {
        id: newId("mem"),
        agentId: agentId ?? null,
        content,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.s.memories.unshift(m);
      this.emit("memory.updated", m);
      return m;
    },

    "memory.update": ({ id, content }) => {
      const m = this.s.memories.find((x) => x.id === id);
      if (!m) throw new Error("memory not found");
      Object.assign(m, { content, updatedAt: Date.now() });
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

    "artifacts.list": ({ agentId }) =>
      this.s.artifacts
        .filter((a) => !agentId || a.agentId === agentId)
        .sort((a, b) => b.createdAt - a.createdAt),

    "bugReports.status": () => ({ ...this.bugFiling, defaultRepo: "JuniorSua/yo-app" }),
    "bugReports.configure": ({ token, repo }) => {
      if (token !== undefined) this.bugFiling.configured = !!token?.trim();
      if (repo !== undefined) {
        const r = repo?.trim() || "JuniorSua/yo-app";
        if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('Repository must look like "owner/name".');
        this.bugFiling.repo = r;
      }
      return { ...this.bugFiling, defaultRepo: "JuniorSua/yo-app" };
    },

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

    "host.openExternal": ({ url }) => {
      (window as any).__yoLastExternal = url;
      return { ok: true };
    },
  } satisfies { [M in keyof ApiMethods]: Handler<M> };

  private finishLogin(a: Account, plan: string) {
    if (a.status !== "signing_in") return;
    Object.assign(a, {
      status: "authenticated",
      plan,
      email: a.provider === "codex" ? "junior@example.com" : (a.email ?? "junior@example.com"),
      message: null,
    });
    this.emit("account.updated", a);
    this.emit("account.login", { accountId: a.id, phase: "done" });
  }
}
