#!/usr/bin/env -S node --import tsx
/**
 * Fake Grok Build CLI.
 *
 *   --version                      → "grok 1.0.44-fake"
 *   models                         → `grok models` text (FAKE_GROK_AUTH=none → not authenticated)
 *   login --device-auth            → prints a device URL + code, exits 0
 *   agent [flags] stdio            → ACP agent (AgentSideConnection) with a scripted prompt turn:
 *       default     → thought chunk, "Hello from Grok" chunks, plan, `ls` tool call with
 *                     session/request_permission (unless --always-approve / yoloMode), usage.
 *       "ask"       → _x.ai/ask_user_question ext request, echoes the answer.
 *       "interrupt" → streams until session/cancel → stopReason "cancelled".
 * Env: FAKE_GROK_LOG=<file> appends received requests (JSONL).
 */
import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
  type Agent,
  AgentSideConnection,
  type InitializeResponse,
  ndJsonStream,
  RequestError,
} from "@agentclientprotocol/sdk";

const argv = process.argv.slice(2);
const log = (entry: unknown) => {
  if (process.env.FAKE_GROK_LOG) appendFileSync(process.env.FAKE_GROK_LOG, `${JSON.stringify(entry)}\n`);
};

if (argv.includes("--version")) {
  process.stdout.write("grok 1.0.44-fake (000000)\n");
  process.exit(0);
}
if (argv[0] === "models") {
  const authed = process.env.FAKE_GROK_AUTH !== "none";
  process.stdout.write(
    `${authed ? "You are logged in with grok.com." : "You are not authenticated."}\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n`,
  );
  process.exit(0);
}
if (argv[0] === "login") {
  process.stdout.write(
    "\nTo sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234\n\nConfirm this code in your browser:\n\n  WXYZ-1234\n\nWaiting for authorization...\n",
  );
  setTimeout(() => {
    process.stdout.write("Logged in.\n");
    process.exit(0);
  }, 150);
} else if (argv[0] === "agent" && argv.includes("stdio")) {
  runAgent();
} else {
  process.stderr.write(`fake grok: unsupported args ${argv.join(" ")}\n`);
  process.exit(2);
}

function runAgent() {
  const alwaysApprove = argv.includes("--always-approve");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const sessions = new Map<string, { yolo: boolean; cancelled: boolean; cancel?: () => void }>();
  let n = 0;

  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );

  new AgentSideConnection((conn) => {
    const update = (sessionId: string, u: Record<string, unknown>) =>
      conn.sessionUpdate({ sessionId, update: u as never });

    const agent: Agent = {
      async initialize(): Promise<InitializeResponse> {
        log({ method: "initialize", argv });
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } as never },
          authMethods: [{ id: "grok.com", name: "Grok", description: "Sign in with Grok" }],
          _meta: {
            agentVersion: "1.0.44-fake",
            modelState: {
              currentModelId: "grok-4.6",
              availableModels: [
                {
                  modelId: "grok-4.6",
                  name: "Grok 4.6",
                  description: "Latest",
                  _meta: {
                    supportsReasoningEffort: true,
                    reasoningEfforts: [
                      { id: "high", value: "high", default: true },
                      { id: "low", value: "low" },
                    ],
                  },
                },
                { modelId: "grok-4.5", name: "Grok 4.5" },
              ],
            },
          },
        };
      },
      async authenticate(params) {
        log({ method: "authenticate", params });
        return {};
      },
      async newSession(params) {
        log({ method: "session/new", params });
        if (process.env.FAKE_GROK_AUTH === "none") throw RequestError.authRequired();
        const sessionId = `ses_fake_${++n}`;
        const meta = (params._meta ?? {}) as Record<string, unknown>;
        sessions.set(sessionId, { yolo: meta.yoloMode === true || alwaysApprove, cancelled: false });
        return { sessionId };
      },
      async resumeSession(params) {
        log({ method: "session/resume", params });
        const meta = (params._meta ?? {}) as Record<string, unknown>;
        sessions.set(params.sessionId, { yolo: meta.yoloMode === true || alwaysApprove, cancelled: false });
        return {};
      },
      async loadSession(params) {
        log({ method: "session/load", params });
        sessions.set(params.sessionId, { yolo: alwaysApprove, cancelled: false });
        return {};
      },
      async setSessionConfigOption(params) {
        log({ method: "session/set_config_option", params });
        return { configOptions: [] };
      },
      async cancel(params) {
        log({ method: "session/cancel", params });
        const s = sessions.get(params.sessionId);
        if (s) {
          s.cancelled = true;
          s.cancel?.();
        }
      },
      async prompt(params) {
        log({ method: "session/prompt", params });
        const sid = params.sessionId;
        const s = sessions.get(sid);
        if (!s) throw RequestError.invalidParams(undefined, "unknown session");
        s.cancelled = false;
        const text = params.prompt.map((p) => ("text" in p ? p.text : "")).join(" ");

        if (/interrupt/i.test(text)) {
          const cancelled = new Promise<void>((r) => {
            s.cancel = r;
          });
          for (let i = 0; i < 200 && !s.cancelled; i++) {
            await update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
            await Promise.race([sleep(20), cancelled]);
          }
          return { stopReason: "cancelled" };
        }

        if (/ask/i.test(text)) {
          const res = (await conn.extMethod("_x.ai/ask_user_question", {
            sessionId: sid,
            toolCallId: "ask_1",
            mode: "default",
            questions: [
              {
                question: "Which color?",
                options: [{ label: "Red" }, { label: "Blue" }],
                multiSelect: false,
              },
            ],
          })) as { outcome: string; answers?: Record<string, string[]> };
          const picked = res.answers?.["Which color?"]?.[0] ?? "nothing";
          await update(sid, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `You picked ${picked}` },
          });
          return { stopReason: "end_turn" };
        }

        await update(sid, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Let me look." },
        });
        const echo = text.match(/^echo (.*)$/s)?.[1];
        for (const t of ["Hello", " from", " Grok"]) {
          await update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
        }
        await update(sid, {
          sessionUpdate: "plan",
          entries: [
            { content: "List files", priority: "high", status: "in_progress" },
            { content: "Report", priority: "medium", status: "pending" },
          ],
        });
        await update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "call_1",
          title: "ls -la",
          kind: "execute",
          status: "pending",
          rawInput: { command: "ls -la" },
        });
        let allowed = true;
        if (!s.yolo) {
          const perm = await conn.requestPermission({
            sessionId: sid,
            toolCall: {
              toolCallId: "call_1",
              title: "ls -la",
              kind: "execute",
              rawInput: { command: "ls -la" },
            },
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
              { optionId: "always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          });
          log({ method: "permission.result", outcome: perm.outcome });
          allowed = perm.outcome.outcome === "selected" && perm.outcome.optionId !== "reject";
        }
        await update(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: allowed ? "completed" : "failed",
          content: [
            {
              type: "content",
              content: { type: "text", text: allowed ? "file1\nfile2" : "Permission denied" },
            },
          ],
        });
        await update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "call_2",
          title: "mcp__browser__browser_click",
          name: "mcp__browser__browser_click",
          kind: "other",
          status: "in_progress",
          rawInput: { element: "Add to cart", ref: "e12" },
        });
        await update(sid, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_2",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "Clicked" } }],
        });
        await update(sid, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: echo ? ` ${echo}` : " Done." },
        });
        return {
          stopReason: "end_turn",
          usage: { totalTokens: 70, inputTokens: 50, outputTokens: 20, cachedReadTokens: 4 },
        };
      },
    };
    return agent;
  }, stream);
}
