/** Which computer the person is using Yo from (not where Yo runs): wording for commands, menus and keys. */
import { useBrowserAuth } from "./browserAuth";

/** True when the person is using Yo from a Mac (the desktop app, or a browser on macOS). */
export function clientIsMac(): boolean {
  if (typeof window === "undefined") return false;
  const desktop = window.yoDesktop?.platform;
  if (desktop) return desktop === "darwin";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  // iPhones and iPads report "iPhone"/"iPad" here, which is correct: they have no Terminal.
  return /mac/i.test(nav.platform ?? "") || /mac/i.test(nav.userAgentData?.platform ?? "");
}

/**
 * True when the person is using Yo in a browser on Windows (the PC edition). Only in browser mode: the default mock
 * stands in for the Mac app, whatever machine the tests run on.
 */
export function clientIsWindows(): boolean {
  if (typeof window === "undefined" || !useBrowserAuth.getState().browserMode) return false;
  const desktop = window.yoDesktop?.platform;
  if (desktop) return desktop === "win32";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /windows/i.test(nav.userAgentData?.platform ?? "") || /Windows NT|Win64|Win32/.test(nav.userAgent);
}
