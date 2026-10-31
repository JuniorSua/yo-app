/**
 * Plain-English help for the moments Yo can't be reached or a request fails. Pure functions, so the wording and
 * the timings are tested (covered by the recovery browser tests) and every screen says the same thing.
 */

/** How long a first connection or a reconnect may take before the app explains and offers recovery guidance. */
export const SLOW_CONNECT_MS = 10_000;

export interface ConnectionHelp {
  /** Past SLOW_CONNECT_MS: show the explanation and a retry button, not just a spinner. */
  slow: boolean;
  title: string;
  body: string;
}

/** Where Yo itself (core) runs, once the app knows: from core's execution status. */
export type CorePlacement = "this-mac" | "this-pc" | "home-pc" | "custom-remote" | null | undefined;

/**
 * Who is asking: the Mac app (default) or a plain browser, and which edition of Yo it talks to ("pc": Docker on the
 * user's Windows or Linux PC, opened at localhost). A browser can't "quit Yo and open it again".
 */
export interface ConnectionClient {
  browser: boolean;
  edition?: string | null;
  /** The helper command on the machine running Yo ("yo-app"). */
  helper?: string | null;
  /** The browser is on Windows (Docker Desktop and the Start menu shortcut), not Linux. */
  windows?: boolean;
}

/**
 * What to tell the user while Yo isn't answering. `first`: the app never loaded (the "Connecting to Yo" screen);
 * otherwise it was working and the connection dropped. `placement`: where Yo runs, so someone with only a Mac
 * never reads about a home PC they don't have (unknown before the first load: then the advice covers both).
 */
export function connectionHelp(
  elapsedMs: number,
  first: boolean,
  placement?: CorePlacement,
  client?: ConnectionClient,
): ConnectionHelp {
  const slow = elapsedMs >= SLOW_CONNECT_MS;
  if (!slow) return { slow, title: first ? "Connecting to Yo…" : "Reconnecting to Yo…", body: "" };
  return {
    slow,
    title: first
      ? "Yo is taking longer than usual to answer"
      : `Can't reach Yo · trying for ${shortDuration(elapsedMs)}`,
    body: client?.browser ? browserRecoveryHint(placement, client) : recoveryHint(placement),
  };
}

function browserRecoveryHint(placement: CorePlacement, client: ConnectionClient): string {
  const retry = "It keeps trying on its own.";
  const helper = client.helper || "yo-app";
  if ((client.edition === "pc" || placement === "this-pc") && client.windows)
    return `${retry} Make sure Docker Desktop is running, then open Yo from the Start menu (or run \`${helper} status\`).`;
  if (client.edition === "pc" || placement === "this-pc")
    return `${retry} Make sure Docker is running, then run \`${helper} start\` (or \`${helper} status\` to see what's wrong).`;
  return `${retry} Check that the computer running Yo is on and awake, and that you're online.`;
}

function recoveryHint(placement: CorePlacement): string {
  const retry = "It keeps trying on its own.";
  const reopen = "If it doesn't come back within a minute, quit Yo and open it again.";
  if (placement === "this-mac") return `${retry} ${reopen}`;
  if (placement === "home-pc")
    return `${retry} Yo runs on your home PC: make sure that PC is on and awake, and that you're online.`;
  if (placement === "custom-remote")
    return `${retry} Yo runs on another computer: make sure it's on and awake, and that you're online.`;
  return `${retry} ${reopen} If Yo runs on another computer, make sure it's on and awake.`;
}

/** "45s", "3 min", "1 h 5 min": coarse on purpose, it's a reassurance, not a stopwatch. */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/**
 * A failed request as the user should read it. The client's own timeout ("chat.send timed out") means Yo never
 * answered, which says nothing to a person; anything else is core's message, already written for people.
 */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!msg) return "Something went wrong. Try again in a moment.";
  if (/^[\w.]+ timed out$/.test(msg))
    return "Yo didn't answer in time. Check that it's running and you're online, then try again.";
  return msg;
}
