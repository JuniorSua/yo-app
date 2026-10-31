import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ComputerOverview, MachineFacts } from "@yo/contracts";
import { AgentdClient } from "./agentd/AgentdClient";
import { ControllerAuth } from "./auth/ControllerAuth";
import { PhoneChannel } from "./channels/phone";
import { TelegramChannel } from "./channels/telegram";
import { CHAT_IMAGE_NAME, snapshotChatImages, toPath } from "./chatImages";
import { ComputerLifecycle, getAgentdToken } from "./computer/ComputerLifecycle";
import { ComputerWatchdog } from "./computer/ComputerWatchdog";
import { CORE_BUILD, CORE_RELEASE, CORE_VERSION, type CoreConfig, loadConfig } from "./config";
import { ConnectService } from "./connect/ConnectService";
import type { HostEnv, HostFs } from "./connect/hostConnect";
import { openDb } from "./db/db";
import { Store } from "./db/store";
import { createExecution, PLACEMENT_LABEL } from "./devices/Execution";
import { createApi } from "./http/api";
import { ReleaseCheck } from "./http/releaseCheck";
import { createServer } from "./http/server";
import { Hub } from "./hub";
import { addSecret, logger, recentLogLines } from "./log";
import type { BackendFactory } from "./onepassword/backend";
import { OnePassword } from "./onepassword/OnePassword";
import { sdkBackend } from "./onepassword/sdkBackend";
import { createOnePasswordTools } from "./onepassword/tools";
import { AccountService } from "./orchestrator/AccountService";
import { Orchestrator } from "./orchestrator/Orchestrator";
import { Scheduler } from "./scheduler/Scheduler";
import { FileSecretStore, KeychainSecretStore, type SecretStore, trackSecrets } from "./secrets/SecretStore";
import { createSetupApi, initComputerSetup } from "./setup";
import { ensureSpaceAgents } from "./team/spaces";
import { BugInbox } from "./tools/bugInbox";
import { BugReports } from "./tools/bugReports";
import { createYoTools } from "./tools/yoTools";

const log = logger("core");

export async function startCore(
  cfg: CoreConfig = loadConfig(),
  overrides: {
    secrets?: SecretStore;
    fetch?: typeof fetch;
    lostTurnGraceMs?: number;
    /** How long message_agent waits for a teammate's reply (tests shorten it). */
    agentReplyWaitMs?: number;
    /** How long a card waits on the user, and the longest a task may run (tests shorten them). */
    userWaitMs?: number;
    maxTurnMs?: number;
    /** How long a task may go silent before it's presumed frozen and stopped (tests shorten it). */
    stuckTurnMs?: number;
    /** Team checks for the lead agent: failing-steps time, long-task time, and per-teammate cooldown (tests shorten them). */
    oversightFailMs?: number;
    oversightLongMs?: number;
    oversightCooldownMs?: number;
    /** Longest a helper's job may run (tests shorten it). */
    helperTurnMs?: number;
    /** How often auto-sleep looks for idle computers (tests shorten it). */
    autoSleepCheckMs?: number;
    /** How often every model sign-in is checked again while the computer is up (tests shorten it). */
    accountRecheckMs?: number;
    /** Machine facts for the setup chat's requirement check (tests fake a Mac). */
    probeMachine?: () => Promise<MachineFacts>;
    /** The "Connect your model" walkthrough's view of this machine (tests use a fake home folder). */
    hostEnv?: () => HostEnv;
    hostFs?: HostFs;
    /** This core's release for the PC edition's update check (tests pretend to be a release build). */
    release?: string | null;
    /** 1Password (tests use a fake instead of the SDK). */
    onePasswordBackend?: BackendFactory;
  } = {},
) {
  const db = openDb(cfg.dataDir);
  const store = new Store(db);
  initComputerSetup(db, store, cfg);
  const secrets: SecretStore = trackSecrets(
    overrides.secrets ??
      (cfg.secrets === "keychain"
        ? new KeychainSecretStore()
        : new FileSecretStore(path.join(cfg.dataDir, "secrets.json"))),
    addSecret,
  );
  const token = process.env.YO_AGENTD_TOKEN ?? (await getAgentdToken(secrets));
  addSecret(token);
  const hub = new Hub();
  // Every ledger change (Yo's task tools, helpers, the Tasks page) reaches the apps.
  store.onTaskChange((t) => hub.push("task.updated", t));

  const agentd = new AgentdClient(cfg.agentdUrl, token, CORE_VERSION);
  const lifecycle = new ComputerLifecycle(cfg, token);
  const accounts = new AccountService(store, secrets, agentd, hub);
  accounts.ensureComputer = () => lifecycle.start();
  const scheduler = new Scheduler(store, hub);

  let metrics: { memMB: number; memLimitMB: number; cacheMB?: number; oomKills?: number } | null = null;
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
    cacheMB: metrics?.cacheMB ?? null,
    oomKills: metrics?.oomKills ?? null,
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
    // The bug mailbox is on Yo Phone's relay (the owner may have pointed it elsewhere; see `phone` below).
    relayUrl: () => phone.relayUrl(),
    logTail: recentLogLines,
    about: () => ({
      version: `${CORE_RELEASE ?? process.env.YO_APP_VERSION ?? `${CORE_VERSION} (from source)`}${CORE_BUILD ? ` (build ${CORE_BUILD})` : ""}`,
      platform: `${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
    }),
    // environment.json: names, versions and states only. No account labels or emails, no tokens.
    diagnostics: () => {
      const overview = computerOverview();
      return {
        yo: {
          release: CORE_RELEASE,
          appVersion: process.env.YO_APP_VERSION ?? null,
          coreVersion: CORE_VERSION,
          build: CORE_BUILD,
        },
        core: {
          os: `${os.type()} ${os.release()}`,
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          uptimeSeconds: Math.round(process.uptime()),
        },
        computer: {
          mode: cfg.computerMode,
          placement: execution.placements.runner,
          runtime: overview.runtime,
          connected: overview.connected,
          message: overview.message,
          imageReady: overview.imageReady,
          memMB: overview.memMB,
          memLimitMB: overview.memLimitMB,
          oomKills: overview.oomKills ?? null,
          agentdVersion: agentd.info?.agentdVersion ?? null,
        },
        providers: store.listAccounts().map((a) => ({
          provider: a.provider,
          status: a.status,
          isDefault: a.isDefault,
          plan: a.plan,
          message: a.message,
        })),
        agents: store.listAgents().length,
      };
    },
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

  // 1Password: Settings → Accounts → 1Password, and the agents' onepassword_* tools (wired below).
  const onePassword = new OnePassword({
    store,
    hub,
    secrets,
    backend: overrides.onePasswordBackend ?? sdkBackend,
  });

  const orchestrator = new Orchestrator({
    onePasswordInfo: () => onePassword.promptInfo(),
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
    agentReplyWaitMs: overrides.agentReplyWaitMs,
    userWaitMs: overrides.userWaitMs,
    maxTurnMs: overrides.maxTurnMs,
    stuckTurnMs: overrides.stuckTurnMs,
    oversightFailMs: overrides.oversightFailMs,
    oversightLongMs: overrides.oversightLongMs,
    oversightCooldownMs: overrides.oversightCooldownMs,
    helperTurnMs: overrides.helperTurnMs,
  });

  orchestrator.attachOnePassword(
    createOnePasswordTools({
      onePassword,
      store,
      fill: (agentId, req) => agentd.request("browser.fillLogin", { agentId, ...req }, 45_000),
      ruleOwner: (id) => orchestrator.ruleOwnerOf(id),
      ask: (agentId, callId, a) => orchestrator.askOnePassword(agentId, callId, a),
    }),
  );

  scheduler.setFire(async (r) => {
    const agent = store.getAgent(r.agentId);
    if (!agent || agent.archivedAt) return;
    await orchestrator.send(r.agentId, r.prompt, [], "routine", r.name);
  });

  // First run: create the primary agent "Yo" and one account card per provider.
  accounts.ensureDefaults();
  // Claude accounts still on a token from the old "paste a token" flow: keep working, and ask once to sign in anew.
  void accounts.markLegacyTokens().catch((err) => log.warn("legacy Claude token check failed", err));
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
  // Work & Personal: Yo leads Work, Pip (made here the first time) leads Personal. Does nothing when spaces are off.
  ensureSpaceAgents(store);

  // Optional Telegram channel: does nothing until a bot token is saved.
  const telegram = new TelegramChannel({ store, hub, orchestrator, secrets });
  // Optional Yo Phone channel: does nothing until a phone link is made.
  const phone = new PhoneChannel({
    store,
    hub,
    orchestrator,
    secrets,
    relayUrl: cfg.phoneRelayUrl,
    // Pictures in replies: the message's snapshot when it has one, else the file on the agent's computer.
    readImage: (agentId, src, stored) =>
      stored && CHAT_IMAGE_NAME.test(stored)
        ? readFile(path.join(cfg.dataDir, "chat-images", stored))
        : fetchFile(agentId, toPath(src)),
    // "Peek at the screen" on the phone: the agent's screen right now, as agentd's PNG.
    screenshot: async (agentId) => {
      const res = await fetch(`${cfg.agentdUrl}/screenshot/${encodeURIComponent(agentId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`screenshot failed: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  });
  // The main agent's create_phone_link / turn_off_phone tools act through it (after the owner approves).
  orchestrator.attachPhone(phone);
  // Only on the owner's core (it needs the bug inbox private key and the relay's register key): files the
  // reports every Yo sends to the bug mailbox as GitHub issues.
  const bugInbox = new BugInbox({
    store,
    secrets,
    dataDir: cfg.dataDir,
    relayUrl: () => phone.relayUrl(),
    repo: () => bugReports.repo(),
    githubApi: cfg.githubApi,
    fetch: overrides.fetch,
  });

  // PC edition: say in Settings → Updates when a newer release is out (`yo-app update` installs it).
  const release = new ReleaseCheck({
    edition: cfg.edition,
    current: overrides.release !== undefined ? overrides.release : CORE_RELEASE,
    url: cfg.releasesUrl,
    fetch: overrides.fetch,
  });

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
    bugInbox,
    ptys,
    onActivity,
    telegram,
    phone,
    onePassword,
    setup: createSetupApi({ cfg, probe: overrides.probeMachine, lifecycle }),
    auth,
    connect: new ConnectService(overrides.hostEnv, overrides.hostFs),
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
    release,
  });

  agentd.on("push", (p) => {
    if (p.type === "metrics") {
      metrics = { memMB: p.memMB, memLimitMB: p.memLimitMB, cacheMB: p.cacheMB, oomKills: p.oomKills };
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
  bugReports.start();
  release.start();
  void bugInbox.start().catch((err) => log.warn("bug inbox failed to start", err));
  void telegram.start().catch((err) => log.warn("telegram channel failed to start", err));
  void phone.start().catch((err) => log.warn("phone channel failed to start", err));

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

  // Check every model sign-in again now and then while the computer is up, so one that stopped working says
  // "Sign in again" in Settings before a task needs it. Never wakes the computer just for this.
  timers.push(
    setInterval(
      () => {
        if (agentd.connected)
          void accounts.refreshAll().catch((err) => log.debug("sign-in re-check skipped", err));
      },
      overrides.accountRecheckMs ?? 6 * 60 * 60 * 1000,
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
    // Yo's computer stopped answering while it should be up (after the Mac sleeps and wakes, say): restart it
    // once, as Stop + Start in Settings would, instead of leaving the user to find that.
    timers.push(
      new ComputerWatchdog({
        now: Date.now,
        connected: () => agentd.connected,
        shouldBeRunning: () =>
          lifecycle.runtime === "running" && !lifecycle.busy && store.getSettings().computerSetup === "done",
        repair: () => lifecycle.repair(),
      }).start(),
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
    bugReports.stop();
    bugInbox.stop();
    release.stop();
    void telegram.stop();
    void phone.stop();
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
    bugInbox,
    onePassword,
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
