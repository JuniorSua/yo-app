/** What core sends on /api/vnc when the computer isn't running (apps/core/src/http/server.ts). */
export const VNC_COMPUTER_OFF_CODE = 4404;
export const VNC_COMPUTER_OFF_REASON = "computer is not running";

export const COMPUTER_OFF_MESSAGE = "Your computer is off — start it";

/** True when the live-view socket closed because the computer isn't running. */
export function vncClosedBecauseOff(code: number, reason: string): boolean {
  return code === VNC_COMPUTER_OFF_CODE || reason.trim().toLowerCase() === VNC_COMPUTER_OFF_REASON;
}
