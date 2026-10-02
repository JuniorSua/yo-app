/** Persistence for paired devices, the grant mirror, device operations and route decisions. */
import {
  type DeviceCapability,
  type DeviceGrant,
  type DeviceOperation,
  type DeviceOperationStatus,
  newId,
  type OsPermissionState,
  type PairedDevice,
  type RouteDecision,
} from "@yo/contracts";
import type { Db } from "../db/db";

type Row = Record<string, any>;

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export interface DeviceRecord {
  device: Omit<PairedDevice, "online">;
  publicKey: string;
}

export interface OperationRecord extends DeviceOperation {
  relPath: string;
  argsDigest: string | null;
  commandId: string | null;
  expectedSha256: string | null;
}

export class DeviceStore {
  constructor(private readonly db: Db) {}

  /* -------------------------------- devices -------------------------------- */

  addDevice(input: {
    id: string;
    name: string;
    publicKey: string;
    osVersion: string;
    appVersion: string;
    now?: number;
  }) {
    this.db
      .prepare(
        `INSERT INTO paired_devices (id, name, platform, public_key, os_version, app_version, paired_at)
         VALUES (?, ?, 'macos', ?, ?, ?, ?)`,
      )
      .run(input.id, input.name, input.publicKey, input.osVersion, input.appVersion, input.now ?? Date.now());
  }

  getDevice(id: string): DeviceRecord | null {
    const r = this.db.prepare("SELECT * FROM paired_devices WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toDevice(r) : null;
  }

  listDevices(includeRevoked = false): DeviceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM paired_devices ${includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY paired_at`,
      )
      .all() as Row[];
    return rows.map((r) => this.toDevice(r));
  }

  updateDeviceSeen(
    id: string,
    patch: {
      appVersion?: string;
      helperVersion?: string | null;
      osVersion?: string;
      capabilities?: DeviceCapability[];
      permissions?: Record<string, OsPermissionState>;
      paused?: boolean;
      now?: number;
    },
  ) {
    const cur = this.getDevice(id);
    if (!cur) return;
    const d = cur.device;
    this.db
      .prepare(
        `UPDATE paired_devices SET app_version = ?, helper_version = ?, os_version = ?, capabilities_json = ?,
           permissions_json = ?, paused = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(
        patch.appVersion ?? d.appVersion,
        patch.helperVersion !== undefined ? patch.helperVersion : d.helperVersion,
        patch.osVersion ?? d.osVersion,
        JSON.stringify(patch.capabilities ?? d.capabilities),
        JSON.stringify(patch.permissions ?? d.permissions),
        (patch.paused ?? d.paused) ? 1 : 0,
        patch.now ?? Date.now(),
        id,
      );
  }

  renameDevice(id: string, name: string) {
    this.db.prepare("UPDATE paired_devices SET name = ? WHERE id = ?").run(name, id);
  }

  revokeDevice(id: string, now = Date.now()) {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE paired_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now, id);
      this.db
        .prepare("UPDATE device_grants SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL")
        .run(now, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private toDevice(r: Row): DeviceRecord {
    return {
      publicKey: r.public_key,
      device: {
        id: r.id,
        name: r.name,
        platform: "macos",
        osVersion: r.os_version,
        appVersion: r.app_version,
        helperVersion: r.helper_version ?? null,
        pairedAt: r.paired_at,
        lastSeenAt: r.last_seen_at ?? null,
        paused: !!r.paused,
        revokedAt: r.revoked_at ?? null,
        capabilities: json<DeviceCapability[]>(r.capabilities_json, []),
        permissions: json<Record<string, OsPermissionState>>(r.permissions_json, {}),
      },
    };
  }

  /* --------------------------------- grants -------------------------------- */

  /**
   * Mirror the device's grant list. The device is the source of truth for grants it created, except that a
   * grant core has revoked stays revoked forever (a reconnecting device can't resurrect it).
   */
  syncGrants(deviceId: string, grants: DeviceGrant[], now = Date.now()): DeviceGrant[] {
    const changed: DeviceGrant[] = [];
    const seen = new Set<string>();
    this.db.exec("BEGIN");
    try {
      for (const g of grants) {
        if (g.deviceId !== deviceId) continue;
        seen.add(g.id);
        const cur = this.getGrant(g.id);
        if (cur && cur.deviceId !== deviceId) continue;
        if (cur?.revokedAt) continue;
        if (
          cur &&
          cur.revision === g.revision &&
          cur.mode === g.mode &&
          (cur.app ?? null) === (g.app ?? null) &&
          cur.expiresAt === g.expiresAt &&
          cur.revokedAt === g.revokedAt &&
          cur.displayPath === g.displayPath
        )
          continue;
        this.db
          .prepare(
            `INSERT INTO device_grants (id, device_id, kind, display_path, name, mode, expires_at, revision, created_at, revoked_at, app)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, app = excluded.app, display_path = excluded.display_path,
               name = excluded.name, mode = excluded.mode, expires_at = excluded.expires_at,
               revision = excluded.revision, revoked_at = excluded.revoked_at`,
          )
          .run(
            g.id,
            deviceId,
            g.kind,
            g.displayPath,
            g.name,
            g.mode,
            g.expiresAt,
            g.revision,
            g.createdAt,
            g.revokedAt,
            g.app ?? null,
          );
        changed.push(this.getGrant(g.id)!);
      }
      // Grants the device no longer lists were removed there.
      for (const g of this.listGrants(deviceId)) {
        if (!seen.has(g.id) && !g.revokedAt) {
          this.db.prepare("UPDATE device_grants SET revoked_at = ? WHERE id = ?").run(now, g.id);
          changed.push(this.getGrant(g.id)!);
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return changed;
  }

  getGrant(id: string): DeviceGrant | null {
    const r = this.db.prepare("SELECT * FROM device_grants WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toGrant(r) : null;
  }

  listGrants(deviceId?: string, includeRevoked = false): DeviceGrant[] {
    const where: string[] = [];
    const args: string[] = [];
    if (deviceId) {
      where.push("device_id = ?");
      args.push(deviceId);
    }
    if (!includeRevoked) where.push("revoked_at IS NULL");
    const rows = this.db
      .prepare(
        `SELECT * FROM device_grants ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`,
      )
      .all(...args) as Row[];
    return rows.map((r) => this.toGrant(r));
  }

  revokedGrantIds(deviceId: string): string[] {
    return (
      this.db
        .prepare("SELECT id FROM device_grants WHERE device_id = ? AND revoked_at IS NOT NULL")
        .all(deviceId) as Row[]
    ).map((r) => r.id as string);
  }

  revokeGrant(id: string, now = Date.now()): DeviceGrant | null {
    this.db
      .prepare("UPDATE device_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(now, id);
    return this.getGrant(id);
  }

  private toGrant(r: Row): DeviceGrant {
    return {
      id: r.id,
      deviceId: r.device_id,
      kind: r.kind,
      ...(r.app ? { app: r.app } : {}),
      displayPath: r.display_path,
      name: r.name,
      mode: r.mode,
      expiresAt: r.expires_at ?? null,
      revision: r.revision,
      createdAt: r.created_at,
      revokedAt: r.revoked_at ?? null,
    };
  }

  /* ------------------------------- operations ------------------------------ */

  createOperation(
    input: Omit<OperationRecord, "id" | "createdAt" | "updatedAt" | "reason" | "commandId"> & {
      reason?: string | null;
    },
  ): OperationRecord {
    const id = newId("op");
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO device_operations (id, agent_id, turn_id, device_id, grant_id, capability, display_path, rel_path,
           args_digest, command_id, expected_sha256, status, reason, bytes, sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.turnId,
        input.deviceId,
        input.grantId,
        input.capability,
        input.displayPath,
        input.relPath,
        input.argsDigest,
        input.expectedSha256,
        input.status,
        input.reason ?? null,
        input.bytes,
        input.sha256,
        now,
        now,
      );
    return this.getOperation(id)!;
  }

  /**
   * Compare-and-set status change. Returns null when the operation isn't in one of `from` (someone else
   * already moved it on), so a double-click or a race can't run an operation twice.
   */
  transition(
    id: string,
    from: DeviceOperationStatus[],
    to: DeviceOperationStatus,
    patch: { reason?: string | null; commandId?: string; sha256?: string | null; bytes?: number | null } = {},
  ): OperationRecord | null {
    const placeholders = from.map(() => "?").join(",");
    const res = this.db
      .prepare(
        `UPDATE device_operations SET status = ?, updated_at = ?,
           reason = COALESCE(?, reason), command_id = COALESCE(?, command_id),
           sha256 = COALESCE(?, sha256), bytes = COALESCE(?, bytes)
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(
        to,
        Date.now(),
        patch.reason ?? null,
        patch.commandId ?? null,
        patch.sha256 ?? null,
        patch.bytes ?? null,
        id,
        ...from,
      );
    return Number(res.changes) === 1 ? this.getOperation(id) : null;
  }

  getOperation(id: string): OperationRecord | null {
    const r = this.db.prepare("SELECT * FROM device_operations WHERE id = ?").get(id) as Row | undefined;
    return r ? this.toOperation(r) : null;
  }

  listOperations(opts: { agentId?: string; statuses?: DeviceOperationStatus[]; limit?: number } = {}) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.agentId) {
      where.push("agent_id = ?");
      args.push(opts.agentId);
    }
    if (opts.statuses?.length) {
      where.push(`status IN (${opts.statuses.map(() => "?").join(",")})`);
      args.push(...opts.statuses);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM device_operations ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args, Math.min(500, opts.limit ?? 100)) as Row[];
    return rows.map((r) => this.toOperation(r));
  }

  private toOperation(r: Row): OperationRecord {
    return {
      id: r.id,
      agentId: r.agent_id,
      turnId: r.turn_id ?? null,
      deviceId: r.device_id,
      grantId: r.grant_id,
      capability: r.capability,
      displayPath: r.display_path,
      relPath: r.rel_path,
      argsDigest: r.args_digest ?? null,
      commandId: r.command_id ?? null,
      expectedSha256: r.expected_sha256 ?? null,
      status: r.status,
      reason: r.reason ?? null,
      bytes: r.bytes ?? null,
      sha256: r.sha256 ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  /* --------------------------------- routes -------------------------------- */

  addRoute(input: Omit<RouteDecision, "id" | "createdAt">): RouteDecision {
    const d: RouteDecision = { ...input, id: newId("rte"), createdAt: Date.now() };
    this.db
      .prepare(
        `INSERT INTO route_decisions (id, agent_id, turn_id, target, device_id, capability, reason, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.agentId, d.turnId, d.target, d.deviceId, d.capability, d.reason, d.summary, d.createdAt);
    return d;
  }

  listRoutes(agentId: string, limit = 50): RouteDecision[] {
    return (
      this.db
        .prepare("SELECT * FROM route_decisions WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(agentId, Math.min(500, limit)) as Row[]
    ).map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      turnId: r.turn_id ?? null,
      target: r.target,
      deviceId: r.device_id ?? null,
      capability: r.capability,
      reason: r.reason,
      summary: r.summary,
      createdAt: r.created_at,
    }));
  }
}
