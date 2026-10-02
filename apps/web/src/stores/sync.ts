/** Wires the API client's pushes into the zustand stores and exposes data loaders. */
import type { AgentView, ApiPushes } from "@yo/contracts";
import { toast } from "sonner";
import { api } from "../lib/api";
import { nativeNotify } from "../lib/desktop";
import { applyAccountUpdate, offeredAccounts, primaryAgent, upsertById, useApp } from "./app";
import { startDeviceSync } from "./device";
import { useTimeline } from "./timeline";
import { ui, useUI } from "./ui";

let started = false;

export async function bootstrap() {
  const b = await api().call("bootstrap", {});
  const agents: Record<string, AgentView> = {};
  for (const a of b.agents) agents[a.id] = a;
  useApp.setState({
    booted: true,
    version: b.version,
    settings: b.settings,
    agents,
    accounts: offeredAccounts(b.accounts),
    computer: b.computer,
    // Older cores don't send it: device features are then shown as unavailable.
    execution: b.execution ?? null,
  });
  const { agentId } = useUI.getState();
  if (!agentId || !agents[agentId]) {
    const p = primaryAgent(agents);
    if (p) useUI.setState({ agentId: p.id });
  }
  void api()
    .call("approvals.pending", {})
    .then((approvals) => useApp.setState({ approvals }));
}

function onNotify(n: ApiPushes["notify"]) {
  const { settings } = useApp.getState();
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
    if (connection === "open" && reconnected) {
      useTimeline.getState().reset();
      // Lists that are on screen stay visible and get refreshed (anything could have changed while we were
      // disconnected). Clearing them instead left mounted views — e.g. the Workspace's Upcoming list — empty,
      // and every later push was dropped because there was no list to update.
      const st = useApp.getState();
      if (st.routines) void load.routines(true);
      if (st.memories) void load.memories(true);
      if (st.activity) void load.activity(true);
      if (st.artifacts) void load.artifacts(true);
      if (st.rules) void load.rules();
      if (st.operations) void load.operations(true);
      void bootstrap().then(() => {
        const id = useUI.getState().agentId;
        if (id) void useTimeline.getState().load(id, true);
      });
    }
  });

  c.on("agent.updated", (a) => {
    useApp.setState((s) => ({ agents: { ...s.agents, [a.id]: a } }));
    const u = useUI.getState();
    if (a.unread > 0 && u.page === "agent" && u.agentId === a.id && document.visibilityState === "visible") {
      void c.call("agent.markRead", { id: a.id });
    }
  });
  c.on("agent.removed", ({ id }) => {
    useApp.setState((s) => {
      const agents = { ...s.agents };
      delete agents[id];
      return { agents };
    });
    if (useUI.getState().agentId === id) {
      const p = primaryAgent(useApp.getState().agents);
      useUI.setState({ agentId: p?.id ?? null });
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

export const load = {
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
    toast.error(errorTitle, { description: (e as Error).message });
    return undefined;
  }
}
