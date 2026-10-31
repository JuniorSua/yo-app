/**
 * "Connect your model" walkthrough: pure checks shared by core, agentd (the real check) and the web UI (instant
 * feedback, and the mock backend).
 *
 * Every provider signs in on Yo's own computer, with nothing to type in Terminal:
 *  - Claude: Claude Code's own sign-in; the person pastes back the code Claude's page shows.
 *  - ChatGPT: Codex's own browser sign-in. ChatGPT's page sends the browser on to an address on Yo's computer
 *    (`http://127.0.0.1:1455/auth/callback?…`) that the person's browser can't open, so they copy that address
 *    and paste it into Yo, which hands it to Codex there (`parseCodexCallback`). A one-time code (device code)
 *    is the other way in; it needs "device code sign-in" turned on once in ChatGPT's security settings.
 *  - Grok: `grok login --device-auth`; the person confirms a code.
 */

/** The providers the walkthrough connects. */
export type ConnectProvider = "claude" | "codex" | "grok";

/**
 * ChatGPT's security settings, where "Enable device code authorization for Codex" lives (personal accounts).
 * The hash opens ChatGPT's Settings on its Security tab.
 */
export const CHATGPT_SECURITY_SETTINGS_URL = "https://chatgpt.com/#settings/Security";

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

export type CodexCallbackCheck = { ok: true; callbackUrl: string } | { ok: false; error: string };

/**
 * Check an address the person pasted after ChatGPT's sign-in page sent their browser on to Codex's sign-in
 * server on Yo's computer, against the sign-in link Codex gave (`authUrl`, which carries where it expects the
 * browser to land and the one-time `state`).
 *
 * Accepted only when it is that very address: http, localhost or 127.0.0.1, the same port and path, and the same
 * `state` (so an address from an older sign-in, or anything that isn't Codex's own address, is never forwarded).
 * Returns the address to call on Yo's computer: Codex's own redirect address with the pasted query.
 *
 * The errors are plain sentences for the person. The pasted address carries a one-time sign-in code: callers must
 * never log it.
 */
export function parseCodexCallback(pasted: string, authUrl: string): CodexCallbackCheck {
  let redirect: URL;
  let state: string | null;
  try {
    const auth = new URL(authUrl);
    redirect = new URL(auth.searchParams.get("redirect_uri") ?? "");
    state = auth.searchParams.get("state");
  } catch {
    return { ok: false, error: BROKEN_LINK };
  }
  if (redirect.protocol !== "http:" || !LOOPBACK.has(redirect.hostname) || !state)
    return { ok: false, error: BROKEN_LINK };

  // Whatever the browser's address bar or a share sheet adds around it: spaces, line breaks, quotes, <…>.
  let text = pasted.replace(/\s+/g, "").replace(/^["'<]+|["'>]+$/g, "");
  if (!text) return { ok: false, error: "Paste the address first." };
  // Some browsers copy the address without "http://".
  if (/^(localhost|127\.0\.0\.1)[:/]/i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: notTheAddress(redirect) };
  }
  if (url.hostname === "auth.openai.com" || url.hostname.endsWith("chatgpt.com"))
    return {
      ok: false,
      error:
        "That's the sign-in link itself. Open it, sign in and click Continue, then copy the address of the page your browser lands on.",
    };
  if (
    url.protocol !== "http:" ||
    !LOOPBACK.has(url.hostname) ||
    url.port !== redirect.port ||
    url.pathname !== redirect.pathname
  )
    return { ok: false, error: notTheAddress(redirect) };
  const got = url.searchParams.get("state");
  if (!got || (!url.searchParams.get("code") && !url.searchParams.get("error")))
    return {
      ok: false,
      error: "That address is cut short. Copy the whole address, all the way to the end, and paste it again.",
    };
  if (got !== state)
    return {
      ok: false,
      error:
        "That address is from an earlier sign-in. Use the newest sign-in page, or press Try again for a fresh one.",
    };
  return { ok: true, callbackUrl: `${redirect.origin}${redirect.pathname}${url.search}` };
}

/** Where the person's browser lands after ChatGPT's page, for the instructions ("http://127.0.0.1:1455"). */
export function codexCallbackOrigin(authUrl: string | undefined): string {
  try {
    const r = new URL(new URL(authUrl ?? "").searchParams.get("redirect_uri") ?? "");
    if (r.protocol === "http:" && LOOPBACK.has(r.hostname)) return `${r.protocol}//${r.host}`;
  } catch {}
  return "http://127.0.0.1:1455";
}

const BROKEN_LINK = "This sign-in link doesn't look right. Press Try again for a fresh one.";

const notTheAddress = (redirect: URL) =>
  `That isn't the address Yo needs. Copy the whole address of the page that says it can't connect. It starts with ${redirect.protocol}//${redirect.host}${redirect.pathname}.`;
