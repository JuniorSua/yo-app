import { describe, expect, it, vi } from "vitest";
import type { AccountService } from "../orchestrator/AccountService";
import { ConnectService, codexSecretValues } from "./ConnectService";
import {
  cliDirs,
  codexYoHome,
  detectHost,
  findCli,
  type HostEnv,
  type HostFs,
  readCodexLogin,
  removeCodexLogin,
} from "./hostConnect";

const HOME = "/home/fake-user";
const env = (over: Partial<HostEnv> = {}): HostEnv => ({
  home: HOME,
  path: "/usr/bin:/bin",
  platform: "darwin",
  hostname: "Fake-MacBook.local",
  ...over,
});

/** In-memory FS: files with content, executables flagged. Records every read. */
class FakeFs implements HostFs {
  files = new Map<string, { content: string; exec?: boolean }>();
  reads: string[] = [];
  failReads = false;
  add(p: string, content = "", exec = false) {
    this.files.set(p, { content, exec });
    return this;
  }
  async exists(p: string) {
    return this.files.has(p) || [...this.files.keys()].some((f) => f.startsWith(`${p}/`));
  }
  async isExecutable(p: string) {
    return !!this.files.get(p)?.exec;
  }
  async readFile(p: string) {
    this.reads.push(p);
    if (this.failReads) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    const f = this.files.get(p);
    if (!f) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return f.content;
  }
  async rm(p: string) {
    this.files.delete(p);
  }
}

const YO_AUTH = `${HOME}/.yo/codex/auth.json`;
const LOGIN = JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "FAKE_id_token_123",
    access_token: "FAKE_access_123",
    refresh_token: "FAKE_refresh_123",
  },
});

describe("detectHost", () => {
  it("finds nothing on a fresh machine", async () => {
    expect(await detectHost(env(), new FakeFs())).toEqual({
      host: { platform: "darwin", name: "Fake-MacBook" },
      claude: { installed: false, signedIn: null },
      codex: { installed: false, signedIn: false, yoLogin: false },
    });
  });

  it("finds CLIs on PATH and in the usual install folders, and who is signed in", async () => {
    const fs = new FakeFs()
      .add(`${HOME}/.local/bin/claude`, "", true) // native installer, not on a GUI app's PATH
      .add("/opt/homebrew/bin/codex", "", true)
      .add(`${HOME}/.claude.json`, JSON.stringify({ oauthAccount: { emailAddress: "fake@example.invalid" } }))
      .add(`${HOME}/.codex/auth.json`, LOGIN);
    const d = await detectHost(env(), fs);
    expect(d.claude).toEqual({ installed: true, signedIn: true });
    expect(d.codex).toEqual({ installed: true, signedIn: true, yoLogin: false });
    // The user's own Codex login is only checked for existence, never read.
    expect(fs.reads).not.toContain(`${HOME}/.codex/auth.json`);
    // And nothing it returns carries a path or the account.
    expect(JSON.stringify(d)).not.toMatch(/fake-user|example\.invalid|FAKE_/);
  });

  it("knows Claude is signed in on Linux from its credentials file, without reading it", async () => {
    const fs = new FakeFs().add(`${HOME}/.claude/.credentials.json`, "{}");
    expect((await detectHost(env({ platform: "linux" }), fs)).claude.signedIn).toBe(true);
    expect(fs.reads).toEqual([]);
  });

  it("says 'can't tell' when ~/.claude.json is unreadable, and signed out when it has no account", async () => {
    const fs = new FakeFs().add(`${HOME}/.claude.json`, "{not json");
    expect((await detectHost(env(), fs)).claude.signedIn).toBeNull();
    fs.add(`${HOME}/.claude.json`, JSON.stringify({ numStartups: 3 }));
    expect((await detectHost(env(), fs)).claude.signedIn).toBe(false);
  });

  it("ignores a non-executable file and relative PATH entries", async () => {
    const fs = new FakeFs().add("/usr/bin/claude", "", false).add("bin/codex", "", true);
    expect(await findCli("claude", env(), fs)).toBe(false);
    expect(await findCli("codex", env({ path: "bin:/usr/bin" }), fs)).toBe(false);
    expect(cliDirs(env({ path: "bin:/usr/bin" }))).not.toContain("bin");
  });

  it("sees the dedicated login for Yo", async () => {
    const fs = new FakeFs().add(YO_AUTH, LOGIN);
    expect((await detectHost(env(), fs)).codex.yoLogin).toBe(true);
    expect(codexYoHome(env())).toBe(`${HOME}/.yo/codex`);
  });
});

describe("readCodexLogin", () => {
  it("waits until the login is there and complete", async () => {
    const fs = new FakeFs();
    expect(await readCodexLogin(env(), fs)).toEqual({ state: "waiting" });
    fs.add(YO_AUTH, '{"tokens": {"refr'); // Codex still writing
    expect(await readCodexLogin(env(), fs)).toEqual({ state: "waiting" });
    fs.failReads = true;
    expect(await readCodexLogin(env(), fs)).toEqual({ state: "waiting" });
    fs.failReads = false;
    fs.add(YO_AUTH, LOGIN);
    expect(await readCodexLogin(env(), fs)).toEqual({ state: "found", authJson: LOGIN });
  });

  it("explains what to do with an unusable login", async () => {
    const fs = new FakeFs().add(YO_AUTH, JSON.stringify({ tokens: {} }));
    const r = await readCodexLogin(env(), fs);
    expect(r.state).toBe("error");
    if (r.state === "error") expect(r.error).toMatch(/Run the sign-in command again/);
  });

  it("removes only Yo's copy", async () => {
    const fs = new FakeFs().add(YO_AUTH, LOGIN).add(`${HOME}/.codex/auth.json`, LOGIN);
    await removeCodexLogin(env(), fs);
    expect(fs.files.has(YO_AUTH)).toBe(false);
    expect(fs.files.has(`${HOME}/.codex/auth.json`)).toBe(true);
  });
});

/* ------------------------------ ConnectService ------------------------------ */

const account = (provider: "claude" | "codex", id = `acc_${provider}`) => ({
  id,
  provider,
  label: provider,
  status: "unverified" as const,
  isDefault: false,
});

function fakeAccounts(over: Partial<Record<"connectWithSecrets" | "accountFor", any>> = {}) {
  const saved: { id: string; secrets: Record<string, string> }[] = [];
  const svc = {
    accountFor: vi.fn((p: "claude" | "codex", id?: string) => (id === "missing" ? null : account(p, id))),
    connectWithSecrets: vi.fn(async (id: string, secrets: Record<string, string>) => {
      saved.push({ id, secrets });
      return { ...account(id.includes("codex") ? "codex" : "claude", id) };
    }),
    ...over,
  };
  return { svc: svc as unknown as AccountService, saved, raw: svc };
}

const FAKE_TOKEN = `sk-ant-oat01-${"FAKE_test_token-".repeat(6)}`;

describe("ConnectService", () => {
  it("saves a pasted Claude token, cleaned up", async () => {
    const { svc, saved } = fakeAccounts();
    const c = new ConnectService(svc, () => env(), new FakeFs());
    const r = await c.claudeToken({ token: `export CLAUDE_CODE_OAUTH_TOKEN="${FAKE_TOKEN}"` });
    expect(r.ok).toBe(true);
    expect(saved).toEqual([{ id: "acc_claude", secrets: { claudeOauthToken: FAKE_TOKEN } }]);
  });

  it("returns errors instead of throwing, and never echoes the token", async () => {
    const boom = new Error(`db failed for ${FAKE_TOKEN}`);
    const { svc } = fakeAccounts({ connectWithSecrets: vi.fn().mockRejectedValue(boom) });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const c = new ConnectService(svc, () => env(), new FakeFs());
      const bad = await c.claudeToken({ token: "nope" });
      expect(bad).toEqual({ ok: false, error: expect.stringMatching(/sk-ant-oat/) });
      const failed = await c.claudeToken({ token: FAKE_TOKEN });
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error).not.toContain(FAKE_TOKEN);
      expect(await c.claudeToken({ token: FAKE_TOKEN, accountId: "missing" })).toMatchObject({ ok: false });
      expect(await c.claudeToken(undefined as any)).toMatchObject({ ok: false });
      const logged = stderr.mock.calls.map((a) => String(a[0])).join("");
      expect(logged).not.toContain(FAKE_TOKEN);
    } finally {
      stderr.mockRestore();
    }
  });

  it("imports the dedicated Codex login once, then removes it", async () => {
    const fs = new FakeFs();
    const { svc, saved } = fakeAccounts();
    const c = new ConnectService(svc, () => env(), fs);
    expect(await c.codexImport()).toEqual({ state: "waiting" });
    fs.add(YO_AUTH, LOGIN);
    // Overlapping polls share one import.
    const [a, b] = await Promise.all([c.codexImport(), c.codexImport()]);
    expect(a.state).toBe("connected");
    expect(b).toBe(a);
    expect(saved).toEqual([{ id: "acc_codex", secrets: { codexAuthJson: LOGIN } }]);
    expect(fs.files.has(YO_AUTH)).toBe(false);
    expect(await c.codexImport()).toEqual({ state: "waiting" });
  });

  it("keeps the login file when saving fails, so the next poll can retry", async () => {
    const fs = new FakeFs().add(YO_AUTH, LOGIN);
    const { svc } = fakeAccounts({ connectWithSecrets: vi.fn().mockRejectedValue(new Error("disk full")) });
    const r = await new ConnectService(svc, () => env(), fs).codexImport();
    expect(r).toEqual({ state: "error", error: expect.stringMatching(/Try again/) });
    expect(fs.files.has(YO_AUTH)).toBe(true);
  });

  it("detect never throws", async () => {
    const fs = new FakeFs();
    fs.exists = () => Promise.reject(new Error("boom"));
    const d = await new ConnectService(fakeAccounts().svc, () => env(), fs).detect();
    expect(d.claude.installed).toBe(false);
  });

  it("lists the secrets inside a Codex login for log scrubbing", () => {
    expect(codexSecretValues(LOGIN).sort()).toEqual([
      "FAKE_access_123",
      "FAKE_id_token_123",
      "FAKE_refresh_123",
    ]);
    expect(codexSecretValues("{oops")).toEqual([]);
  });
});
