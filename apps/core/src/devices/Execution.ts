/** Composition of the device pieces + the API surface the UI uses to see and manage them. */
import fs from "node:fs";
import path from "node:path";
import type { ApiMethods, ExecutionStatus, Placement } from "@yo/contracts";
import type { AgentdClient } from "../agentd/AgentdClient";
import { type CoreIdentity, loadOrCreateIdentity } from "../auth/identity";
import type { CoreConfig } from "../config";
import type { Db } from "../db/db";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import { DeviceHub } from "./DeviceHub";
import { DeviceStore } from "./DeviceStore";
import { DeviceTools } from "./DeviceTools";

type H<M extends keyof ApiMethods> = (p: ApiMethods[M]["params"]) => Promise<ApiMethods[M]["result"]>;

export const PLACEMENT_LABEL: Record<Placement, string> = {
  "this-mac": "This Mac",
  "home-pc": "Home PC",
  "custom-remote": "Remote computer",
};

export function placements(cfg: CoreConfig): { core: Placement; runner: Placement } {
  const valid = (v: string | undefined): Placement | null =>
    v === "this-mac" || v === "home-pc" || v === "custom-remote" ? v : null;
  const core = valid(process.env.YO_CORE_PLACEMENT) ?? "this-mac";
  const runner =
    valid(process.env.YO_RUNNER_PLACEMENT) ?? (cfg.computerMode === "local" ? "this-mac" : "home-pc");
  return { core, runner };
}

export function createExecution(d: {
  cfg: CoreConfig;
  db: Db;
  store: Store;
  hub: Hub;
  agentd: AgentdClient;
  fetchFile: (agentId: string, filePath: string) => Promise<Buffer>;
}) {
  const identity: CoreIdentity = loadOrCreateIdentity(d.cfg.dataDir);
  const where = placements(d.cfg);
  const store = new DeviceStore(d.db);
  const devices = new DeviceHub(store, identity, `Yo on ${PLACEMENT_LABEL[where.core]}`);

  const tools = new DeviceTools({
    store,
    devices,
    identity,
    settings: () => d.store.getSettings(),
    onOperation: (op) => d.hub.push("operation.updated", op),
    onRoute: (r) => d.hub.push("route.decided", r),
    activity: (agentId, summary) => {
      const e = d.store.addActivity({ agentId, kind: "device", summary, ref: null });
      d.hub.push("activity.new", e);
    },
    readFromComputer: d.fetchFile,
    saveToComputer: async (agentId, name, data) => {
      const res = await d.agentd.request("fs.write", {
        agentId,
        dir: "from-mac",
        name,
        dataBase64: data.toString("base64"),
      });
      return res.path;
    },
  });
  tools.recoverAfterRestart();

  devices.on("updated", (v) => d.hub.push("device.updated", v));
  devices.on("grantsChanged", (deviceId) => {
    for (const g of store.listGrants(deviceId, true)) d.hub.push("grant.updated", g);
  });
  devices.on("online", (deviceId) => void tools.reconcile(deviceId));
  devices.on("leaseEnded", (deviceId, leaseId, reason) => tools.leaseEnded(deviceId, leaseId, reason));

  const status = (): ExecutionStatus => {
    const s = d.store.getSettings();
    return {
      corePlacement: where.core,
      runnerPlacement: where.runner,
      flags: { devices: s.macAccess, deviceWrites: s.macWrites, control: s.macControl },
      devices: devices.list(),
      grants: store.listGrants(),
    };
  };

  const api: {
    "execution.status": H<"execution.status">;
    "devices.pair.start": H<"devices.pair.start">;
    "devices.unpair": H<"devices.unpair">;
    "devices.rename": H<"devices.rename">;
    "grants.revoke": H<"grants.revoke">;
    "operations.list": H<"operations.list">;
    "routes.list": H<"routes.list">;
  } = {
    "execution.status": async () => status(),
    "devices.pair.start": async () => devices.startPairing(),
    "devices.unpair": async ({ deviceId }) => {
      devices.unpair(String(deviceId));
      return { ok: true };
    },
    "devices.rename": async ({ deviceId, name }) => {
      const clean = String(name ?? "")
        .trim()
        .slice(0, 80);
      if (!clean) throw new Error("Name can't be empty");
      store.renameDevice(String(deviceId), clean);
      const v = devices.view(String(deviceId));
      if (!v) throw new Error("Unknown device");
      d.hub.push("device.updated", v);
      return v;
    },
    "grants.revoke": async ({ grantId }) => {
      const g = store.revokeGrant(String(grantId));
      if (!g) throw new Error("Unknown grant");
      devices.notifyRevoked(g.deviceId, g.id);
      d.hub.push("grant.updated", g);
      return { ok: true };
    },
    "operations.list": async ({ agentId, limit }) =>
      store
        .listOperations({ agentId, limit })
        .map(({ relPath, argsDigest, commandId, expectedSha256, ...v }) => v),
    "routes.list": async ({ agentId, limit }) => store.listRoutes(String(agentId), limit),
  };

  /** One-time enrollment token for the desktop app (written by the owner/setup only). */
  const enrollTokenPath = path.join(d.cfg.dataDir, "enroll-token");

  return {
    identity,
    store,
    devices,
    tools,
    status,
    api,
    placements: where,
    enrollTokenPath,
    hasEnrollToken: () => fs.existsSync(enrollTokenPath),
  };
}

export type Execution = ReturnType<typeof createExecution>;
