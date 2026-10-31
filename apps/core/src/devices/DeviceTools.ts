/**
 * The model's way to reach the user's Mac: `mac_*` Yo tools. Everything here is decided by code, not by
 * the model: which device and grant, whether the route is allowed, and — for writes — the exact bytes the
 * user approved. The device checks all of it again before touching a file.
 *
 * Routing for these tools is simple by construction: the data lives on the Mac, so the only correct
 * executor is the paired device's dedicated file command. Everything else (browsing, code, documents)
 * keeps running on the agent's computer. Each decision is recorded with a stable reason code.
 */
import {
  appWriteDigestInput,
  canonicalJson,
  DEVICE_MAX_FILE_BYTES,
  DEVICE_MAX_INLINE_TEXT_BYTES,
  type DeviceApp,
  type DeviceCapability,
  type DeviceCommandName,
  type DeviceGrant,
  type DeviceOperation,
  newId,
  type PairedDevice,
  type PendingRequest,
  type RECEIPT_COMMANDS,
  type RouteDecision,
  type RoutePreference,
  type RouteReason,
  type Settings,
  signedText,
  writeDigestInput,
} from "@yo/contracts";
import { type CoreIdentity, sha256Hex } from "../auth/identity";
import { logger } from "../log";
import {
  type CommandReply,
  DeviceDisconnectedError,
  type DeviceHub,
  DeviceOfflineError,
  DeviceTimeoutError,
} from "./DeviceHub";
import type { DeviceStore, OperationRecord } from "./DeviceStore";

const log = logger("device-tools");

const READ_TIMEOUT_MS = 60_000;
const WRITE_TIMEOUT_MS = 90_000;
const APPROVAL_TTL_MS = 10 * 60 * 1000;
const RECEIPT_TTL_MS = 2 * 60 * 1000;

export type DeviceWriteRequest = NonNullable<PendingRequest["deviceWrite"]>;

export interface DeviceToolContext {
  agentId: string;
  turnId: string | null;
  route: RoutePreference;
  /** Show the exact-action card and wait for the user. */
  askApproval(title: string, details: DeviceWriteRequest): Promise<"allow" | "deny" | "expired">;
  /** Same, for a change in a Mac app (Calendar, Reminders). */
  askAction(title: string, details: DeviceActionRequest): Promise<"allow" | "deny" | "expired">;
}

export type DeviceActionRequest = NonNullable<PendingRequest["deviceAction"]>;

export interface DeviceToolDeps {
  store: DeviceStore;
  devices: DeviceHub;
  identity: CoreIdentity;
  settings: () => Settings;
  onOperation: (op: DeviceOperation) => void;
  onRoute: (r: RouteDecision) => void;
  activity: (agentId: string, summary: string) => void;
  /** Download a file from the agent's computer. */
  readFromComputer: (agentId: string, path: string) => Promise<Buffer>;
  /** Save into the agent's computer under ~/from-mac/. Returns the path there. */
  saveToComputer: (agentId: string, name: string, data: Buffer) => Promise<string>;
}

class Refusal extends Error {
  constructor(
    readonly reason: RouteReason,
    message: string,
    readonly deviceId: string | null = null,
  ) {
    super(message);
  }
}

interface Target {
  device: PairedDevice;
  grant: DeviceGrant;
  relPath: string;
  displayPath: string;
}

export class DeviceTools {
  constructor(private readonly d: DeviceToolDeps) {}

  async handle(tool: string, args: Record<string, unknown>, ctx: DeviceToolContext): Promise<string> {
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
    try {
      switch (tool) {
        case "mac_access":
          return this.describeAccess(ctx);
        case "mac_list_files":
          return await this.list(ctx, str("folder"), str("path"), str("cursor") || null);
        case "mac_read_file":
          return await this.read(ctx, str("folder"), str("path"));
        case "mac_copy_to_computer":
          return await this.copy(ctx, str("folder"), str("path"));
        case "mac_write_file":
          return await this.write(ctx, str("folder"), str("path"), args);
        case "mac_contacts_search":
          return await this.contactsSearch(ctx, str("query"));
        case "mac_calendar_list":
          return await this.calendarList(ctx);
        case "mac_calendar_events":
          return await this.calendarEvents(ctx, str("start"), str("end"), strList(args.calendars));
        case "mac_calendar_create_event":
          return await this.calendarCreate(ctx, args);
        case "mac_calendar_update_event":
          return await this.calendarUpdate(ctx, args);
        case "mac_reminders":
          return await this.remindersList(ctx, strList(args.lists), args.include_completed === true);
        case "mac_reminders_create":
          return await this.remindersCreate(ctx, args);
        case "mac_reminders_complete":
          return await this.remindersComplete(ctx, str("reminder_id"), args.completed !== false);
        case "mac_notes_search":
          return await this.notesSearch(ctx, str("query"));
        case "mac_notes_read":
          return await this.notesRead(ctx, str("note_id"));
        case "mac_notes_create":
          return await this.notesCreate(ctx, str("title"), str("body"), str("folder") || null);
        case "mac_mail_search":
          return await this.mailSearch(ctx, str("query"), str("mailbox"));
        case "mac_mail_read":
          return await this.mailRead(ctx, str("message_id"));
        case "mac_mail_draft":
          return await this.mailDraft(ctx, args);
        case "mac_windows":
          return await this.windowsList(ctx);
        case "mac_window_session":
          return await this.windowSession(ctx, args);
        case "mac_window_look":
          return await this.windowLook(ctx);
        case "mac_window_click":
          return await this.windowInput(ctx, "window.click", {
            x: Number(args.x),
            y: Number(args.y),
            button: args.button === "right" ? "right" : "left",
            count: args.double === true ? 2 : 1,
          });
        case "mac_window_type":
          return await this.windowInput(ctx, "window.type", { text: str("text").slice(0, 500) });
        case "mac_window_key":
          return await this.windowInput(ctx, "window.key", {
            key: str("key").toLowerCase().slice(0, 20),
            modifiers: (strList(args.modifiers) ?? []).map((m) => m.toLowerCase()).slice(0, 3),
          });
        case "mac_window_scroll":
          return await this.windowInput(ctx, "window.scroll", {
            dx: Math.round(Number(args.dx ?? 0)),
            dy: Math.round(Number(args.dy ?? 0)),
          });
        case "mac_window_end":
          return await this.windowEnd(ctx, "the agent finished");
        default:
          throw new Error(`Unknown tool ${tool}`);
      }
    } catch (err) {
      if (err instanceof Refusal) {
        this.route(ctx, "device", err.deviceId, tool, err.reason, err.message);
        return err.message;
      }
      throw err;
    }
  }

  /* ------------------------------- admission -------------------------------- */

  private describeAccess(ctx: DeviceToolContext): string {
    const s = this.d.settings();
    const devices = this.d.devices.list();
    if (!s.macAccess) return "Mac access is turned off in Yo's settings (Settings → Devices & access).";
    if (ctx.route === "agent-computer")
      return "For this message the user chose “Agent computer only”, so their Mac is off-limits. Ask them if you need something from it.";
    if (!devices.length)
      return "No Mac is paired with Yo yet. The user can pair one in Settings → Devices & access.";
    const lines: string[] = [];
    for (const dev of devices) {
      const state = dev.paused
        ? "paused by the user"
        : dev.online
          ? "online"
          : `offline${dev.lastSeenAt ? ` (last seen ${new Date(dev.lastSeenAt).toISOString()})` : ""}`;
      lines.push(`Mac “${dev.name}” — ${state}`);
      const grants = this.activeGrants(dev.id);
      if (!grants.length) lines.push("  Nothing shared yet.");
      for (const g of grants.filter((x) => x.kind === "app"))
        lines.push(
          `  ${g.displayPath} app — ${g.mode === "read-write" ? "read and change (each change approved by the user)" : "read only"}`,
        );
      for (const g of grants.filter((x) => x.kind !== "app"))
        lines.push(
          `  [${g.id}] ${g.name} — ${g.displayPath} (${g.kind === "dir" ? "folder" : "file"}, ${
            g.mode === "read-write" ? "read and change" : "read only"
          }${g.expiresAt ? `, until ${new Date(g.expiresAt).toISOString()}` : ""})`,
        );
    }
    if (!s.macWrites) lines.push("Changing files on the Mac is turned off in settings.");
    return lines.join("\n");
  }

  private activeGrants(deviceId?: string): DeviceGrant[] {
    const now = Date.now();
    return this.d.store
      .listGrants(deviceId)
      .filter((g) => !g.revokedAt && (g.expiresAt == null || g.expiresAt > now));
  }

  /** Find the device + grant + relative path, or refuse with the reason. */
  private admit(ctx: DeviceToolContext, capability: DeviceCapability, folder: string, path: string): Target {
    const s = this.d.settings();
    if (!s.macAccess) throw new Refusal("disabled", "Mac access is turned off in Yo's settings.");
    if (ctx.route === "agent-computer")
      throw new Refusal(
        "route-restricted",
        "The user chose “Agent computer only” for this message, so I can't use their Mac. Ask them whether you may.",
      );
    const devices = this.d.devices.list();
    if (!devices.length)
      throw new Refusal(
        "needs-pairing",
        "No Mac is paired with Yo. The user can pair one in Settings → Devices & access.",
      );

    const grants = this.activeGrants().filter(
      (g) => g.kind !== "app" && devices.some((dv) => dv.id === g.deviceId),
    );
    const want = folder.trim().toLowerCase();
    let matches = grants.filter((g) => g.id === folder.trim());
    if (!matches.length && want)
      matches = grants.filter(
        (g) =>
          g.name.toLowerCase() === want ||
          g.displayPath.toLowerCase() === want ||
          g.displayPath.toLowerCase() === `~/${want}`,
      );
    if (!matches.length) {
      const avail = grants.map((g) => `${g.name} (${g.displayPath})`).join(", ");
      throw new Refusal(
        "needs-grant",
        avail
          ? `“${folder}” isn't one of the folders the user shared. Shared: ${avail}. To use another folder, ask the user to share it in Yo (Settings → Devices & access).`
          : "The user hasn't shared any folders from their Mac yet. Ask them to choose one in Yo (Settings → Devices & access).",
      );
    }
    if (matches.length > 1)
      throw new Refusal(
        "needs-source-choice",
        `Several shared folders match “${folder}”: ${matches.map((g) => `[${g.id}] ${g.displayPath}`).join(", ")}. Use the id.`,
      );
    const grant = matches[0]!;
    const device = devices.find((dv) => dv.id === grant.deviceId)!;
    if (device.paused)
      throw new Refusal("paused", `The user paused Yo's access to “${device.name}”.`, device.id);
    if (!device.online)
      throw new Refusal(
        "offline",
        `The Mac “${device.name}” is offline${device.lastSeenAt ? ` (last seen ${new Date(device.lastSeenAt).toISOString()})` : ""}, so I can't reach ${grant.displayPath} right now. Continue with anything that doesn't need it and tell the user what's waiting.`,
        device.id,
      );
    if (!device.capabilities.includes(capability))
      throw new Refusal(
        "unsupported",
        `“${device.name}” doesn't support ${capability} (update Yo on the Mac).`,
        device.id,
      );
    if (capability === "files.write") {
      if (grant.mode !== "read-write")
        throw new Refusal(
          "grant-read-only",
          `${grant.displayPath} is shared read-only. The user can allow changes in Settings → Devices & access.`,
          device.id,
        );
      if (!s.macWrites)
        throw new Refusal("disabled", "Changing files on the Mac is turned off in Yo's settings.", device.id);
    }
    const relPath = normalizeRelPath(path, grant);
    const displayPath = relPath ? `${grant.displayPath.replace(/\/$/, "")}/${relPath}` : grant.displayPath;
    return { device, grant, relPath, displayPath };
  }

  private route(
    ctx: DeviceToolContext,
    target: "device" | "agent-computer",
    deviceId: string | null,
    capability: string,
    reason: RouteReason,
    summary: string,
  ) {
    const r = this.d.store.addRoute({
      agentId: ctx.agentId,
      turnId: ctx.turnId,
      target,
      deviceId,
      capability,
      reason,
      summary: summary.slice(0, 300),
    });
    this.d.onRoute(r);
  }

  /* --------------------------------- reads ---------------------------------- */

  private async run(
    t: Target,
    command: DeviceCommandName,
    args: Record<string, unknown>,
    op: OperationRecord,
    timeoutMs: number,
  ): Promise<CommandReply> {
    const commandId = newId("cmd");
    this.update(this.d.store.transition(op.id, ["authorized"], "dispatching", { commandId }));
    return this.d.devices.command(
      t.device.id,
      {
        type: "command",
        commandId,
        operationId: op.id,
        command,
        grantId: t.grant.id,
        grantRevision: t.grant.revision,
        args,
        argsDigest: sha256Hex(canonicalJson(args)),
        receipt: null,
        expiresAt: Date.now() + timeoutMs,
      },
      timeoutMs,
    );
  }

  private startOp(ctx: DeviceToolContext, t: Target, capability: DeviceCapability): OperationRecord {
    this.route(
      ctx,
      "device",
      t.device.id,
      capability,
      "dedicated-command",
      `Using ${t.device.name} because ${t.displayPath} is only there`,
    );
    const op = this.d.store.createOperation({
      agentId: ctx.agentId,
      turnId: ctx.turnId,
      deviceId: t.device.id,
      grantId: t.grant.id,
      capability,
      displayPath: t.displayPath,
      relPath: t.relPath,
      argsDigest: null,
      expectedSha256: null,
      status: "authorized",
      bytes: null,
      sha256: null,
    });
    this.d.onOperation(op);
    return op;
  }

  private finishRead(
    op: OperationRecord,
    reply: CommandReply,
    extra: { bytes?: number; sha256?: string | null } = {},
  ) {
    if (reply.ok)
      this.update(
        this.d.store.transition(op.id, ["dispatching"], "succeeded", {
          bytes: extra.bytes ?? null,
          sha256: extra.sha256 ?? null,
        }),
      );
    else
      this.update(
        this.d.store.transition(op.id, ["dispatching"], "failed", { reason: reply.error?.code ?? "error" }),
      );
  }

  private async readOp(
    ctx: DeviceToolContext,
    t: Target,
    capability: DeviceCapability,
    command: DeviceCommandName,
    args: Record<string, unknown>,
  ): Promise<{ op: OperationRecord; reply: CommandReply }> {
    const op = this.startOp(ctx, t, capability);
    try {
      const reply = await this.run(t, command, args, op, READ_TIMEOUT_MS);
      return { op, reply };
    } catch (err) {
      this.update(
        this.d.store.transition(op.id, ["dispatching", "authorized"], "failed", { reason: errReason(err) }),
      );
      throw new Refusal("offline", `Couldn't reach “${t.device.name}”: ${friendly(err)}`, t.device.id);
    }
  }

  private async list(ctx: DeviceToolContext, folder: string, path: string, cursor: string | null) {
    const t = this.admit(ctx, "files.list", folder, path);
    const { op, reply } = await this.readOp(ctx, t, "files.list", "files.list", {
      relPath: t.relPath,
      limit: 200,
      cursor,
    });
    this.finishRead(op, reply);
    if (!reply.ok) return deviceErrorText(reply, t.displayPath);
    const res = reply.result as {
      entries: { name: string; kind: string; size: number; mtimeMs: number }[];
      nextCursor: string | null;
    };
    const lines = res.entries.map(
      (e) =>
        `${e.kind === "dir" ? "📁" : e.kind === "file" ? "📄" : "·"} ${e.name}${e.kind === "file" ? ` (${fmtBytes(e.size)}, modified ${new Date(e.mtimeMs).toISOString()})` : e.kind === "symlink" ? " (link, not followed)" : ""}`,
    );
    return `${t.displayPath} on ${t.device.name}:\n${lines.join("\n") || "(empty)"}${res.nextCursor ? `\n(more: call again with cursor "${res.nextCursor}")` : ""}`;
  }

  private async read(ctx: DeviceToolContext, folder: string, path: string) {
    const t = this.admit(ctx, "files.read", folder, path);
    const { op, reply } = await this.readOp(ctx, t, "files.read", "files.read", {
      relPath: t.relPath,
      maxBytes: DEVICE_MAX_INLINE_TEXT_BYTES,
    });
    if (!reply.ok) {
      this.finishRead(op, reply);
      return deviceErrorText(reply, t.displayPath);
    }
    const res = reply.result as {
      dataBase64: string;
      size: number;
      sha256: string | null;
      truncated: boolean;
      mtimeMs: number;
    };
    const buf = Buffer.from(res.dataBase64, "base64");
    this.finishRead(op, reply, { bytes: buf.length, sha256: res.sha256 });
    this.d.activity(ctx.agentId, `Read ${t.displayPath} on ${t.device.name}`);
    if (!looksLikeText(buf))
      return `${t.displayPath} isn't a text file (${fmtBytes(res.size)}). Use mac_copy_to_computer to work with it on your computer.`;
    return `${t.displayPath} on ${t.device.name} (${fmtBytes(res.size)}, modified ${new Date(res.mtimeMs).toISOString()})${
      res.truncated
        ? ` — showing the first ${fmtBytes(buf.length)}; use mac_copy_to_computer for the whole file`
        : ""
    }:\n\n${buf.toString("utf8")}`;
  }

  private async copy(ctx: DeviceToolContext, folder: string, path: string) {
    const t = this.admit(ctx, "files.read", folder, path);
    const { op, reply } = await this.readOp(ctx, t, "files.read", "files.read", {
      relPath: t.relPath,
      maxBytes: DEVICE_MAX_FILE_BYTES,
    });
    if (!reply.ok) {
      this.finishRead(op, reply);
      return deviceErrorText(reply, t.displayPath);
    }
    const res = reply.result as {
      dataBase64: string;
      size: number;
      sha256: string | null;
      truncated: boolean;
    };
    if (res.truncated) {
      this.update(this.d.store.transition(op.id, ["dispatching"], "failed", { reason: "too_large" }));
      return `${t.displayPath} is ${fmtBytes(res.size)}, over the ${fmtBytes(DEVICE_MAX_FILE_BYTES)} limit for copying.`;
    }
    const buf = Buffer.from(res.dataBase64, "base64");
    const name = t.relPath ? t.relPath.split("/").pop()! : t.grant.name;
    const saved = await this.d.saveToComputer(ctx.agentId, name, buf);
    this.finishRead(op, reply, { bytes: buf.length, sha256: res.sha256 });
    this.d.activity(ctx.agentId, `Copied ${t.displayPath} from ${t.device.name} to the agent's computer`);
    return `Copied ${t.displayPath} (${fmtBytes(buf.length)}) from ${t.device.name} to ${saved} on your computer.`;
  }

  /* --------------------------------- writes --------------------------------- */

  private async write(ctx: DeviceToolContext, folder: string, path: string, args: Record<string, unknown>) {
    const t = this.admit(ctx, "files.write", folder, path);
    if (!t.relPath && t.grant.kind === "dir") return "Give the file's path inside the shared folder.";
    const content = typeof args.content === "string" ? args.content : null;
    const fromComputer = typeof args.fromComputerPath === "string" ? args.fromComputerPath : null;
    if ((content == null) === (fromComputer == null))
      return "Give exactly one of `content` or `fromComputerPath`.";
    const data =
      content != null
        ? Buffer.from(content, "utf8")
        : await this.d.readFromComputer(ctx.agentId, fromComputer!);
    if (data.length > DEVICE_MAX_FILE_BYTES)
      return `That's ${fmtBytes(data.length)}; the limit for saving to the Mac is ${fmtBytes(DEVICE_MAX_FILE_BYTES)}.`;

    // What's there now? The approval is bound to it, so a file that changes before the write isn't clobbered.
    const statOp = await this.readOp(ctx, t, "files.read", "files.stat", { relPath: t.relPath });
    let expectedSha256: string | null = null;
    let replaces: DeviceWriteRequest["replaces"] = null;
    if (statOp.reply.ok) {
      const st = statOp.reply.result as {
        kind: string;
        size: number;
        mtimeMs: number;
        sha256: string | null;
      };
      this.finishRead(statOp.op, statOp.reply, { bytes: st.size, sha256: st.sha256 });
      if (st.kind !== "file") return `${t.displayPath} exists and isn't a regular file; I won't replace it.`;
      if (!st.sha256) return `${t.displayPath} is too large to replace safely.`;
      expectedSha256 = st.sha256;
      replaces = { bytes: st.size, modifiedAt: st.mtimeMs };
    } else if (statOp.reply.error?.code === "not_found") {
      this.update(
        this.d.store.transition(statOp.op.id, ["dispatching"], "succeeded", { reason: "not_found" }),
      );
    } else {
      this.finishRead(statOp.op, statOp.reply);
      return deviceErrorText(statOp.reply, t.displayPath);
    }

    const sha256 = sha256Hex(data);
    const writeArgs = {
      relPath: t.relPath,
      dataBase64: data.toString("base64"),
      sha256,
      size: data.length,
      expectedSha256,
    };
    const argsDigest = writeDigest(t.device.id, t.grant.id, t.grant.revision, writeArgs);
    const op = this.d.store.createOperation({
      agentId: ctx.agentId,
      turnId: ctx.turnId,
      deviceId: t.device.id,
      grantId: t.grant.id,
      capability: "files.write",
      displayPath: t.displayPath,
      relPath: t.relPath,
      argsDigest,
      expectedSha256,
      status: "awaiting-approval",
      bytes: data.length,
      sha256,
    });
    this.d.onOperation(op);
    this.route(
      ctx,
      "device",
      t.device.id,
      "files.write",
      "dedicated-command",
      `Saving ${t.displayPath} on ${t.device.name} (needs your approval)`,
    );

    const fileName = t.displayPath.split("/").pop() ?? t.displayPath;
    const decision = await ctx.askApproval(
      `${replaces ? "Replace" : "Create"} “${fileName}” on ${t.device.name}`,
      {
        operationId: op.id,
        deviceName: t.device.name,
        displayPath: t.displayPath,
        bytes: data.length,
        sha256,
        replaces,
        preview: looksLikeText(data) ? data.subarray(0, 4096).toString("utf8") : null,
        expiresAt: Date.now() + APPROVAL_TTL_MS,
      },
    );
    if (decision !== "allow") {
      this.update(
        this.d.store.transition(op.id, ["awaiting-approval"], decision === "deny" ? "denied" : "expired", {
          reason: decision === "deny" ? "user declined" : "approval expired",
        }),
      );
      return decision === "deny"
        ? `The user declined saving ${t.displayPath}. Nothing was written.`
        : `The approval for ${t.displayPath} expired. Nothing was written.`;
    }

    // Re-check everything the approval assumed, at the moment of execution.
    let fresh: Target;
    try {
      fresh = this.admit(ctx, "files.write", t.grant.id, t.relPath);
    } catch (err) {
      this.update(
        this.d.store.transition(op.id, ["awaiting-approval"], "cancelled", {
          reason: (err as Error).message.slice(0, 200),
        }),
      );
      throw err;
    }
    if (fresh.grant.revision !== t.grant.revision || fresh.device.id !== t.device.id) {
      this.update(
        this.d.store.transition(op.id, ["awaiting-approval"], "cancelled", { reason: "access changed" }),
      );
      return `Access to ${t.displayPath} changed after approval, so nothing was written. Ask again if needed.`;
    }
    if (!this.update(this.d.store.transition(op.id, ["awaiting-approval"], "authorized"))) {
      return "This change was already handled.";
    }

    const receiptBody = {
      operationId: op.id,
      deviceId: t.device.id,
      grantId: t.grant.id,
      grantRevision: t.grant.revision,
      command: "files.write" as const,
      argsDigest,
      expiresAt: Date.now() + RECEIPT_TTL_MS,
    };
    const receipt = { ...receiptBody, signature: this.d.identity.sign(signedText.approval(receiptBody)) };
    const commandId = newId("cmd");
    this.update(this.d.store.transition(op.id, ["authorized"], "dispatching", { commandId }));
    let reply: CommandReply;
    try {
      reply = await this.d.devices.command(
        t.device.id,
        {
          type: "command",
          commandId,
          operationId: op.id,
          command: "files.write",
          grantId: t.grant.id,
          grantRevision: t.grant.revision,
          args: writeArgs,
          argsDigest,
          receipt,
          expiresAt: receipt.expiresAt,
        },
        WRITE_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof DeviceOfflineError) {
        this.update(this.d.store.transition(op.id, ["dispatching"], "failed", { reason: "offline" }));
        return `“${t.device.name}” went offline before the save started. Nothing was written.`;
      }
      // Sent, but the answer was lost: never resend. Ask the device's journal when it's back.
      this.update(
        this.d.store.transition(op.id, ["dispatching"], "unknown-outcome", { reason: errReason(err) }),
      );
      void this.reconcile(t.device.id);
      return `I lost contact with “${t.device.name}” while saving ${t.displayPath}, so I don't know yet whether it was saved. Don't retry; Yo will check when the Mac is back and show the result. Tell the user.`;
    }
    if (!reply.ok) {
      this.update(
        this.d.store.transition(op.id, ["dispatching"], "failed", { reason: reply.error?.code ?? "error" }),
      );
      return deviceErrorText(reply, t.displayPath);
    }
    const res = reply.result as { sha256: string; size: number };
    if (res.sha256 !== sha256) {
      this.update(
        this.d.store.transition(op.id, ["dispatching"], "unknown-outcome", {
          reason: "content check failed",
        }),
      );
      return `The Mac reported a different result for ${t.displayPath} than approved. Tell the user to check the file.`;
    }
    this.update(this.d.store.transition(op.id, ["dispatching"], "succeeded"));
    this.d.activity(ctx.agentId, `Saved ${t.displayPath} on ${t.device.name} (approved)`);
    return `Saved ${t.displayPath} on ${t.device.name} (${fmtBytes(data.length)}, verified).`;
  }

  /* --------------------------- Mac apps (R2) ----------------------------- */

  /** Recently seen events/reminders (per device), so approval cards can name what changes and spot edits. */
  private seen = new Map<
    string,
    { title: string; start?: number; calendar?: string; lastModified?: number | null }
  >();

  private admitApp(ctx: DeviceToolContext, app: DeviceApp, capability: DeviceCapability): Target {
    const s = this.d.settings();
    const label = APP_LABEL[app];
    if (!s.macAccess) throw new Refusal("disabled", "Mac access is turned off in Yo's settings.");
    if (ctx.route === "agent-computer")
      throw new Refusal(
        "route-restricted",
        `The user chose “Agent computer only” for this message, so I can't use their Mac's ${label}. Ask them whether you may.`,
      );
    const devices = this.d.devices.list();
    if (!devices.length)
      throw new Refusal(
        "needs-pairing",
        "No Mac is paired with Yo. The user can pair one in Settings → Devices & access.",
      );
    const grants = this.activeGrants().filter(
      (g) => g.kind === "app" && g.app === app && devices.some((dv) => dv.id === g.deviceId),
    );
    if (!grants.length)
      throw new Refusal(
        "needs-grant",
        `The user hasn't shared their Mac's ${label} with Yo. They can allow it in Settings → Devices & access → Apps.`,
      );
    if (grants.length > 1)
      throw new Refusal(
        "needs-source-choice",
        `${label} is shared from several Macs (${grants.map((g) => devices.find((d) => d.id === g.deviceId)?.name).join(", ")}). Ask the user which one.`,
      );
    const grant = grants[0]!;
    const device = devices.find((dv) => dv.id === grant.deviceId)!;
    if (device.paused)
      throw new Refusal("paused", `The user paused Yo's access to “${device.name}”.`, device.id);
    if (!device.online)
      throw new Refusal(
        "offline",
        `The Mac “${device.name}” is offline${device.lastSeenAt ? ` (last seen ${new Date(device.lastSeenAt).toISOString()})` : ""}, so its ${label} can't be checked right now. Don't answer from memory as if it were current.`,
        device.id,
      );
    if (!device.capabilities.includes(capability))
      throw new Refusal(
        "unsupported",
        `“${device.name}” doesn't support ${label} yet (update Yo on the Mac).`,
        device.id,
      );
    if (WRITE_CAPS.has(capability)) {
      if (grant.mode !== "read-write")
        throw new Refusal(
          "grant-read-only",
          `${label} is shared read-only. The user can allow changes in Settings → Devices & access.`,
          device.id,
        );
      if (!s.macWrites)
        throw new Refusal("disabled", "Changes on the Mac are turned off in Yo's settings.", device.id);
    }
    return { device, grant, relPath: "", displayPath: label };
  }

  private async appRead(
    ctx: DeviceToolContext,
    t: Target,
    capability: DeviceCapability,
    command: DeviceCommandName,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; result: any } | { ok: false; text: string }> {
    const { op, reply } = await this.readOp(ctx, t, capability, command, args);
    this.finishRead(op, reply);
    if (!reply.ok) return { ok: false, text: appErrorText(reply, t.displayPath) };
    return { ok: true, result: reply.result };
  }

  private tz() {
    return this.d.settings().timezone || "UTC";
  }

  private async contactsSearch(ctx: DeviceToolContext, query: string) {
    if (!query.trim()) return "Give a name, phone number or email to look up.";
    const t = this.admitApp(ctx, "contacts", "contacts.read");
    const r = await this.appRead(ctx, t, "contacts.read", "contacts.search", {
      query: query.trim().slice(0, 200),
      limit: 20,
    });
    if (!r.ok) return r.text;
    const list = r.result.contacts as {
      id: string;
      name: string;
      organization: string | null;
      phones: { label: string | null; value: string }[];
      emails: { label: string | null; value: string }[];
    }[];
    this.d.activity(ctx.agentId, `Looked up “${query.slice(0, 60)}” in Contacts on ${t.device.name}`);
    if (!list.length)
      return `No contacts match “${query}” in Contacts on ${t.device.name}. (That's only this Mac's Contacts.)`;
    const lines = list.map(
      (c) =>
        `- ${c.name}${c.organization ? ` (${c.organization})` : ""}${c.phones.length ? ` · phones: ${c.phones.map((p) => `${p.value}${p.label ? ` [${p.label}]` : ""}`).join(", ")}` : ""}${c.emails.length ? ` · emails: ${c.emails.map((e) => e.value).join(", ")}` : ""}`,
    );
    return `Contacts on ${t.device.name} matching “${query}”:\n${lines.join("\n")}${list.length > 1 ? "\nSeveral match: ask the user which person before using a number or email." : ""}`;
  }

  private async calendars(ctx: DeviceToolContext, t: Target) {
    const r = await this.appRead(ctx, t, "calendar.read", "calendar.calendars", {});
    if (!r.ok) return r;
    return {
      ok: true as const,
      list: r.result.calendars as { id: string; title: string; account: string; writable: boolean }[],
    };
  }

  private async calendarList(ctx: DeviceToolContext) {
    const t = this.admitApp(ctx, "calendar", "calendar.read");
    const r = await this.calendars(ctx, t);
    if (!r.ok) return r.text;
    if (!r.list.length) return `No calendars in Calendar on ${t.device.name}.`;
    return `Calendars on ${t.device.name}:\n${r.list
      .map((c) => `- [${c.id}] ${c.title} · ${c.account}${c.writable ? "" : " · read-only"}`)
      .join("\n")}`;
  }

  private resolveNamed<T extends { id: string; title: string }>(
    items: T[],
    wanted: string,
    what: string,
  ): T | string {
    const exact = items.filter((c) => c.id === wanted);
    if (exact.length) return exact[0]!;
    const byName = items.filter((c) => c.title.toLowerCase() === wanted.trim().toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1)
      return `Several ${what}s are named “${wanted}”: ${byName.map((c) => `[${c.id}]`).join(", ")}. Ask the user which one.`;
    return `No ${what} “${wanted}”. Available: ${items.map((c) => c.title).join(", ") || "none"}.`;
  }

  private async calendarEvents(
    ctx: DeviceToolContext,
    startS: string,
    endS: string,
    wanted: string[] | null,
  ) {
    const start = parseWhen(startS, this.tz());
    const end = parseWhen(endS, this.tz());
    if (start == null || end == null) return "Give start and end as ISO 8601 dates/times.";
    if (end.ms <= start.ms) return "The end must be after the start.";
    if (end.ms - start.ms > 366 * 86_400_000) return "Ask for at most a year at a time.";
    const t = this.admitApp(ctx, "calendar", "calendar.read");
    const cals = await this.calendars(ctx, t);
    if (!cals.ok) return cals.text;
    let ids: string[] | null = null;
    if (wanted?.length) {
      ids = [];
      for (const w of wanted) {
        const c = this.resolveNamed(cals.list, w, "calendar");
        if (typeof c === "string") return c;
        ids.push(c.id);
      }
    }
    const r = await this.appRead(ctx, t, "calendar.read", "calendar.events", {
      start: start.ms,
      end: end.ms,
      calendarIds: ids,
      limit: 200,
    });
    if (!r.ok) return r.text;
    const events = r.result.events as {
      id: string;
      calendarId: string;
      title: string;
      start: number;
      end: number;
      allDay: boolean;
      location: string | null;
      recurring: boolean;
      occurrenceDate: number;
      lastModified: number | null;
    }[];
    const calName = new Map(cals.list.map((c) => [c.id, `${c.title} (${c.account})`]));
    for (const e of events)
      this.seen.set(`${t.device.id}:event:${e.id}:${e.occurrenceDate}`, {
        title: e.title,
        start: e.start,
        calendar: calName.get(e.calendarId),
        lastModified: e.lastModified,
      });
    this.trimSeen();
    this.d.activity(ctx.agentId, `Checked Calendar on ${t.device.name} (${events.length} events)`);
    const scope = ids ? ids.map((i) => calName.get(i)).join(", ") : `all ${cals.list.length} calendars`;
    if (!events.length)
      return `No events between ${fmtWhen(start.ms, this.tz())} and ${fmtWhen(end.ms, this.tz())} in ${scope} on ${t.device.name} (live).`;
    return `Events on ${t.device.name} (live, ${scope}, times in ${this.tz()}):\n${events
      .map(
        (e) =>
          `- ${e.allDay ? `${fmtDate(e.start, this.tz())} (all day)` : `${fmtWhen(e.start, this.tz())} – ${fmtTime(e.end, this.tz())}`} · ${e.title}${e.location ? ` · ${e.location}` : ""} · ${calName.get(e.calendarId) ?? e.calendarId}${e.recurring ? " · repeats" : ""} · id ${e.id}${e.recurring ? ` · occurrence ${new Date(e.occurrenceDate).toISOString()}` : ""}`,
      )
      .join("\n")}${r.result.truncated ? "\n(More events not shown: narrow the range.)" : ""}`;
  }

  private async calendarCreate(ctx: DeviceToolContext, a: Record<string, unknown>) {
    const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
    const title = s("title");
    if (!title) return "Give the event a title.";
    const allDayArg = a.all_day === true;
    const start = parseWhen(s("start"), this.tz());
    const end = parseWhen(s("end"), this.tz());
    if (!start || !end) return "Give start and end as ISO 8601 dates/times.";
    const allDay = allDayArg || (start.dateOnly && end.dateOnly);
    if (end.ms < start.ms || (!allDay && end.ms === start.ms)) return "The end must be after the start.";
    const t = this.admitApp(ctx, "calendar", "calendar.write");
    const cals = await this.calendars(ctx, t);
    if (!cals.ok) return cals.text;
    const cal = this.resolveNamed(cals.list, s("calendar"), "calendar");
    if (typeof cal === "string") return cal;
    if (!cal.writable) return `“${cal.title}” is read-only; pick another calendar.`;
    const args = {
      calendarId: cal.id,
      title: title.slice(0, 500),
      start: start.ms,
      end: allDay && end.ms === start.ms ? end.ms + 86_400_000 : end.ms,
      allDay,
      location: s("location") ? s("location").slice(0, 500) : null,
      notes: s("notes") ? s("notes").slice(0, 8000) : null,
      timeZone: this.tz(),
    };
    const when = allDay
      ? `${fmtDate(args.start, this.tz())} (all day)`
      : `${fmtWhen(args.start, this.tz())} – ${fmtTime(args.end, this.tz())}`;
    const lines = [
      { label: "Calendar", value: `${cal.title} · ${cal.account}` },
      { label: "Title", value: args.title },
      { label: "When", value: when },
      ...(args.location ? [{ label: "Location", value: args.location }] : []),
      ...(args.notes ? [{ label: "Notes", value: args.notes.slice(0, 400) }] : []),
      { label: "Invites", value: "None (nobody is notified)" },
    ];
    return this.appWrite(
      ctx,
      t,
      "calendar.write",
      "calendar.createEvent",
      args,
      `Add “${args.title}” to ${cal.title}`,
      lines,
      (res) => {
        return `Added “${args.title}” (${when}) to ${cal.title} on ${t.device.name}. Event id ${res.id}.`;
      },
    );
  }

  private async calendarUpdate(ctx: DeviceToolContext, a: Record<string, unknown>) {
    const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : undefined);
    const id = s("event_id");
    if (!id) return "Give the event id (from mac_calendar_events).";
    const changes: Record<string, unknown> = {};
    if (s("title")) changes.title = s("title")!.slice(0, 500);
    for (const k of ["start", "end"] as const) {
      const v = s(k);
      if (v) {
        const w = parseWhen(v, this.tz());
        if (!w) return `Give ${k} as an ISO 8601 date/time.`;
        changes[k] = w.ms;
      }
    }
    if (s("location") !== undefined) changes.location = s("location") || null;
    if (s("notes") !== undefined) changes.notes = s("notes") || null;
    if (!Object.keys(changes).length)
      return "Nothing to change: give a new title, start, end, location or notes.";
    const occ = s("occurrence_start") ? parseWhen(s("occurrence_start")!, this.tz()) : null;
    const t = this.admitApp(ctx, "calendar", "calendar.write");
    const known = [...this.seen.entries()].find(
      ([k]) => k.startsWith(`${t.device.id}:event:${id}:`) && (!occ || k.endsWith(`:${occ.ms}`)),
    );
    if (!known)
      return "Look the event up first with mac_calendar_events, so the user sees exactly which event changes.";
    const info = known[1];
    const occurrenceDate = Number(known[0].split(":").pop());
    const args = {
      id,
      occurrenceDate: Number.isFinite(occurrenceDate) ? occurrenceDate : null,
      expectedLastModified: info.lastModified ?? null,
      changes,
    };
    const lines = [
      { label: "Event", value: `${info.title}${info.start ? ` · ${fmtWhen(info.start, this.tz())}` : ""}` },
      ...(info.calendar ? [{ label: "Calendar", value: info.calendar }] : []),
      { label: "Applies to", value: "This occurrence only" },
      ...Object.entries(changes).map(([k, v]) => ({
        label: `New ${k}`,
        value:
          v == null
            ? "(cleared)"
            : k === "start" || k === "end"
              ? fmtWhen(v as number, this.tz())
              : String(v).slice(0, 400),
      })),
    ];
    return this.appWrite(
      ctx,
      t,
      "calendar.write",
      "calendar.updateEvent",
      args,
      `Change “${info.title}”`,
      lines,
      () => `Updated “${info.title}” on ${t.device.name}.`,
    );
  }

  private async reminderLists(ctx: DeviceToolContext, t: Target) {
    const r = await this.appRead(ctx, t, "reminders.read", "reminders.lists", {});
    if (!r.ok) return r;
    return {
      ok: true as const,
      list: r.result.lists as { id: string; title: string; account: string; writable: boolean }[],
    };
  }

  private async remindersList(ctx: DeviceToolContext, wanted: string[] | null, includeCompleted: boolean) {
    const t = this.admitApp(ctx, "reminders", "reminders.read");
    const lists = await this.reminderLists(ctx, t);
    if (!lists.ok) return lists.text;
    let ids: string[] | null = null;
    if (wanted?.length) {
      ids = [];
      for (const w of wanted) {
        const l = this.resolveNamed(lists.list, w, "list");
        if (typeof l === "string") return l;
        ids.push(l.id);
      }
    }
    const r = await this.appRead(ctx, t, "reminders.read", "reminders.list", {
      listIds: ids,
      includeCompleted,
      limit: 200,
    });
    if (!r.ok) return r.text;
    const items = r.result.reminders as {
      id: string;
      listId: string;
      title: string;
      due: number | null;
      dueAllDay: boolean;
      completed: boolean;
    }[];
    const listName = new Map(lists.list.map((l) => [l.id, l.title]));
    for (const x of items) this.seen.set(`${t.device.id}:reminder:${x.id}`, { title: x.title });
    this.trimSeen();
    this.d.activity(ctx.agentId, `Checked Reminders on ${t.device.name} (${items.length})`);
    if (!items.length)
      return `No ${includeCompleted ? "" : "open "}reminders in ${ids ? ids.map((i) => listName.get(i)).join(", ") : "any list"} on ${t.device.name}.`;
    return `Reminders on ${t.device.name} (lists: ${lists.list.map((l) => l.title).join(", ")}):\n${items
      .map(
        (x) =>
          `- ${x.completed ? "[done] " : ""}${x.title}${x.due ? ` · due ${x.dueAllDay ? fmtDate(x.due, this.tz()) : fmtWhen(x.due, this.tz())}` : ""} · ${listName.get(x.listId) ?? x.listId} · id ${x.id}`,
      )
      .join("\n")}${r.result.truncated ? "\n(More not shown.)" : ""}`;
  }

  private async remindersCreate(ctx: DeviceToolContext, a: Record<string, unknown>) {
    const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
    const title = s("title");
    if (!title) return "Give the reminder a title.";
    const due = s("due") ? parseWhen(s("due"), this.tz()) : null;
    if (s("due") && !due) return "Give the due date as ISO 8601.";
    const t = this.admitApp(ctx, "reminders", "reminders.write");
    const lists = await this.reminderLists(ctx, t);
    if (!lists.ok) return lists.text;
    const list = this.resolveNamed(lists.list, s("list"), "list");
    if (typeof list === "string") return list;
    if (!list.writable) return `“${list.title}” is read-only; pick another list.`;
    const args = {
      listId: list.id,
      title: title.slice(0, 500),
      due: due?.ms ?? null,
      dueAllDay: !!due?.dateOnly,
      notes: s("notes") ? s("notes").slice(0, 8000) : null,
    };
    const lines = [
      { label: "List", value: `${list.title} · ${list.account}` },
      { label: "Reminder", value: args.title },
      {
        label: "Due",
        value: due ? (due.dateOnly ? fmtDate(due.ms, this.tz()) : fmtWhen(due.ms, this.tz())) : "No date",
      },
      ...(args.notes ? [{ label: "Notes", value: args.notes.slice(0, 400) }] : []),
    ];
    return this.appWrite(
      ctx,
      t,
      "reminders.write",
      "reminders.create",
      args,
      `Add reminder “${args.title}”`,
      lines,
      () => `Added the reminder “${args.title}” to ${list.title} on ${t.device.name}.`,
    );
  }

  private async remindersComplete(ctx: DeviceToolContext, id: string, completed: boolean) {
    if (!id) return "Give the reminder id (from mac_reminders).";
    const t = this.admitApp(ctx, "reminders", "reminders.write");
    const info = this.seen.get(`${t.device.id}:reminder:${id}`);
    if (!info)
      return "Look the reminder up first with mac_reminders, so the user sees exactly which one changes.";
    const args = { id, completed };
    return this.appWrite(
      ctx,
      t,
      "reminders.write",
      "reminders.complete",
      args,
      `${completed ? "Complete" : "Reopen"} “${info.title}”`,
      [
        { label: "Reminder", value: info.title },
        { label: "Change", value: completed ? "Mark as done" : "Mark as not done" },
      ],
      () => `Marked “${info.title}” as ${completed ? "done" : "not done"} on ${t.device.name}.`,
    );
  }

  /** Shared exact-approval + signed-receipt flow for app changes. */
  private async appWrite(
    ctx: DeviceToolContext,
    t: Target,
    capability: DeviceCapability,
    command: (typeof RECEIPT_COMMANDS)[number],
    args: Record<string, unknown>,
    title: string,
    lines: { label: string; value: string }[],
    done: (result: any) => string,
  ): Promise<string> {
    const argsDigest = sha256Hex(
      appWriteDigestInput(t.device.id, t.grant.id, t.grant.revision, command, args),
    );
    const op = this.d.store.createOperation({
      agentId: ctx.agentId,
      turnId: ctx.turnId,
      deviceId: t.device.id,
      grantId: t.grant.id,
      capability,
      displayPath: `${t.displayPath}: ${title}`.slice(0, 300),
      relPath: "",
      argsDigest,
      expectedSha256: null,
      status: "awaiting-approval",
      bytes: null,
      sha256: null,
    });
    this.d.onOperation(op);
    this.route(
      ctx,
      "device",
      t.device.id,
      capability,
      "dedicated-command",
      `${title} on ${t.device.name} (needs your approval)`,
    );
    const decision = await ctx.askAction(`${title} on ${t.device.name}`, {
      operationId: op.id,
      deviceName: t.device.name,
      app: t.grant.app!,
      lines,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    });
    if (decision !== "allow") {
      this.update(
        this.d.store.transition(op.id, ["awaiting-approval"], decision === "deny" ? "denied" : "expired", {
          reason: decision === "deny" ? "user declined" : "approval expired",
        }),
      );
      return decision === "deny"
        ? "The user declined. Nothing was changed."
        : "The approval expired. Nothing was changed.";
    }
    let fresh: Target;
    try {
      fresh = this.admitApp(ctx, t.grant.app!, capability);
    } catch (err) {
      this.update(
        this.d.store.transition(op.id, ["awaiting-approval"], "cancelled", {
          reason: (err as Error).message.slice(0, 200),
        }),
      );
      throw err;
    }
    if (fresh.grant.id !== t.grant.id || fresh.grant.revision !== t.grant.revision) {
      this.update(
        this.d.store.transition(op.id, ["awaiting-approval"], "cancelled", { reason: "access changed" }),
      );
      return "Access changed after approval, so nothing was changed. Ask again if needed.";
    }
    if (!this.update(this.d.store.transition(op.id, ["awaiting-approval"], "authorized")))
      return "This change was already handled.";
    const receiptBody = {
      operationId: op.id,
      deviceId: t.device.id,
      grantId: t.grant.id,
      grantRevision: t.grant.revision,
      command,
      argsDigest,
      expiresAt: Date.now() + RECEIPT_TTL_MS,
    };
    const receipt = { ...receiptBody, signature: this.d.identity.sign(signedText.approval(receiptBody)) };
    const commandId = newId("cmd");
    this.update(this.d.store.transition(op.id, ["authorized"], "dispatching", { commandId }));
    let reply: CommandReply;
    try {
      reply = await this.d.devices.command(
        t.device.id,
        {
          type: "command",
          commandId,
          operationId: op.id,
          command,
          grantId: t.grant.id,
          grantRevision: t.grant.revision,
          args,
          argsDigest,
          receipt,
          expiresAt: receipt.expiresAt,
        },
        WRITE_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof DeviceOfflineError) {
        this.update(this.d.store.transition(op.id, ["dispatching"], "failed", { reason: "offline" }));
        return `“${t.device.name}” went offline before the change started. Nothing was changed.`;
      }
      this.update(
        this.d.store.transition(op.id, ["dispatching"], "unknown-outcome", { reason: errReason(err) }),
      );
      void this.reconcile(t.device.id);
      return `I lost contact with “${t.device.name}” during the change, so I don't know yet whether it happened. Don't retry; tell the user to check ${t.displayPath}.`;
    }
    if (!reply.ok) {
      this.update(
        this.d.store.transition(op.id, ["dispatching"], "failed", { reason: reply.error?.code ?? "error" }),
      );
      return appErrorText(reply, t.displayPath);
    }
    this.update(this.d.store.transition(op.id, ["dispatching"], "succeeded"));
    this.d.activity(ctx.agentId, `${title} on ${t.device.name} (approved)`);
    return done(reply.result);
  }

  /* ------------------------------ Notes & Mail (R4) ------------------------------ */

  private async notesSearch(ctx: DeviceToolContext, query: string) {
    if (!query.trim()) return "Give something to search for.";
    const t = this.admitApp(ctx, "notes", "notes.read");
    const r = await this.appRead(ctx, t, "notes.read", "notes.search", {
      query: query.trim().slice(0, 200),
      limit: 20,
    });
    if (!r.ok) return r.text;
    const notes = r.result.notes as { id: string; name: string; folder: string; modified: number }[];
    for (const n of notes) this.seen.set(`${t.device.id}:note:${n.id}`, { title: n.name });
    this.trimSeen();
    this.d.activity(ctx.agentId, `Searched Notes on ${t.device.name}`);
    if (!notes.length) return `No notes match “${query}” in Notes on ${t.device.name}.`;
    return `Notes on ${t.device.name} matching “${query}”:\n${notes
      .map((n) => `- ${n.name} · ${n.folder} · edited ${fmtWhen(n.modified, this.tz())} · id ${n.id}`)
      .join("\n")}`;
  }

  private async notesRead(ctx: DeviceToolContext, id: string) {
    if (!id) return "Give the note id (from mac_notes_search).";
    const t = this.admitApp(ctx, "notes", "notes.read");
    const r = await this.appRead(ctx, t, "notes.read", "notes.read", { id });
    if (!r.ok) return r.text;
    const n = r.result as {
      name: string;
      folder: string;
      modified: number;
      text: string;
      truncated: boolean;
    };
    this.d.activity(ctx.agentId, `Read the note “${n.name.slice(0, 60)}” on ${t.device.name}`);
    return `Note “${n.name}” (${n.folder}, edited ${fmtWhen(n.modified, this.tz())})${n.truncated ? " — truncated" : ""}:\n\n${n.text}`;
  }

  private async notesCreate(ctx: DeviceToolContext, title: string, body: string, folder: string | null) {
    if (!title.trim()) return "Give the note a title.";
    const t = this.admitApp(ctx, "notes", "notes.write");
    const args = {
      folder: folder ? folder.slice(0, 200) : null,
      title: title.trim().slice(0, 500),
      body: body.slice(0, 50000),
    };
    const lines = [
      { label: "Folder", value: args.folder ?? "Notes (default)" },
      { label: "Title", value: args.title },
      { label: "Text", value: args.body.slice(0, 600) + (args.body.length > 600 ? "…" : "") },
    ];
    return this.appWrite(
      ctx,
      t,
      "notes.write",
      "notes.create",
      args,
      `New note “${args.title}”`,
      lines,
      () => `Created the note “${args.title}” in Notes on ${t.device.name}.`,
    );
  }

  private async mailSearch(ctx: DeviceToolContext, query: string, mailbox: string) {
    if (!query.trim()) return "Give a subject or sender to search for.";
    const box = mailbox === "sent" || mailbox === "drafts" ? mailbox : "inbox";
    const t = this.admitApp(ctx, "mail", "mail.read");
    const r = await this.appRead(ctx, t, "mail.read", "mail.search", {
      query: query.trim().slice(0, 200),
      limit: 20,
      mailbox: box,
    });
    if (!r.ok) return r.text;
    const msgs = r.result.messages as {
      id: string;
      subject: string;
      sender: string;
      date: number;
      account: string;
      read: boolean;
    }[];
    this.d.activity(ctx.agentId, `Searched Mail (${box}) on ${t.device.name}`);
    if (!msgs.length)
      return `No recent ${box} messages match “${query}” in Mail on ${t.device.name} (only recent messages are searched).`;
    return `Mail ${box} on ${t.device.name} matching “${query}” (recent messages only):\n${msgs
      .map(
        (m) =>
          `- ${fmtWhen(m.date, this.tz())} · ${m.sender} · ${m.subject}${m.read ? "" : " · unread"} · ${m.account} · id ${m.id}`,
      )
      .join("\n")}`;
  }

  private async mailRead(ctx: DeviceToolContext, id: string) {
    if (!id) return "Give the message id (from mac_mail_search).";
    const t = this.admitApp(ctx, "mail", "mail.read");
    const r = await this.appRead(ctx, t, "mail.read", "mail.read", { id });
    if (!r.ok) return r.text;
    const m = r.result as {
      subject: string;
      sender: string;
      to: string[];
      cc: string[];
      date: number;
      content: string;
      truncated: boolean;
    };
    this.d.activity(ctx.agentId, `Read the email “${m.subject.slice(0, 60)}” on ${t.device.name}`);
    return `From: ${m.sender}\nTo: ${m.to.join(", ")}${m.cc.length ? `\nCc: ${m.cc.join(", ")}` : ""}\nDate: ${fmtWhen(m.date, this.tz())}\nSubject: ${m.subject}${m.truncated ? "\n(truncated)" : ""}\n\n${m.content}`;
  }

  private async mailDraft(ctx: DeviceToolContext, a: Record<string, unknown>) {
    const to = strList(a.to) ?? [];
    const cc = strList(a.cc) ?? [];
    const subject = typeof a.subject === "string" ? a.subject.slice(0, 500) : "";
    const body = typeof a.body === "string" ? a.body.slice(0, 50000) : "";
    const bad = [...to, ...cc].find((e) => !/^[^\s@]+@[^\s@]+$/.test(e));
    if (!to.length) return "Give at least one recipient email address.";
    if (bad) return `“${bad}” isn't an email address. Look it up (mac_contacts_search) or ask the user.`;
    const t = this.admitApp(ctx, "mail", "mail.draft");
    const args = { to: to.slice(0, 20), cc: cc.slice(0, 20), subject, body };
    const lines = [
      { label: "To", value: args.to.join(", ") },
      ...(args.cc.length ? [{ label: "Cc", value: args.cc.join(", ") }] : []),
      { label: "Subject", value: args.subject || "(no subject)" },
      { label: "Body", value: args.body.slice(0, 800) + (args.body.length > 800 ? "…" : "") },
      { label: "Sending", value: "Not sent: it's saved as a draft for you to review and send in Mail" },
    ];
    return this.appWrite(
      ctx,
      t,
      "mail.draft",
      "mail.createDraft",
      args,
      `Draft “${args.subject || "(no subject)"}”`,
      lines,
      () =>
        `Saved a draft “${args.subject}” to ${args.to.join(", ")} in Mail on ${t.device.name}. It was NOT sent; the user reviews and sends it from Mail.`,
    );
  }

  /* ------------------------------ window sessions (R3) ------------------------------ */

  /** One active session per agent: which Mac, which window, until when, and whether it may click/type. */
  private sessions = new Map<
    string,
    {
      deviceId: string;
      leaseId: string;
      windowId: number;
      title: string;
      app: string;
      control: boolean;
      expiresAt: number;
    }
  >();

  private admitScreen(ctx: DeviceToolContext, control: boolean): Target {
    if (!this.d.settings().macControl)
      throw new Refusal(
        "disabled",
        "Using windows on the Mac is turned off in Yo's settings (Devices & access → Window control).",
      );
    const t = this.admitApp(ctx, "screen", control ? "window.control" : "window.observe");
    if (control && t.grant.mode !== "read-write")
      throw new Refusal(
        "grant-read-only",
        "On this Mac Yo may only look at windows, not click or type.",
        t.device.id,
      );
    return t;
  }

  private async windowsList(ctx: DeviceToolContext) {
    const t = this.admitScreen(ctx, false);
    const r = await this.appRead(ctx, t, "window.observe", "windows.list", {});
    if (!r.ok) return r.text;
    const wins = r.result.windows as { windowId: number; appName: string; bundleId: string; title: string }[];
    if (!wins.length) return `No usable windows are open on ${t.device.name}.`;
    return `Windows on ${t.device.name} (front to back):\n${wins
      .slice(0, 40)
      .map((w) => `- [${w.windowId}] ${w.appName}${w.title ? ` — ${w.title}` : ""}`)
      .join("\n")}\nAsk for one with mac_window_session.`;
  }

  private async windowSession(ctx: DeviceToolContext, a: Record<string, unknown>) {
    const windowId = Math.trunc(Number(a.window_id));
    const purpose = typeof a.purpose === "string" ? a.purpose.trim().slice(0, 300) : "";
    const minutes = Math.min(30, Math.max(1, Math.trunc(Number(a.minutes ?? 10)) || 10));
    const control = a.control !== false;
    if (!Number.isFinite(windowId) || windowId < 1) return "Give a window_id from mac_windows.";
    if (!purpose) return "Say what you'll do in one sentence (the user sees it).";
    const t = this.admitScreen(ctx, control);
    const r = await this.appRead(ctx, t, "window.observe", "windows.list", {});
    if (!r.ok) return r.text;
    const w = (
      r.result.windows as { windowId: number; appName: string; bundleId: string; title: string }[]
    ).find((x) => x.windowId === windowId);
    if (!w) return "That window isn't available anymore (closed, or an app Yo never uses). List them again.";
    const args = {
      windowId,
      bundleId: w.bundleId,
      title: (w.title || w.appName).slice(0, 500),
      minutes,
      control,
    };
    const lines = [
      { label: "App", value: w.appName },
      { label: "Window", value: w.title || "(untitled)" },
      { label: "For", value: purpose },
      {
        label: "Allowed",
        value: control ? "See, click and type in this window only" : "See this window only",
      },
      { label: "Time", value: `Up to ${minutes} min` },
      { label: "Stop", value: "Anytime: Stop in the banner or menu bar, or ⌃⌥⌘ ." },
    ];
    const prev = this.sessions.get(ctx.agentId);
    if (prev) await this.windowEnd(ctx, "replaced by a new session");
    return this.appWrite(
      ctx,
      t,
      "window.control",
      "window.session",
      args,
      `Use “${w.appName}” window`,
      lines,
      (res) => {
        this.sessions.set(ctx.agentId, {
          deviceId: t.device.id,
          leaseId: String(res?.leaseId ?? ""),
          windowId,
          title: args.title,
          app: w.appName,
          control,
          expiresAt: Number(res?.expiresAt ?? Date.now() + minutes * 60_000),
        });
        return `You may ${control ? "see and use" : "see"} “${w.appName} — ${args.title}” for up to ${minutes} min. Start with mac_window_look. Leave final sends/purchases/deletes to the user, and call mac_window_end when done.`;
      },
    );
  }

  private activeSession(ctx: DeviceToolContext) {
    const sess = this.sessions.get(ctx.agentId);
    if (!sess) return null;
    if (sess.expiresAt <= Date.now()) {
      this.sessions.delete(ctx.agentId);
      return null;
    }
    return sess;
  }

  /** The Mac ended a lease (user pressed Stop, expired, window closed): forget it. */
  leaseEnded(deviceId: string, leaseId: string, reason: string) {
    for (const [agentId, sess] of this.sessions)
      if (sess.deviceId === deviceId && sess.leaseId === leaseId) {
        this.sessions.delete(agentId);
        this.d.activity(agentId, `Window session ended on the Mac (${reason})`);
      }
  }

  private async windowLook(ctx: DeviceToolContext) {
    const sess = this.activeSession(ctx);
    if (!sess)
      return "No window session is active (it ended or the user stopped it). Ask again with mac_window_session if needed.";
    const t = this.admitScreen(ctx, false);
    const r = await this.appRead(ctx, t, "window.observe", "window.capture", {
      windowId: sess.windowId,
      maxWidth: 1600,
    });
    if (!r.ok) return this.windowError(ctx, r.text);
    const shot = r.result as { pngBase64: string; width: number; height: number };
    const saved = await this.d.saveToComputer(
      ctx.agentId,
      `mac-window-${Date.now()}.png`,
      Buffer.from(shot.pngBase64, "base64"),
    );
    return `Screenshot of “${sess.app} — ${sess.title}” saved at ${saved} (${shot.width}×${shot.height}). Open it to see the window. Click positions are fractions of this image (0–1).`;
  }

  private async windowInput(
    ctx: DeviceToolContext,
    command: "window.click" | "window.type" | "window.key" | "window.scroll",
    extra: Record<string, unknown>,
  ) {
    const sess = this.activeSession(ctx);
    if (!sess) return "No window session is active (it ended or the user stopped it).";
    if (!sess.control)
      return "This session is look-only. Ask for a new session with control if you need to click or type.";
    const t = this.admitScreen(ctx, true);
    if (t.device.id !== sess.deviceId) return "The session's Mac isn't available.";
    const r = await this.appRead(ctx, t, "window.control", command, { windowId: sess.windowId, ...extra });
    if (!r.ok) return this.windowError(ctx, r.text);
    return "Done. Take another look (mac_window_look) to check the result.";
  }

  private windowError(ctx: DeviceToolContext, text: string) {
    return text;
  }

  private async windowEnd(ctx: DeviceToolContext, reason: string) {
    const sess = this.sessions.get(ctx.agentId);
    if (!sess) return "No window session was active.";
    this.sessions.delete(ctx.agentId);
    try {
      const t = this.admitScreen(ctx, false);
      await this.appRead(ctx, t, "window.observe", "window.end", { leaseId: sess.leaseId });
    } catch {
      // The Mac also expires leases on its own.
    }
    this.d.activity(ctx.agentId, `Window session ended (${reason})`);
    return "Window session ended.";
  }

  private trimSeen() {
    while (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value!);
  }

  /* ------------------------------ reconciliation ---------------------------- */

  /** After a restart: approvals that were waiting are gone; dispatches in flight become unknown. */
  recoverAfterRestart() {
    for (const op of this.d.store.listOperations({ statuses: ["awaiting-approval"], limit: 500 }))
      this.update(
        this.d.store.transition(op.id, ["awaiting-approval"], "expired", { reason: "Yo restarted" }),
      );
    for (const op of this.d.store.listOperations({ statuses: ["authorized"], limit: 500 }))
      this.update(
        this.d.store.transition(op.id, ["authorized"], "cancelled", {
          reason: "Yo restarted before sending",
        }),
      );
    for (const op of this.d.store.listOperations({ statuses: ["dispatching"], limit: 500 })) {
      if (op.capability === "files.write")
        this.update(
          this.d.store.transition(op.id, ["dispatching"], "unknown-outcome", { reason: "Yo restarted" }),
        );
      else this.update(this.d.store.transition(op.id, ["dispatching"], "failed", { reason: "Yo restarted" }));
    }
  }

  /** Resolve writes whose outcome is unknown, using the device journal and a read-back. Never resends. */
  async reconcile(deviceId: string) {
    if (!this.d.devices.isOnline(deviceId)) return;
    for (const op of this.d.store.listOperations({ statuses: ["unknown-outcome"], limit: 100 })) {
      if (op.deviceId !== deviceId) continue;
      if (op.capability !== "files.write") {
        await this.reconcileAppWrite(deviceId, op).catch((err) => log.warn(`reconcile ${op.id} failed`, err));
        continue;
      }
      try {
        if (op.commandId) {
          const st = await this.d.devices.queryStatus(deviceId, op.commandId);
          if (st.state === "done") {
            const sha = (st.result as { sha256?: string } | undefined)?.sha256;
            if (st.ok && sha && sha === op.sha256) {
              this.update(
                this.d.store.transition(op.id, ["unknown-outcome"], "succeeded", {
                  reason: "confirmed by the Mac",
                }),
              );
              continue;
            }
            if (!st.ok) {
              this.update(
                this.d.store.transition(op.id, ["unknown-outcome"], "failed", {
                  reason: st.error?.code ?? "failed",
                }),
              );
              continue;
            }
          }
          if (st.state === "unknown") {
            this.update(
              this.d.store.transition(op.id, ["unknown-outcome"], "failed", {
                reason: "never reached the Mac",
              }),
            );
            continue;
          }
        }
        // Started but no result recorded: read the file back.
        const grant = this.d.store.getGrant(op.grantId);
        if (!grant || grant.revokedAt) continue;
        const reply = await this.d.devices.command(
          deviceId,
          {
            type: "command",
            commandId: newId("cmd"),
            operationId: op.id,
            command: "files.stat",
            grantId: grant.id,
            grantRevision: grant.revision,
            args: { relPath: op.relPath },
            argsDigest: sha256Hex(canonicalJson({ relPath: op.relPath })),
            receipt: null,
            expiresAt: Date.now() + READ_TIMEOUT_MS,
          },
          READ_TIMEOUT_MS,
        );
        const sha = reply.ok ? (reply.result as { sha256: string | null }).sha256 : null;
        if (sha && sha === op.sha256)
          this.update(
            this.d.store.transition(op.id, ["unknown-outcome"], "succeeded", {
              reason: "verified by reading it back",
            }),
          );
        else if (
          (sha ?? null) === op.expectedSha256 ||
          (!reply.ok && reply.error?.code === "not_found" && op.expectedSha256 == null)
        )
          this.update(
            this.d.store.transition(op.id, ["unknown-outcome"], "failed", { reason: "not written" }),
          );
        else
          this.update(
            this.d.store.transition(op.id, ["unknown-outcome"], "unknown-outcome", {
              reason: "file changed by something else; check it",
            }),
          );
      } catch (err) {
        log.warn(`reconcile ${op.id} failed`, err);
      }
    }
  }

  /** App changes can't be read back generically: trust the Mac's journal, otherwise leave it for the user. */
  private async reconcileAppWrite(deviceId: string, op: OperationRecord) {
    if (!op.commandId) return;
    const st = await this.d.devices.queryStatus(deviceId, op.commandId);
    if (st.state === "done")
      this.update(
        this.d.store.transition(op.id, ["unknown-outcome"], st.ok ? "succeeded" : "failed", {
          reason: st.ok ? "confirmed by the Mac" : (st.error?.code ?? "failed"),
        }),
      );
    else if (st.state === "unknown")
      this.update(
        this.d.store.transition(op.id, ["unknown-outcome"], "failed", { reason: "never reached the Mac" }),
      );
    else
      this.update(
        this.d.store.transition(op.id, ["unknown-outcome"], "unknown-outcome", {
          reason: "check it in the app",
        }),
      );
  }

  private update(op: OperationRecord | null): OperationRecord | null {
    if (op) this.d.onOperation(stripOp(op));
    return op;
  }
}

/* --------------------------------- helpers --------------------------------- */

export function writeDigest(
  deviceId: string,
  grantId: string,
  grantRevision: number,
  a: { relPath: string; sha256: string; size: number; expectedSha256: string | null },
): string {
  return sha256Hex(writeDigestInput(deviceId, grantId, grantRevision, a));
}

/** Core-side pre-check of a relative path (the device re-validates natively, component by component). */
export function normalizeRelPath(
  input: string,
  grant: Pick<DeviceGrant, "kind" | "name" | "displayPath">,
): string {
  let p = input.trim().replace(/^\.\/+/, "");
  const prefix = grant.displayPath.replace(/\/$/, "");
  if (p === prefix || p.startsWith(`${prefix}/`)) p = p.slice(prefix.length).replace(/^\/+/, "");
  if (grant.kind === "file") {
    if (p === "" || p === grant.name) return "";
    throw new Refusal("needs-grant", `Only the file ${grant.displayPath} is shared, not “${input}”.`);
  }
  if (p === "" || p === ".") return "";
  if (p.includes("\0") || p.startsWith("/") || p.startsWith("~"))
    throw new Refusal(
      "needs-grant",
      `Use a path inside the shared folder ${grant.displayPath}, not “${input}”.`,
    );
  const parts = p.split("/").filter((c, i, all) => !(c === "" && i === all.length - 1));
  if (parts.some((c) => c === "" || c === "." || c === ".."))
    throw new Refusal("needs-grant", `“${input}” leaves the shared folder ${grant.displayPath}.`);
  return parts.join("/");
}

function stripOp(op: OperationRecord): DeviceOperation {
  const { relPath: _r, argsDigest: _a, commandId: _c, expectedSha256: _e, ...view } = op;
  return view;
}

function looksLikeText(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.length < buf.length ? trimPartialUtf8(head) : head);
    return true;
  } catch {
    return false;
  }
}

function trimPartialUtf8(b: Buffer): Buffer {
  const end = b.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const c = b[end - i]!;
    if ((c & 0xc0) === 0xc0) return b.subarray(0, end - i);
    if ((c & 0x80) === 0) break;
  }
  return b;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ERROR_TEXT: Record<string, string> = {
  not_found: "doesn't exist",
  protected: "is protected (keys, credentials and app data are never shared)",
  symlink: "is a link; Yo doesn't follow links out of shared folders",
  hardlink: "has multiple hard links, so Yo won't touch it",
  too_large: "is too large",
  conflict: "changed since this was prepared, so nothing was written",
  exists: "already exists",
  not_a_directory: "isn't a folder",
  not_a_file: "isn't a regular file",
  stale_scope: "can't be found anymore (moved or deleted?) — the user may need to share it again",
  revoked: "is no longer shared",
  paused: "is paused by the user",
  expired: "took too long; nothing was done",
  denied: "was refused by the Mac",
};

function deviceErrorText(reply: CommandReply, displayPath: string): string {
  const code = reply.error?.code ?? "error";
  return `${displayPath} ${ERROR_TEXT[code] ?? `couldn't be accessed (${code})`}.`;
}

function errReason(err: unknown): string {
  if (err instanceof DeviceOfflineError) return "offline";
  if (err instanceof DeviceTimeoutError) return "timeout";
  if (err instanceof DeviceDisconnectedError) return "disconnected";
  return "error";
}

function friendly(err: unknown): string {
  if (err instanceof DeviceOfflineError) return "it's offline";
  if (err instanceof DeviceTimeoutError) return "it didn't answer in time";
  if (err instanceof DeviceDisconnectedError) return "the connection dropped";
  return String((err as Error)?.message ?? err);
}

const APP_LABEL: Record<DeviceApp, string> = {
  contacts: "Contacts",
  calendar: "Calendar",
  reminders: "Reminders",
  notes: "Notes",
  mail: "Mail",
  screen: "Window control",
};

/** Capabilities that change data (need read-and-change + the approved-changes switch). */
const WRITE_CAPS = new Set<DeviceCapability>([
  "files.write",
  "calendar.write",
  "reminders.write",
  "notes.write",
  "mail.draft",
]);

function strList(v: unknown): string[] | null {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 50)
    : null;
}

const APP_ERRORS: Record<string, string> = {
  permission:
    "isn't allowed for Yo in macOS (System Settings → Privacy & Security); the user can turn it on there",
  read_only: "is read-only, so nothing was changed",
  not_found: "doesn't have that item anymore",
  conflict: "changed since you looked, so nothing was changed; look it up again",
  revoked: "is no longer shared with Yo",
  paused: "is paused by the user",
  denied: "refused the change",
  expired: "took too long; nothing was done",
  secure_input: "is asking for a password or other secure input, so Yo stopped. Let the user handle it",
  user_active: "is being used by the user right now, so Yo waited. Try again in a moment",
  not_frontmost: "couldn't be brought to the front (something is covering it), so nothing was clicked",
  no_session: "has no active window session (the user may have pressed Stop)",
};

function appErrorText(reply: CommandReply, label: string): string {
  const code = reply.error?.code ?? "error";
  return `${label} ${APP_ERRORS[code] ?? `couldn't be used (${code})`}.`;
}

/** Offset of `tz` from UTC at instant `utcMs`, in ms. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs
  );
}

/** ISO 8601 with offset; a plain date (all-day) or a time without offset is read in the user's time zone. */
export function parseWhen(s: string, tz: string): { ms: number; dateOnly: boolean } | null {
  const v = s.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (local) {
    const [, y, mo, d, h = "0", mi = "0", se = "0"] = local;
    const guess = Date.UTC(+y!, +mo! - 1, +d!, +h, +mi, +se);
    let ms = guess - tzOffsetMs(guess, tz);
    ms = guess - tzOffsetMs(ms, tz); // settle across DST edges
    return { ms, dateOnly: !local[4] };
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? { ms, dateOnly: false } : null;
}

function fmtWhen(ms: number, tz: string) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function fmtTime(ms: number, tz: string) {
  return new Date(ms).toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}
function fmtDate(ms: number, tz: string) {
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
