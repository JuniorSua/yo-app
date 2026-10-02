import { execFile } from "node:child_process";
import {
  type AgentDraft,
  type ApiMethods,
  type ChannelApiMethods,
  type ComputerOverview,
  newId,
  type Settings,
} from "@yo/contracts";
import type { AgentdClient } from "../agentd/AgentdClient";
import type { TelegramChannel } from "../channels/telegram";
import type { ComputerLifecycle } from "../computer/ComputerLifecycle";
import { CORE_VERSION, type CoreConfig } from "../config";
import { ConnectService } from "../connect/ConnectService";
import type { Store } from "../db/store";
import type { Execution } from "../devices/Execution";
import type { Hub } from "../hub";
import type { AccountService } from "../orchestrator/AccountService";
import type { Orchestrator } from "../orchestrator/Orchestrator";
import type { Scheduler } from "../scheduler/Scheduler";
import type { createSetupApi } from "../setup";
import { forUi } from "../timelineView";
import type { BugReports } from "../tools/bugReports";

export interface ApiDeps {
  cfg: CoreConfig;
  store: Store;
  hub: Hub;
  agentd: AgentdClient;
  lifecycle: ComputerLifecycle;
  accounts: AccountService;
  orchestrator: Orchestrator;
  scheduler: Scheduler;
  computerOverview: () => ComputerOverview;
  execution: Execution;
  bugReports: BugReports;
  /** pty ownership: ptyId -> socket id, set by the pty proxy. */
  ptys: Map<string, { agentId: string }>;
  onActivity: () => void;
  telegram: TelegramChannel;
  /** `setup.*`: the first agent's computer setup (../setup). */
  setup: ReturnType<typeof createSetupApi>;
  /** "Connect your model" walkthrough (tests inject one with a fake home folder). */
  connect?: ConnectService;
}

type AllMethods = ApiMethods & ChannelApiMethods;
type Handlers = {
  [M in keyof AllMethods]: (params: AllMethods[M]["params"]) => Promise<AllMethods[M]["result"]>;
};

const ok = { ok: true as const };

export function createApi(d: ApiDeps): Handlers {
  const { store, orchestrator, accounts } = d;
  const connect = d.connect ?? new ConnectService(accounts);

  const agentView = (id: string) => {
    const v = orchestrator.view(id);
    if (!v) throw new Error("Unknown agent");
    return v;
  };

  /** Agents can only be put on accounts Yo offers (see ENABLED_PROVIDERS). */
  const offeredAccount = (accountId: string | null | undefined) => {
    if (accounts.isHiddenAccount(accountId)) throw new Error("That account isn't available in Yo.");
  };

  const draftPatch = (p: Partial<AgentDraft> & { pinned?: boolean }) => ({
    ...(p.name !== undefined ? { name: p.name.trim() || "Agent" } : {}),
    ...(p.role !== undefined ? { role: p.role } : {}),
    ...(p.instructions !== undefined ? { instructions: p.instructions } : {}),
    ...(p.avatar !== undefined ? { avatar: p.avatar } : {}),
    ...(p.accountId !== undefined ? { accountId: p.accountId } : {}),
    ...(p.model !== undefined ? { model: p.model } : {}),
    ...(p.effort !== undefined ? { effort: p.effort } : {}),
    ...(p.runtimeMode !== undefined ? { runtimeMode: p.runtimeMode } : {}),
    ...(p.pinned !== undefined ? { pinned: p.pinned } : {}),
  });

  return {
    bootstrap: async () => ({
      version: CORE_VERSION,
      settings: store.getSettings(),
      agents: orchestrator.views(),
      accounts: accounts.list(),
      computer: d.computerOverview(),
      execution: d.execution.status(),
    }),

    "settings.update": async (patch) => {
      const s: Settings = store.updateSettings(patch);
      d.hub.push("settings.updated", s);
      return s;
    },

    "agent.create": async (p) => {
      offeredAccount(p.accountId);
      const a = store.createAgent({
        name: p.name.trim() || "Agent",
        role: p.role ?? "",
        instructions: p.instructions ?? "",
        avatar: p.avatar,
        accountId: p.accountId ?? null,
        model: p.model ?? null,
        effort: p.effort ?? null,
        runtimeMode: p.runtimeMode ?? store.getSettings().defaultRuntimeMode,
        isPrimary: false,
        pinned: false,
      });
      store.addActivity({ agentId: a.id, kind: "system", summary: `Created agent ${a.name}`, ref: null });
      const v = agentView(a.id);
      d.hub.push("agent.updated", v);
      return v;
    },

    "agent.update": async ({ id, patch }) => {
      const before = store.getAgent(id);
      if (!before) throw new Error("Unknown agent");
      offeredAccount(patch.accountId);
      store.updateAgent(id, draftPatch(patch));
      const v = agentView(id);
      d.hub.push("agent.updated", v);
      return v;
    },

    "agent.archive": async ({ id }) => {
      const a = store.getAgent(id);
      if (!a) throw new Error("Unknown agent");
      if (a.isPrimary) throw new Error("The main agent can't be archived");
      await orchestrator.interrupt(id).catch(() => {});
      if (d.agentd.connected) await d.agentd.request("computer.hibernate", { agentId: id }).catch(() => {});
      store.updateAgent(id, { archivedAt: Date.now() });
      for (const r of store.listRoutines(id)) d.scheduler.update(r.id, { enabled: false });
      d.hub.push("agent.removed", { id });
      return ok;
    },

    "agent.markRead": async ({ id }) => {
      store.clearUnread(id);
      orchestrator.broadcast(id);
      return ok;
    },

    "agent.newSession": async ({ id }) => {
      await orchestrator.newSession(id);
      orchestrator.broadcast(id);
      return ok;
    },

    "agent.compact": async ({ id, focus }) => {
      await orchestrator.compact(id, focus);
      return ok;
    },

    // A reply still streaming has no text in the DB yet: fill in what was streamed, so a client that
    // reconnects mid-reply sees all of it rather than only the tail.
    "timeline.list": async ({ agentId, before, limit }) =>
      store.listTimeline(agentId, before, limit ?? 200).map((e) => {
        if (e.item.status !== "running") return forUi(e);
        const text = orchestrator.liveText(e.id);
        return forUi(
          text && text.length > (e.item.text?.length ?? 0) ? { ...e, item: { ...e.item, text } } : e,
        );
      }),

    "chat.send": async ({ agentId, text, attachments, route }) =>
      orchestrator.send(
        agentId,
        text,
        attachments ?? [],
        "user",
        undefined,
        route === "agent-computer" ? "agent-computer" : "auto",
      ),

    ...d.execution.api,
    ...d.telegram.api,
    ...d.setup,

    "chat.interrupt": async ({ agentId }) => {
      await orchestrator.interrupt(agentId);
      return ok;
    },

    "request.respond": async ({ agentId, requestId, decision, answers, message }) => {
      await orchestrator.respond(agentId, requestId, decision, answers, message);
      return ok;
    },

    "account.list": async () => accounts.list(),
    "account.add": async ({ provider, label }) => accounts.add(provider, label),
    "account.remove": async ({ id }) => {
      await accounts.remove(id);
      return ok;
    },
    "account.refresh": async ({ id }) => accounts.refresh(id),
    "account.setDefault": async ({ id }) => {
      accounts.setDefault(id);
      return ok;
    },
    "account.login.start": async ({ id, restart }) => {
      d.onActivity();
      await accounts.loginStart(id, { restart });
      return ok;
    },
    "account.login.input": async ({ id, input }) => {
      await accounts.loginInput(id, input);
      return ok;
    },
    "account.login.cancel": async ({ id }) => {
      await accounts.loginCancel(id);
      return ok;
    },
    "account.setApiKey": async ({ id, key }) => accounts.setApiKey(id, key),
    "connect.detect": async () => connect.detect(),
    "connect.claudeToken": async (p) => connect.claudeToken(p),
    "connect.codexImport": async (p) => {
      d.onActivity();
      return connect.codexImport(p);
    },
    "models.list": async ({ accountId }) =>
      accounts.isHiddenAccount(accountId) ? [] : (store.getAccount(accountId)?.models ?? []),

    "computer.overview": async () => d.computerOverview(),
    "computer.start": async () => {
      d.onActivity();
      void d.lifecycle.start().catch(() => {});
      return d.computerOverview();
    },
    "computer.stop": async () => {
      await d.lifecycle.stop();
      return d.computerOverview();
    },
    "computer.wake": async ({ agentId }) => {
      d.onActivity();
      if (!d.agentd.connected) {
        await d.lifecycle.start();
        await d.agentd.waitReady(120000);
      }
      orchestrator.markComputer(agentId, "booting");
      await d.agentd.request("computer.ensure", { agentId }, 90000);
      orchestrator.markComputer(agentId, "ready");
      return ok;
    },
    "computer.takeover": async ({ agentId }) => {
      await d.agentd.request("computer.lease", { agentId, holder: "user" });
      orchestrator.setLease(agentId, "user");
      store.addActivity({
        agentId,
        kind: "takeover",
        summary: "You took control of the computer",
        ref: null,
      });
      return ok;
    },
    "computer.release": async ({ agentId, note }) => {
      await d.agentd.request("computer.lease", { agentId, holder: "agent" }).catch(() => {});
      orchestrator.setLease(agentId, "agent");
      orchestrator.releaseTakeover(agentId, note);
      store.addActivity({ agentId, kind: "takeover", summary: "You gave control back", ref: null });
      return ok;
    },
    "computer.files": async ({ agentId, path }) => {
      const res = await d.agentd.request("fs.list", { agentId, path });
      return res.entries;
    },
    "pty.open": async ({ agentId, cols, rows }) => {
      const ptyId = newId("pty");
      await d.agentd.request("pty.open", { ptyId, agentId, cols, rows });
      d.ptys.set(ptyId, { agentId });
      return { ptyId };
    },

    "memory.list": async ({ agentId }) => store.listMemories(agentId ?? null),
    "memory.add": async ({ content, agentId }) => {
      const m = store.addMemory(content, agentId ?? null);
      d.hub.push("memory.updated", m);
      return m;
    },
    "memory.update": async ({ id, content }) => {
      const m = store.updateMemory(id, content);
      if (!m) throw new Error("Unknown memory");
      d.hub.push("memory.updated", m);
      return m;
    },
    "memory.delete": async ({ id }) => {
      store.deleteMemory(id);
      return ok;
    },

    "routine.list": async ({ agentId }) => store.listRoutines(agentId),
    "routine.create": async (p) =>
      d.scheduler.create({
        agentId: p.agentId,
        name: p.name,
        prompt: p.prompt,
        cron: p.cron ?? null,
        runAt: p.runAt ?? null,
      }),
    "routine.update": async ({ id, patch }) => d.scheduler.update(id, patch),
    "routine.delete": async ({ id }) => {
      d.scheduler.remove(id);
      return ok;
    },
    "routine.runNow": async ({ id }) => {
      await d.scheduler.runNow(id);
      return ok;
    },

    "activity.list": async ({ agentId, limit }) => store.listActivity(agentId, limit ?? 200),
    "approvals.pending": async () => orchestrator.pendingRequestEntries().map(forUi),
    "rules.list": async () => store.listRules(),
    "rules.delete": async ({ id }) => {
      store.deleteRule(id);
      return ok;
    },
    "artifacts.list": async ({ agentId }) => store.listArtifacts(agentId),
    "bugReports.status": async () => d.bugReports.status(),
    "bugReports.configure": async (p) => d.bugReports.configure(p),

    "host.openExternal": async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be opened");
      if (process.platform === "darwin") execFile("open", [url]);
      // Not via cmd: it would read & and ^ in the URL as shell syntax.
      else if (process.platform === "win32") execFile("rundll32", ["url.dll,FileProtocolHandler", url]);
      else execFile("xdg-open", [url]);
      return ok;
    },
  };
}
