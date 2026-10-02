/**
 * "Connect your model" walkthrough: pure checks shared by core (the real check) and the web UI (instant
 * feedback, and the mock backend).
 */

/** Where the walkthrough asks for a dedicated Codex login, relative to the home folder of core's machine. */
export const CODEX_YO_HOME = ".yo/codex";

const PREFIX = /sk-ant-oat\d{2}-/;
const TOKEN_RUN = /sk-ant-oat\d{2}-[A-Za-z0-9_-]*/g;
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;
/** Real setup-token tokens carry ~95 characters after the prefix; much less means the copy was cut off. */
export const MIN_CLAUDE_TOKEN_BODY = 60;
const RUN_AGAIN = "Run `claude setup-token` again and copy the whole line it prints.";

export type ClaudeTokenCheck = { ok: true; token: string } | { ok: false; error: string };

/** Every `sk-ant-oat…` run in the text, rejoined when Terminal wrapped it onto the next lines. */
function tokenCandidates(text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const out: string[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(TOKEN_RUN)) {
      let token = m[0];
      // Only a token that runs to the end of its line can continue on the next one.
      if (m.index + token.length === line.length) {
        for (let j = i + 1; j < lines.length && TOKEN_CHARS.test(lines[j]!); j++) token += lines[j];
      }
      out.push(token);
    }
  });
  return out;
}

/**
 * Accepts the token alone or a sloppy paste around it (quotes, `export CLAUDE_CODE_OAUTH_TOKEN=…`, the
 * whole Terminal output, a wrapped line). Errors never echo what was pasted, and each says what to do next.
 */
export function parseClaudeToken(raw: string): ClaudeTokenCheck {
  const text = (typeof raw === "string" ? raw : "").trim();
  if (!text) return { ok: false, error: `Paste the token first. ${RUN_AGAIN}` };
  const best = tokenCandidates(text).sort((a, b) => b.length - a.length)[0];
  if (!best) {
    if (/sk-ant-api\d{2}-/.test(text))
      return {
        ok: false,
        error: `That's an Anthropic API key, not a sign-in token for your Claude plan. ${RUN_AGAIN}`,
      };
    if (/^https?:\/\//i.test(text) || /^[A-Za-z0-9_-]{20,}#[A-Za-z0-9_-]+$/.test(text))
      return {
        ok: false,
        error:
          "That looks like the code from the browser. Paste it into Terminal instead, then copy the token Terminal prints (it starts with sk-ant-oat).",
      };
    return {
      ok: false,
      error: `That doesn't look like a Claude token — it starts with sk-ant-oat. ${RUN_AGAIN}`,
    };
  }
  if (best.replace(PREFIX, "").length < MIN_CLAUDE_TOKEN_BODY)
    return {
      ok: false,
      error: "That token looks cut off. Copy the whole line that starts with sk-ant-oat, then paste it here.",
    };
  return { ok: true, token: best };
}

/** A usable Codex `auth.json`: a ChatGPT login (tokens with a refresh token) or an API key. */
export function checkCodexAuthJson(raw: string): "ok" | "partial" | "invalid" {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    // Codex may still be writing it: try again on the next poll.
    return "partial";
  }
  if (!v || typeof v !== "object") return "invalid";
  const o = v as Record<string, unknown>;
  const tokens = o.tokens as Record<string, unknown> | null | undefined;
  if (
    tokens &&
    typeof tokens === "object" &&
    typeof tokens.refresh_token === "string" &&
    tokens.refresh_token
  )
    return "ok";
  if (typeof o.OPENAI_API_KEY === "string" && o.OPENAI_API_KEY) return "ok";
  return "invalid";
}

/**
 * The exact Terminal commands the walkthrough shows (one path per provider). Codex needs its CODEX_HOME
 * folder to exist, hence the `mkdir -p`.
 */
export const CONNECT_COMMANDS = {
  claudeInstall: "curl -fsSL https://claude.ai/install.sh | bash",
  claudeToken: "claude setup-token",
  codexInstall: "npm install -g @openai/codex",
  codexInstallBrew: "brew install --cask codex",
  codexLogin: `mkdir -p ~/${CODEX_YO_HOME} && CODEX_HOME=~/${CODEX_YO_HOME} codex login`,
} as const;

/** The providers the walkthrough connects. */
export type ConnectProvider = "claude" | "codex";
