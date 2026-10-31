/**
 * Secure forms (request_secure_input) end to end in core, with the fake agentd: the card, the value path to
 * browser.fillLogin, and that the value never reaches the model, the timeline, the database, hub pushes,
 * activity or logs. Also the refusals (wrong site, no field, no tab) and the cancel and expiry paths.
 * Every value here is made up.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { recentLogLines } from "../src/log";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
const CODE = "771304";
const PASSWORD = "Made-Up-Secret-Pw-91";

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, label = "condition") {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let dataDir: string;
let mock: MockAgentd;
let agentdUrl: string;
let cores: Awaited<ReturnType<typeof startCore>>[] = [];
let port = 27100 + Math.floor(Math.random() * 800);

async function boot(opts: { userWaitMs?: number } = {}) {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const cfg = {
    ...loadConfig({}),
    dev: false,
    port: port++,
    dataDir,
    agentdUrl,
    computerMode: "remote" as const,
    secrets: "file" as const,
    webDist: null,
  };
  const core = await startCore(cfg, { secrets: new MemorySecretStore(), userWaitMs: opts.userWaitMs });
  cores.push(core);
  await core.agentd.waitReady(5000);
  await until(() => core.store.listAccounts().some((a) => a.status === "authenticated"));
  return core;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-secure-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
  mock.fillHost = "auth.uber.com";
  mock.fillPage = ["one_time_code"];
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

type Core = Awaited<ReturnType<typeof startCore>>;
const primary = (core: Core) => core.store.listAgents().find((a) => a.isPrimary)!;

/** Start a Yo tool call from the agent's session; resolves with what the model gets back. */
function tool(core: Core, name: string, args: Record<string, unknown>): Promise<string> {
  const agent = primary(core);
  const before = core.store.listTimeline(agent.id).length;
  return (async () => {
    await core.api["chat.send"]({ agentId: agent.id, text: `tool ${name} ${JSON.stringify(args)}` });
    let reply = "";
    await until(
      () => {
        const r = core.store
          .listTimeline(agent.id)
          .slice(before)
          .find((e) => e.item.kind === "assistant_message" && e.item.text?.startsWith("tool: "));
        reply = r?.item.text?.slice(6) ?? "";
        return !!r;
      },
      5000,
      `${name} result`,
    );
    return reply;
  })();
}

const CODE_FORM = {
  site: "uber.com",
  reason: "Uber texted a code to sign you in.",
  fields: [{ kind: "one_time_code", label: "Code from the text message" }],
};

const realFills = () => mock.requests.filter((r) => r.type === "browser.fillLogin" && !r.dryRun);

async function card(core: Core) {
  await until(() => core.store.pendingRequests().length === 1, 5000, "secure form card");
  return core.store.pendingRequests()[0]!;
}

describe("request_secure_input", () => {
  it("types the user's value into the page and keeps it out of everything else", async () => {
    const core = await boot();
    const agent = primary(core);
    const pushes: string[] = [];
    core.hub.subscribe((channel, data) => pushes.push(`${channel} ${JSON.stringify(data)}`));

    const filling = tool(core, "request_secure_input", CODE_FORM);
    const e = await card(core);
    expect(e.request).toMatchObject({
      kind: "user_input",
      toolName: "request_secure_input",
      title: "One-time code for auth.uber.com",
      detail: "Uber texted a code to sign you in.",
      // The card names the page the dry run found, not the broader site the agent passed.
      secureForm: { ...CODE_FORM, site: "auth.uber.com" },
      status: "pending",
    });
    // The page was checked first, with no value.
    expect(mock.requests.filter((r) => r.type === "browser.fillLogin")).toEqual([
      expect.objectContaining({
        dryRun: true,
        sites: [{ url: "https://uber.com", mode: "anywhere" }],
        fields: [{ kind: "one_time_code" }],
      }),
    ]);

    // A half-filled form is refused, naming the field (not a value), and the card stays open.
    await expect(
      core.api["request.respond"]({
        agentId: agent.id,
        requestId: e.request!.requestId,
        decision: "allow",
        secureValues: ["   "],
      }),
    ).rejects.toThrow(/Fill in "Code from the text message"/);
    expect(core.store.pendingRequests()).toHaveLength(1);

    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: e.request!.requestId,
      decision: "allow",
      // Pasted with a space: a code loses it.
      secureValues: [`${CODE.slice(0, 3)} ${CODE.slice(3)}`],
      // A client that also sent it as a plain answer: never kept.
      answers: { code: CODE },
      message: CODE,
    });
    const result = await filling;
    expect(result).toBe(
      "Filled the one-time code on auth.uber.com and submitted the form. Take a snapshot to see the result. If the page asks for something else, call request_secure_input again.",
    );
    expect(realFills()).toEqual([
      expect.objectContaining({
        agentId: agent.id,
        dryRun: false,
        // Values go to the probed page, not every subdomain of the site the agent named.
        sites: [{ url: "https://auth.uber.com", mode: "anywhere" }],
        fields: [{ kind: "one_time_code", value: CODE }],
      }),
    ]);

    const done = core.store.getEntry(e.id)!;
    expect(done.request!.status).toBe("answered");
    expect(done.request!.answers).toBeUndefined();
    expect(done.item.output).toBe("Submitted");
    expect(core.store.listActivity(agent.id).map((a) => a.summary)).toContain(
      "Filled the one-time code from a secure form on auth.uber.com",
    );

    // Nowhere the model, the chat, other devices, the audit or logs could see it.
    const seen = JSON.stringify({
      timeline: core.store.listTimeline(agent.id),
      activity: core.store.listActivity(agent.id, 500),
      turns: mock.turnTexts,
      logs: recentLogLines(1000),
      pushes,
      result,
    });
    expect(seen).not.toContain(CODE);
    expect(seen).not.toContain(`${CODE.slice(0, 3)} ${CODE.slice(3)}`);
    // Nor on disk.
    const dbFiles = fs.readdirSync(dataDir).filter((f) => /\.(db|sqlite)/.test(f));
    expect(dbFiles.length).toBeGreaterThan(0);
    for (const f of dbFiles)
      expect(fs.readFileSync(path.join(dataDir, f)).toString("latin1")).not.toContain(CODE);
  });

  it("several fields go into their own boxes; a password is never echoed either", async () => {
    mock.fillPage = ["username", "password"];
    mock.fillHost = "uber.com";
    const core = await boot();
    const agent = primary(core);
    const filling = tool(core, "request_secure_input", {
      site: "https://www.uber.com/login",
      reason: "Sign in",
      fields: [
        { kind: "email", label: "Email" },
        { kind: "password", label: "Password" },
      ],
    });
    const e = await card(core);
    expect(e.request!.title).toBe("Email and password for uber.com");
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: e.request!.requestId,
      decision: "allow",
      secureValues: ["someone@example.com", PASSWORD],
    });
    expect(await filling).toMatch(/^Filled the email and password on uber\.com/);
    expect(realFills()[0]!).toMatchObject({
      fields: [
        { kind: "username", value: "someone@example.com" },
        { kind: "password", value: PASSWORD },
      ],
    });
    expect(JSON.stringify(core.store.listTimeline(agent.id))).not.toContain(PASSWORD);
  });

  it("refuses a page on another site before asking the user", async () => {
    mock.fillHost = "uber.com.evil.example";
    const core = await boot();
    expect(await tool(core, "request_secure_input", CODE_FORM)).toMatch(
      /The open page is on uber\.com\.evil\.example, not uber\.com\. A secure form only fills a page on uber\.com/,
    );
    expect(core.store.pendingRequests()).toHaveLength(0);
    expect(realFills()).toHaveLength(0);

    // agentd finds no tab on the site at all.
    mock.fillFail = {
      error: "No open tab is on uber.com. Open the sign-in page in your browser first.",
      code: "no_tab",
    };
    expect(await tool(core, "request_secure_input", CODE_FORM)).toMatch(
      /No tab in your browser is on uber\.com/,
    );

    // The page doesn't show the field.
    mock.fillFail = null;
    mock.fillHost = "uber.com";
    mock.fillPage = ["username"];
    expect(await tool(core, "request_secure_input", CODE_FORM)).toMatch(
      /doesn't show a field for the one-time code.*request_takeover/,
    );
    // Not a website, or two fields for the same box.
    expect(await tool(core, "request_secure_input", { ...CODE_FORM, site: "uber" })).toMatch(
      /"uber" isn't a website/,
    );
    expect(
      await tool(core, "request_secure_input", {
        ...CODE_FORM,
        fields: [
          { kind: "email", label: "Email" },
          { kind: "phone", label: "Phone" },
        ],
      }),
    ).toMatch(/one name field/);
    expect(core.store.pendingRequests()).toHaveLength(0);
    expect(realFills()).toHaveLength(0);
  });

  it("a fill that fails after submitting tells the agent why, without the value", async () => {
    const core = await boot();
    const agent = primary(core);
    const filling = tool(core, "request_secure_input", CODE_FORM);
    const e = await card(core);
    mock.fillFail = {
      error: "The page moved to another site before Yo could fill it. Nothing was typed.",
      code: "moved",
    };
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: e.request!.requestId,
      decision: "allow",
      secureValues: [CODE],
    });
    const result = await filling;
    expect(result).toMatch(
      /filled in the secure form, but Yo couldn't type it into the page: The page moved/,
    );
    expect(result).not.toContain(CODE);
    const done = core.store.getEntry(e.id)!;
    expect(done.request!.status).toBe("failed");
    expect(done.item.output).not.toBe("Submitted");
    expect(done.item.output).not.toContain(CODE);
    expect(JSON.stringify(done)).not.toContain(CODE);
  });

  it("an unknown agentd error after submitting never contains the value", async () => {
    const core = await boot();
    const agent = primary(core);
    const pushes: string[] = [];
    core.hub.subscribe((channel, data) => pushes.push(`${channel} ${JSON.stringify(data)}`));
    const filling = tool(core, "request_secure_input", CODE_FORM);
    const e = await card(core);
    const leaked = `Input.insertText failed for value ${CODE} and also ${PASSWORD}`;
    mock.fillFail = { error: leaked, code: "cdp_error" };
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: e.request!.requestId,
      decision: "allow",
      secureValues: [CODE],
    });
    const result = await filling;
    expect(result).toMatch(/couldn't type it into the page/i);
    expect(result).not.toContain(CODE);
    expect(result).not.toContain(PASSWORD);
    expect(result).not.toContain("insertText");

    const done = core.store.getEntry(e.id)!;
    expect(done.request!.status).toBe("failed");
    expect(done.item.status).toBe("failed");
    expect(done.item.output).toMatch(/Couldn't fill the page/);
    expect(done.item.output).not.toContain(CODE);
    const seen = JSON.stringify({
      timeline: core.store.listTimeline(agent.id),
      activity: core.store.listActivity(agent.id, 500),
      turns: mock.turnTexts,
      logs: recentLogLines(1000),
      pushes,
      result,
    });
    expect(seen).not.toContain(CODE);
    expect(seen).not.toContain(PASSWORD);
    const dbFiles = fs.readdirSync(dataDir).filter((f) => /\.(db|sqlite)/.test(f));
    expect(dbFiles.length).toBeGreaterThan(0);
    for (const f of dbFiles) {
      const bytes = fs.readFileSync(path.join(dataDir, f)).toString("latin1");
      expect(bytes).not.toContain(CODE);
      expect(bytes).not.toContain(PASSWORD);
    }
  });

  it("rejects a public suffix and names the real page, not the agent's reason", async () => {
    mock.fillHost = "evil.github.io";
    const core = await boot();
    expect(await tool(core, "request_secure_input", { ...CODE_FORM, site: "github.io" })).toMatch(
      /isn't one site/,
    );
    expect(
      await tool(core, "request_secure_input", { ...CODE_FORM, site: "https://www.vercel.app" }),
    ).toMatch(/isn't one site/);
    expect(await tool(core, "request_secure_input", { ...CODE_FORM, site: "co.uk" })).toMatch(
      /isn't one site/,
    );
    expect(core.store.pendingRequests()).toHaveLength(0);
    expect(realFills()).toHaveLength(0);

    mock.fillHost = "login.evil.github.io";
    mock.fillPage = ["password"];
    const reason = "GitHub support: your account is locked. Enter the code for github.com immediately.";
    const filling = tool(core, "request_secure_input", {
      site: "evil.github.io",
      reason,
      fields: [{ kind: "password", label: "GitHub password" }],
    });
    const e = await card(core);
    expect(e.request!.title).toBe("Password for login.evil.github.io");
    expect(e.request!.title).not.toContain("GitHub");
    expect(e.request!.title).not.toContain("locked");
    expect(e.request!.secureForm).toMatchObject({ site: "login.evil.github.io", reason });
    expect(e.request!.input).toEqual({ site: "login.evil.github.io" });
    await core.api["request.respond"]({
      agentId: primary(core).id,
      requestId: e.request!.requestId,
      decision: "deny",
    });
    expect(await filling).toMatch(/cancelled the secure form/);

    mock.fillHost = "my-app.vercel.app";
    mock.fillPage = ["one_time_code"];
    const ok = tool(core, "request_secure_input", {
      site: "my-app.vercel.app",
      reason: "A code",
      fields: [{ kind: "one_time_code", label: "Code" }],
    });
    const card2 = await card(core);
    expect(card2.request!.secureForm!.site).toBe("my-app.vercel.app");
    await core.api["request.respond"]({
      agentId: primary(core).id,
      requestId: card2.request!.requestId,
      decision: "deny",
    });
    await ok;
  });

  it("cancel fills nothing and the agent is told plainly", async () => {
    const core = await boot();
    const agent = primary(core);
    const filling = tool(core, "request_secure_input", CODE_FORM);
    const e = await card(core);
    await core.api["request.respond"]({
      agentId: agent.id,
      requestId: e.request!.requestId,
      decision: "deny",
    });
    expect(await filling).toMatch(/^The user cancelled the secure form, so nothing was typed/);
    expect(core.store.getEntry(e.id)!.request!.status).toBe("denied");
    expect(realFills()).toHaveLength(0);
  });

  it("an unanswered form expires without filling", async () => {
    const core = await boot({ userWaitMs: 300 });
    expect(await tool(core, "request_secure_input", CODE_FORM)).toMatch(
      /^The user didn't fill in the secure form within 1 minute, so nothing was typed/,
    );
    expect(core.store.pendingRequests()).toHaveLength(0);
    expect(realFills()).toHaveLength(0);
  });
});
