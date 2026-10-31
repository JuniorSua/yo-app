/**
 * Local state of "Yo on this Mac" from the desktop app's preload bridge (window.yoDesktop.device).
 * Separate from core's view (useApp().execution): this is what the Mac itself reports — pairing, the
 * connection to core, the local pause and the grants it enforces. Never persisted.
 */
import { create } from "zustand";
import { type DeviceStatusView, deviceBridge } from "../lib/desktop";

interface DeviceState {
  /** null until the first status() call answers (or when there is no bridge). */
  status: DeviceStatusView | null;
  /** Last failure reading the status. Action errors are shown next to the control that failed. */
  error: string | null;
}

export const useDevice = create<DeviceState>(() => ({ status: null, error: null }));

export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "");
  // Electron prefixes IPC errors: "Error invoking remote method 'yo:device:pair': Error: …"
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") || "Something went wrong.";
}

export async function refreshDevice() {
  const b = deviceBridge();
  if (!b) return;
  try {
    const status = await b.status();
    useDevice.setState({ status, error: null });
  } catch (e) {
    useDevice.setState({ error: errorText(e) });
  }
}

/** Apply the status a bridge call returned (each call answers with the fresh status). */
export function applyDeviceStatus(status: DeviceStatusView | undefined) {
  if (status) useDevice.setState({ status, error: null });
}

/** The active window session on this Mac (desktop app only), or null. */
export function useWindowLease() {
  return useDevice((s) => s.status?.lease ?? null);
}

/** Stop the active window session now. */
export async function stopWindowLease() {
  const b = deviceBridge();
  if (!b?.stopLease) return;
  await b.stopLease();
  await refreshDevice();
}

let started = false;
export function startDeviceSync() {
  const b = deviceBridge();
  if (!b || started) return;
  started = true;
  b.onChanged(() => void refreshDevice());
  void refreshDevice();
}
