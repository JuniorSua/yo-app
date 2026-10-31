/**
 * Which start-up step is in progress, from core's status line (`ComputerOverview.message`). Core has no separate
 * "the VM is up" flag: it starts the virtual machine first ("Starting Yo's computer (virtual machine)…", or the
 * plain "Starting Yo's computer…" right after Try again), then downloads, unpacks or builds the computer.
 */
export function isVmPhase(message: string | null | undefined): boolean {
  const m = message?.trim() ?? "";
  return !m || /virtual machine|colima/i.test(m) || /^Starting\b/i.test(m);
}
