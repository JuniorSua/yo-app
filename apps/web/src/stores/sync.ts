/** Wires the API client's pushes into the zustand stores and exposes data loaders. */
import type { AgentView, ApiPushes } from "@yo/contracts";
import { toast } from "sonner";
import { api, isUnknownMethod } from "../lib/api";
import { friendlyError } from "../lib/connection";
import { nativeNotify } from "../lib/desktop";
import { applyTaskUpdate } from "../lib/tasks";
import { applyAccountUpdate, chatFor, offeredAccounts, trackWorkingSince, upsertById, useApp } from "./app";
import { startDeviceSync } from "./device";
import { pickAgentId, spaceView } from "./space";
import { useTimeline } from "./timeline";
import { ui, useUI } from "./ui";

let started = false;
/** A bootstrap call is in flight (the first one waits in the send queue until the socket opens). */
let booting = false;
const ignore = () => undefined;
function omitKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = rec;
  return rest;
}

function loadBootstrap() {
  return api().call("bootstrap", {});
}

export async function bootstrap() {
  booting = true;
  let b: Awaited<ReturnType<typeof loadBootstrap>>;
  try {
    b = await loadBootstrap();
  } finally {
    booting = false;
  }
  const agents: Record<string, AgentView> = {};
  for (const a of b.agents) agents[a.id] = a;
  // Agents that finished while we were away stop their clocks (passing each one as both before and after keeps
  // the ones still busy as they were).
  let workingSince = useApp.getState().workingSince;
  for (const a of b.agents) workingSince = trackWorkingSince(workingSince, a, a);
  for (const id of Object.keys(workingSince)) if (!agents[id]) workingSince = omitKey(workingSince, id);
  const reconnect = useApp.getState().booted;
  useApp.setState({
    booted: true,
    workingSince,
    version: b.version,
    settings: b.settings,
    agents,
    accounts: offeredAccounts(b.accounts),
    computer: b.computer,
    // Older cores don't send it: device features are then shown as unavailable.
    execution: b.execution ?? null,
  });
  // The saved chat, unless it's gone or (on first load) it's the other space's agent: then the active space's (Pip
  // in Personal time, Yo otherwise). A reconnect keeps the chat that's on screen.
  const { agentId } = useUI.getState();
  const pick = pickAgentId(agents, agentId, spaceView(Date.now(), b.settings, agents), {
    keepOpen: reconnect,
  });
  if (pick && pick !== agentId) useUI.setState({ agentId: pick });
  void api()
    .call("approvals.pending", {})
    .then((approvals) => useApp.setState({ approvals }))
    .catch(ignore); // the Approvals page loads them again (and says so if that fails)
  // "Up next": only a busy agent can have messages waiting. Older cores have no queue.* (nothing shows).
  useApp.setState({ queues: {} });
  for (const a of b.agents)
    if (a.activity === "working" || a.activity === "waiting")
      void api()
        .call("queue.list", { agentId: a.id })
        .then((items) => useApp.setState((s) => ({ queues: { ...s.queues, [a.id]: items } })))
        .catch(ignore);
}
/**
 * "Try again" on the connecting screens. With the socket up, only the first load failed: run it again. Otherwise
 * reconnect right away instead of waiting out the backoff (never a page reload: in the desktop app, reloading
 * while Yo is unreachable leaves a browser error page instead of Yo).
 */
export function retryConnection() {
  const c = api();
  if (c.status() === "open") {
    // Even if a first load is still pending: it may be stuck behind a core that was busy; a second is harmless.
    if (!useApp.getState().booted) void bootstrap().catch(ignore);
  } else c.reconnectNow();
}

function onNotify(push: ApiPushes["notify"]) {
  const { settings, agents } = useApp.getState();
  // A helper's news opens the chat of the agent that started it.
  const n = push.agentId ? { ...push, agentId: chatFor(agents, push.agentId) } : push;
  const viewing =
    useUI.getState().page === "agent" && useUI.getState().agentId === n.agentId && document.hasFocus();
  if (!viewing || n.kind === "needs_you" || n.kind === "error") {
    const opts = {
      description: n.body,
      action: n.agentId ? { label: "Open", onClick: () => ui.openAgent(n.agentId!) } : undefined,
    };
    if (n.kind === "error") toast.error(n.title, opts);
    else if (n.kind === "needs_you") toast.warning(n.title, opts);
    else if (n.kind === "done") toast.success(n.title, opts);
    else toast(n.title, opts);
  }
  if (settings.notifications && (!document.hasFocus() || n.kind === "needs_you")) {
    nativeNotify(n.title, n.body, n.agentId ?? undefined);
  }
}

export function startSync() {
  if (started) return;
  started = true;
  const c = api();

  c.onStatus((connection, reconnected) => {
    useApp.setState({ connection });
    // The very first connection failed long enough for the initial bootstrap to time out (say a Home PC's
    // core refused the socket until it was fixed): load now, or the app stays on "Connecting to Yo…" forever.
    if (connection === "open" && !reconnected && !useApp.getState().booted && !booting) {
      void bootstrap().catch(() => undefined);
      return;
    }
    if (connection === "open" && reconnected) {
      useTimeline.getState().reset();
      // Lists that are on screen stay visible and get refreshed (anything could have changed while we were
      // disconnected). Clearing them instead left mounted views — e.g. the Workspace's Upcoming list — empty,
      // and every later push was dropped because there was no list to update.
      const st = useApp.getState();
      // A refresh that fails keeps what's on screen; the page's own retry (or the next reconnect) catches up.
      if (st.routines) load.routines(true).catch(ignore);
      if (st.memories) load.memories(true).catch(ignore);
      if (st.activity) load.activity(true).catch(ignore);
      if (st.artifacts) load.artifacts(true).catch(ignore);
      if (st.rules) load.rules().catch(ignore);
      if (st.operations) load.operations(true).catch(ignore);
      for (const id of Object.keys(st.tasks)) load.tasks(id).catch(ignore);
      bootstrap()
        .catch((e) =>
          toast.error("Couldn't refresh after reconnecting", {
            description: friendlyError(e),
            action: { label: "Try again", onClick: () => void bootstrap().catch(ignore) },
          }),
        )
        .finally(() => {
          // Reload the open chat either way: reset() marked it stale.
          const id = useUI.getState().agentId;
          if (id) void useTimeline.getState().load(id, true);
        });
    }
  });

  c.on("agent.updated", (a) => {
    useApp.setState((s) => ({
      agents: { ...s.agents, [a.id]: a },
      workingSince: trackWorkingSince(s.workingSince, s.agents[a.id], a),
    }));
    const u = useUI.getState();
    if (a.unread > 0 && u.page === "agent" && u.agentId === a.id && document.visibilityState === "visible") {
      c.call("agent.markRead", { id: a.id }).catch(ignore);
    }
  });
  c.on("agent.removed", ({ id }) => {
    useApp.setState((s) => {
      const agents = { ...s.agents };
      delete agents[id];
      return { agents };
    });
    if (useUI.getState().agentId === id) {
      const { agents, settings } = useApp.getState();
      useUI.setState({ agentId: pickAgentId(agents, null, spaceView(Date.now(), settings, agents)) });
    }
  });
  c.on("timeline.upsert", (e) => {
    useTimeline.getState().upsert(e);
    if (e.request) {
      useApp.setState((s) => {
        const rest = s.approvals.filter((x) => x.id !== e.id);
        return { approvals: e.request?.status === "pending" ? [...rest, e] : rest };
      });
    }
  });
  c.on("timeline.delta", (d) => useTimeline.getState().delta(d));
  c.on("queue.updated", ({ agentId, items }) =>
    useApp.setState((s) => ({ queues: { ...s.queues, [agentId]: items } })),
  );
  c.on("account.updated", (a) => useApp.setState((s) => ({ accounts: applyAccountUpdate(s.accounts, a) })));
  c.on("account.removed", ({ id }) =>
    useApp.setState((s) => ({ accounts: s.accounts.filter((a) => a.id !== id) })),
  );
  c.on("account.login", (l) => {
    useApp.setState((s) => ({ logins: { ...s.logins, [l.accountId]: l } }));
    if (l.phase === "error" && l.message) toast.error(l.message);
  });
  c.on("computer.updated", (computer) => useApp.setState({ computer }));
  c.on("routine.updated", (r) => {
    changed("routines");
    useApp.setState((s) => ({ routines: upsertById(s.routines, r) }));
  });
  c.on("routine.removed", ({ id }) => {
    changed("routines");
    useApp.setState((s) => ({ routines: s.routines?.filter((r) => r.id !== id) ?? null }));
  });
  c.on("activity.new", (ev) => {
    changed("activity");
    useApp.setState((s) => ({ activity: s.activity ? [ev, ...s.activity] : null }));
  });
  c.on("memory.updated", (m) => {
    changed("memories");
    useApp.setState((s) => ({ memories: upsertById(s.memories, m, true) }));
  });
  c.on("artifact.new", (a) => {
    changed("artifacts");
    useApp.setState((s) => ({ artifacts: upsertById(s.artifacts, a, true) }));
  });
  c.on("task.updated", (t) => {
    taskVersion++;
    // Only into a list that's loaded: an agent whose tasks were never asked for gets them all on its first load.
    useApp.setState((s) =>
      s.tasks[t.ownerId]
        ? { tasks: { ...s.tasks, [t.ownerId]: applyTaskUpdate(s.tasks[t.ownerId]!, t) } }
        : {},
    );
  });
  c.on("settings.updated", (settings) =>
    useApp.setState((s) => ({
      settings,
      // Core derives the device kill switches from these settings; keep the two views in step.
      execution: s.execution
        ? {
            ...s.execution,
            flags: {
              devices: settings.macAccess,
              deviceWrites: settings.macWrites,
              control: settings.macControl,
            },
          }
        : null,
    })),
  );
  c.on("device.updated", (d) =>
    useApp.setState((s) =>
      s.execution ? { execution: { ...s.execution, devices: upsertById(s.execution.devices, d) ?? [] } } : {},
    ),
  );
  c.on("grant.updated", (g) =>
    useApp.setState((s) =>
      s.execution ? { execution: { ...s.execution, grants: upsertById(s.execution.grants, g) ?? [] } } : {},
    ),
  );
  c.on("operation.updated", (op) => {
    changed("operations");
    useApp.setState((s) => ({ operations: upsertById(s.operations, op, true) }));
  });
  c.on("notify", onNotify);

  startDeviceSync();
  return bootstrap();
}

/* ------------------------------- Data loaders ------------------------------ */

type Collection = "routines" | "memories" | "activity" | "artifacts" | "operations";

/**
 * Pushes bump a per-collection version. A load that was already in flight when a push arrived may have
 * fetched the list from before the change (and the push itself had no list to update yet), so it reloads once.
 */
const versions: Record<Collection, number> = {
  routines: 0,
  memories: 0,
  activity: 0,
  artifacts: 0,
  operations: 0,
};
function changed(c: Collection) {
  versions[c]++;
}
async function fetchList<K extends Collection>(
  c: K,
  force: boolean,
  get: () => Promise<NonNullable<AppList<K>>>,
) {
  if (useApp.getState()[c] && !force) return;
  for (let attempt = 0; attempt < 2; attempt++) {
    const v = versions[c];
    const list = await get();
    useApp.setState({ [c]: list } as never);
    if (versions[c] === v) return;
  }
}
type AppList<K extends Collection> = ReturnType<typeof useApp.getState>[K];

/** Bumped by every task.updated push: a tasks load that raced one fetches again (like `versions`). */
let taskVersion = 0;

export const load = {
  /** The Tasks page's list for one main agent (the suggestion above its message box reads it too). */
  async tasks(agentId: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const v = taskVersion;
      const list = await api()
        .call("tasks.list", { agentId })
        .catch((e) => {
          if (isUnknownMethod(e)) return null;
          throw e;
        });
      if (!list) {
        // An older core has no Tasks: an empty list, and no + to add one it couldn't keep.
        useApp.setState((s) => ({ tasks: { ...s.tasks, [agentId]: [] }, tasksUnsupported: true }));
        return;
      }
      useApp.setState((s) => ({ tasks: { ...s.tasks, [agentId]: list }, tasksUnsupported: false }));
      if (taskVersion === v) return;
    }
  },
  routines: (force = false) => fetchList("routines", force, () => api().call("routine.list", {})),
  memories: (force = false) => fetchList("memories", force, () => api().call("memory.list", {})),
  activity: (force = false) =>
    fetchList("activity", force, () => api().call("activity.list", { limit: 300 })),
  artifacts: (force = false) => fetchList("artifacts", force, () => api().call("artifacts.list", {})),
  operations: (force = false) =>
    fetchList("operations", force, () => api().call("operations.list", { limit: 50 })),
  /** Re-read devices + grants from core. Leaves `execution` null on cores without device support. */
  async execution() {
    try {
      const execution = await api().call("execution.status", {});
      useApp.setState({ execution });
    } catch {
      /* older core: stays unavailable */
    }
  },
  async rules() {
    const rules = await api().call("rules.list", {});
    useApp.setState({ rules });
  },
  async approvals() {
    const approvals = await api().call("approvals.pending", {});
    useApp.setState({ approvals });
  },
};

/** Call an API method and surface failures as a toast. */
export async function run<T>(p: Promise<T>, errorTitle = "Something went wrong"): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast.error(errorTitle, { description: friendlyError(e) });
    return undefined;
  }
}
