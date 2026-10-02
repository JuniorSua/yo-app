import { FAKE_OAUTH_TOKEN, SETUP_TOKEN_URL, setupTokenTranscript } from "@yo/testkit";
import { describe, expect, it, vi } from "vitest";
import type { LoginCallbacks } from "../ProviderAdapter";
import { stripAnsi } from "../shared/ansi";
import type { PtyProcess, PtySpawn } from "../shared/process";
import { recorder } from "../shared/testUtil";
import { type ClaudeQueryFn, createClaudeAdapter } from "./ClaudeAdapter";
import { findAuthorizeUrl, findLoginError, findOauthToken, runSetupToken } from "./setupToken";

describe("setup-token transcript parsing", () => {
  it("strips ANSI and restores cursor-spaced words", () => {
    const clean = stripAnsi(setupTokenTranscript().join(""));
    expect(clean).toContain("Welcome to Claude Code");
    expect(clean).toContain("Paste code here if prompted >");
    expect(clean).not.toContain("\u001b");
  });

  it("finds the authorize URL (OSC 8 hyperlink + plain text)", () => {
    const clean = stripAnsi(setupTokenTranscript().slice(0, 8).join(""));
    expect(findAuthorizeUrl(clean)).toBe(SETUP_TOKEN_URL);
  });

  it("extracts the token", () => {
    const clean = stripAnsi(setupTokenTranscript().join(""));
    expect(findOauthToken(clean)).toBe(FAKE_OAUTH_TOKEN);
  });

  it("joins a token wrapped across lines", () => {
    const clean = stripAnsi(setupTokenTranscript({ wrapAt: 40 }).join(""));
    expect(findOauthToken(clean)).toBe(FAKE_OAUTH_TOKEN);
  });

  it("does not glue the following word onto an unwrapped token", () => {
    expect(findOauthToken(`${FAKE_OAUTH_TOKEN}\nStore this token`)).toBe(FAKE_OAUTH_TOKEN);
  });

  it("ignores truncated tokens and recognizes errors", () => {
    expect(findOauthToken("sk-ant-oat01-short")).toBeUndefined();
    expect(findLoginError("OAuth error: invalid_grant\n")).toBe("OAuth error: invalid_grant");
  });
});

function fakePty(
  script: (p: { emit(d: string): void; exit(code: number): void; written: string[] }) => void,
): {
  spawn: PtySpawn;
  calls: { file: string; args: string[]; opts: Parameters<PtySpawn>[2] }[];
  written: string[];
} {
  const calls: { file: string; args: string[]; opts: Parameters<PtySpawn>[2] }[] = [];
  const written: string[] = [];
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
      kill: () => {},
    };
    setTimeout(() => script({ emit: (d) => onData(d), exit: (c) => onExit({ exitCode: c }), written }), 0);
    return p;
  };
  return { spawn, calls, written };
}

describe("setup-token login flow", () => {
  it("prompts with the URL, forwards the code, returns the token", async () => {
    const chunks = setupTokenTranscript();
    const pty = fakePty(({ emit, written }) => {
      for (const c of chunks.slice(0, 8)) emit(c);
      const wait = setInterval(() => {
        if (written.includes("\r")) {
          clearInterval(wait);
          for (const c of chunks.slice(8)) emit(c);
        }
      }, 5);
    });
    const prompt = vi.fn();
    const result = new Promise<Parameters<LoginCallbacks["result"]>[0]>((resolve) => {
      const handle = runSetupToken({
        spawnPty: pty.spawn,
        executable: "/bundled/claude",
        env: { CLAUDE_CONFIG_DIR: "/data/accounts/claude/a1" },
        cwd: "/tmp",
        cb: {
          prompt: (p) => {
            prompt(p);
            handle.input(`  the-code#${new URL(SETUP_TOKEN_URL).searchParams.get("state")}  `);
          },
          result: resolve,
        },
      });
    });
    const r = await result;
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ url: SETUP_TOKEN_URL, needsInput: true }));
    expect(pty.calls[0]).toMatchObject({
      file: "/bundled/claude",
      args: ["setup-token"],
      opts: { cols: 1000 },
    });
    expect(pty.written).toEqual([`the-code#${new URL(SETUP_TOKEN_URL).searchParams.get("state")}`, "\r"]);
    expect(r).toEqual({ ok: true, secrets: { claudeOauthToken: FAKE_OAUTH_TOKEN } });
  });

  it("reports failure when the CLI exits without a token", async () => {
    const pty = fakePty(({ emit, exit }) => {
      emit("OAuth error: Invalid code\r\n");
      exit(1);
    });
    const r = await new Promise<Parameters<LoginCallbacks["result"]>[0]>((resolve) => {
      runSetupToken({
        spawnPty: pty.spawn,
        executable: "claude",
        env: {},
        cwd: "/tmp",
        cb: { prompt: () => {}, result: resolve },
      });
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Invalid code");
  });

  it("fails fast (no hang) when the CLI rejects a pasted code and waits for Enter", async () => {
    const chunks = setupTokenTranscript();
    const pty = fakePty(({ emit, written }) => {
      for (const c of chunks.slice(0, 8)) emit(c);
      const wait = setInterval(() => {
        if (written.includes("\r")) {
          clearInterval(wait);
          // Real CLI output (captured): masked echo, then an error, then it waits for Enter forever.
          emit("\u001b[2K*********ate456\r\n");
          emit(
            "\u001b[31mOAuth error: Request failed with status code 400\u001b[39m Press Enter to retry.\r\n",
          );
        }
      }, 5);
    });
    const t0 = Date.now();
    const r = await new Promise<Parameters<LoginCallbacks["result"]>[0]>((resolve) => {
      const handle = runSetupToken({
        spawnPty: pty.spawn,
        executable: "claude",
        env: {},
        cwd: "/tmp",
        cb: {
          prompt: () => handle.input(`bad\ncode#${new URL(SETUP_TOKEN_URL).searchParams.get("state")}`),
          result: resolve,
        },
      });
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("didn't accept that code");
    expect(r.message).toContain("status code 400");
    expect(pty.written[0]).toBe(`badcode#${new URL(SETUP_TOKEN_URL).searchParams.get("state")}`);
  });

  it("rejects a code copied from an older sign-in tab without sending it, and keeps the flow open", async () => {
    const chunks = setupTokenTranscript();
    const pty = fakePty(({ emit }) => {
      for (const c of chunks.slice(0, 8)) emit(c);
    });
    const prompts: { message?: string; url?: string }[] = [];
    let finished = false;
    const handle = runSetupToken({
      spawnPty: pty.spawn,
      executable: "claude",
      env: {},
      cwd: "/tmp",
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
    expect(prompts[1]?.url).toBe(SETUP_TOKEN_URL);
    expect(finished).toBe(false);
    handle.cancel();
  });

  it("adapter.login uses CLAUDE_CONFIG_DIR, no token and no display", async () => {
    const rec = recorder();
    const pty = fakePty(({ exit }) => exit(1));
    const adapter = createClaudeAdapter(
      { emit: rec.emit, log: rec.log },
      {
        query: (() => {}) as unknown as ClaudeQueryFn,
        spawnPty: pty.spawn,
        executablePath: "/bundled/claude",
      },
    );
    const done = new Promise((resolve) =>
      adapter.login(
        {
          accountId: "a1",
          provider: "claude",
          configDir: "/data/accounts/claude/a1",
          secrets: { claudeOauthToken: "sk-ant-oat01-old" },
        },
        { prompt: () => {}, result: resolve },
      ),
    );
    await done;
    const env = pty.calls[0]!.opts.env;
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/accounts/claude/a1");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.DISPLAY).toBeUndefined();
    expect(env.BROWSER).toBe("true");
  });
});
