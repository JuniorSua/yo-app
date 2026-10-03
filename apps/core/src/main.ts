import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ComputerOverview, MachineFacts } from "@yo/contracts";
import { AgentdClient } from "./agentd/AgentdClient";
import { ControllerAuth } from "./auth/ControllerAuth";
import { TelegramChannel } from "./channels/telegram";
import { snapshotChatImages } from "./chatImages";
import { ComputerLifecycle, getAgentdToken } from "./computer/ComputerLifecycle";
import { CORE_BUILD, CORE_RELEASE, CORE_VERSION, type CoreConfig, loadConfig } from "./config";
import { ConnectService } from "./connect/ConnectService";
import type { HostEnv, HostFs } from "./connect/hostConnect";
import { openDb } from "./db/db";
import { Store } from "./db/store";
import { createExecution, PLACEMENT_LABEL } from "./devices/Execution";
import { createApi } from "./http/api";
import { createServer } from "./http/server";
import { Hub } from "./hub";
import { addSecret, logger } from "./log";
import { AccountService } from "./orchestrator/AccountService";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { Scheduler } from "./scheduler/Scheduler";
import { FileSecretStore, KeychainSecretStore, type SecretStore } from "./secrets/SecretStore";
import { createSetupApi, initComputerSetup } from "./setup";
import { BugReports } from "./tools/bugReports";
import { createYoTools } from "./tools/yoTools";

const log = logger("core");

export async function startCore(
  cfg: CoreConfig = loadConfig(),
  overrides: {
    secrets?: SecretStore;
    fetch?: typeof fetch;
    lostTurnGraceMs?: number;
    /** How often auto-sleep looks for idle computers (tests shorten it). */
    autoSleepCheckMs?: number;
    /** Machine facts for the setup chat's requirement check (tests fake a Mac). */
    probeMachine?: () => Promise<MachineFacts>;
    /** The "Connect your model" walkthrough's view of this machine (tests use a fake home folder). */
    hostEnv?: () => HostEnv;
    hostFs?: HostFs;
  } = {},
) {
  const db = openDb(cfg.dataDir);
  const store = new Store(db);
  initComputerSetup(db, store, cfg);
  const secrets: SecretStore =
    overrides.secrets ??
    (cfg.secrets === "keychain"
      ? new KeychainSecretStore()
      : new FileSecretStore(path.join(cfg.dataDir, "secrets.json")));
  const token = process.env.YO_AGENTD_TOKEN ?? (await getAgentdToken(secrets));
  addSecret(token);
  const hub = new Hub();

  const agentd = new AgentdClient(cfg.agentdUrl, token, CORE_VERSION);
  const lifecycle = new ComputerLifecycle(cfg, token);
  const accounts = new AccountService(store, secrets, agentd, hub);
  accounts.ensureComputer = () => lifecycle.start();
  const scheduler = new Scheduler(store, hub);

  let metrics: { memMB: number; memLimitMB: number } | null = null;
  let lastActivity = Date.now();
  const onActivity = () => {
    lastActivity = Date.now();
  };

  const computerOverview = (): ComputerOverview => ({
    runtime:
      cfg.computerMode === "remote"
        ? agentd.connected
          ? "running"
          : "stopped"
        : agentd.connected
          ? "running"
          : lifecycle.runtime,
    host:
      cfg.computerMode === "remote"
        ? {
            kind: "remote",
            label: PLACEMENT_LABEL[execution.placements.runner],
            url: cfg.agentdUrl,
            placement: execution.placements.runner,
          }
        : { kind: "local", label: "This Mac", url: cfg.agentdUrl, placement: "this-mac" },
    connected: agentd.connected,
    message: lifecycle.message,
    memMB: metrics?.memMB ?? null,
    memLimitMB: metrics?.memLimitMB ?? null,
    imageReady: lifecycle.imageReady || agentd.connected,
  });
  const pushOverview = () => hub.push("computer.updated", computerOverview());

  const fetchFile = async (agentId: string, filePath: string) => {
    const res = await fetch(
      `${cfg.agentdUrl}/files/${encodeURIComponent(agentId)}?path=${encodeURIComponent(filePath)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    if (!res.ok) throw new Error(`Couldn't read ${filePath}: ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  };

  const bugReports = new BugReports({
    store,
    hub,
    secrets,
    dataDir: cfg.dataDir,
    githubApi: cfg.githubApi,
    fetch: overrides.fetch,
    environment: (agentId) => {
      const agent = store.getAgent(agentId);
      const session = store.latestSession(agentId);
      const provider = session?.provider ?? accounts.resolveFor(agent?.accountId ?? null)?.provider;
      const model = session?.model ?? agent?.model;
      return [
        // The release baked in at build; else the version Yo.app passes (a core built from source).
        `Yo ${CORE_RELEASE ?? process.env.YO_APP_VERSION ?? `${CORE_VERSION} (from source)`}${CORE_BUILD ? ` (build ${CORE_BUILD})` : ""}`,
        `Yo core on ${os.type()} ${os.release()} (${process.platform}/${process.arch}), Node ${process.versions.node}`,
        `Agent computer: ${PLACEMENT_LABEL[execution.placements.runner]}`,
        `Agent: ${agent?.name ?? "Yo"} on ${provider ?? "an unknown provider"}${model ? ` (${model})` : ""}`,
      ];
    },
  });
  const tools = createYoTools({ store, hub, scheduler, dataDir: cfg.dataDir, fetchFile, bugReports });
  const execution = createExecution({ cfg, db, store, hub, agentd, fetchFile });
  const auth = new ControllerAuth(db, cfg.dataDir, cfg.dev);

  const orchestrator = new Orchestrator({
    store,
    agentd,
    hub,
    accounts,
    tools,
    deviceTools: (tool, args, ctx) => execution.tools.handle(tool, args, ctx),
    snapshotImages: (agentId, text) => snapshotChatImages(text, (p) => fetchFile(agentId, p), cfg.dataDir),
    ensureComputer: () => lifecycle.start(),
    maxAwake: () => store.getSettings().maxAwakeComputers,
    onActivity,
    lostTurnGraceMs: overrides.lostTurnGraceMs,
  });

  scheduler.setFire(async (r) => {
    const agent = store.getAgent(r.agentId);
    if (!agent || agent.archivedAt) return;
    await orchestrator.send(r.agentId, r.prompt, [], "routine", r.name);
  });

  // First run: create the primary agent "Yo" and one account card per provider.
  accounts.ensureDefaults();
  if (!store.listAgents().some((a) => a.isPrimary)) {
    store.createAgent({
      name: "Yo",
      role: "your personal agent",
      instructions: "",
      avatar: { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" },
      accountId: null,
      model: null,
      effort: null,
      runtimeMode: store.getSettings().defaultRuntimeMode,
      isPrimary: true,
      pinned: true,
    });
  }

  // Optional Telegram channel: does nothing until a bot token is saved.
  const telegram = new TelegramChannel({ store, hub, orchestrator, secrets });

  const ptys = new Map<string, { agentId: string }>();
  const api = createApi({
    cfg,
    store,
    hub,
    agentd,
    lifecycle,
    accounts,
    orchestrator,
    scheduler,
    computerOverview,
    execution,
    bugReports,
    ptys,
    onActivity,
    telegram,
    setup: createSetupApi({ cfg, probe: overrides.probeMachine }),
    connect: new ConnectService(accounts, overrides.hostEnv, overrides.hostFs),
  });
  const server = createServer({
    cfg,
    hub,
    store,
    agentd,
    agentdToken: () => token,
    api,
    ptys,
    auth,
    devices: execution.devices,
    coreId: execution.identity.coreId,
  });

  agentd.on("push", (p) => {
    if (p.type === "metrics") {
      metrics = { memMB: p.memMB, memLimitMB: p.memLimitMB };
      pushOverview();
    } else if (p.type === "log") {
      log.debug(`agentd: ${p.message}`);
    }
  });
  agentd.on("connected", pushOverview);
  agentd.on("connected", () => {
    // A computer that just came up isn't idle: after a first download longer than the auto-sleep time,
    // the whole-VM auto-sleep would otherwise stop it within a minute of connecting.
    onActivity();
    // "Do this later", then the computer started anyway (a message woke it): it's set up now, so it starts
    // with Yo again and the "isn't set up yet" banner goes away.
    try {
      if (store.getSettings().computerSetup === "later")
        hub.push("settings.updated", store.updateSettings({ computerSetup: "done" }));
    } catch (err) {
      log.debug("couldn't mark the computer set up", err); // e.g. racing a shutdown (database closed)
    }
  });
  agentd.on("disconnected", pushOverview);
  lifecycle.on("changed", pushOverview);

  await server.listen();
  log.info(`Yo core ${CORE_VERSION} listening on http://${cfg.host}:${cfg.port} (data: ${cfg.dataDir})`);

  agentd.start();
  scheduler.start();
  void telegram.start().catch((err) => log.warn("telegram channel failed to start", err));

  const timers: NodeJS.Timeout[] = [];
  // Auto-sleep each agent's computer after `autoSleepMinutes` without use, in both modes. (On the home PC core
  // doesn't own the container, so the whole-VM stop below never runs there; this per-computer sleep does.)
  const routineSoon = () =>
    store
      .listRoutines()
      .some((r) => r.enabled && r.nextRunAt != null && r.nextRunAt - Date.now() < 5 * 60 * 1000);
  timers.push(
    setInterval(
      () => {
        const mins = store.getSettings().autoSleepMinutes;
        if (!mins || mins <= 0 || !agentd.connected || routineSoon()) return;
        void orchestrator
          .sleepIdle(mins * 60 * 1000)
          .then((ids) => {
            if (ids.length)
              log.info(`auto-sleep: ${ids.length} idle computer(s) put to sleep after ${mins} min`);
          })
          .catch((err) => log.warn("auto-sleep failed", err));
      },
      overrides.autoSleepCheckMs ?? 60 * 1000,
    ),
  );

  if (cfg.computerMode === "local") {
    await lifecycle.refresh();
    pushOverview();
    // Bring the computer up at launch so the first message doesn't wait on a cold VM, once the first agent's
    // setup chat has set it up (a fresh install checks the Mac first; "Do this later" waits for the user).
    // (`compose up -d` is idempotent and also recreates the container if its token/config drifted.)
    if (lifecycle.runtime !== "missing" && store.getSettings().computerSetup === "done") {
      void lifecycle.start().catch(() => {});
    }
    // Auto-sleep: stop the VM when idle to give RAM back to the Mac.
    timers.push(
      setInterval(async () => {
        const mins = store.getSettings().autoSleepMinutes;
        if (!mins || mins <= 0) return;
        if (!agentd.connected || orchestrator.isBusy()) {
          if (orchestrator.isBusy()) onActivity();
          return;
        }
        if (routineSoon()) return;
        if (Date.now() - lastActivity > mins * 60 * 1000) {
          log.info("auto-sleep: stopping Yo's computer after idle period");
          await lifecycle.stop({ vm: true });
        }
      }, 60 * 1000),
    );
    // Wake the computer shortly before a routine is due.
    timers.push(
      setInterval(() => {
        if (agentd.connected) return;
        const due = store
          .listRoutines()
          .some((r) => r.enabled && r.nextRunAt != null && r.nextRunAt - Date.now() < 3 * 60 * 1000);
        if (due) void lifecycle.start().catch(() => {});
      }, 60 * 1000),
    );
  }
  for (const t of timers) t.unref();

  const shutdown = async () => {
    log.info("shutting down");
    scheduler.stop();
    void telegram.stop();
    agentd.stop();
    orchestrator.dispose();
    execution.devices.close();
    for (const t of timers) clearInterval(t);
    await server.close().catch(() => {});
    db.close();
  };

  return {
    cfg,
    store,
    hub,
    agentd,
    lifecycle,
    accounts,
    orchestrator,
    scheduler,
    server,
    shutdown,
    api,
    auth,
    execution,
    bugReports,
  };
}

const isMain =
  (!!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) ||
  process.env.YO_CORE_MAIN === "1";
if (isMain) {
  // A stray rejected promise shouldn't take core down (and every running task with it): log it instead.
  process.on("unhandledRejection", (err) => log.error("unhandled rejection", err));
  startCore()
    .then((core) => {
      const stop = async () => {
        // Never hang on shutdown (e.g. a slow socket): hard-exit after 3s.
        setTimeout(() => process.exit(0), 3000).unref();
        await core.shutdown().catch(() => {});
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      // Electron parent died -> exit too.
      process.on("disconnect", stop);
    })
    .catch((err) => {
      log.error("failed to start", err);
      process.exit(1);
    });
}
