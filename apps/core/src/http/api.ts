import { execFile } from "node:child_process";
import {
  type AgentDraft,
  type ApiMethods,
  type BugInboxApiMethods,
  type ChannelApiMethods,
  type ComputerOverview,
  type LicenseState,
  newId,
  type Settings,
  Space,
} from "@yo/contracts";
import type { AgentdClient } from "../agentd/AgentdClient";
import type { ControllerAuth } from "../auth/ControllerAuth";
import type { PhoneChannel } from "../channels/phone";
import type { TelegramChannel } from "../channels/telegram";
import type { ComputerLifecycle } from "../computer/ComputerLifecycle";
import { CORE_VERSION, type CoreConfig } from "../config";
import { ConnectService } from "../connect/ConnectService";
import type { Store } from "../db/store";
import type { Execution } from "../devices/Execution";
import type { Hub } from "../hub";
import type { OnePassword } from "../onepassword/OnePassword";
import type { AccountService } from "../orchestrator/AccountService";
import type { Orchestrator } from "../orchestrator/Orchestrator";
import type { Scheduler } from "../scheduler/Scheduler";
import type { createSetupApi } from "../setup";
import { createTasksApi } from "../tasks/tasks";
import { Consolidator } from "../team/Consolidator";
import { ensureSpaceAgents, shelvePersonalAgent } from "../team/spaces";
import { forUi } from "../timelineView";
import { claimBrief, sendBriefRequest } from "../tools/brief";
import type { BugInbox } from "../tools/bugInbox";
import type { BugReports } from "../tools/bugReports";
import { requestServerUpdate } from "./updates";

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
  /** `bugInbox.*`: the owner's receiving end of bug reports (../tools/bugInbox). */
  bugInbox: BugInbox;
  /** pty ownership: ptyId -> socket id, set by the pty proxy. */
  ptys: Map<string, { agentId: string }>;
  onActivity: () => void;
  telegram: TelegramChannel;
  /** `channels.phone.*`: Yo Phone (../channels/phone). */
  phone: PhoneChannel;
  /** `onePassword.*`: Settings → Accounts → 1Password (../onepassword). */
  onePassword: OnePassword;
  /** `setup.*`: the first agent's computer setup (../setup). */
  setup: ReturnType<typeof createSetupApi>;
  /** `auth.*`: the apps and browsers signed in to this core (../auth/ControllerAuth). */
  auth: ControllerAuth;
  /** "Connect your model" walkthrough (tests inject one with a fake home folder). */
  connect?: ConnectService;
}

type AllMethods = ApiMethods & ChannelApiMethods & BugInboxApiMethods;
type Handlers = {
  [M in keyof AllMethods]: (params: AllMethods[M]["params"]) => Promise<AllMethods[M]["result"]>;
};

const ok = { ok: true as const };
/** The only answer `license.*` gives: Yo 2 has no license check. */
const FREE: LicenseState = { required: false, active: true };

export function createApi(d: ApiDeps): Handlers {
  const { store, orchestrator, accounts } = d;
  const connect = d.connect ?? new ConnectService();

  const agentView = (id: string) => {
    const v = orchestrator.view(id);
    if (!v) throw new Error("Unknown agent");
    return v;
  };

  /** Agents can only be put on accounts Yo offers (see ENABLED_PROVIDERS). */
  const offeredAccount = (accountId: string | null | undefined) => {
    if (accounts.isHiddenAccount(accountId)) throw new Error("That account isn't available in Yo.");
  };

  /** The Archive button: stop the agent, put its computer to sleep, archive it, switch its routines off. */
  const archiveAgent = async (id: string) => {
    const a = store.getAgent(id);
    if (!a) throw new Error("Unknown agent");
    if (a.isPrimary) throw new Error("The main agent can't be archived");
    if (a.space) throw new Error("Turn off Work & Personal in Settings instead.");
    await stopAgent(id);
    store.updateAgent(id, { archivedAt: Date.now() });
    for (const r of store.listRoutines(id)) d.scheduler.update(r.id, { enabled: false });
    d.hub.push("agent.removed", { id });
  };
  const stopAgent = async (id: string) => {
    await orchestrator.interrupt(id, { dropQueue: true }).catch(() => {});
    if (d.agentd.connected) await d.agentd.request("computer.hibernate", { agentId: id }).catch(() => {});
  };

  /**
   * Spaces turned on: make sure Work and Personal each have their agent (Pip appears, or comes back). Turned off:
   * Pip is put away (archived, chats kept; its routines stay as they were and come back with it).
   */
  const applySpacesOn = async (on: boolean) => {
    if (on) {
      for (const id of ensureSpaceAgents(store)) {
        const v = orchestrator.view(id);
        if (v) d.hub.push("agent.updated", v);
      }
      return;
    }
    const personal = store.getSpaceAgent("personal");
    if (!personal) return;
    await stopAgent(personal.id);
    if (shelvePersonalAgent(store)) d.hub.push("agent.removed", { id: personal.id });
  };

  /** A space from the apps: "work" / "personal", null (Everywhere); absent stays absent. */
  const spaceParam = (v: unknown) =>
    v === undefined ? undefined : Space.safeParse(v).success ? (v as Space) : null;
  const consolidator = new Consolidator({ store, hub: d.hub, agentd: d.agentd, archive: archiveAgent });

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
      if (typeof patch.spacesOn === "boolean") await applySpacesOn(patch.spacesOn);
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
      // A teammate made in the app says hello and asks its one question right away, like one Yo adds.
      if (p.introduce) orchestrator.introduce(a.id);
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
      await archiveAgent(id);
      return ok;
    },

    "team.consolidatePlan": async () => consolidator.plan(),
    "team.consolidate": async ({ agentIds }) => consolidator.consolidate(agentIds),

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

    "workspace.search": async ({ query, limit }) => store.searchWorkspace(query, limit),
    "timeline.around": async ({ agentId, entryId }) => store.timelineAround(agentId, entryId).map(forUi),

    "chat.send": async ({ agentId, text, attachments, route }) =>
      orchestrator.send(
        agentId,
        text,
        attachments ?? [],
        "user",
        undefined,
        route === "agent-computer" ? "agent-computer" : "auto",
      ),

    // The daily brief: the chat shows "Morning brief" where the request sits, and it waits behind a running task.
    "brief.claim": async ({ localDate }) =>
      claimBrief(
        {
          store,
          send: (agentId, text) => sendBriefRequest(orchestrator, agentId, text),
        },
        localDate,
      ),

    ...d.execution.api,
    ...d.telegram.api,
    ...d.phone.api,
    ...d.onePassword.api,
    ...d.bugInbox.api,
    ...d.setup,

    "chat.interrupt": async ({ agentId }) => {
      await orchestrator.interrupt(agentId);
      return ok;
    },

    "queue.list": async ({ agentId }) => orchestrator.queueOf(agentId),
    "queue.update": async ({ agentId, id, text }) => orchestrator.updateQueued(agentId, id, text),
    "queue.remove": async ({ agentId, id }) => orchestrator.removeQueued(agentId, id),
    "queue.reorder": async ({ agentId, ids }) => orchestrator.reorderQueued(agentId, ids ?? []),
    "queue.steer": async ({ agentId, id }) => orchestrator.steerQueued(agentId, id),

    "request.respond": async ({ agentId, requestId, decision, answers, message, secureValues }) => {
      await orchestrator.respond(agentId, requestId, decision, answers, message, secureValues);
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
    "account.login.start": async ({ id, restart, method }) => {
      d.onActivity();
      await accounts.loginStart(id, { restart, method: method === "code" ? "code" : undefined });
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
      await orchestrator.wakeComputer(agentId);
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
    "memory.add": async ({ content, agentId, space }) => {
      const m = store.addMemory(content, agentId ?? null, spaceParam(space) ?? null);
      d.hub.push("memory.updated", m);
      return m;
    },
    "memory.update": async ({ id, content, space }) => {
      const m = store.updateMemory(id, content, spaceParam(space));
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
    // The Tasks page (../tasks/tasks): list, add with +, Start, check off or hide.
    ...createTasksApi({ store, orchestrator }),
    "artifacts.list": async ({ agentId }) => store.listArtifacts(agentId),
    "artifact.pin": async ({ id, pinned }) => {
      const a = store.setArtifactPinned(String(id), pinned === true);
      if (!a) throw new Error("That isn't in Make any more.");
      d.hub.push("artifact.new", a);
      return a;
    },
    "bugReports.status": async () => d.bugReports.status(),
    "bugReports.configure": async (p) => d.bugReports.configure(p),
    "bugReports.preview": async (p) => d.bugReports.preview(p),
    "bugReports.send": async (p) => d.bugReports.send(p),
    // Apps and browsers signed in to Yo (Settings → Browsers & apps). Only signed-in callers reach the UI socket.
    "auth.clients.list": async () => d.auth.listClients(),
    "auth.clients.rename": async ({ id, label }) => d.auth.renameClient(String(id), String(label ?? "")),
    "auth.clients.revoke": async ({ id }) => {
      if (!d.auth.revokeController(String(id))) throw new Error("That app or browser isn't signed in to Yo.");
      return ok;
    },
    "auth.signInLink.create": async () => d.auth.createSignInLink(),

    // Yo is free since 2.0: an older app that still asks about a license hears "free".
    "license.status": async () => FREE,
    "license.activate": async () => FREE,
    "license.refresh": async () => FREE,
    "license.deactivate": async () => FREE,

    "host.openExternal": async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error("Only http(s) URLs can be opened");
      if (process.platform === "darwin") execFile("open", [url]);
      // Not via cmd: it would read & and ^ in the URL as shell syntax.
      else if (process.platform === "win32") execFile("rundll32", ["url.dll,FileProtocolHandler", url]);
      else execFile("xdg-open", [url]);
      return ok;
    },

    // The UI socket only opens for a signed-in controller (server.ts), so only the user's own Restart lands here.
    "update.applyServer": async ({ rev }) => {
      requestServerUpdate(d.cfg.dataDir, rev);
      return ok;
    },
  };
}
