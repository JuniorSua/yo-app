/**
 * The purchase email: after checkout, the thanks-page handler emails the new license key. It must stay a no-op
 * unless both mail env vars are set, send one plain email, survive a failed send, and not send twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JS
import { makeKey } from "../../../site/api/_lib/license.mjs";
import {
  licenseEmailsSettled,
  licenseKeyEmailText,
  PORTAL_URL,
  resetLicenseEmailState,
  SEND_CAP_MS,
  // @ts-expect-error plain JS
} from "../../../site/api/_lib/licenseMail.mjs";
// @ts-expect-error plain JS
import { licenseFromSession } from "../../../site/api/license/session.mjs";

const API = "https://site.test";
const HMAC = "hmac-secret-for-tests-only";
const CUS = "cus_TestCustomer01";
const SESSION = "cs_test_mail1234567890";
const RESEND = "re_test_fake";
const FROM = "Yo <support@theyoapp.com>";
const KEY = () => makeKey(CUS, HMAC);
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

function setVercelContext(value: unknown) {
  Reflect.set(globalThis, VERCEL_REQUEST_CONTEXT, value);
}

function clearVercelContext() {
  Reflect.deleteProperty(globalThis, VERCEL_REQUEST_CONTEXT);
}

function env(over: Record<string, string | undefined> = {}) {
  return {
    STRIPE_SECRET_KEY: "sk_test_fake",
    YO_LICENSE_HMAC_SECRET: HMAC,
    ...over,
  };
}

function mailEnv(over: Record<string, string | undefined> = {}) {
  return env({ RESEND_API_KEY: RESEND, YO_MAIL_FROM: FROM, ...over });
}

function sessionBody(over: Record<string, unknown> = {}) {
  return {
    status: "complete",
    mode: "subscription",
    customer: CUS,
    customer_details: { email: "buyer@example.com" },
    ...over,
  };
}

type Call = { url: string; init?: RequestInit };

function installFetch(opts: {
  session?: Record<string, unknown>;
  resend?: (url: string, init?: RequestInit) => Response | Promise<Response>;
  mark?: (url: string, init?: RequestInit) => Response | Promise<Response>;
}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    if (call.url.startsWith("https://api.resend.com/")) {
      if (opts.resend) return opts.resend(call.url, init);
      return Response.json({ id: "email_1" });
    }
    if (init?.method === "POST") {
      if (opts.mark) return opts.mark(call.url, init);
      return Response.json({ id: "cs_marked" });
    }
    return Response.json(opts.session ?? sessionBody());
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function resendCalls(calls: Call[]) {
  return calls.filter((c) => c.url.startsWith("https://api.resend.com/"));
}

function markCalls(calls: Call[]) {
  return calls.filter((c) => c.init?.method === "POST" && c.url.includes("api.stripe.com"));
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetLicenseEmailState();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
  clearVercelContext();
});

function logged() {
  return errors.mock.calls.map((c: unknown[]) => c.map(String).join(" ")).join("\n");
}

function header(call: Call, name: string) {
  const headers = call.init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return undefined;
  return headers[name];
}

function ask(
  id: string,
  fetchImpl: typeof fetch,
  vars = mailEnv(),
  context?: { waitUntil?: (p: Promise<unknown>) => void },
) {
  return licenseFromSession(new Request(`${API}/api/license/session?id=${id}`), vars, fetchImpl, context);
}

describe("license key email", () => {
  // Yo 2 dropped the paid plans and the site's Stripe portal link; 0.1 subscribers' emails keep the portal.
  it("links the Stripe portal for 0.1 subscribers", () => {
    const text = licenseKeyEmailText(KEY());
    expect(text).toContain(`Manage or cancel your subscription: ${PORTAL_URL}`);
    expect(text).toContain("Download Yo: https://theyoapp.com\n");
    expect(text).toContain("Open Yo, paste this key, and click Activate.");
    expect(text).toContain(KEY());
    expect(licenseKeyEmailText(KEY(), "https://evil.example/portal")).not.toContain("Manage or cancel");
    expect(licenseKeyEmailText(KEY(), "")).not.toContain("Manage or cancel");
  });

  it("does nothing unless both mail env vars are set and non-empty", async () => {
    const cases = [
      env(),
      env({ RESEND_API_KEY: "", YO_MAIL_FROM: "" }),
      env({ RESEND_API_KEY: RESEND }),
      env({ YO_MAIL_FROM: FROM }),
      env({ RESEND_API_KEY: "   ", YO_MAIL_FROM: FROM }),
      env({ RESEND_API_KEY: RESEND, YO_MAIL_FROM: " \n " }),
    ];
    let vercelReads = 0;
    setVercelContext({
      get() {
        vercelReads += 1;
        return {
          waitUntil() {
            vercelReads += 1;
          },
        };
      },
    });
    for (const vars of cases) {
      let waited = 0;
      const { calls, fetchImpl } = installFetch({
        resend: () => new Promise(() => {}),
      });
      const res = await ask(SESSION, fetchImpl, vars, {
        waitUntil() {
          waited += 1;
        },
      });
      expect(res.status, JSON.stringify(vars)).toBe(200);
      expect(await res.json()).toEqual({ key: KEY(), email: "buyer@example.com" });
      expect(resendCalls(calls)).toHaveLength(0);
      expect(markCalls(calls)).toHaveLength(0);
      expect(waited).toBe(0);
      expect(logged()).toBe("");
    }
    expect(vercelReads).toBe(0);
  });

  it("sends one email with the key, the download link and the portal", async () => {
    let waited: Promise<unknown> | null = null;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { calls, fetchImpl } = installFetch({
      resend: async () => {
        await gate;
        return Response.json({ id: "email_1" });
      },
    });
    try {
      const res = await Promise.race([
        ask(SESSION, fetchImpl, mailEnv(), {
          waitUntil(p: Promise<unknown>) {
            waited = p;
          },
        }),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("email delayed the key")), 1000),
        ),
      ]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: KEY(), email: "buyer@example.com" });
      expect(waited).toBeInstanceOf(Promise);
      expect(resendCalls(calls)).toHaveLength(1);

      const init = resendCalls(calls)[0]?.init;
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${RESEND}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `yo-license/${SESSION}`,
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        from: FROM,
        to: ["buyer@example.com"],
        subject: "Your Yo license key",
        text: licenseKeyEmailText(KEY()),
      });
      expect(String(init?.body)).not.toContain(RESEND);
      expect(String(init?.body)).not.toContain("sk_test_fake");

      // A second load while the first send is still in flight does not send again.
      const again = await ask(SESSION, fetchImpl, mailEnv(), { waitUntil() {} });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ key: KEY(), email: "buyer@example.com" });
      expect(resendCalls(calls)).toHaveLength(1);
    } finally {
      release?.();
      await licenseEmailsSettled();
    }
    expect(markCalls(calls)).toHaveLength(1);
    const mark = markCalls(calls)[0];
    expect(mark?.url).toBe(`https://api.stripe.com/v1/checkout/sessions/${SESSION}`);
    expect(mark?.init?.headers).toMatchObject({
      Authorization: "Bearer sk_test_fake",
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-09-30",
    });
    expect(mark?.init?.body).toBe("metadata[yo_license_emailed]=1");
    expect(String(mark?.init?.body)).not.toContain(KEY());
    expect(logged()).toBe("");

    // Settled, and this process remembers the session: a refresh still does not send.
    const third = await ask(SESSION, fetchImpl);
    expect(third.status).toBe(200);
    await licenseEmailsSettled();
    expect(resendCalls(calls)).toHaveLength(1);
  });

  it("keeps the address Stripe has, and lowercases only the envelope", async () => {
    const { calls, fetchImpl } = installFetch({
      session: sessionBody({ customer_details: { email: "Buyer@Example.com" } }),
    });
    const res = await ask(SESSION, fetchImpl);
    expect(await res.json()).toEqual({ key: KEY(), email: "Buyer@Example.com" });
    await licenseEmailsSettled();
    const body = JSON.parse(String(resendCalls(calls)[0]?.init?.body));
    expect(body.to).toEqual(["buyer@example.com"]);
  });

  it("does not email an unfinished checkout or a buyer with no address", async () => {
    const open = installFetch({ session: sessionBody({ status: "open", customer: null }) });
    const unfinished = await ask("cs_test_open1234567890", open.fetchImpl);
    expect(unfinished.status).toBe(409);
    expect(resendCalls(open.calls)).toHaveLength(0);

    const nameless = installFetch({ session: sessionBody({ customer_details: {} }) });
    const res = await ask(SESSION, nameless.fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: KEY(), email: null });
    await licenseEmailsSettled();
    expect(resendCalls(nameless.calls)).toHaveLength(0);
    expect(logged()).toBe("");
  });

  it("a failed send still returns the key, logs without secrets, and can be retried", async () => {
    const key = KEY();
    const { calls, fetchImpl } = installFetch({
      resend: () => {
        throw new Error(`down ${key} ${RESEND} sk_test_fake buyer@example.com`);
      },
    });
    const res = await ask(SESSION, fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key, email: "buyer@example.com" });
    await licenseEmailsSettled();
    expect(logged()).toBe("license email: send failed");
    expect(logged()).not.toContain(key);
    expect(logged()).not.toContain(RESEND);
    expect(logged()).not.toContain("sk_test_fake");
    expect(logged()).not.toContain("buyer@example.com");
    expect(markCalls(calls)).toHaveLength(0);

    const retry = installFetch({});
    const second = await ask(SESSION, retry.fetchImpl);
    expect(second.status).toBe(200);
    await licenseEmailsSettled();
    expect(resendCalls(retry.calls)).toHaveLength(1);
  });

  it("a refused send does not change the key response", async () => {
    const key = KEY();
    const { calls, fetchImpl } = installFetch({
      resend: () => new Response(JSON.stringify({ message: key, key: RESEND }), { status: 502 }),
    });
    const res = await ask(SESSION, fetchImpl);
    expect(await res.json()).toEqual({ key, email: "buyer@example.com" });
    await licenseEmailsSettled();
    expect(logged()).toBe("license email: send failed (502)");
    expect(logged()).not.toContain(key);
    expect(logged()).not.toContain(RESEND);
    expect(markCalls(calls)).toHaveLength(0);
  });

  it("suppresses a second email when Stripe already marked the checkout", async () => {
    const { calls, fetchImpl } = installFetch({
      session: sessionBody({ metadata: { yo_license_emailed: "1" } }),
    });
    let waited = 0;
    const res = await ask(SESSION, fetchImpl, mailEnv(), {
      waitUntil() {
        waited += 1;
      },
    });
    expect(await res.json()).toEqual({ key: KEY(), email: "buyer@example.com" });
    await licenseEmailsSettled();
    expect(resendCalls(calls)).toHaveLength(0);
    expect(markCalls(calls)).toHaveLength(0);
    expect(waited).toBe(0);
    expect(logged()).toBe("");
  });

  it("sends once per checkout, and stops marking after the Stripe key refuses", async () => {
    const first = installFetch({
      mark: () => new Response(JSON.stringify({ error: { message: KEY() } }), { status: 403 }),
    });
    expect((await ask(SESSION, first.fetchImpl)).status).toBe(200);
    await licenseEmailsSettled();
    const other = "cs_test_other123456789";
    expect((await ask(other, first.fetchImpl)).status).toBe(200);
    await licenseEmailsSettled();
    const keys = resendCalls(first.calls).map((c) => header(c, "Idempotency-Key"));
    expect(keys).toEqual([`yo-license/${SESSION}`, `yo-license/${other}`]);
    // The 403 is remembered, so the second checkout is emailed but not marked again.
    expect(markCalls(first.calls)).toHaveLength(1);
    expect(logged()).toBe("license email: mark failed (403)");
    expect(logged()).not.toContain(KEY());

    // Same checkout again: still one email for that purchase.
    const repeat = installFetch({});
    await ask(SESSION, repeat.fetchImpl);
    await licenseEmailsSettled();
    expect(resendCalls(repeat.calls)).toHaveLength(0);
  });

  it("returns the key without waiting when context.waitUntil keeps the send alive", async () => {
    let symbolWaits = 0;
    setVercelContext({
      get: () => ({
        waitUntil() {
          symbolWaits += 1;
        },
      }),
    });
    let held: Promise<unknown> | null = null;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { calls, fetchImpl } = installFetch({
      resend: async () => {
        await gate;
        return Response.json({ id: "email_1" });
      },
    });
    try {
      const res = await Promise.race([
        ask(SESSION, fetchImpl, mailEnv(), {
          waitUntil(p) {
            held = p;
          },
        }),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("email delayed the key")), 1000),
        ),
      ]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: KEY(), email: "buyer@example.com" });
      expect(held).toBeInstanceOf(Promise);
      expect(symbolWaits).toBe(0);
      expect(resendCalls(calls)).toHaveLength(1);
    } finally {
      release();
      await licenseEmailsSettled();
    }
  });

  it("uses the Vercel request-context waitUntil when the handler has none", async () => {
    let held: Promise<unknown> | null = null;
    setVercelContext({
      get: () => ({
        waitUntil(p: Promise<unknown>) {
          held = p;
        },
      }),
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { calls, fetchImpl } = installFetch({
      resend: async () => {
        await gate;
        return Response.json({ id: "email_1" });
      },
    });
    try {
      const res = await Promise.race([
        ask(SESSION, fetchImpl, mailEnv(), {}),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("email delayed the key")), 1000),
        ),
      ]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: KEY(), email: "buyer@example.com" });
      expect(held).toBeInstanceOf(Promise);
      expect(resendCalls(calls)).toHaveLength(1);
    } finally {
      release();
      await held;
      await licenseEmailsSettled();
    }
  });

  it("waits at most 2.5s when waitUntil is missing, and still returns the key if the send is slow or fails", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = installFetch({
      resend: async () => {
        await gate;
        return Response.json({ id: "email_1" });
      },
    });
    const started = Date.now();
    try {
      const res = await ask("cs_test_slowcap123456", slow.fetchImpl, mailEnv(), {});
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ key: KEY(), email: "buyer@example.com" });
      expect(elapsed).toBeGreaterThanOrEqual(SEND_CAP_MS - 200);
      expect(elapsed).toBeLessThan(SEND_CAP_MS + 1500);
      expect(resendCalls(slow.calls)).toHaveLength(1);
      // The response did not wait for the send to finish.
      expect(markCalls(slow.calls)).toHaveLength(0);
    } finally {
      release();
      await licenseEmailsSettled();
    }

    const failStarted = Date.now();
    const failed = installFetch({
      resend: () => {
        throw new Error(`down ${KEY()} ${RESEND}`);
      },
    });
    const res = await ask("cs_test_capfail123456", failed.fetchImpl, mailEnv(), {});
    expect(Date.now() - failStarted).toBeLessThan(1000);
    expect(await res.json()).toEqual({ key: KEY(), email: "buyer@example.com" });
    expect(logged()).toBe("license email: send failed");
    expect(logged()).not.toContain(KEY());
    expect(logged()).not.toContain(RESEND);
  });
});
