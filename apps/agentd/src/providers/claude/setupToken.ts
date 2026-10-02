/**
 * `claude setup-token` driver: runs the CLI in a PTY, surfaces the authorize URL, forwards the
 * pasted code, and captures the long-lived CLAUDE_CODE_OAUTH_TOKEN it prints.
 *
 * The token is only ever handed to `cb.result` (yo-core stores it in the Keychain);
 * it is never logged.
 */
import type { LoginCallbacks, LoginHandle } from "../ProviderAdapter";
import { stripAnsi } from "../shared/ansi";
import type { PtySpawn } from "../shared/process";

export const TOKEN_PREFIX = "sk-ant-oat01-";
const TOKEN_CHAR = /[A-Za-z0-9_-]/;
/** Real tokens carry ~95 chars after the prefix; a shorter run before a line break means it wrapped. */
const WRAP_THRESHOLD = 80;
const MIN_TOKEN_BODY = 20;

/** Find the OAuth authorize URL in (ANSI-stripped) output. */
export function findAuthorizeUrl(clean: string): string | undefined {
  const m = clean.match(/https:\/\/[^\s"'<>]*\/oauth\/authorize\?[^\s"'<>]+/);
  return m?.[0];
}

/**
 * Extract the `sk-ant-oat01-…` token from ANSI-stripped output, joining it across line breaks
 * if the terminal wrapped it.
 */
export function findOauthToken(clean: string): string | undefined {
  const start = clean.lastIndexOf(TOKEN_PREFIX);
  if (start < 0) return undefined;
  let body = "";
  let i = start + TOKEN_PREFIX.length;
  while (i < clean.length) {
    const ch = clean[i]!;
    if (TOKEN_CHAR.test(ch)) {
      body += ch;
      i++;
      continue;
    }
    if ((ch === "\n" || ch === "\r") && body.length < WRAP_THRESHOLD) {
      // Wrapped: skip the line break and any indentation, then continue if more token chars follow.
      let j = i;
      while (j < clean.length && /[\r\n \t]/.test(clean[j]!)) j++;
      if (j < clean.length && TOKEN_CHAR.test(clean[j]!)) {
        i = j;
        continue;
      }
    }
    break;
  }
  return body.length >= MIN_TOKEN_BODY ? TOKEN_PREFIX + body : undefined;
}

/** Recognizable failure lines printed by setup-token. */
export function findLoginError(clean: string): string | undefined {
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = lines.find((l) =>
    /(OAuth error|invalid code|Invalid authorization|authorization failed|error:|failed to|expired)/i.test(l),
  );
  return hit && !hit.includes(TOKEN_PREFIX) ? hit.slice(0, 300) : undefined;
}

export interface SetupTokenOptions {
  spawnPty: PtySpawn;
  executable: string;
  env: Record<string, string>;
  cwd: string;
  cb: LoginCallbacks;
  /** Overall timeout for the whole flow (user has to open a browser and paste a code). */
  timeoutMs?: number;
  /** Time allowed for the CLI to print the URL. */
  urlTimeoutMs?: number;
}

export function runSetupToken(opts: SetupTokenOptions): LoginHandle {
  const { cb } = opts;
  let raw = "";
  let urlSent = false;
  let finished = false;
  let inputSent = false;
  let inputOffset = 0;
  let expectedState: string | null = null;
  let promptUrl: string | undefined;

  const pty = opts.spawnPty(opts.executable, ["setup-token"], {
    // Wide terminal so neither the URL nor the token wraps.
    cols: 1000,
    rows: 60,
    cwd: opts.cwd,
    env: opts.env,
    name: "xterm-256color",
  });

  const finish = (r: Parameters<LoginCallbacks["result"]>[0]) => {
    if (finished) return;
    finished = true;
    clearTimeout(overall);
    clearTimeout(urlTimer);
    try {
      pty.kill();
    } catch {
      // already gone
    }
    cb.result(r);
  };

  const overall = setTimeout(
    () => finish({ ok: false, message: "Sign-in timed out. Please try again." }),
    opts.timeoutMs ?? 30 * 60_000,
  );
  const urlTimer = setTimeout(() => {
    if (!urlSent) finish({ ok: false, message: "Claude did not produce a sign-in link in time." });
  }, opts.urlTimeoutMs ?? 60_000);
  overall.unref?.();
  urlTimer.unref?.();

  pty.onData((chunk) => {
    raw += chunk;
    if (raw.length > 200_000) raw = raw.slice(-100_000);
    const clean = stripAnsi(raw);
    if (!urlSent) {
      const url = findAuthorizeUrl(clean);
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
            "Claude opened in your browser. Click Authorize, then copy the code it shows and paste it here.",
        });
      }
    }
    const token = findOauthToken(clean);
    // Only accept a token once the full line has arrived (a newline follows it).
    if (token && new RegExp(`${token}[^A-Za-z0-9_-]`).test(clean)) {
      finish({ ok: true, secrets: { claudeOauthToken: token } });
      return;
    }
    // After a code is submitted the CLI reports a rejected code as "OAuth error: … Press Enter to retry"
    // and then just waits. Surface it instead of hanging.
    if (inputSent) {
      const after = stripAnsi(raw.slice(inputOffset));
      if (/OAuth error|Press Enter to retry|invalid[_ ]grant|Invalid code/i.test(after)) {
        const detail = after
          .match(/OAuth error:?[^\n]*/i)?.[0]
          ?.replace(/Press Enter to retry\.?/i, "")
          .trim();
        finish({
          ok: false,
          message: `Claude didn't accept that code${detail ? ` (${detail})` : ""}. Codes expire quickly and only work with the most recent link — click Connect to get a fresh link, then paste the whole code.`,
        });
      }
    }
  });

  pty.onExit(({ exitCode }) => {
    if (finished) return;
    const clean = stripAnsi(raw);
    const token = findOauthToken(clean);
    if (token) {
      finish({ ok: true, secrets: { claudeOauthToken: token } });
      return;
    }
    const err = findLoginError(clean);
    finish({
      ok: false,
      message:
        err ??
        (inputSent
          ? `Claude sign-in failed (exit ${exitCode}). Check the code and try again.`
          : `Claude sign-in exited early (exit ${exitCode}).`),
    });
  });

  return {
    input(text: string) {
      if (finished) return;
      // Accept pastes with stray whitespace/newlines (e.g. copied from a wrapped line).
      const code = text.replace(/\s+/g, "");
      // The code is "<authCode>#<state>". If the state doesn't match THIS link, the user copied it from an
      // older sign-in tab; Claude would reject it (400), so say so and keep this flow open.
      const state = code.includes("#") ? code.slice(code.indexOf("#") + 1) : null;
      if (expectedState && state && state !== expectedState) {
        cb.prompt({
          url: promptUrl,
          needsInput: true,
          message:
            "That code is from an older Claude sign-in tab. Close the other Claude tabs, use the newest one (or click Open sign-in page), Authorize, and paste that code.",
        });
        return;
      }
      inputSent = true;
      inputOffset = raw.length;
      pty.write(code);
      // Separate write for Enter: Ink-based prompts treat a single chunk ending in \r as paste.
      setTimeout(() => {
        if (!finished) pty.write("\r");
      }, 150);
    },
    cancel() {
      finish({ ok: false, message: "Sign-in canceled." });
    },
  };
}
