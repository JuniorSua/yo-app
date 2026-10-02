/**
 * Bridge to the Electron preload (apps/desktop). The preload exposes `window.yoDesktop`; in a plain
 * browser everything falls back gracefully.
 */
import type { DeviceApp, DeviceGrant, GrantMode, OsPermissionState } from "@yo/contracts";
import type { YoUpdatesBridge } from "./updates";

/** Mirrors `DeviceStatusView` in apps/desktop/src/device/DeviceService.ts. */
export interface DeviceStatusView {
  supported: boolean;
  signedIn: boolean;
  needsEnrollment: boolean;
  paired: boolean;
  deviceId: string | null;
  deviceName: string;
  connected: boolean;
  paused: boolean;
  helper: { available: boolean; version: string | null };
  grants: DeviceGrant[];
  permissions: Record<string, OsPermissionState>;
  /** Active window session (R3); absent in desktop builds before window control. */
  lease?: WindowLease | null;
}

/** One approved window Yo may look at (and, with `control`, click and type in) until `expiresAt`. */
export interface WindowLease {
  leaseId: string;
  windowId: number;
  title: string;
  control: boolean;
  expiresAt: number;
}

/** Memory of Yo's own processes on this Mac (MiB), from Electron's app metrics. */
export interface DeviceMetrics {
  at: number;
  procs: { type: string; name: string | null; memMB: number; cpu: number }[];
  totalMB: number;
}

/**
 * "Yo on this Mac" (preload `device`). Every call only asks: pairing and widening access open native
 * dialogs owned by the main process, and folders come from the native picker.
 */
export interface YoDeviceBridge {
  status(): Promise<DeviceStatusView>;
  pair(): Promise<DeviceStatusView>;
  unpair(): Promise<DeviceStatusView>;
  chooseFolder(mode: GrantMode): Promise<DeviceStatusView>;
  setMode(grantId: string, mode: GrantMode): Promise<DeviceStatusView>;
  revoke(grantId: string): Promise<DeviceStatusView>;
  setPaused(paused: boolean): Promise<DeviceStatusView>;
  metrics(): Promise<DeviceMetrics>;
  /**
   * Share an app (Contacts, Calendar, Reminders, Notes, Mail) or allow window sessions ("screen": read =
   * look only, read-write = look + click/type). macOS asks first; Yo's grant is created only when
   * `osStatus` comes back "granted" or "limited". For "screen", "needs-settings" means the user has to turn
   * Yo on in System Settings (Screen Recording, and Accessibility to click/type) and click Allow again.
   */
  allowApp(app: DeviceApp, mode: GrantMode): Promise<DeviceStatusView & { osStatus: string }>;
  /** Open System Settings at the app's Privacy & Security pane. */
  openPrivacy(app: DeviceApp): Promise<void>;
  /** End the active window session right now (absent in desktop builds before window control). */
  stopLease?(): Promise<void>;
  /** Fires when pairing, connection, pause or grants change. Returns an unsubscribe function. */
  onChanged(cb: () => void): () => void;
}

export interface YoDesktopBridge {
  platform: "darwin" | "win32" | "linux" | string;
  notify(title: string, body: string, agentId?: string | null): void;
  openExternal(url: string): void;
  /** Deep links from native notifications / tray, e.g. { agentId } or { page: "approvals" }. */
  onNavigate(cb: (target: { agentId?: string; page?: string }) => void): () => void;
  /** Present in desktop builds with device support. */
  device?: YoDeviceBridge;
  /** Present in desktop builds with the updater (see lib/updates.ts). */
  updates?: YoUpdatesBridge;
}

declare global {
  interface Window {
    yoDesktop?: YoDesktopBridge;
  }
}

export const desktop = typeof window !== "undefined" ? window.yoDesktop : undefined;
export const isDesktop = !!desktop;
/** Leave room for the macOS traffic lights in a frameless window. */
export const hasTrafficLights = desktop?.platform === "darwin";

/** The device bridge, read lazily (the mock backend can install one with `?mockDesktop=1`). */
export function deviceBridge(): YoDeviceBridge | undefined {
  return typeof window !== "undefined" ? window.yoDesktop?.device : undefined;
}

export function openExternal(url: string) {
  if (desktop) desktop.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

export function nativeNotify(title: string, body: string, agentId?: string | null) {
  if (desktop) {
    desktop.notify(title, body, agentId ?? null);
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
    try {
      new Notification(title, { body });
    } catch {
      /* ignore */
    }
  }
}
