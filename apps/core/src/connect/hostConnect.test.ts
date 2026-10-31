import { describe, expect, it } from "vitest";
import { ConnectService } from "./ConnectService";
import { cliDirs, detectHost, findCli, type HostEnv, type HostFs } from "./hostConnect";

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
  async listDir(p: string) {
    const names = [...this.files.keys()]
      .filter((f) => f.startsWith(`${p}/`))
      .map((f) => f.slice(p.length + 1).split("/")[0]!);
    return [...new Set(names)];
  }
}

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
      codex: { installed: false, signedIn: false },
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
    expect(d.codex).toEqual({ installed: true, signedIn: true });
    // The user's own Codex login is only checked for existence, never read.
    expect(fs.reads).not.toContain(`${HOME}/.codex/auth.json`);
    // And nothing it returns carries a path or the account.
    expect(JSON.stringify(d)).not.toMatch(/fake-user|example\.invalid|FAKE_/);
  });

  it("finds CLIs installed with npm under nvm, and with the standalone installers", async () => {
    const fs = new FakeFs()
      .add(`${HOME}/.nvm/versions/node/v22.11.0/bin/codex`, "", true)
      .add(`${HOME}/.local/bin/claude`, "", true);
    expect(await findCli("codex", env(), fs)).toBe(true);
    expect(await findCli("claude", env(), fs)).toBe(true);
    expect(await findCli("codex", env(), new FakeFs())).toBe(false);
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

  it("never reads the old walkthrough's Codex folder (ChatGPT signs in on Yo's computer now)", async () => {
    const fs = new FakeFs().add(`${HOME}/.yo/codex/auth.json`, LOGIN);
    const d = await detectHost(env(), fs);
    expect(d.codex).toEqual({ installed: false, signedIn: false });
    expect(fs.reads.filter((p) => p.includes(".yo"))).toEqual([]);
  });
});

describe("ConnectService", () => {
  it("imports nothing: every provider signs in on Yo's computer", () => {
    const c = new ConnectService(() => env(), new FakeFs()) as unknown as Record<string, unknown>;
    expect(c.claudeToken).toBeUndefined();
    expect(c.codexImport).toBeUndefined();
  });

  it("detect never throws", async () => {
    const fs = new FakeFs();
    fs.exists = () => Promise.reject(new Error("boom"));
    const d = await new ConnectService(() => env(), fs).detect();
    expect(d.claude.installed).toBe(false);
    expect(d.codex).toEqual({ installed: false, signedIn: null });
  });
});
