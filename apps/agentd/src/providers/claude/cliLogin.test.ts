import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_LOGIN_FAILED_TAIL,
  CLAUDE_LOGIN_STATE,
  CLAUDE_LOGIN_SUCCESS_TAIL,
  CLAUDE_LOGIN_URL,
  claudeLoginPrompt,
  FAKE_CLAUDE_LOGIN_CODE,
} from "@yo/testkit";
import { describe, expect, it, vi } from "vitest";
import type { LoginCallbacks } from "../ProviderAdapter";
import { stripAnsi } from "../shared/ansi";
import type { PtyProcess, PtySpawn } from "../shared/process";
import { account, recorder, tempDir } from "../shared/testUtil";
import { type ClaudeQueryFn, createClaudeAdapter } from "./ClaudeAdapter";
import { CLAUDE_LOGIN_ARGS, findAuthorizeUrl, findLoginError, runClaudeCliLogin } from "./cliLogin";

type Result = Parameters<LoginCallbacks["result"]>[0];

describe("claude auth login output", () => {
  it("strips ANSI, keeping one copy of the link and the paste prompt", () => {
    for (const terminator of ["bel", "st"] as const) {
      const clean = stripAnsi(claudeLoginPrompt({ terminator }).join(""));
      expect(clean).toContain("Opening browser to sign in…");
      expect(clean).toContain("Paste code here if prompted >");
      expect(clean).not.toContain("\u001b");
      expect(clean.split(CLAUDE_LOGIN_URL)).toHaveLength(2);
    }
  });

  it("finds the whole link in the OSC 8 hyperlink, whichever way it ends (BEL or ESC \\)", () => {
    expect(findAuthorizeUrl(claudeLoginPrompt({ terminator: "bel" }).join(""))).toBe(CLAUDE_LOGIN_URL);
    expect(findAuthorizeUrl(claudeLoginPrompt({ terminator: "st" }).join(""))).toBe(CLAUDE_LOGIN_URL);
  });

  it("never takes a link cut off at a chunk boundary", () => {
    const full = claudeLoginPrompt({ terminator: "st" }).join("");
    const linkStart = full.indexOf("https://");
    // Every prefix of the output: either no link yet, or exactly the whole one (never a truncated or doubled one).
    for (let i = 0; i <= full.length; i += 7) {
      const found = findAuthorizeUrl(full.slice(0, i));
      if (found !== undefined) expect(found).toBe(CLAUDE_LOGIN_URL);
      if (i < linkStart + CLAUDE_LOGIN_URL.length) expect(found).toBeUndefined();
    }
  });

  it("finds a plain-text link too (no hyperlink), once its line has arrived", () => {
    expect(findAuthorizeUrl(`visit: ${CLAUDE_LOGIN_URL}`)).toBeUndefined();
    expect(findAuthorizeUrl(`visit: ${CLAUDE_LOGIN_URL}\r\n`)).toBe(CLAUDE_LOGIN_URL);
  });

  it("recognizes Claude Code's failure lines", () => {
    expect(findLoginError(stripAnsi(CLAUDE_LOGIN_FAILED_TAIL))).toBe(
      "Login failed: Request failed with status code 400",
    );
    expect(findLoginError("Paste code here if prompted > Login failed: boom\n")).toBe("Login failed: boom");
    expect(findLoginError("OAuth error: invalid_grant Press Enter to retry.\n")).toBe(
      "OAuth error: invalid_grant",
    );
    expect(findLoginError(stripAnsi(claudeLoginPrompt().join("")))).toBeUndefined();
  });
});

function fakePty(
  script: (p: { emit(d: string): void; exit(code: number): void; written: string[] }) => void,
): {
  spawn: PtySpawn;
  calls: { file: string; args: string[]; opts: Parameters<PtySpawn>[2] }[];
  written: string[];
  killed: () => boolean;
} {
  const calls: { file: string; args: string[]; opts: Parameters<PtySpawn>[2] }[] = [];
  const written: string[] = [];
  let killed = false;
  const spawn: PtySpawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    let onData: (d: string) => void = () => {};
    let onExit: (e: { exitCode: number }) => void = () => {};
    const p: PtyProcess = {
      onData: (cb) => {
        onData = cb;
      },
      onExit: (cb) => {
        onExit = cb;
      },
      write: (d) => {
        written.push(d);
      },
      kill: () => {
        killed = true;
      },
    };
    setTimeout(() => script({ emit: (d) => onData(d), exit: (c) => onExit({ exitCode: c }), written }), 0);
    return p;
  };
  return { spawn, calls, written, killed: () => killed };
}

/** Emits the prompt in small chunks (as a PTY does), then runs `after` once Enter was pressed. */
function loginPty(
  after: (p: { emit(d: string): void; exit(code: number): void }) => void,
  terminator?: "st",
) {
  return fakePty(({ emit, exit, written }) => {
    const out = claudeLoginPrompt({ terminator }).join("");
    for (let i = 0; i < out.length; i += 50) emit(out.slice(i, i + 50));
    const wait = setInterval(() => {
      if (written.includes("\r")) {
        clearInterval(wait);
        after({ emit, exit });
      }
    }, 5);
  });
}

function run(
  pty: ReturnType<typeof fakePty>,
  o: { code?: string; status?: { loggedIn?: boolean } | null; onPrompt?: (p: unknown) => void } = {},
) {
  const checkStatus = vi.fn(async () => (o.status === undefined ? { loggedIn: true } : o.status));
  const prompts: Parameters<LoginCallbacks["prompt"]>[0][] = [];
  const result = new Promise<Result>((resolve) => {
    const handle = runClaudeCliLogin({
      spawnPty: pty.spawn,
      executable: "/bundled/claude",
      env: { CLAUDE_CONFIG_DIR: "/data/accounts/claude/a1" },
      cwd: "/tmp",
      checkStatus,
      cb: {
        prompt: (p) => {
          prompts.push(p);
          o.onPrompt?.(p);
          if (prompts.length === 1 && o.code !== undefined) handle.input(o.code);
        },
        result: resolve,
      },
    });
  });
  return { result, prompts, checkStatus };
}

describe("Claude Code sign-in flow", () => {
  it("shows Claude's link, forwards the code, confirms with auth status, and returns no secrets", async () => {
    const pty = loginPty(({ emit, exit }) => {
      emit(CLAUDE_LOGIN_SUCCESS_TAIL);
      exit(0);
    });
    const { result, prompts, checkStatus } = run(pty, { code: `  ${FAKE_CLAUDE_LOGIN_CODE}\n` });
    const r = await result;
    expect(r).toEqual({ ok: true });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ url: CLAUDE_LOGIN_URL, needsInput: true });
    expect(prompts[0]!.message).toMatch(/Claude's page/);
    expect(pty.calls[0]).toMatchObject({
      file: "/bundled/claude",
      args: CLAUDE_LOGIN_ARGS,
      opts: { cols: 1000 },
    });
    expect(CLAUDE_LOGIN_ARGS).toEqual(["auth", "login", "--claudeai"]);
    expect(pty.written).toEqual([FAKE_CLAUDE_LOGIN_CODE, "\r"]);
    expect(checkStatus).toHaveBeenCalledTimes(1);
  });

  it("works with the ESC \\ hyperlink ending (Claude Code 2.1.285)", async () => {
    const pty = loginPty(({ exit }) => exit(0), "st");
    const { result, prompts } = run(pty, { code: FAKE_CLAUDE_LOGIN_CODE });
    expect(await result).toEqual({ ok: true });
    expect(prompts[0]!.url).toBe(CLAUDE_LOGIN_URL);
  });

  it("fails plainly when Claude turns the code down (real CLI output), without echoing it", async () => {
    const pty = loginPty(({ emit, exit }) => {
      emit(CLAUDE_LOGIN_FAILED_TAIL);
      setTimeout(() => exit(1), 20);
    });
    const { result, checkStatus } = run(pty, { code: FAKE_CLAUDE_LOGIN_CODE });
    const r = await result;
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Claude didn't accept that code (error 400)");
    expect(r.message).toContain("Try again");
    expect(r.message).not.toContain("FAKEcode");
    expect(r.secrets).toBeUndefined();
    expect(checkStatus).not.toHaveBeenCalled();
  });

  it("doesn't call it signed in when Claude Code says it isn't", async () => {
    const pty = loginPty(({ exit }) => exit(0));
    const r = await run(pty, { code: FAKE_CLAUDE_LOGIN_CODE, status: { loggedIn: false } }).result;
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/still isn't signed in/) });
  });

  it("trusts the CLI's exit 0 when the status check itself can't run", async () => {
    const pty = loginPty(({ exit }) => exit(0));
    expect(await run(pty, { code: FAKE_CLAUDE_LOGIN_CODE, status: null }).result).toEqual({ ok: true });
  });

  it("reports a CLI that stops before showing a link", async () => {
    const pty = fakePty(({ emit, exit }) => {
      emit("Error: something broke\r\n");
      exit(1);
    });
    const r = await run(pty).result;
    expect(r).toEqual({
      ok: false,
      message: "Claude's sign-in stopped: Error: something broke. Press Try again.",
    });
  });

  it("rejects a code copied from an older sign-in tab without sending it, and keeps the flow open", async () => {
    const pty = fakePty(({ emit }) => {
      for (const c of claudeLoginPrompt()) emit(c);
    });
    let finished = false;
    const prompts: { message?: string; url?: string }[] = [];
    const handle = runClaudeCliLogin({
      spawnPty: pty.spawn,
      executable: "claude",
      env: {},
      cwd: "/tmp",
      checkStatus: async () => ({ loggedIn: true }),
      cb: {
        prompt: (p) => {
          prompts.push(p);
          if (prompts.length === 1) handle.input("abc#some-other-state");
        },
        result: () => {
          finished = true;
        },
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(pty.written).toEqual([]);
    expect(prompts[1]?.message).toContain("older Claude sign-in tab");
    expect(prompts[1]?.url).toBe(CLAUDE_LOGIN_URL);
    expect(finished).toBe(false);
    // The matching code still goes through.
    handle.input(`code#${CLAUDE_LOGIN_STATE}`);
    expect(pty.written).toEqual([`code#${CLAUDE_LOGIN_STATE}`]);
    handle.cancel();
    expect(finished).toBe(true);
    expect(pty.killed()).toBe(true);
  });

  it("times out when no link shows up", async () => {
    const pty = fakePty(() => {});
    const r = await new Promise<Result>((resolve) =>
      runClaudeCliLogin({
        spawnPty: pty.spawn,
        executable: "claude",
        env: {},
        cwd: "/tmp",
        checkStatus: async () => ({ loggedIn: true }),
        urlTimeoutMs: 20,
        cb: { prompt: () => {}, result: resolve },
      }),
    );
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/sign-in link/) });
  });
});

/** A stand-in `claude` that records its args and the env it got, and answers `auth status --json`. */
function fakeClaudeBin(status: Record<string, unknown>) {
  const dir = tempDir("yo-fake-claude-");
  const logFile = join(dir, "calls.log");
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$* | token=\${CLAUDE_CODE_OAUTH_TOKEN:-none} | dir=$CLAUDE_CONFIG_DIR" >> "${logFile}"
case "$*" in
  "--version") echo "2.1.285 (Claude Code)";;
  "auth status --json") echo '${JSON.stringify(status)}';;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(logFile, "utf8").trim().split("\n") };
}

describe("ClaudeAdapter sign-in, sign-out and probe (Claude Code's own sign-in)", () => {
  it("login runs `auth login --claudeai` with the account's config dir, no token and no display", async () => {
    const fake = fakeClaudeBin({ loggedIn: true });
    const rec = recorder();
    const pty = loginPty(({ exit }) => exit(0));
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      { query: (() => {}) as unknown as ClaudeQueryFn, spawnPty: pty.spawn, executablePath: fake.bin },
    );
    const legacy = account("claude", { claudeOauthToken: `sk-ant-oat01-${"FAKElegacy".repeat(3)}` });
    const r = await new Promise<Result>((resolve) => {
      const handle = adapter.login(legacy, {
        prompt: () => void handle.then((h) => h.input(FAKE_CLAUDE_LOGIN_CODE)),
        result: resolve,
      });
    });
    expect(r).toEqual({ ok: true });
    const call = pty.calls.at(-1)!;
    expect(call.args).toEqual(["auth", "login", "--claudeai"]);
    expect(call.opts.env.CLAUDE_CONFIG_DIR).toBe(legacy.configDir);
    expect(call.opts.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(call.opts.env.DISPLAY).toBeUndefined();
    expect(call.opts.env.BROWSER).toBe("true");
    // The confirming status check asked Claude Code about its own sign-in, not the legacy token.
    expect(fake.calls()).toContain(`auth status --json | token=none | dir=${legacy.configDir}`);
    // Nothing logged carries the code.
    expect(rec.logs.join("\n")).not.toContain("FAKEcode");
  });

  it("logout runs `claude auth logout` in the account's config dir without the legacy token", async () => {
    const fake = fakeClaudeBin({ loggedIn: false });
    const rec = recorder();
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      { query: (() => {}) as unknown as ClaudeQueryFn, executablePath: fake.bin },
    );
    const acc = account("claude", { claudeOauthToken: `sk-ant-oat01-${"FAKElegacy".repeat(3)}` });
    await adapter.logout!(acc);
    expect(fake.calls()).toEqual([`auth logout | token=none | dir=${acc.configDir}`]);
  });

  it("probe: an account signed in with Claude Code (no token anywhere) is connected, with email and plan", async () => {
    const fake = fakeClaudeBin({ loggedIn: true, email: "fake@example.com", subscriptionType: "max" });
    const rec = recorder();
    // The SDK's init reports no account (as when it can't start): `claude auth status` decides.
    const query = (() => ({
      initializationResult: async () => ({ models: [] }),
      close: () => {},
    })) as unknown as ClaudeQueryFn;
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      { query, executablePath: fake.bin },
    );
    const acc = account("claude");
    const st = await adapter.probe(acc);
    expect(st).toMatchObject({ status: "authenticated", email: "fake@example.com", plan: "Claude Max" });
    expect(fake.calls()).toContain(`auth status --json | token=none | dir=${acc.configDir}`);
  });

  it("probe: signed in per Claude Code but no email or plan still counts as connected", async () => {
    const fake = fakeClaudeBin({ loggedIn: true });
    const rec = recorder();
    const query = (() => ({
      initializationResult: async () => ({ models: [] }),
      close: () => {},
    })) as unknown as ClaudeQueryFn;
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      { query, executablePath: fake.bin },
    );
    expect(await adapter.probe(account("claude"))).toMatchObject({
      status: "authenticated",
      label: "Claude subscription",
    });
  });

  it("probe: not signed in per Claude Code", async () => {
    const fake = fakeClaudeBin({ loggedIn: false });
    const rec = recorder();
    const query = (() => ({
      initializationResult: async () => ({ models: [] }),
      close: () => {},
    })) as unknown as ClaudeQueryFn;
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      { query, executablePath: fake.bin },
    );
    expect(await adapter.probe(account("claude"))).toMatchObject({ status: "unauthenticated" });
  });
});
