/**
 * Claude Code's own sign-in, on Yo's computer: `claude auth login --claudeai` in a PTY, with the account's
 * CLAUDE_CONFIG_DIR and no CLAUDE_CODE_OAUTH_TOKEN. Claude Code prints its sign-in link, the user signs in on
 * Claude's own page and pastes back the code it shows; Claude Code then keeps the sign-in in the config dir and
 * refreshes it itself.
 *
 * Yo never sees a Claude token here: the CLI never prints one, the result carries no secrets, and nothing from
 * the config dir is read. The pasted code is written to the PTY only (never logged; the CLI doesn't echo it).
 */
import type { LoginCallbacks, LoginHandle } from "../ProviderAdapter";
import { stripAnsi } from "../shared/ansi";
import type { PtySpawn } from "../shared/process";

export const CLAUDE_LOGIN_ARGS = ["auth", "login", "--claudeai"];

/**
 * The sign-in link inside an OSC 8 hyperlink (`ESC ]8;params;URL` ended by BEL or `ESC \`). Only a complete
 * one matches, so a link cut off at a chunk boundary is never taken.
 */
const OSC8_LINK =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape parsing
  /\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\s\x07\x1b]*\/oauth\/authorize\?[^\s\x07\x1b]+)(?:\x07|\x1b\\)/;
/** The link as plain text, only once something follows it (the rest of the line has arrived). */
const TEXT_LINK = /https:\/\/[^\s"'<>]*\/oauth\/authorize\?[^\s"'<>]+(?=[\s"'<>])/;

/**
 * The OAuth authorize link in raw PTY output: the hyperlink's target when there is one (exactly one copy, never
 * the visible text glued to it), else a complete plain-text link.
 */
export function findAuthorizeUrl(raw: string): string | undefined {
  const osc = raw.match(OSC8_LINK);
  if (osc) return osc[1];
  return stripAnsi(raw).match(TEXT_LINK)?.[0];
}

/** Claude Code's own failure line ("Login failed: …", "OAuth error: …"), cut short. */
export function findLoginError(clean: string): string | undefined {
  const line = clean
    .split("\n")
    .map((l) => l.replace(/^.*Paste code here if prompted >\s*/, "").trim())
    .find((l) =>
      /^(Login failed|OAuth error|Error)\b|invalid[_ ]grant|Invalid code|authorization failed/i.test(l),
    );
  return line?.replace(/\s*Press Enter to retry\.?/i, "").slice(0, 200) || undefined;
}

/** Codes Claude turned down: they expire quickly and only work with the newest link. */
function codeRejected(detail?: string): string {
  const status = detail?.match(/status code (\d{3})/)?.[1];
  return `Claude didn't accept that code${status ? ` (error ${status})` : ""}. Codes expire quickly and only work with the newest sign-in link. Press Try again for a fresh link, then paste the whole code.`;
}

export interface ClaudeLoginStatus {
  loggedIn?: boolean;
}

export interface ClaudeCliLoginOptions {
  spawnPty: PtySpawn;
  executable: string;
  env: Record<string, string>;
  cwd: string;
  cb: LoginCallbacks;
  /** `claude auth status --json` for this account (no token in its env), asked once the CLI exits 0. */
  checkStatus: () => Promise<ClaudeLoginStatus | null>;
  /** Overall timeout for the whole flow (the user has to open a browser and paste a code). */
  timeoutMs?: number;
  /** Time allowed for the CLI to print the link. */
  urlTimeoutMs?: number;
}

export function runClaudeCliLogin(opts: ClaudeCliLoginOptions): LoginHandle {
  const { cb } = opts;
  let raw = "";
  let urlSent = false;
  let finished = false;
  let inputSent = false;
  let inputOffset = 0;
  let expectedState: string | null = null;
  let promptUrl: string | undefined;

  const pty = opts.spawnPty(opts.executable, CLAUDE_LOGIN_ARGS, {
    // Wide terminal so the link never wraps.
    cols: 1000,
    rows: 60,
    cwd: opts.cwd,
    env: opts.env,
    name: "xterm-256color",
  });

  const finish = (r: { ok: true } | { ok: false; message: string }) => {
    if (finished) return;
    finished = true;
    clearTimeout(overall);
    clearTimeout(urlTimer);
    try {
      pty.kill();
    } catch {
      // already gone
    }
    // Never secrets: Claude Code keeps its sign-in in its own config dir.
    cb.result(r.ok ? { ok: true } : { ok: false, message: r.message });
  };

  const overall = setTimeout(
    () => finish({ ok: false, message: "Sign-in timed out. Please try again." }),
    opts.timeoutMs ?? 30 * 60_000,
  );
  const urlTimer = setTimeout(() => {
    if (!urlSent)
      finish({ ok: false, message: "Claude did not show a sign-in link in time. Please try again." });
  }, opts.urlTimeoutMs ?? 60_000);
  overall.unref?.();
  urlTimer.unref?.();

  pty.onData((chunk) => {
    if (finished) return;
    raw += chunk;
    if (raw.length > 200_000) {
      const cut = raw.length - 100_000;
      raw = raw.slice(cut);
      inputOffset = Math.max(0, inputOffset - cut);
    }
    if (!urlSent) {
      const url = findAuthorizeUrl(raw);
      if (url) {
        urlSent = true;
        promptUrl = url;
        try {
          expectedState = new URL(url).searchParams.get("state");
        } catch {
          expectedState = null;
        }
        cb.prompt({
          url,
          needsInput: true,
          message:
            "Sign in on Claude's page with the account that has your plan and click Authorize. Then copy the code Claude shows and paste it here.",
        });
      }
    }
    // A code Claude turned down: the CLI says so ("Login failed: … status code 400") and exits. Say it plainly
    // right away (an older CLI waits for Enter instead of exiting).
    if (inputSent) {
      const err = findLoginError(stripAnsi(raw.slice(inputOffset)));
      if (err) finish({ ok: false, message: codeRejected(err) });
    }
  });

  pty.onExit(({ exitCode }) => {
    if (finished) return;
    if (exitCode === 0) {
      // Signed in as far as the CLI knows: confirm with Claude Code itself before saying so.
      clearTimeout(urlTimer);
      opts
        .checkStatus()
        .catch(() => null)
        .then((st) => {
          if (st?.loggedIn === false)
            finish({
              ok: false,
              message: "Claude finished, but Yo's computer still isn't signed in. Press Try again.",
            });
          // Unknown (the status check itself failed): the CLI said yes, and the next account check tells.
          else finish({ ok: true });
        });
      return;
    }
    const err = findLoginError(stripAnsi(raw));
    finish({
      ok: false,
      message: inputSent
        ? codeRejected(err)
        : err
          ? `Claude's sign-in stopped: ${err}. Press Try again.`
          : `Claude's sign-in stopped before it was done (exit ${exitCode}). Press Try again.`,
    });
  });

  return {
    input(text: string) {
      if (finished) return;
      // Accept pastes with stray whitespace/newlines (e.g. copied from a wrapped line).
      const code = text.replace(/\s+/g, "");
      if (!code) return;
      // The code is "<authCode>#<state>". If the state doesn't match THIS link, the user copied it from an
      // older sign-in tab; Claude would reject it, so say so and keep this flow open.
      const state = code.includes("#") ? code.slice(code.indexOf("#") + 1) : null;
      if (expectedState && state && state !== expectedState) {
        cb.prompt({
          url: promptUrl,
          needsInput: true,
          message:
            "That code is from an older Claude sign-in tab. Close the other Claude tabs, use the newest one (or click Open sign-in page), click Authorize, and paste that code.",
        });
        return;
      }
      inputSent = true;
      inputOffset = raw.length;
      pty.write(code);
      // Separate write for Enter: some prompts treat a single chunk ending in \r as a paste.
      setTimeout(() => {
        if (!finished) pty.write("\r");
      }, 150);
    },
    cancel() {
      finish({ ok: false, message: "Sign-in canceled." });
    },
  };
}
