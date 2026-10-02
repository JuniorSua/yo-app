import { describe, expect, it } from "vitest";
import { CONNECT_COMMANDS, checkCodexAuthJson, MIN_CLAUDE_TOKEN_BODY, parseClaudeToken } from "./connect";

// Obviously fake: never a real token in tests.
const FAKE = `sk-ant-oat01-${"FAKE_test_token-".repeat(6)}`;

describe("parseClaudeToken", () => {
  it("accepts the token alone, trimmed", () => {
    expect(parseClaudeToken(`  ${FAKE}\n`)).toEqual({ ok: true, token: FAKE });
  });

  it("digs the token out of a sloppy paste", () => {
    for (const paste of [
      `"${FAKE}"`,
      `'${FAKE}'`,
      `export CLAUDE_CODE_OAUTH_TOKEN=${FAKE}`,
      `CLAUDE_CODE_OAUTH_TOKEN="${FAKE}"`,
      `✓ Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n${FAKE}\n\nStore this token securely.`,
    ])
      expect(parseClaudeToken(paste)).toEqual({ ok: true, token: FAKE });
  });

  it("rejoins a token Terminal wrapped onto several lines", () => {
    const wrapped = `${FAKE.slice(0, 40)}\n${FAKE.slice(40, 80)}\n${FAKE.slice(80)}\n\nStore this token securely.`;
    expect(parseClaudeToken(wrapped)).toEqual({ ok: true, token: FAKE });
  });

  it("picks the longest token when there are several", () => {
    const short = "sk-ant-oat01-short";
    expect(parseClaudeToken(`${short} ${FAKE}`)).toEqual({ ok: true, token: FAKE });
  });

  it("turns every mistake into a next step, without echoing the paste", () => {
    const cases: [string, RegExp][] = [
      ["", /Paste the token first/],
      ["   ", /Paste the token first/],
      ["sk-ant-api03-FAKEapiKEYfakeFAKEfake", /API key/],
      ["https://claude.ai/oauth/code/callback?code=FAKE", /code from the browser/],
      ["FAKEcodeFAKEcodeFAKEcode#FAKEstate", /code from the browser/],
      ["hello there", /starts with sk-ant-oat/],
      [`sk-ant-oat01-${"x".repeat(MIN_CLAUDE_TOKEN_BODY - 1)}`, /cut off/],
    ];
    for (const [paste, msg] of cases) {
      const r = parseClaudeToken(paste);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toMatch(msg);
      if (paste.trim()) expect(r.error).not.toContain(paste.trim());
    }
  });

  it("never throws on junk input", () => {
    expect(parseClaudeToken(undefined as unknown as string).ok).toBe(false);
    expect(parseClaudeToken(42 as unknown as string).ok).toBe(false);
  });
});

describe("checkCodexAuthJson", () => {
  it("accepts a ChatGPT login or an API key", () => {
    expect(
      checkCodexAuthJson(
        JSON.stringify({ tokens: { id_token: "FAKE", access_token: "FAKE", refresh_token: "FAKE_refresh" } }),
      ),
    ).toBe("ok");
    expect(checkCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: "sk-FAKE" }))).toBe("ok");
  });

  it("treats a half-written file as not there yet", () => {
    expect(checkCodexAuthJson('{"tokens": {"refresh')).toBe("partial");
    expect(checkCodexAuthJson("")).toBe("partial");
  });

  it("rejects a file Yo can't use", () => {
    expect(checkCodexAuthJson("null")).toBe("invalid");
    expect(checkCodexAuthJson("[]")).toBe("invalid");
    expect(checkCodexAuthJson(JSON.stringify({ tokens: { access_token: "FAKE" } }))).toBe("invalid");
    expect(checkCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: null, tokens: null }))).toBe("invalid");
  });
});

describe("CONNECT_COMMANDS", () => {
  it("sign Codex in to Yo's own folder, never the user's ~/.codex", () => {
    expect(CONNECT_COMMANDS.codexLogin).toBe("mkdir -p ~/.yo/codex && CODEX_HOME=~/.yo/codex codex login");
    expect(CONNECT_COMMANDS.claudeToken).toBe("claude setup-token");
  });
});
