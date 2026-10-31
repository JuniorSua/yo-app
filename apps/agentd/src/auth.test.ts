import { describe, expect, it } from "vitest";
import { bearerFrom, checkBearer, isLocalPeer, safeEqual, scrubEnv, validateToken } from "./auth";
import { redact } from "./log";

const TOKEN = "a".repeat(64);

describe("auth", () => {
  it("compares tokens exactly", () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true);
    expect(safeEqual(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(safeEqual(TOKEN, "b".repeat(64))).toBe(false);
    expect(safeEqual("", TOKEN)).toBe(false);
  });

  it("requires a >= 32 char token", () => {
    expect(() => validateToken(undefined)).toThrow();
    expect(() => validateToken("short")).toThrow();
    expect(validateToken(TOKEN)).toBe(TOKEN);
  });

  it("parses bearer headers", () => {
    expect(bearerFrom({ headers: { authorization: `Bearer ${TOKEN}` } })).toBe(TOKEN);
    expect(bearerFrom({ headers: { authorization: `bearer  ${TOKEN} ` } })).toBe(TOKEN);
    expect(bearerFrom({ headers: { authorization: `Basic ${TOKEN}` } })).toBeNull();
    expect(bearerFrom({ headers: {} })).toBeNull();
    expect(checkBearer({ headers: { authorization: `Bearer ${TOKEN}` } }, TOKEN)).toBe(true);
    expect(checkBearer({ headers: { authorization: "Bearer nope" } }, TOKEN)).toBe(false);
  });

  it("redacts secrets from logs", () => {
    const out = redact('key sk-ant-oat01-abc_DEF-123 and Authorization: Bearer xyz.123 {"token":"s3cr3t"}');
    expect(out).not.toContain("abc_DEF");
    expect(out).not.toContain("xyz.123");
    expect(out).not.toContain("s3cr3t");
  });
});

describe("local peer rejection", () => {
  const own = new Set(["172.18.0.2", "fe80::42:acff:fe12:2"]);
  it("treats loopback and own interface addresses as local", () => {
    for (const a of [
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "::ffff:127.0.0.1",
      "172.18.0.2",
      "::ffff:172.18.0.2",
      "fe80::42:acff:fe12:2%eth0",
      undefined,
    ]) {
      expect(isLocalPeer(a, own)).toBe(true);
    }
  });
  it("accepts the docker gateway / VM peers", () => {
    for (const a of ["172.18.0.1", "::ffff:172.18.0.1", "192.168.5.15", "10.0.0.7"]) {
      expect(isLocalPeer(a, own)).toBe(false);
    }
  });
  it("scrubs YO_AGENTD_* from child envs", () => {
    const env = scrubEnv({
      YO_AGENTD_TOKEN: "x",
      YO_AGENTD_ALLOW_LOCAL: "1",
      PATH: "/bin",
      YO_AGENT_ID: "a1",
    });
    expect(env).toEqual({ PATH: "/bin", YO_AGENT_ID: "a1" });
  });
});
