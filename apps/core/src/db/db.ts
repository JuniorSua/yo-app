import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    avatar_json TEXT NOT NULL,
    account_id TEXT,
    model TEXT,
    effort TEXT,
    runtime_mode TEXT NOT NULL DEFAULT 'full-access',
    is_primary INTEGER NOT NULL DEFAULT 0,
    pinned INTEGER NOT NULL DEFAULT 0,
    unread INTEGER NOT NULL DEFAULT 0,
    last_active_at INTEGER,
    created_at INTEGER NOT NULL,
    archived_at INTEGER
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unknown',
    email TEXT,
    plan TEXT,
    message TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    models_json TEXT NOT NULL DEFAULT '[]',
    rate_limit_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE native_sessions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    resume_cursor_json TEXT,
    last_seq INTEGER NOT NULL DEFAULT 0,
    turn_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX idx_sessions_agent ON native_sessions(agent_id, started_at);

  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    trigger TEXT NOT NULL DEFAULT 'user',
    status TEXT NOT NULL,
    usage_json TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX idx_turns_agent ON turns(agent_id, started_at);

  CREATE TABLE timeline (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    turn_id TEXT,
    created_at INTEGER NOT NULL,
    item_json TEXT NOT NULL,
    request_json TEXT,
    source_json TEXT
  );
  CREATE INDEX idx_timeline_agent ON timeline(agent_id, seq);

  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE scratchpads (agent_id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL);

  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cron TEXT,
    run_at INTEGER,
    timezone TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    ref TEXT
  );
  CREATE INDEX idx_activity_ts ON activity(ts);

  CREATE TABLE approval_rules (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    match TEXT NOT NULL,
    decision TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    path TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  /* 2 — every Yo worker wears the headset (they're listening). Drawn avatars only; uploaded images untouched. */ `
  UPDATE agents
     SET avatar_json = json_set(avatar_json, '$.accessory', 'headset')
   WHERE json_extract(avatar_json, '$.image') IS NULL;
  `,
  /* 3 — /compact: a handoff summary that seeds the next native session instead of the full transcript. */ `
  CREATE TABLE context_summaries (
    agent_id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    upto_seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  /* 4 — controllers, paired devices, device grants, durable device operations, route decisions and
         one row per scheduled routine occurrence. Additive only. */ `
  CREATE TABLE IF NOT EXISTS controllers (
    id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    public_key TEXT NOT NULL,
    os_version TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    helper_version TEXT,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    permissions_json TEXT NOT NULL DEFAULT '{}',
    paused INTEGER NOT NULL DEFAULT 0,
    paired_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS device_grants (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    display_path TEXT NOT NULL,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    expires_at INTEGER,
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_grants_device ON device_grants(device_id);

  CREATE TABLE IF NOT EXISTS device_operations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    turn_id TEXT,
    device_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    display_path TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    args_digest TEXT,
    command_id TEXT,
    expected_sha256 TEXT,
    status TEXT NOT NULL,
    reason TEXT,
    bytes INTEGER,
    sha256 TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ops_agent ON device_operations(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_ops_status ON device_operations(status);

  CREATE TABLE IF NOT EXISTS route_decisions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    turn_id TEXT,
    target TEXT NOT NULL,
    device_id TEXT,
    capability TEXT NOT NULL,
    reason TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_routes_agent ON route_decisions(agent_id, created_at);

  CREATE TABLE IF NOT EXISTS routine_runs (
    routine_id TEXT NOT NULL,
    scheduled_for INTEGER NOT NULL,
    claimed_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    PRIMARY KEY (routine_id, scheduled_for)
  );
  `,
  /* 5 — bug reports Yo files for the developer are artifacts of kind 'bug'. */ `
  ALTER TABLE artifacts ADD COLUMN kind TEXT NOT NULL DEFAULT 'file';
  `,
  /* 6 — grants for Mac apps' data (Contacts / Calendar / Reminders) name the app. */ `
  ALTER TABLE device_grants ADD COLUMN app TEXT;
  `,
  /* 7 — bug reports: the agent drafts, the user says yes, then it's submitted (filed on GitHub or saved with a
         prefilled link). Drafts are bound to the agent's conversation; artifacts remember the issue. */ `
  CREATE TABLE IF NOT EXISTS bug_drafts (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    after_seq INTEGER NOT NULL,
    fields_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    artifact_id TEXT,
    created_at INTEGER NOT NULL,
    submitted_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bug_drafts_agent ON bug_drafts(agent_id, created_at);
  ALTER TABLE artifacts ADD COLUMN issue_json TEXT;
  `,
  /* 8 — tool screenshots are no longer kept in the timeline (nothing read them; they were most of its
     size), plus indexes for the pending-request scan, the chat preview and per-agent activity, and steps that
     ended turns left "running" are closed. */ `
  UPDATE timeline SET item_json = json_remove(item_json, '$.image')
   WHERE json_extract(item_json, '$.image') IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_timeline_requests ON timeline(seq) WHERE request_json IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_timeline_messages ON timeline(agent_id, seq)
   WHERE json_extract(item_json, '$.kind') IN ('assistant_message','user_message');
  CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity(agent_id, ts);
  UPDATE timeline SET item_json = json_set(item_json, '$.status', 'failed')
   WHERE json_extract(item_json, '$.status') = 'running'
     AND turn_id IN (SELECT id FROM turns WHERE status != 'running');
  `,
];

export type Db = DatabaseSync;

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "yo.sqlite"));
  migrate(db);
  return db;
}

export function openMemoryDb(): Db {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  // synchronous=NORMAL is durable under WAL (a power cut can lose only the last commits, never corrupt).
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const row = db.prepare("SELECT MAX(version) AS v FROM _migrations").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[i]!);
      db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(i + 1, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
