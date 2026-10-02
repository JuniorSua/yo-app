/**
 * Paired personal devices (the user's Mac) and the bounded commands Yo may run on them.
 *
 * Trust model:
 *  - The agent computer (providers, shell, browser) never talks to a device. It can only *ask* core
 *    through Yo tools; core checks grants and the user's approvals, then sends a fixed command.
 *  - The device (Electron main + the native YoDeviceBridge helper) re-checks its own local grants and
 *    verifies core's signed approval receipt before any write. Grants are created on the device itself,
 *    from a native picker, so a web page or the model can't mint one.
 *
 * Every wire message is parsed with these strict schemas; unknown fields are rejected, not ignored.
 */
import { z } from "zod";

export const DEVICE_PROTOCOL_VERSION = 1;

/** Largest file Yo moves between the Mac and the agent computer in one operation. */
export const DEVICE_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Largest text returned straight to the model from a Mac file. */
export const DEVICE_MAX_INLINE_TEXT_BYTES = 256 * 1024;

export const DeviceIdSchema = z.string().regex(/^dev_[A-Za-z0-9_-]{8,64}$/);
export const GrantIdSchema = z.string().regex(/^grt_[A-Za-z0-9_-]{8,64}$/);

/** OS permission state as the device observed it. Only the device can report "granted". */
export const OsPermissionState = z.enum([
  "not-requested",
  "granted",
  "denied",
  "restricted",
  "limited",
  "write-only",
  "unknown",
  "unsupported",
]);
export type OsPermissionState = z.infer<typeof OsPermissionState>;

export const DeviceCapability = z.enum([
  "files.list",
  "files.read",
  "files.write",
  "contacts.read",
  "calendar.read",
  "calendar.write",
  "reminders.read",
  "reminders.write",
  "notes.read",
  "notes.write",
  "mail.read",
  "mail.draft",
  "window.observe",
  "window.control",
]);
export type DeviceCapability = z.infer<typeof DeviceCapability>;

export const GrantMode = z.enum(["read", "read-write"]);
export type GrantMode = z.infer<typeof GrantMode>;

/** Mac apps whose data Yo reads through the OS frameworks (R2). */
/** "screen" = the user allowed window sessions on this Mac (read = look only, read-write = also click/type). */
export const DeviceApp = z.enum(["contacts", "calendar", "reminders", "notes", "mail", "screen"]);
export type DeviceApp = z.infer<typeof DeviceApp>;

/** Access to one folder or file the user picked on the device, or to one app's data ("app"). */
export const DeviceGrant = z
  .object({
    id: GrantIdSchema,
    deviceId: DeviceIdSchema,
    kind: z.enum(["dir", "file", "app"]),
    /** For kind "app". */
    app: DeviceApp.optional(),
    /** Home-relative display path, e.g. "~/Documents/Taxes". Never used to locate the file. */
    displayPath: z.string().max(1024),
    name: z.string().max(255),
    mode: GrantMode,
    /** null = until removed. */
    expiresAt: z.number().nullable(),
    revision: z.number().int().nonnegative(),
    createdAt: z.number(),
    revokedAt: z.number().nullable(),
  })
  .strict();
export type DeviceGrant = z.infer<typeof DeviceGrant>;

export const PairedDevice = z.object({
  id: DeviceIdSchema,
  name: z.string(),
  platform: z.literal("macos"),
  osVersion: z.string(),
  appVersion: z.string(),
  helperVersion: z.string().nullable(),
  pairedAt: z.number(),
  lastSeenAt: z.number().nullable(),
  online: z.boolean(),
  /** The user paused all Mac access from the device itself. */
  paused: z.boolean(),
  revokedAt: z.number().nullable(),
  capabilities: z.array(DeviceCapability),
  permissions: z.record(z.string(), OsPermissionState),
});
export type PairedDevice = z.infer<typeof PairedDevice>;

export const DeviceOperationStatus = z.enum([
  "awaiting-approval",
  "authorized",
  "dispatching",
  "succeeded",
  "failed",
  "denied",
  "expired",
  "cancelled",
  /** A write was sent but its result was lost; resolved by asking the device / reading the file back. */
  "unknown-outcome",
]);
export type DeviceOperationStatus = z.infer<typeof DeviceOperationStatus>;

export const DeviceOperation = z.object({
  id: z.string(),
  agentId: z.string(),
  turnId: z.string().nullable(),
  deviceId: z.string(),
  grantId: z.string(),
  capability: DeviceCapability,
  /** Display path of the target ("~/Documents/Taxes/2025.csv"). */
  displayPath: z.string(),
  status: DeviceOperationStatus,
  reason: z.string().nullable(),
  bytes: z.number().nullable(),
  sha256: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DeviceOperation = z.infer<typeof DeviceOperation>;

/** Why a step ran where it did. Stable codes; `summary` is the human sentence. */
export const RouteReason = z.enum([
  "dedicated-command",
  "agent-computer",
  "route-restricted",
  "needs-pairing",
  "needs-grant",
  "grant-read-only",
  "offline",
  "paused",
  "disabled",
  "needs-source-choice",
  "unsupported",
]);
export type RouteReason = z.infer<typeof RouteReason>;

export const RouteDecision = z.object({
  id: z.string(),
  agentId: z.string(),
  turnId: z.string().nullable(),
  target: z.enum(["agent-computer", "device"]),
  deviceId: z.string().nullable(),
  capability: z.string(),
  reason: RouteReason,
  summary: z.string(),
  createdAt: z.number(),
});
export type RouteDecision = z.infer<typeof RouteDecision>;

/** Per-message execution preference chosen in the composer. A preference, never a permission. */
export const RoutePreference = z.enum(["auto", "agent-computer"]);
export type RoutePreference = z.infer<typeof RoutePreference>;

/** Placement of the pieces, from config (never inferred from a localhost URL). */
export const Placement = z.enum(["this-mac", "home-pc", "custom-remote"]);
export type Placement = z.infer<typeof Placement>;

export const ExecutionStatus = z.object({
  corePlacement: Placement,
  runnerPlacement: Placement,
  /** Server-side kill switches (core enforces them; the device has its own local pause). */
  flags: z.object({ devices: z.boolean(), deviceWrites: z.boolean(), control: z.boolean().optional() }),
  devices: z.array(PairedDevice),
  grants: z.array(DeviceGrant),
});
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

/* ------------------------------ wire protocol ------------------------------ */

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Nonce = z.string().regex(/^[0-9a-f]{32,128}$/);
const B64 = z.string().regex(/^[A-Za-z0-9+/=]*$/);

/** Relative path inside a grant. The device re-validates every component natively. */
export const RelPath = z
  .string()
  .max(4096)
  .refine((p) => !p.includes("\0") && !p.startsWith("/"), "invalid path");

export const FilesListArgs = z
  .object({
    relPath: RelPath,
    limit: z.number().int().min(1).max(500),
    cursor: z.string().max(1024).nullable(),
  })
  .strict();
export const FilesReadArgs = z
  .object({ relPath: RelPath, maxBytes: z.number().int().min(1).max(DEVICE_MAX_FILE_BYTES) })
  .strict();
export const FilesStatArgs = z.object({ relPath: RelPath }).strict();
export const FilesWriteArgs = z
  .object({
    relPath: RelPath,
    dataBase64: B64,
    sha256: Hex64,
    size: z.number().int().min(0).max(DEVICE_MAX_FILE_BYTES),
    /** null = the file must not exist yet. */
    expectedSha256: Hex64.nullable(),
  })
  .strict();

/* App data (R2). Mirrors the native helper's methods; the device re-validates natively. */
const Ms = z.number().int().min(0).max(8.64e15);
const Str = (max: number) => z.string().max(max);
const Ids = z.array(Str(512)).max(200).nullable();

export const ContactsSearchArgs = z
  .object({ query: Str(200).min(1), limit: z.number().int().min(1).max(50) })
  .strict();
export const CalendarEventsArgs = z
  .object({ start: Ms, end: Ms, calendarIds: Ids, limit: z.number().int().min(1).max(500) })
  .strict();
export const CalendarCreateEventArgs = z
  .object({
    calendarId: Str(512),
    title: Str(500).min(1),
    start: Ms,
    end: Ms,
    allDay: z.boolean(),
    location: Str(500).nullable(),
    notes: Str(8000).nullable(),
    timeZone: Str(100).nullable(),
  })
  .strict();
export const CalendarUpdateEventArgs = z
  .object({
    id: Str(512),
    occurrenceDate: Ms.nullable(),
    expectedLastModified: Ms.nullable(),
    changes: z
      .object({
        title: Str(500).min(1).optional(),
        start: Ms.optional(),
        end: Ms.optional(),
        allDay: z.boolean().optional(),
        location: Str(500).nullable().optional(),
        notes: Str(8000).nullable().optional(),
      })
      .strict(),
  })
  .strict();
export const RemindersListArgs = z
  .object({ listIds: Ids, includeCompleted: z.boolean(), limit: z.number().int().min(1).max(500) })
  .strict();
export const RemindersCreateArgs = z
  .object({
    listId: Str(512),
    title: Str(500).min(1),
    due: Ms.nullable(),
    dueAllDay: z.boolean(),
    notes: Str(8000).nullable(),
  })
  .strict();
export const RemindersCompleteArgs = z.object({ id: Str(512), completed: z.boolean() }).strict();
export const NotesSearchArgs = z
  .object({ query: Str(200).min(1), limit: z.number().int().min(1).max(50) })
  .strict();
export const NotesReadArgs = z.object({ id: Str(512) }).strict();
export const NotesCreateArgs = z
  .object({ folder: Str(200).nullable(), title: Str(500).min(1), body: Str(50000) })
  .strict();
export const MailSearchArgs = z
  .object({
    query: Str(200).min(1),
    limit: z.number().int().min(1).max(50),
    mailbox: z.enum(["inbox", "sent", "drafts"]),
  })
  .strict();
export const MailReadArgs = z.object({ id: Str(512) }).strict();
const Email = Str(320).regex(/^[^\s@]+@[^\s@]+$/);
export const MailDraftArgs = z
  .object({
    to: z.array(Email).min(1).max(20),
    cc: z.array(Email).max(20),
    subject: Str(500),
    body: Str(50000),
  })
  .strict();

/* Selected-window control (R3). x/y are fractions of the window (0..1). */
export const WindowSessionArgs = z
  .object({
    windowId: z.number().int().min(1),
    bundleId: Str(255),
    title: Str(500),
    minutes: z.number().int().min(1).max(30),
    control: z.boolean(),
  })
  .strict();
export const WindowCaptureArgs = z
  .object({ windowId: z.number().int().min(1), maxWidth: z.number().int().min(320).max(2560) })
  .strict();
export const WindowClickArgs = z
  .object({
    windowId: z.number().int().min(1),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    button: z.enum(["left", "right"]),
    count: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();
export const WindowTypeArgs = z.object({ windowId: z.number().int().min(1), text: Str(500).min(1) }).strict();
export const WindowKeyArgs = z
  .object({
    windowId: z.number().int().min(1),
    key: Str(20),
    modifiers: z.array(z.enum(["cmd", "shift", "option", "control"])).max(3),
  })
  .strict();
export const WindowScrollArgs = z
  .object({
    windowId: z.number().int().min(1),
    dx: z.number().int().min(-2000).max(2000),
    dy: z.number().int().min(-2000).max(2000),
  })
  .strict();

/** Window commands and what they need (all also need an active, matching session lease on the Mac). */
export const WINDOW_COMMANDS: Record<string, { control: boolean; args: z.ZodTypeAny }> = {
  "window.capture": { control: false, args: WindowCaptureArgs },
  "window.click": { control: true, args: WindowClickArgs },
  "window.type": { control: true, args: WindowTypeArgs },
  "window.key": { control: true, args: WindowKeyArgs },
  "window.scroll": { control: true, args: WindowScrollArgs },
};

export const NoArgs = z.object({}).strict();
export const WindowEndArgs = z.object({ leaseId: z.string().max(128) }).strict();

export const DeviceCommandName = z.enum([
  "files.list",
  "files.read",
  "files.stat",
  "files.write",
  "contacts.search",
  "calendar.calendars",
  "calendar.events",
  "calendar.createEvent",
  "calendar.updateEvent",
  "reminders.lists",
  "reminders.list",
  "reminders.create",
  "reminders.complete",
  "notes.search",
  "notes.read",
  "notes.create",
  "mail.search",
  "mail.read",
  "mail.createDraft",
  "windows.list",
  "window.session",
  "window.end",
  "window.capture",
  "window.click",
  "window.type",
  "window.key",
  "window.scroll",
]);
export type DeviceCommandName = z.infer<typeof DeviceCommandName>;

/** What each app command needs: which app grant, whether it changes data (→ exact approval + receipt). */
export const APP_COMMANDS: Record<string, { app: DeviceApp; write: boolean; args: z.ZodTypeAny }> = {
  "contacts.search": { app: "contacts", write: false, args: ContactsSearchArgs },
  "calendar.calendars": { app: "calendar", write: false, args: NoArgs },
  "calendar.events": { app: "calendar", write: false, args: CalendarEventsArgs },
  "calendar.createEvent": { app: "calendar", write: true, args: CalendarCreateEventArgs },
  "calendar.updateEvent": { app: "calendar", write: true, args: CalendarUpdateEventArgs },
  "reminders.lists": { app: "reminders", write: false, args: NoArgs },
  "reminders.list": { app: "reminders", write: false, args: RemindersListArgs },
  "reminders.create": { app: "reminders", write: true, args: RemindersCreateArgs },
  "reminders.complete": { app: "reminders", write: true, args: RemindersCompleteArgs },
  "notes.search": { app: "notes", write: false, args: NotesSearchArgs },
  "notes.read": { app: "notes", write: false, args: NotesReadArgs },
  "notes.create": { app: "notes", write: true, args: NotesCreateArgs },
  "mail.search": { app: "mail", write: false, args: MailSearchArgs },
  "mail.read": { app: "mail", write: false, args: MailReadArgs },
  "mail.createDraft": { app: "mail", write: true, args: MailDraftArgs },
};

/** Commands that change data and therefore need core's signed approval receipt. */
export const RECEIPT_COMMANDS = [
  "files.write",
  "calendar.createEvent",
  "calendar.updateEvent",
  "reminders.create",
  "reminders.complete",
  "notes.create",
  "mail.createDraft",
  "window.session",
] as const;

/** Core's signed approval for exactly one write. */
export const ApprovalReceipt = z
  .object({
    operationId: z.string().max(128),
    deviceId: DeviceIdSchema,
    grantId: GrantIdSchema,
    grantRevision: z.number().int().nonnegative(),
    command: z.enum(RECEIPT_COMMANDS),
    argsDigest: Hex64,
    expiresAt: z.number(),
    signature: B64,
  })
  .strict();
export type ApprovalReceipt = z.infer<typeof ApprovalReceipt>;

export const CoreToDevice = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("challenge"),
      protocol: z.literal(DEVICE_PROTOCOL_VERSION),
      nonce: Nonce,
      coreId: z.string().max(128),
      /** Core's signature over the device's clientNonce + nonce, checked against the key pinned at pairing. */
      coreSignature: B64,
    })
    .strict(),
  z.object({ type: z.literal("welcome"), revokedGrantIds: z.array(GrantIdSchema).max(10_000) }).strict(),
  z
    .object({
      type: z.literal("command"),
      commandId: z.string().max(128),
      operationId: z.string().max(128),
      command: DeviceCommandName,
      grantId: GrantIdSchema,
      grantRevision: z.number().int().nonnegative(),
      args: z.unknown(),
      argsDigest: Hex64,
      receipt: ApprovalReceipt.nullable(),
      expiresAt: z.number(),
    })
    .strict(),
  z.object({ type: z.literal("status.query"), commandId: z.string().max(128) }).strict(),
  z.object({ type: z.literal("revoke"), grantId: GrantIdSchema }).strict(),
  z.object({ type: z.literal("unpaired") }).strict(),
]);
export type CoreToDevice = z.infer<typeof CoreToDevice>;

export const DeviceError = z.object({ code: z.string().max(64), message: z.string().max(500) }).strict();
export type DeviceError = z.infer<typeof DeviceError>;

export const DeviceToCore = z.discriminatedUnion("type", [
  z.object({ type: z.literal("init"), deviceId: DeviceIdSchema, clientNonce: Nonce }).strict(),
  z
    .object({
      type: z.literal("hello"),
      protocol: z.literal(DEVICE_PROTOCOL_VERSION),
      deviceId: DeviceIdSchema,
      signature: B64,
      appVersion: z.string().max(64),
      helperVersion: z.string().max(64).nullable(),
      osVersion: z.string().max(128),
      capabilities: z.array(DeviceCapability).max(16),
      permissions: z.record(z.string().max(64), OsPermissionState),
      paused: z.boolean(),
    })
    .strict(),
  z.object({ type: z.literal("grants"), grants: z.array(DeviceGrant).max(1000) }).strict(),
  /** The Mac ended a window-control session (user pressed Stop, it expired, the window went away…). */
  z
    .object({
      type: z.literal("lease.ended"),
      leaseId: z.string().max(128),
      reason: z.string().max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("state"),
      paused: z.boolean(),
      permissions: z.record(z.string().max(64), OsPermissionState),
    })
    .strict(),
  z
    .object({
      type: z.literal("result"),
      commandId: z.string().max(128),
      ok: z.boolean(),
      result: z.unknown().optional(),
      error: DeviceError.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("status"),
      commandId: z.string().max(128),
      state: z.enum(["unknown", "started", "done"]),
      ok: z.boolean().optional(),
      result: z.unknown().optional(),
      error: DeviceError.optional(),
    })
    .strict(),
]);
export type DeviceToCore = z.infer<typeof DeviceToCore>;

/* --------------------------- signed message bodies --------------------------- */
// Domain-separated strings that core and device sign/verify. Keep in one place so both sides agree.

export const signedText = {
  coreHello: (clientNonce: string, nonce: string, deviceId: string) =>
    `yo-core-hello\n${clientNonce}\n${nonce}\n${deviceId}`,
  deviceHello: (nonce: string, clientNonce: string, deviceId: string) =>
    `yo-device-hello\n${nonce}\n${clientNonce}\n${deviceId}`,
  pairing: (challenge: string, deviceId: string, publicKey: string) =>
    `yo-device-pair\n${challenge}\n${deviceId}\n${publicKey}`,
  controllerSession: (nonce: string, controllerId: string) =>
    `yo-controller-session\n${nonce}\n${controllerId}`,
  approval: (r: Omit<ApprovalReceipt, "signature">) =>
    [
      "yo-approval",
      r.operationId,
      r.deviceId,
      r.grantId,
      String(r.grantRevision),
      r.command,
      r.argsDigest,
      String(r.expiresAt),
    ].join("\n"),
};

/**
 * The exact thing a write approval covers (hashed with SHA-256 by both sides). The file bytes are bound
 * through their sha256 + size; the device hashes the received data and compares.
 */
export function writeDigestInput(
  deviceId: string,
  grantId: string,
  grantRevision: number,
  a: { relPath: string; sha256: string; size: number; expectedSha256: string | null },
): string {
  return canonicalJson({
    op: "files.write",
    deviceId,
    grantId,
    grantRevision,
    relPath: a.relPath,
    sha256: a.sha256,
    size: a.size,
    expectedSha256: a.expectedSha256,
  });
}

/** What an approval for an app-data change covers: the exact command and arguments. */
export function appWriteDigestInput(
  deviceId: string,
  grantId: string,
  grantRevision: number,
  command: string,
  args: unknown,
): string {
  return canonicalJson({ op: command, deviceId, grantId, grantRevision, args });
}

/** Canonical JSON (sorted keys, no whitespace) so both sides hash identical bytes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
