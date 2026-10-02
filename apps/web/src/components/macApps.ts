/**
 * Mac apps Yo can use through app grants: Calendar, Contacts and Reminders (R2), Notes and Mail (R4), and
 * window control (R3, the "screen" app). Shared by Settings → Devices & access, the Mac approval card and
 * recent activity.
 */
import type { DeviceApp, DeviceGrant, GrantMode, OsPermissionState } from "@yo/contracts";
import {
  AppWindow,
  Ban,
  BookUser,
  CalendarDays,
  Check,
  CircleDashed,
  CircleHelp,
  ListTodo,
  Lock,
  type LucideIcon,
  Mail,
  NotebookPen,
  PencilLine,
} from "lucide-react";

export interface MacAppInfo {
  app: DeviceApp;
  label: string;
  /** Name of the pane under System Settings → Privacy & Security. */
  pane: string;
  /**
   * Key in the device's `permissions` record, or null for apps Yo controls through Apple Events (Notes,
   * Mail): macOS reports no status for those and asks on first use (Privacy & Security → Automation).
   */
  permissionKey: string | null;
  icon: LucideIcon;
  purpose: string;
  /** Contacts are read only: there is no "read and change" for them. */
  canChange: boolean;
  /** How the "read-write" mode reads for this app ("Read and change", "Read and draft"). */
  changeLabel: string;
  /** Primary button on the approval card ("Save to Calendar", "Save draft"). */
  saveLabel: string;
}

const CHANGE = "Read and change";

/** The Apps group in Settings, in the order shown. */
export const MAC_APPS: MacAppInfo[] = [
  {
    app: "calendar",
    label: "Calendar",
    pane: "Calendars",
    permissionKey: "calendars",
    icon: CalendarDays,
    purpose: "Check events; add or change them with your OK",
    canChange: true,
    changeLabel: CHANGE,
    saveLabel: "Save to Calendar",
  },
  {
    app: "contacts",
    label: "Contacts",
    pane: "Contacts",
    permissionKey: "contacts",
    icon: BookUser,
    purpose: "Look up people",
    canChange: false,
    changeLabel: CHANGE,
    saveLabel: "Save to Contacts",
  },
  {
    app: "reminders",
    label: "Reminders",
    pane: "Reminders",
    permissionKey: "reminders",
    icon: ListTodo,
    purpose: "See, add and complete reminders",
    canChange: true,
    changeLabel: CHANGE,
    saveLabel: "Save to Reminders",
  },
  {
    app: "notes",
    label: "Notes",
    pane: "Automation",
    permissionKey: null,
    icon: NotebookPen,
    purpose: "Search and read notes; add new ones with your OK",
    canChange: true,
    changeLabel: CHANGE,
    saveLabel: "Save to Notes",
  },
  {
    app: "mail",
    label: "Mail",
    pane: "Automation",
    permissionKey: null,
    icon: Mail,
    purpose: "Search and read recent mail; prepare drafts with your OK — Yo never sends",
    canChange: true,
    changeLabel: "Read and draft",
    saveLabel: "Save draft",
  },
];

/** Window control (R3). Not a row in Apps: it has its own group in Settings. */
export const SCREEN_APP: MacAppInfo = {
  app: "screen",
  label: "Window control",
  pane: "Screen Recording",
  permissionKey: "screenRecording",
  icon: AppWindow,
  purpose: "Look at one window you approve, and click and type in it if you allow that",
  canChange: true,
  changeLabel: "Look and click",
  saveLabel: "Allow",
};

export function macApp(app: DeviceApp): MacAppInfo {
  return app === "screen" ? SCREEN_APP : MAC_APPS.find((a) => a.app === app)!;
}

/** "Read only" / "Read and change" / "Read and draft" (or "Look only" / "Look and click"). */
export function modeText(info: MacAppInfo, mode: GrantMode): string {
  if (info.app === "screen") return mode === "read" ? "Look only" : info.changeLabel;
  return mode === "read" ? "Read only" : info.changeLabel;
}

/** Mode choices for an app's select. */
export function modeOptions(info: MacAppInfo): { value: GrantMode; label: string }[] {
  return [
    { value: "read", label: modeText(info, "read") },
    { value: "read-write", label: modeText(info, "read-write") },
  ];
}

export const isAppGrant = (g: DeviceGrant) => g.kind === "app";

export interface OsView {
  text: string;
  icon: LucideIcon;
  tone: "success" | "warning" | "danger" | "muted";
  /** macOS stops Yo from using the app's data. */
  blocked: boolean;
}

/** What macOS currently allows, as words + an icon (never color alone). */
export function osPermissionView(state: OsPermissionState | undefined): OsView {
  switch (state) {
    case "granted":
      return { text: "macOS: allowed", icon: Check, tone: "success", blocked: false };
    case "limited":
      return { text: "macOS: limited access", icon: Check, tone: "success", blocked: false };
    case "write-only":
      return { text: "macOS: add only, can't read", icon: PencilLine, tone: "warning", blocked: false };
    case "not-requested":
      return { text: "macOS: not asked yet", icon: CircleDashed, tone: "muted", blocked: false };
    case "denied":
      return { text: "macOS: blocked", icon: Ban, tone: "danger", blocked: true };
    case "restricted":
      return { text: "macOS: restricted", icon: Lock, tone: "danger", blocked: true };
    case "unsupported":
      return { text: "macOS: not supported here", icon: CircleHelp, tone: "muted", blocked: false };
    default:
      return { text: "macOS: unknown", icon: CircleHelp, tone: "muted", blocked: false };
  }
}

/**
 * macOS status for one app. Notes and Mail have no status macOS reports: until they're shared macOS "asks
 * on first use"; once shared it said yes (Yo only shares after it does), unless the last answer was no.
 */
export function appOsView(
  info: MacAppInfo,
  permissions: Record<string, OsPermissionState> | undefined,
  shared: boolean,
  answered?: string | null,
): OsView {
  if (info.permissionKey) return osPermissionView(permissions?.[info.permissionKey]);
  if (answered === "denied" || answered === "restricted") return osPermissionView("denied");
  if (shared) return osPermissionView("granted");
  return { text: "macOS: asks on first use", icon: CircleDashed, tone: "muted", blocked: false };
}

/** One macOS setting window control needs ("Screen Recording: on"), as words + an icon. */
export function macSettingView(
  name: string,
  state: OsPermissionState | undefined,
): { text: string; icon: LucideIcon; tone: OsView["tone"]; on: boolean } {
  if (state === "granted") return { text: `${name}: on`, icon: Check, tone: "success", on: true };
  if (state === "denied" || state === "restricted")
    return { text: `${name}: blocked`, icon: Ban, tone: "danger", on: false };
  return { text: `${name}: off`, icon: CircleDashed, tone: "muted", on: false };
}

export const OS_TONE_CLASS = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-muted",
} as const;
