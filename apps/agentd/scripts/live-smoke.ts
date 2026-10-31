/**
 * Live smoke test for the provider adapters against the HOST's existing logins.
 *
 *   YO_LIVE=1 pnpm --filter @yo/agentd exec tsx scripts/live-smoke.ts [claude|codex|all]
 *
 * Cheap on purpose (protects the user's Claude Max limits):
 *  - Claude: probe (no tokens) + 2 Haiku turns ("pong", then a resumed second turn).
 *  - Codex: read-only `account/read` + `model/list` against ~/.codex (no config.toml is written).
 * Nothing here prints secrets; emails are masked.
 */

import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEvent } from "@yo/contracts";
import { type ClaudeQueryFn, createClaudeAdapter } from "../src/providers/claude/ClaudeAdapter";
import { createCodexAdapter } from "../src/providers/codex/CodexAdapter";
import type { AccountContext } from "../src/providers/ProviderAdapter";

if (process.env.YO_LIVE !== "1") {
  console.log("live-smoke: set YO_LIVE=1 to run (uses your real subscriptions).");
  process.exit(0);
}

const which = process.argv[2] ?? "all";
const mask = (e?: string) => (e ? e.replace(/^(.).*(@.*)$/, "$1***$2") : e);

function summarize(ev: ProviderEvent): string {
  switch (ev.type) {
    case "content.delta":
      return `content.delta(${JSON.stringify(ev.delta)})`;
    case "item.started":
    case "item.completed":
      return `${ev.type}[${ev.item.kind}${ev.item.text ? `:${JSON.stringify(ev.item.text.slice(0, 40))}` : ""}${ev.item.title ? ` "${ev.item.title}"` : ""}]`;
    case "turn.completed":
      return `turn.completed{${ev.status}, usage=${JSON.stringify(ev.usage)}, cursor=${JSON.stringify(ev.resumeCursor)}}`;
    case "session.state":
      return `session.state(${ev.state})`;
    case "rate_limit":
      return `rate_limit(${JSON.stringify(ev.info)})`;
    case "request.opened":
      return `request.opened(${ev.request.kind}: ${ev.request.title})`;
    case "request.resolved":
      return `request.resolved(${ev.decision})`;
    case "runtime.error":
      return `runtime.error(${ev.message})`;
    default:
      return ev.type;
  }
}

/** Tee raw SDK messages to a JSONL file (used to refresh testkit fixtures). */
function recordingQuery(file: string): ClaudeQueryFn {
  return (params) => {
    const q = sdkQuery(params);
    const tee = (async function* () {
      for await (const m of q) {
        appendFileSync(file, `${JSON.stringify(m)}\n`);
        yield m;
      }
    })();
    return new Proxy(q, {
      get(target, prop) {
        if (prop === Symbol.asyncIterator) return () => tee;
        if (prop === "next") return tee.next.bind(tee);
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };
}

async function claude() {
  console.log("\n=== Claude (host login, no CLAUDE_CONFIG_DIR) ===");
  const events: ProviderEvent[] = [];
  let resolveTurn: (() => void) | undefined;
  const hostClaude = process.env.YO_CLAUDE_BIN ?? execSync("command -v claude", { encoding: "utf8" }).trim();
  const adapter = createClaudeAdapter(
    {
      emit: (k, ev) => {
        events.push(ev);
        if (ev.type === "turn.completed") resolveTurn?.();
        // Auto-answer AskUserQuestion with the first option (claude-ask mode).
        if (ev.type === "request.opened" && ev.request.kind === "user_input") {
          const answers = Object.fromEntries(
            (ev.request.questions ?? []).map((q) => [
              q.question,
              q.options[1]?.label ?? q.options[0]?.label ?? "Blue",
            ]),
          );
          setTimeout(
            () => void adapter.respond(k, { requestId: ev.request.requestId, decision: "allow", answers }),
            300,
          );
        }
      },
      log: (m) => process.env.YO_DEBUG && console.log("[log]", m),
    },
    {
      executablePath: hostClaude,
      ...(process.env.YO_DUMP ? { query: recordingQuery(process.env.YO_DUMP) } : {}),
    },
  );
  // Empty configDir => the CLI's default config (the host login). Only for this smoke test.
  const account: AccountContext = { accountId: "host", provider: "claude", configDir: "", secrets: {} };

  const t0 = Date.now();
  const status = await adapter.probe(account);
  console.log(`probe (${Date.now() - t0}ms):`, {
    ...status,
    email: mask(status.email),
    label: status.label?.replace(/\(.*\)/, "(…)"),
  });
  const models = await adapter.listModels(account);
  console.log("models:", models.map((m) => `${m.id}${m.isDefault ? "*" : ""}`).join(", "));
  if (which === "claude-probe") return;

  const runTurn = async (sessionKey: string, turnId: string, text: string) => {
    const done = new Promise<void>((r) => (resolveTurn = r));
    const start = events.length;
    await adapter.sendTurn(sessionKey, turnId, [{ type: "text", text }]);
    await Promise.race([
      done,
      new Promise((_, rej) => setTimeout(() => rej(new Error("turn timeout")), 120_000)),
    ]);
    await new Promise((r) => setTimeout(r, 200));
    return events.slice(start);
  };

  const base = {
    agentId: "live",
    account,
    model: "claude-haiku-4-5-20251001",
    runtimeMode: "full-access" as const,
    systemAppend: "",
    cwd: "/tmp",
    env: {},
    mcpServers: [],
  };
  if (which === "claude-ask") {
    // One turn: full-access mode, the model must ask via AskUserQuestion; we answer the 2nd option.
    await adapter.startSession({ ...base, sessionKey: "live-ask" });
    const t = await runTurn(
      "live-ask",
      "turn-ask",
      "Use the AskUserQuestion tool once to ask me: 'Which color?' with exactly two options, Red and Blue. Then reply with only the color I picked.",
    );
    console.log("ask turn:", t.map(summarize).join("\n  "));
    await adapter.stopSession("live-ask");
    return;
  }
  await adapter.startSession({ ...base, sessionKey: "live-1" });
  const t1 = await runTurn("live-1", "turn-1", "Reply with exactly: pong");
  console.log("turn 1:", t1.map(summarize).join("\n  "));
  const cursor = [...t1].reverse().find((e) => e.type === "turn.completed" && e.resumeCursor);
  await adapter.stopSession("live-1");

  const resumeCursor = cursor?.type === "turn.completed" ? cursor.resumeCursor : undefined;
  const r = await adapter.startSession({ ...base, sessionKey: "live-2", resumeCursor });
  console.log("resumed:", r.resumed);
  const t2 = await runTurn(
    "live-2",
    "turn-2",
    "What exact word did you reply with last time? Answer with that one word only.",
  );
  console.log("turn 2:", t2.map(summarize).join("\n  "));
  await adapter.stopSession("live-2");
  await adapter.dispose();
}

async function codex() {
  console.log("\n=== Codex (host ~/.codex, read-only) ===");
  const adapter = createCodexAdapter(
    { emit: () => {}, log: (m) => process.env.YO_DEBUG && console.log("[log]", m) },
    { writeConfig: false },
  );
  const account: AccountContext = {
    accountId: "host",
    provider: "codex",
    configDir: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    secrets: {},
  };
  console.log("version:", await adapter.version());
  const status = await adapter.probe(account);
  console.log("probe:", {
    ...status,
    email: mask(status.email),
    label: status.label?.replace(/\(.*\)/, "(…)"),
  });
  const models = await adapter.listModels(account);
  console.log(
    "models:",
    models.map((m) => `${m.id}${m.isDefault ? "*" : ""}[${m.efforts?.join("/") ?? ""}]`).join(", "),
  );
  await adapter.dispose();
}

try {
  if (which.startsWith("claude") || which === "all") await claude();
  if (which === "codex" || which === "all") await codex();
  process.exit(0);
} catch (err) {
  console.error("live-smoke failed:", err);
  process.exit(1);
}
