import {
  type Account,
  type ActivityEvent,
  type Agent,
  type ApprovalRule,
  type Artifact,
  type Avatar,
  DEFAULT_SETTINGS,
  type Item,
  type Memory,
  type ModelInfo,
  newId,
  type PendingRequest,
  type ProviderKind,
  type RateLimitInfo,
  type ReportBugInput,
  type ResumeCursor,
  type Routine,
  type RuntimeMode,
  type Settings,
  type TimelineEntry,
} from "@yo/contracts";
import type { Db } from "./db";

type Row = Record<string, any>;

const json = <T>(v: string | null | undefined, fallback: T): T => {
  if (v == null) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

export interface NativeSession {
  id: string;
  agentId: string;
  accountId: string;
  provider: ProviderKind;
  model: string | null;
  resumeCursor: ResumeCursor | null;
  lastSeq: number;
  turnCount: number;
  startedAt: number;
  endedAt: number | null;
}

export type RequestStatus = NonNullable<TimelineEntry["request"]>["status"];

export class Store {
  constructor(readonly db: Db) {}

  /* ------------------------------- settings ------------------------------- */

  /* ----------------------------- routine runs ----------------------------- */

  /** Claim one scheduled occurrence. False if it was already claimed. */
  claimRoutineRun(routineId: string, scheduledFor: number, now = Date.now()): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO routine_runs (routine_id, scheduled_for, claimed_at, status, error) VALUES (?, ?, ?, 'claimed', NULL)",
      )
      .run(routineId, scheduledFor, now);
    return Number(res.changes) === 1;
  }

  setRoutineRunStatus(routineId: string, scheduledFor: number, status: string, error: string | null) {
    this.db
      .prepare("UPDATE routine_runs SET status = ?, error = ? WHERE routine_id = ? AND scheduled_for = ?")
      .run(status, error, routineId, scheduledFor);
  }

  claimedRoutineRuns(): { routineId: string; scheduledFor: number }[] {
    return (
      this.db
        .prepare("SELECT routine_id, scheduled_for FROM routine_runs WHERE status = 'claimed'")
        .all() as Row[]
    ).map((r) => ({ routineId: r.routine_id as string, scheduledFor: r.scheduled_for as number }));
  }

  getSettings(): Settings {
    const rows = this.db.prepare("SELECT key, value_json FROM settings").all() as Row[];
    const s: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of rows) if (r.key in DEFAULT_SETTINGS) s[r.key] = json(r.value_json, null);
    return s as Settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
    );
    for (const [k, v] of Object.entries(patch))
      if (k in DEFAULT_SETTINGS && v !== undefined) stmt.run(k, JSON.stringify(v));
    return this.getSettings();
  }

  getKv<T>(key: string): T | null {
    const r = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`_${key}`) as
      | Row
      | undefined;
    return r ? json<T | null>(r.value_json, null) : null;
  }

  setKv(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
      )
      .run(`_${key}`, JSON.stringify(value));
  }

  /* -------------------------------- agents -------------------------------- */

  private toAgent(r: Row): Agent & { unread: number; lastActiveAt: number | null } {
    return {
      id: r.id,
      name: r.name,
      role: r.role,
      instructions: r.instructions,
      avatar: json<Avatar>(r.avatar_json, {
        shape: "bubble",
        color: "yo",
        eyes: "capsule",
        accessory: "none",
      }),
      accountId: r.account_id ?? null,
      model: r.model ?? null,
      effort: r.effort ?? null,
      runtimeMode: r.runtime_mode as RuntimeMode,
      isPrimary: !!r.is_primary,
      pinned: !!r.pinned,
      createdAt: r.created_at,
      archivedAt: r.archived_at ?? null,
      unread: r.unread ?? 0,
      lastActiveAt: r.last_active_at ?? null,
    };
  }

  listAgents() {
    const rows = this.db
      .prepare(
        "SELECT * FROM agents WHERE archived_at IS NULL ORDER BY is_primary DESC, pinned DESC, created_at ASC",
      )
      .all() as Row[];
    return rows.map((r) => this.toAgent(r));
  }

  getAgent(id: string) {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toAgent(r) : null;
  }

  createAgent(a: Omit<Agent, "id" | "createdAt" | "archivedAt"> & { id?: string }) {
    const id = a.id ?? newId("agt");
    this.db
      .prepare(
        `INSERT INTO agents (id, name, role, instructions, avatar_json, account_id, model, effort, runtime_mode, is_primary, pinned, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        a.name,
        a.role,
        a.instructions,
        JSON.stringify(a.avatar),
        a.accountId,
        a.model,
        a.effort,
        a.runtimeMode,
        a.isPrimary ? 1 : 0,
        a.pinned ? 1 : 0,
        Date.now(),
      );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, patch: Partial<Omit<Agent, "id" | "createdAt">>) {
    const map: Record<string, [string, (v: any) => unknown]> = {
      name: ["name", (v) => v],
      role: ["role", (v) => v],
      instructions: ["instructions", (v) => v],
      avatar: ["avatar_json", (v) => JSON.stringify(v)],
      accountId: ["account_id", (v) => v],
      model: ["model", (v) => v],
      effort: ["effort", (v) => v],
      runtimeMode: ["runtime_mode", (v) => v],
      pinned: ["pinned", (v) => (v ? 1 : 0)],
      archivedAt: ["archived_at", (v) => v],
    };
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      this.db.prepare(`UPDATE agents SET ${m[0]} = ? WHERE id = ?`).run(m[1](v) as any, id);
    }
    return this.getAgent(id);
  }

  bumpUnread(id: string, by = 1) {
    this.db.prepare("UPDATE agents SET unread = unread + ? WHERE id = ?").run(by, id);
  }
  clearUnread(id: string) {
    this.db.prepare("UPDATE agents SET unread = 0 WHERE id = ?").run(id);
  }
  touchAgent(id: string) {
    this.db.prepare("UPDATE agents SET last_active_at = ? WHERE id = ?").run(Date.now(), id);
  }

  /* ------------------------------- accounts ------------------------------- */

  private toAccount(r: Row): Account {
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      status: r.status,
      email: r.email ?? null,
      plan: r.plan ?? null,
      message: r.message ?? null,
      isDefault: !!r.is_default,
      models: json<ModelInfo[]>(r.models_json, []),
      rateLimit: json<RateLimitInfo | null>(r.rate_limit_json, null),
      createdAt: r.created_at,
    };
  }

  listAccounts(): Account[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all() as Row[]).map((r) =>
      this.toAccount(r),
    );
  }

  getAccount(id: string): Account | null {
    const r = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toAccount(r) : null;
  }

  createAccount(provider: ProviderKind, label: string): Account {
    const id = newId("acc");
    const hasDefault = this.db.prepare("SELECT 1 FROM accounts WHERE is_default = 1").get();
    this.db
      .prepare("INSERT INTO accounts (id, provider, label, is_default, created_at) VALUES (?,?,?,?,?)")
      .run(id, provider, label, hasDefault ? 0 : 1, Date.now());
    return this.getAccount(id)!;
  }

  updateAccount(id: string, patch: Partial<Omit<Account, "id" | "provider" | "createdAt">>): Account | null {
    const map: Record<string, [string, (v: any) => unknown]> = {
      label: ["label", (v) => v],
      status: ["status", (v) => v],
      email: ["email", (v) => v],
      plan: ["plan", (v) => v],
      message: ["message", (v) => v],
      models: ["models_json", (v) => JSON.stringify(v)],
      rateLimit: ["rate_limit_json", (v) => (v ? JSON.stringify(v) : null)],
    };
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      this.db.prepare(`UPDATE accounts SET ${m[0]} = ? WHERE id = ?`).run(m[1](v) as any, id);
    }
    return this.getAccount(id);
  }

  setDefaultAccount(id: string) {
    this.db.exec("BEGIN");
    this.db.prepare("UPDATE accounts SET is_default = 0").run();
    this.db.prepare("UPDATE accounts SET is_default = 1 WHERE id = ?").run(id);
    this.db.exec("COMMIT");
  }

  deleteAccount(id: string) {
    const acc = this.getAccount(id);
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    this.db.prepare("UPDATE agents SET account_id = NULL WHERE account_id = ?").run(id);
    if (acc?.isDefault) {
      const next = this.db.prepare("SELECT id FROM accounts ORDER BY created_at LIMIT 1").get() as
        | Row
        | undefined;
      if (next) this.setDefaultAccount(next.id);
    }
  }

  defaultAccount(): Account | null {
    const r = this.db.prepare("SELECT * FROM accounts WHERE is_default = 1").get() as Row | undefined;
    return r ? this.toAccount(r) : (this.listAccounts()[0] ?? null);
  }

  /* ------------------------------- sessions ------------------------------- */

  private toSession(r: Row): NativeSession {
    return {
      id: r.id,
      agentId: r.agent_id,
      accountId: r.account_id,
      provider: r.provider,
      model: r.model ?? null,
      resumeCursor: json<ResumeCursor | null>(r.resume_cursor_json, null),
      lastSeq: r.last_seq,
      turnCount: r.turn_count,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? null,
    };
  }

  latestSession(agentId: string): NativeSession | null {
    const r = this.db
      .prepare("SELECT * FROM native_sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(agentId) as Row | undefined;
    return r ? this.toSession(r) : null;
  }

  getSession(id: string): NativeSession | null {
    const r = this.db.prepare("SELECT * FROM native_sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toSession(r) : null;
  }

  openSessions(): NativeSession[] {
    return (this.db.prepare("SELECT * FROM native_sessions WHERE ended_at IS NULL").all() as Row[]).map((r) =>
      this.toSession(r),
    );
  }

  createSession(s: {
    agentId: string;
    accountId: string;
    provider: ProviderKind;
    model: string | null;
  }): NativeSession {
    const id = newId("ses");
    this.db
      .prepare(
        "INSERT INTO native_sessions (id, agent_id, account_id, provider, model, started_at) VALUES (?,?,?,?,?,?)",
      )
      .run(id, s.agentId, s.accountId, s.provider, s.model, Date.now());
    return this.getSession(id)!;
  }

  updateSession(id: string, patch: { resumeCursor?: ResumeCursor; lastSeq?: number; model?: string | null }) {
    if (patch.resumeCursor !== undefined)
      this.db
        .prepare("UPDATE native_sessions SET resume_cursor_json = ? WHERE id = ?")
        .run(JSON.stringify(patch.resumeCursor), id);
    if (patch.lastSeq !== undefined)
      this.db.prepare("UPDATE native_sessions SET last_seq = ? WHERE id = ?").run(patch.lastSeq, id);
    if (patch.model !== undefined)
      this.db.prepare("UPDATE native_sessions SET model = ? WHERE id = ?").run(patch.model, id);
  }

  incSessionTurns(id: string) {
    this.db.prepare("UPDATE native_sessions SET turn_count = turn_count + 1 WHERE id = ?").run(id);
  }

  endSession(id: string) {
    this.db
      .prepare("UPDATE native_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
      .run(Date.now(), id);
  }

  /* --------------------------------- turns -------------------------------- */

  createTurn(t: { id: string; agentId: string; sessionId: string | null; trigger: string }) {
    this.db
      .prepare(
        "INSERT INTO turns (id, agent_id, session_id, trigger, status, started_at) VALUES (?,?,?,?,?,?)",
      )
      .run(t.id, t.agentId, t.sessionId, t.trigger, "running", Date.now());
  }

  finishTurn(id: string, status: string, usage?: unknown, error?: string) {
    this.db
      .prepare("UPDATE turns SET status = ?, usage_json = ?, error = ?, completed_at = ? WHERE id = ?")
      .run(status, usage ? JSON.stringify(usage) : null, error ?? null, Date.now(), id);
  }

  /** Core (re)started: turns that were running are over. Returns them so their agents can be told. */
  failRunningTurns(): { id: string; agentId: string }[] {
    const rows = this.db.prepare("SELECT id, agent_id FROM turns WHERE status = 'running'").all() as Row[];
    this.db
      .prepare("UPDATE turns SET status = 'interrupted', completed_at = ? WHERE status = 'running'")
      .run(Date.now());
    return rows.map((r) => ({ id: r.id, agentId: r.agent_id }));
  }

  /** A turn ended: steps it left "running" (stopped, crashed, lost connection) get a final status. */
  closeRunningItems(turnId: string, status: "completed" | "failed"): TimelineEntry[] {
    const running = "turn_id = ? AND json_extract(item_json, '$.status') = 'running'";
    const rows = this.db.prepare(`SELECT id FROM timeline WHERE ${running}`).all(turnId) as Row[];
    if (!rows.length) return [];
    this.db
      .prepare(`UPDATE timeline SET item_json = json_set(item_json, '$.status', ?) WHERE ${running}`)
      .run(status, turnId);
    return rows.map((r) => this.getEntry(r.id)).filter((e): e is TimelineEntry => !!e);
  }

  /* ------------------------------- timeline ------------------------------- */

  private toEntry(r: Row): TimelineEntry {
    const entry: TimelineEntry = {
      id: r.id,
      agentId: r.agent_id,
      turnId: r.turn_id ?? null,
      seq: r.seq,
      createdAt: r.created_at,
      item: json<Item>(r.item_json, { id: r.id, kind: "notice", status: "completed" }),
    };
    const req = json<TimelineEntry["request"] | null>(r.request_json, null);
    if (req) entry.request = req;
    const src = json<TimelineEntry["source"] | null>(r.source_json, null);
    if (src) entry.source = src;
    return entry;
  }

  upsertEntry(e: {
    id: string;
    agentId: string;
    turnId: string | null;
    item: Item;
    request?: TimelineEntry["request"];
    source?: TimelineEntry["source"];
  }): TimelineEntry {
    // Tool screenshots (base64) aren't kept: nothing reads them back and they dwarfed everything else.
    if (e.item.image) {
      const { image: _image, ...item } = e.item;
      e = { ...e, item };
    }
    const existing = this.db.prepare("SELECT seq, created_at FROM timeline WHERE id = ?").get(e.id) as
      | Row
      | undefined;
    if (existing) {
      this.db
        .prepare(
          "UPDATE timeline SET item_json = ?, request_json = COALESCE(?, request_json), source_json = COALESCE(?, source_json), turn_id = COALESCE(?, turn_id) WHERE id = ?",
        )
        .run(
          JSON.stringify(e.item),
          e.request ? JSON.stringify(e.request) : null,
          e.source ? JSON.stringify(e.source) : null,
          e.turnId,
          e.id,
        );
    } else {
      this.db
        .prepare(
          "INSERT INTO timeline (id, agent_id, turn_id, created_at, item_json, request_json, source_json) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          e.id,
          e.agentId,
          e.turnId,
          Date.now(),
          JSON.stringify(e.item),
          e.request ? JSON.stringify(e.request) : null,
          e.source ? JSON.stringify(e.source) : null,
        );
    }
    return this.getEntry(e.id)!;
  }

  getEntry(id: string): TimelineEntry | null {
    const r = this.db.prepare("SELECT * FROM timeline WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toEntry(r) : null;
  }

  setRequestStatus(entryId: string, status: RequestStatus): TimelineEntry | null {
    const e = this.getEntry(entryId);
    if (!e?.request) return e;
    const request = { ...e.request, status };
    this.db
      .prepare("UPDATE timeline SET request_json = ? WHERE id = ?")
      .run(JSON.stringify(request), entryId);
    return this.getEntry(entryId);
  }

  listTimeline(agentId: string, before?: number, limit = 200): TimelineEntry[] {
    const rows = (
      before
        ? this.db
            .prepare("SELECT * FROM timeline WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
            .all(agentId, before, limit)
        : this.db
            .prepare("SELECT * FROM timeline WHERE agent_id = ? ORDER BY seq DESC LIMIT ?")
            .all(agentId, limit)
    ) as Row[];
    return rows.reverse().map((r) => this.toEntry(r));
  }

  pendingRequests(): TimelineEntry[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM timeline WHERE request_json IS NOT NULL AND json_extract(request_json, '$.status') = 'pending' ORDER BY seq ASC",
      )
      .all() as Row[];
    return rows.map((r) => this.toEntry(r));
  }

  expirePendingRequests() {
    for (const e of this.pendingRequests()) this.setRequestStatus(e.id, "expired");
  }

  lastAssistantPreview(agentId: string): string | null {
    const r = this.db
      .prepare(
        "SELECT item_json FROM timeline WHERE agent_id = ? AND json_extract(item_json, '$.kind') IN ('assistant_message','user_message') ORDER BY seq DESC LIMIT 1",
      )
      .get(agentId) as Row | undefined;
    if (!r) return null;
    const item = json<Item | null>(r.item_json, null);
    return item?.text ? item.text.replace(/\s+/g, " ").slice(0, 140) : null;
  }

  /** Recent conversation (user + assistant messages) for seeding a fresh session. */
  recentConversation(
    agentId: string,
    limit = 24,
    afterSeq = 0,
  ): { role: "user" | "assistant"; text: string; at: number }[] {
    const rows = this.db
      .prepare(
        "SELECT item_json, created_at FROM timeline WHERE agent_id = ? AND seq > ? AND json_extract(item_json, '$.kind') IN ('assistant_message','user_message') ORDER BY seq DESC LIMIT ?",
      )
      .all(agentId, afterSeq, limit) as Row[];
    return rows
      .reverse()
      .map((r) => {
        const item = json<Item | null>(r.item_json, null);
        return {
          role: item?.kind === "user_message" ? ("user" as const) : ("assistant" as const),
          text: item?.text ?? "",
          at: r.created_at as number,
        };
      })
      .filter((m) => m.text);
  }

  /** Highest timeline seq for an agent (0 when empty). */
  maxTimelineSeq(agentId: string): number {
    const r = this.db.prepare("SELECT MAX(seq) AS s FROM timeline WHERE agent_id = ?").get(agentId) as Row;
    return (r?.s as number | null) ?? 0;
  }

  /* --------------------------- context summaries -------------------------- */

  getContextSummary(agentId: string): { summary: string; uptoSeq: number; createdAt: number } | null {
    const r = this.db.prepare("SELECT * FROM context_summaries WHERE agent_id = ?").get(agentId) as
      | Row
      | undefined;
    return r ? { summary: r.summary, uptoSeq: r.upto_seq, createdAt: r.created_at } : null;
  }

  setContextSummary(agentId: string, summary: string, uptoSeq: number) {
    this.db
      .prepare(
        "INSERT INTO context_summaries (agent_id, summary, upto_seq, created_at) VALUES (?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET summary = excluded.summary, upto_seq = excluded.upto_seq, created_at = excluded.created_at",
      )
      .run(agentId, summary, uptoSeq, Date.now());
  }

  /* ------------------------------- memories ------------------------------- */

  private toMemory(r: Row): Memory {
    return {
      id: r.id,
      agentId: r.agent_id ?? null,
      content: r.content,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listMemories(agentId?: string | null): Memory[] {
    const rows = (
      agentId
        ? this.db
            .prepare("SELECT * FROM memories WHERE agent_id IS NULL OR agent_id = ? ORDER BY updated_at DESC")
            .all(agentId)
        : this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC").all()
    ) as Row[];
    return rows.map((r) => this.toMemory(r));
  }

  addMemory(content: string, agentId: string | null): Memory {
    const id = newId("mem");
    const now = Date.now();
    this.db
      .prepare("INSERT INTO memories (id, agent_id, content, created_at, updated_at) VALUES (?,?,?,?,?)")
      .run(id, agentId, content, now, now);
    return this.toMemory(this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row);
  }

  updateMemory(id: string, content: string): Memory | null {
    this.db
      .prepare("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?")
      .run(content, Date.now(), id);
    const r = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toMemory(r) : null;
  }

  deleteMemory(id: string) {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  searchMemories(query: string, agentId: string): Memory[] {
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2);
    const all = this.listMemories(agentId);
    if (!terms.length) return all.slice(0, 20);
    return all
      .map((m) => ({ m, score: terms.filter((t) => m.content.toLowerCase().includes(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
      .map((x) => x.m);
  }

  getScratchpad(agentId: string): string {
    const r = this.db.prepare("SELECT content FROM scratchpads WHERE agent_id = ?").get(agentId) as
      | Row
      | undefined;
    return r?.content ?? "";
  }

  setScratchpad(agentId: string, content: string) {
    this.db
      .prepare(
        "INSERT INTO scratchpads (agent_id, content, updated_at) VALUES (?,?,?) ON CONFLICT(agent_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
      )
      .run(agentId, content, Date.now());
  }

  /* ------------------------------- routines ------------------------------- */

  private toRoutine(r: Row): Routine {
    return {
      id: r.id,
      agentId: r.agent_id,
      name: r.name,
      prompt: r.prompt,
      cron: r.cron ?? null,
      runAt: r.run_at ?? null,
      timezone: r.timezone,
      enabled: !!r.enabled,
      nextRunAt: r.next_run_at ?? null,
      lastRunAt: r.last_run_at ?? null,
      createdAt: r.created_at,
    };
  }

  listRoutines(agentId?: string): Routine[] {
    const rows = (
      agentId
        ? this.db.prepare("SELECT * FROM routines WHERE agent_id = ? ORDER BY created_at").all(agentId)
        : this.db.prepare("SELECT * FROM routines ORDER BY created_at").all()
    ) as Row[];
    return rows.map((r) => this.toRoutine(r));
  }

  getRoutine(id: string): Routine | null {
    const r = this.db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toRoutine(r) : null;
  }

  createRoutine(r: Omit<Routine, "id" | "createdAt" | "lastRunAt">): Routine {
    const id = newId("rtn");
    this.db
      .prepare(
        "INSERT INTO routines (id, agent_id, name, prompt, cron, run_at, timezone, enabled, next_run_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        r.agentId,
        r.name,
        r.prompt,
        r.cron,
        r.runAt,
        r.timezone,
        r.enabled ? 1 : 0,
        r.nextRunAt,
        Date.now(),
      );
    return this.getRoutine(id)!;
  }

  updateRoutine(id: string, patch: Partial<Omit<Routine, "id" | "createdAt" | "agentId">>): Routine | null {
    const map: Record<string, [string, (v: any) => unknown]> = {
      name: ["name", (v) => v],
      prompt: ["prompt", (v) => v],
      cron: ["cron", (v) => v],
      runAt: ["run_at", (v) => v],
      enabled: ["enabled", (v) => (v ? 1 : 0)],
      nextRunAt: ["next_run_at", (v) => v],
      lastRunAt: ["last_run_at", (v) => v],
      timezone: ["timezone", (v) => v],
    };
    for (const [k, v] of Object.entries(patch)) {
      const m = map[k];
      if (!m || v === undefined) continue;
      this.db.prepare(`UPDATE routines SET ${m[0]} = ? WHERE id = ?`).run(m[1](v) as any, id);
    }
    return this.getRoutine(id);
  }

  deleteRoutine(id: string) {
    this.db.prepare("DELETE FROM routines WHERE id = ?").run(id);
  }

  /* ------------------------------- activity ------------------------------- */

  addActivity(a: Omit<ActivityEvent, "id" | "ts">): ActivityEvent {
    const ev: ActivityEvent = { ...a, id: newId("act"), ts: Date.now() };
    this.db
      .prepare("INSERT INTO activity (id, agent_id, ts, kind, summary, ref) VALUES (?,?,?,?,?,?)")
      .run(ev.id, ev.agentId, ev.ts, ev.kind, ev.summary, ev.ref);
    return ev;
  }

  listActivity(agentId?: string, limit = 200): ActivityEvent[] {
    const rows = (
      agentId
        ? this.db
            .prepare("SELECT * FROM activity WHERE agent_id = ? ORDER BY ts DESC LIMIT ?")
            .all(agentId, limit)
        : this.db.prepare("SELECT * FROM activity ORDER BY ts DESC LIMIT ?").all(limit)
    ) as Row[];
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id ?? null,
      ts: r.ts,
      kind: r.kind,
      summary: r.summary,
      ref: r.ref ?? null,
    }));
  }

  /* -------------------------------- rules --------------------------------- */

  listRules(): ApprovalRule[] {
    return (this.db.prepare("SELECT * FROM approval_rules ORDER BY created_at DESC").all() as Row[]).map(
      (r) => ({
        id: r.id,
        agentId: r.agent_id ?? null,
        match: r.match,
        decision: r.decision,
        createdAt: r.created_at,
      }),
    );
  }

  addRule(r: Omit<ApprovalRule, "id" | "createdAt">): ApprovalRule {
    const id = newId("rul");
    this.db
      .prepare("INSERT INTO approval_rules (id, agent_id, match, decision, created_at) VALUES (?,?,?,?,?)")
      .run(id, r.agentId, r.match, r.decision, Date.now());
    return this.listRules().find((x) => x.id === id)!;
  }

  deleteRule(id: string) {
    this.db.prepare("DELETE FROM approval_rules WHERE id = ?").run(id);
  }

  findRule(agentId: string, match: string): ApprovalRule | null {
    return (
      this.listRules().find((r) => r.match === match && (r.agentId === null || r.agentId === agentId)) ?? null
    );
  }

  /* ------------------------------ bug reports ----------------------------- */

  addBugDraft(agentId: string, fields: ReportBugInput): BugDraft {
    const id = newId("bdr");
    this.db
      .prepare(
        "INSERT INTO bug_drafts (id, agent_id, after_seq, fields_json, status, created_at) VALUES (?,?,?,?, 'draft', ?)",
      )
      .run(id, agentId, this.maxTimelineSeq(agentId), JSON.stringify(fields), Date.now());
    return this.getBugDraft(id)!;
  }

  getBugDraft(id: string): BugDraft | null {
    const r = this.db.prepare("SELECT * FROM bug_drafts WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: r.id,
      agentId: r.agent_id,
      afterSeq: r.after_seq,
      fields: json<ReportBugInput>(r.fields_json, {}),
      status: r.status === "submitted" || r.status === "submitting" ? r.status : "draft",
      artifactId: r.artifact_id ?? null,
      createdAt: r.created_at,
      submittedAt: r.submitted_at ?? null,
    };
  }

  /** Atomically take a draft for submitting. False if another call already has it (or it was submitted). */
  claimBugDraft(id: string): boolean {
    const res = this.db
      .prepare("UPDATE bug_drafts SET status = 'submitting' WHERE id = ? AND status = 'draft'")
      .run(id);
    return Number(res.changes) === 1;
  }

  /** Give a claimed draft back (its submit failed before anything was saved). */
  releaseBugDraft(id: string) {
    this.db.prepare("UPDATE bug_drafts SET status = 'draft' WHERE id = ? AND status = 'submitting'").run(id);
  }

  /**
   * When the turn that was running at `at` ended: a number, `null` while it's still running, `undefined` when
   * no turn covers that moment.
   */
  turnEndAt(agentId: string, at: number): number | null | undefined {
    const r = this.db
      .prepare(
        "SELECT completed_at FROM turns WHERE agent_id = ? AND started_at <= ? AND (completed_at IS NULL OR completed_at >= ?) ORDER BY started_at DESC LIMIT 1",
      )
      .get(agentId, at, at) as Row | undefined;
    if (!r) return undefined;
    return (r.completed_at as number | null) ?? null;
  }

  markBugDraftSubmitted(id: string, artifactId: string) {
    this.db
      .prepare("UPDATE bug_drafts SET status = 'submitted', artifact_id = ?, submitted_at = ? WHERE id = ?")
      .run(artifactId, Date.now(), id);
  }

  /** Messages the user typed (not routines) after a timeline position, oldest first. */
  userMessagesAfter(agentId: string, seq: number): { text: string; at: number }[] {
    const rows = this.db
      .prepare(
        "SELECT item_json, created_at FROM timeline WHERE agent_id = ? AND seq > ? AND json_extract(item_json, '$.kind') = 'user_message' ORDER BY seq ASC",
      )
      .all(agentId, seq) as Row[];
    return rows
      .map((r) => ({ item: json<Item | null>(r.item_json, null), at: r.created_at as number }))
      .filter((m) => !!m.item && !m.item.title?.startsWith("Routine"))
      .map((m) => ({ text: m.item!.text ?? "", at: m.at }));
  }

  /* ------------------------------- artifacts ------------------------------ */

  addArtifact(a: Omit<Artifact, "id" | "createdAt" | "issue"> & { storedPath: string }): Artifact {
    const id = newId("art");
    this.db
      .prepare(
        "INSERT INTO artifacts (id, agent_id, title, path, mime, size, stored_path, created_at, kind) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(id, a.agentId, a.title, a.path, a.mime, a.size, a.storedPath, Date.now(), a.kind ?? "file");
    return this.listArtifacts().find((x) => x.id === id)!;
  }

  listArtifacts(agentId?: string): Artifact[] {
    const rows = (
      agentId
        ? this.db.prepare("SELECT * FROM artifacts WHERE agent_id = ? ORDER BY created_at DESC").all(agentId)
        : this.db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all()
    ) as Row[];
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      title: r.title,
      path: r.path,
      mime: r.mime,
      size: r.size,
      createdAt: r.created_at,
      kind: r.kind === "bug" ? "bug" : "file",
      ...(r.issue_json ? { issue: json<Artifact["issue"]>(r.issue_json, undefined) } : {}),
    }));
  }

  getArtifact(id: string): Artifact | null {
    return this.listArtifacts().find((a) => a.id === id) ?? null;
  }

  setArtifactIssue(id: string, issue: NonNullable<Artifact["issue"]>): Artifact | null {
    this.db.prepare("UPDATE artifacts SET issue_json = ? WHERE id = ?").run(JSON.stringify(issue), id);
    return this.getArtifact(id);
  }

  artifactFile(id: string): { storedPath: string; mime: string; title: string } | null {
    const r = this.db.prepare("SELECT stored_path, mime, title FROM artifacts WHERE id = ?").get(id) as
      | Row
      | undefined;
    return r ? { storedPath: r.stored_path, mime: r.mime, title: r.title } : null;
  }
}

export interface BugDraft {
  id: string;
  agentId: string;
  /** Timeline position when it was drafted: the user's OK must come after it. */
  afterSeq: number;
  fields: ReportBugInput;
  /** "submitting" = claimed by one submit call while it files (no second issue from a parallel call). */
  status: "draft" | "submitting" | "submitted";
  artifactId: string | null;
  createdAt: number;
  submittedAt: number | null;
}

export type { PendingRequest };
