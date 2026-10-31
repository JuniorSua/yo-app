import { describe, expect, it } from "vitest";
import { CHATGPT_SECURITY_SETTINGS_URL, codexCallbackOrigin, parseCodexCallback } from "./connect";

const AUTH = (redirect = "http://localhost:1455/auth/callback", state = "STATE_abc123") =>
  `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&redirect_uri=${encodeURIComponent(
    redirect,
  )}&code_challenge=FAKE&code_challenge_method=S256&state=${state}&originator=yo`;
const LANDED = "http://localhost:1455/auth/callback?code=FAKE_code&scope=openid&state=STATE_abc123";

describe("parseCodexCallback", () => {
  it("accepts the address the browser lands on, and calls Codex's own address with it", () => {
    expect(parseCodexCallback(LANDED, AUTH())).toEqual({ ok: true, callbackUrl: LANDED });
    // Codex may name 127.0.0.1; the browser shows either.
    expect(parseCodexCallback(LANDED, AUTH("http://127.0.0.1:1455/auth/callback"))).toEqual({
      ok: true,
      callbackUrl: LANDED.replace("localhost", "127.0.0.1"),
    });
  });

  it("forgives what copying adds: spaces, line breaks, quotes, a missing http://", () => {
    for (const p of [
      `  ${LANDED}\n`,
      `"${LANDED}"`,
      `<${LANDED}>`,
      LANDED.replace("http://", ""),
      LANDED.replace("&scope", "\n&scope"),
    ])
      expect(parseCodexCallback(p, AUTH())).toMatchObject({ ok: true, callbackUrl: LANDED });
  });

  it("passes a sign-in ChatGPT turned down on to Codex (it reports why)", () => {
    const denied = "http://localhost:1455/auth/callback?error=access_denied&state=STATE_abc123";
    expect(parseCodexCallback(denied, AUTH())).toEqual({ ok: true, callbackUrl: denied });
  });

  it("refuses an address from another sign-in (state)", () => {
    const r = parseCodexCallback(LANDED.replace("STATE_abc123", "STATE_other"), AUTH());
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/earlier sign-in/) });
  });

  it("refuses anything that isn't Codex's own address on Yo's computer", () => {
    for (const p of [
      "https://localhost:1455/auth/callback?code=x&state=STATE_abc123",
      "http://evil.example/auth/callback?code=x&state=STATE_abc123",
      "http://localhost:8080/auth/callback?code=x&state=STATE_abc123",
      "http://localhost:1455/other?code=x&state=STATE_abc123",
      "http://localhost.evil.example:1455/auth/callback?code=x&state=STATE_abc123",
      "http://user@evil.example:1455/auth/callback?code=x&state=STATE_abc123",
      "not an address",
    ]) {
      const r = parseCodexCallback(p, AUTH());
      expect(r, p).toMatchObject({ ok: false, error: expect.stringMatching(/isn't the address/) });
    }
  });

  it("says when the sign-in link itself was pasted, or the address was cut short", () => {
    expect(parseCodexCallback(AUTH(), AUTH())).toMatchObject({ ok: false, error: /sign-in link itself/ });
    expect(parseCodexCallback("http://localhost:1455/auth/callback?code=x", AUTH())).toMatchObject({
      ok: false,
      error: /cut short/,
    });
    expect(
      parseCodexCallback("http://localhost:1455/auth/callback?state=STATE_abc123", AUTH()),
    ).toMatchObject({
      ok: false,
      error: /cut short/,
    });
    expect(parseCodexCallback("   ", AUTH())).toMatchObject({ ok: false, error: /Paste the address/ });
  });

  it("never forwards anywhere but a loopback http address, whatever the sign-in link says", () => {
    for (const bad of [
      AUTH("https://evil.example/cb"),
      AUTH("http://evil.example:1455/auth/callback"),
      AUTH(undefined, ""),
      "not a link",
    ])
      expect(parseCodexCallback(LANDED, bad)).toMatchObject({ ok: false, error: /Try again/ });
  });

  it("an error never repeats the pasted address (it carries a one-time code)", () => {
    const r = parseCodexCallback("http://evil.example/?code=SECRET_code&state=STATE_abc123", AUTH());
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET_code");
  });
});

describe("codexCallbackOrigin", () => {
  it("names where the browser lands, for the instructions", () => {
    expect(codexCallbackOrigin(AUTH())).toBe("http://localhost:1455");
    expect(codexCallbackOrigin(AUTH("http://127.0.0.1:1455/auth/callback"))).toBe("http://127.0.0.1:1455");
    expect(codexCallbackOrigin(undefined)).toBe("http://127.0.0.1:1455");
    expect(codexCallbackOrigin(AUTH("https://evil.example/cb"))).toBe("http://127.0.0.1:1455");
  });
});

describe("CHATGPT_SECURITY_SETTINGS_URL", () => {
  it("opens ChatGPT's Settings on its Security tab", () => {
    expect(CHATGPT_SECURITY_SETTINGS_URL).toBe("https://chatgpt.com/#settings/Security");
  });
});
