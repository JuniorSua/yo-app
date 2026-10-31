/**
 * The sentence above each provider's sign-in steps.
 *
 * `connect.detect`'s `host` is the machine **core** runs on, not the machine the person is sitting at. On a home
 * server (a friend's Mac app against core on someone else's PC) the two differ, so nothing here ever asks for a
 * Terminal: Claude, ChatGPT and Grok all sign in on Yo's own computer, wherever that is, and the person finishes
 * in any browser (Mac app, home server, PC edition alike).
 */
import type { ConnectDetection } from "@yo/contracts";

/** " on ProDesktop" when Yo runs on another computer, "" on this Mac. */
const onHost = (d: ConnectDetection | null) =>
  d && d.host.platform !== "darwin" ? ` on ${d.host.name}` : "";

/** Where Yo's private workspace runs: " on ProDesktop" for another computer, " on this Mac" otherwise. */
const where = (d: ConnectDetection | null) => onHost(d) || " on this Mac";

/** Claude: Claude Code's own sign-in on Yo's computer; the person pastes back the code Claude's page shows. */
export function claudeSignInHint(d: ConnectDetection | null): string {
  return `Yo runs Claude Code in a private workspace${where(d)}. You sign in on Claude's own page, in a browser on this computer or your phone, so there's nothing to install or type in Terminal.`;
}

/** ChatGPT: Codex's own sign-in on Yo's computer; the person pastes back the address ChatGPT's page leads to. */
export function codexSignInHint(d: ConnectDetection | null): string {
  return `Yo runs Codex in a private workspace${where(d)}. You sign in on ChatGPT's own page, in a browser on this computer or your phone, so there's nothing to install or type in Terminal.`;
}

/** Grok: `grok login --device-auth` on Yo's computer; the person confirms the code in any browser. */
export function grokSignInHint(d: ConnectDetection | null): string {
  return `Yo signs in to Grok in a private workspace${where(d)}, so there's nothing to install or type in Terminal. You just need a browser, on this computer or your phone.`;
}
