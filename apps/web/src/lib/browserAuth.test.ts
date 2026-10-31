import nodeCrypto from "node:crypto";
import { signedText } from "@yo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserAuth,
  browserLabel,
  consumeSignInToken,
  EXPIRED_LINK,
  memoryKeyStore,
  parseSignInInput,
  SignInError,
  TOO_MANY,
  UNSUPPORTED,
} from "./browserAuth";

const TOKEN = "a".repeat(64);
const CORE_ID = "core_test";

/** A tiny core: /auth/* as in packages/contracts/src/browser.ts, verifying signatures with node:crypto. */
function fakeCore() {
  const state = {
    token: TOKEN as string | null,
    controllers: new Map<string, { publicKey: string; label: string; revoked: boolean }>(),
    nonces: new Set<string>(),
    /** The browser's cookie jar: one session at a time. */
    session: null as string | null,
    sessions: 0,
    down: false,
    enrollStatus: 0,
    signedOut: 0,
    calls: [] as string[],
    verified: [] as { text: string; signature: string; publicKey: string }[],
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    state.calls.push(path);
    if (state.down) throw new TypeError("Failed to fetch");
    expect(init?.credentials).toBe("same-origin");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    switch (path) {
      case "/auth/info":
        return json(200, {
          protocol: 1,
          authRequired: true,
          enrolled: true,
          coreId: CORE_ID,
          browserSignIn: true,
          edition: "pc",
          helperCommand: "yo-app",
        });
      case "/auth/me": {
        const c = state.session ? state.controllers.get(state.session) : undefined;
        return json(
          200,
          c && !c.revoked
            ? { signedIn: true, kind: "controller", controllerId: state.session, expiresAt: 1 }
            : { signedIn: false },
        );
      }
      case "/auth/enroll": {
        if (state.enrollStatus) return json(state.enrollStatus, { error: "nope" });
        if (!state.token || body.token !== state.token) return json(401, { error: "invalid enrollment" });
        state.token = null;
        const id = `ctl_${state.controllers.size + 1}`;
        state.controllers.set(id, { publicKey: body.publicKey, label: body.label, revoked: false });
        return json(200, { controllerId: id });
      }
      case "/auth/challenge": {
        const nonce = nodeCrypto.randomBytes(32).toString("hex");
        state.nonces.add(nonce);
        return json(200, { nonce, expiresAt: Date.now() + 60_000 });
      }
      case "/auth/session": {
        expect(body.cookie).toBe(true);
        const c = state.controllers.get(body.controllerId);
        if (!state.nonces.delete(body.nonce) || !c || c.revoked)
          return json(401, { error: "sign-in rejected" });
        const text = signedText.controllerSession(body.nonce, body.controllerId);
        const key = nodeCrypto.createPublicKey({
          key: Buffer.from(c.publicKey, "base64"),
          format: "der",
          type: "spki",
        });
        if (!nodeCrypto.verify(null, Buffer.from(text), key, Buffer.from(body.signature, "base64")))
          return json(401, { error: "sign-in rejected" });
        state.verified.push({ text, signature: body.signature, publicKey: c.publicKey });
        state.session = body.controllerId;
        state.sessions++;
        return json(200, { ok: true, expiresAt: Date.now() + 12 * 3600_000 });
      }
      case "/auth/signout":
        state.session = null;
        state.signedOut++;
        return json(200, { ok: true });
    }
    return json(404, { error: "not found" });
  });
  return { state, fetch: fetchImpl as unknown as typeof fetch };
}

function setup(subtle: SubtleCrypto = crypto.subtle) {
  const core = fakeCore();
  const keys = memoryKeyStore();
  const auth = new BrowserAuth({
    fetch: core.fetch,
    keys,
    subtle,
    base: "http://localhost:7777",
    label: () => "Edge on Windows",
    now: () => 1000,
  });
  return { core, keys, auth };
}

describe("BrowserAuth", () => {
  it("no key: signed out; enroll with the token, then a signed session", async () => {
    const { core, keys, auth } = setup();
    expect(await auth.ensureSession()).toBe("signed-out");
    await auth.enroll(TOKEN);
    const stored = keys.keys.get(CORE_ID)!;
    expect(stored.controllerId).toBe("ctl_1");
    expect(stored.privateKey.extractable).toBe(false);
    expect(stored.createdAt).toBe(1000);
    expect(core.state.controllers.get("ctl_1")).toMatchObject({ label: "Edge on Windows" });
    expect(await auth.ensureSession()).toBe("ok");
    expect(auth.controllerId).toBe("ctl_1");
    // The signature verifies against the exported SPKI key with node:crypto.
    const v = core.state.verified[0]!;
    expect(v.publicKey).toBe(stored.publicKey);
    expect(v.text.startsWith("yo-controller-session\n")).toBe(true);
    const pub = nodeCrypto.createPublicKey({
      key: Buffer.from(stored.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    expect(nodeCrypto.verify(null, Buffer.from(v.text), pub, Buffer.from(v.signature, "base64"))).toBe(true);
  });

  it("a live session is used as is; forcing renews it", async () => {
    const { core, auth } = setup();
    await auth.enroll(TOKEN);
    expect(await auth.ensureSession()).toBe("ok");
    expect(core.state.sessions).toBe(1);
    expect(await auth.ensureSession()).toBe("ok");
    expect(core.state.sessions).toBe(1);
    expect(await auth.ensureSession(true)).toBe("ok");
    expect(core.state.sessions).toBe(2);
  });

  it("an ended session (core restarted) signs a new one without the user", async () => {
    const { core, auth } = setup();
    await auth.enroll(TOKEN);
    await auth.ensureSession();
    core.state.session = null;
    expect(await auth.ensureSession()).toBe("ok");
    expect(core.state.sessions).toBe(2);
  });

  it("dedupes concurrent calls", async () => {
    const { core, auth } = setup();
    await auth.enroll(TOKEN);
    const [a, b, c] = await Promise.all([auth.ensureSession(), auth.ensureSession(), auth.ensureSession()]);
    expect([a, b, c]).toEqual(["ok", "ok", "ok"]);
    expect(core.state.calls.filter((p) => p === "/auth/session")).toHaveLength(1);
  });

  it("a revoked key is deleted and the browser is signed out", async () => {
    const { core, keys, auth } = setup();
    await auth.enroll(TOKEN);
    await auth.ensureSession();
    core.state.controllers.get("ctl_1")!.revoked = true;
    expect(await auth.ensureSession()).toBe("signed-out");
    expect(keys.keys.size).toBe(0);
    expect(auth.controllerId).toBeNull();
    // Retried once with a fresh challenge before giving up.
    expect(core.state.calls.filter((p) => p === "/auth/session")).toHaveLength(3);
  });

  it("core down: unreachable, and the key stays", async () => {
    const { core, keys, auth } = setup();
    await auth.enroll(TOKEN);
    core.state.down = true;
    core.state.session = null;
    expect(await auth.ensureSession()).toBe("unreachable");
    expect(keys.keys.size).toBe(1);
  });

  it("a used or expired token says so; rate limits too", async () => {
    const { core, auth } = setup();
    await auth.enroll(TOKEN);
    await expect(auth.enroll(TOKEN)).rejects.toThrow(EXPIRED_LINK);
    core.state.enrollStatus = 429;
    await expect(auth.enroll("b".repeat(64))).rejects.toThrow(TOO_MANY);
  });

  it("no Ed25519 in WebCrypto: unsupported", async () => {
    const subtle = {
      generateKey: () => Promise.reject(new DOMException("nope", "NotSupportedError")),
    } as unknown as SubtleCrypto;
    const { auth } = setup(subtle);
    expect(await auth.ensureSession()).toBe("unsupported");
    const err = await auth.enroll(TOKEN).catch((e) => e);
    expect(err).toBeInstanceOf(SignInError);
    expect(err.message).toBe(UNSUPPORTED);
  });

  it("forget deletes the key and ends the session", async () => {
    const { core, keys, auth } = setup();
    await auth.enroll(TOKEN);
    await auth.ensureSession();
    await auth.forget();
    expect(keys.keys.size).toBe(0);
    expect(core.state.signedOut).toBe(1);
    expect(await auth.ensureSession()).toBe("signed-out");
  });

  it("forget never deletes a newer key (signed in again before an old sign-out finished)", async () => {
    const { keys, auth } = setup();
    await auth.enroll(TOKEN);
    const old = auth.controllerId;
    // Another sign-in in this browser replaced the key meanwhile.
    const stored = await keys.get(CORE_ID);
    await keys.put({ ...stored!, controllerId: "ctl_newer" });
    auth.controllerId = old;
    await auth.forget();
    expect((await keys.get(CORE_ID))?.controllerId).toBe("ctl_newer");
  });
});

describe("sign-in links", () => {
  it("takes the token out of the address bar at once, keeping path and query", () => {
    const replaceState = vi.fn();
    const token = consumeSignInToken(
      { hash: `#signin=${TOKEN}`, pathname: "/", search: "?x=1" },
      { replaceState, state: null },
    );
    expect(token).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?x=1");
  });

  it("leaves other fragments alone", () => {
    const replaceState = vi.fn();
    expect(
      consumeSignInToken({ hash: "#other", pathname: "/", search: "" }, { replaceState, state: null }),
    ).toBe(null);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("a malformed link is no token, never an exception", () => {
    const replaceState = vi.fn();
    expect(
      consumeSignInToken({ hash: "#signin=%", pathname: "/", search: "" }, { replaceState, state: null }),
    ).toBe(null);
    expect(replaceState).toHaveBeenCalled();
    expect(parseSignInInput("http://localhost:7777/#signin=%E0%A4%A")).toBeNull();
  });

  it("reads a pasted link or a bare token", () => {
    expect(parseSignInInput(`  http://localhost:7777/#signin=${TOKEN}  `)).toBe(TOKEN);
    expect(parseSignInInput(TOKEN)).toBe(TOKEN);
    expect(parseSignInInput("http://localhost:7777/#signin=")).toBeNull();
    expect(parseSignInInput("hello there")).toBeNull();
  });
});

describe("browserLabel", () => {
  const ua = {
    edgeWin:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    chromeLinux:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    firefoxWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
    safariMac:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  };
  it("names the browser and the OS", () => {
    expect(browserLabel({ userAgent: ua.edgeWin })).toBe("Edge on Windows");
    expect(browserLabel({ userAgent: ua.chromeLinux })).toBe("Chrome on Linux");
    expect(browserLabel({ userAgent: ua.firefoxWin })).toBe("Firefox on Windows");
    expect(browserLabel({ userAgent: ua.safariMac })).toBe("Safari on Mac");
    expect(
      browserLabel({
        userAgent: ua.chromeLinux,
        userAgentData: { platform: "Windows", brands: [{ brand: "Microsoft Edge" }] },
      }),
    ).toBe("Edge on Windows");
  });
});
