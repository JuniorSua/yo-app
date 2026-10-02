/**
 * Fake Claude Agent SDK `query()` for adapter tests. Produces realistic SDKMessage sequences
 * (shapes recorded from claude-agent-sdk 0.3.285 / Claude Code 2.1.285) and honors
 * canUseTool, PreToolUse hooks, interrupt(), setModel(), setPermissionMode().
 *
 * Scenarios by prompt text:
 *   default     → text stream, Bash `ls -la` (permission via canUseTool unless bypassPermissions),
 *                 mcp__browser__browser_navigate (text + screenshot result), TodoWrite, final text.
 *   "ask"       → AskUserQuestion via PreToolUse hook (or canUseTool), echoes the answer.
 *   "interrupt" → streams text until interrupt(), then an error_during_execution result.
 *   "leak"      → Bash output echoes CLAUDE_CODE_OAUTH_TOKEN from the options env.
 *   "rate"      → emits a rejected rate_limit_event and an assistant rate_limit error.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Msg = Record<string, unknown>;
type AnyFn = (...args: any[]) => any;

export interface FakeClaudeCall {
  options: Record<string, any>;
  /** User messages received through the streaming prompt. */
  prompts: Msg[];
  query: FakeQuery;
}

export interface FakeQuery extends AsyncGenerator<Msg, void> {
  interrupt(): Promise<undefined>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: string): Promise<void>;
  initializationResult(): Promise<Msg>;
  supportedModels(): Promise<Msg[]>;
  close(): void;
  readonly model?: string;
  readonly permissionMode?: string;
}

export const FAKE_CLAUDE_INIT = {
  commands: [],
  agents: [],
  output_style: "default",
  available_output_styles: ["default"],
  models: [
    {
      value: "default",
      displayName: "Default (recommended)",
      description: "Sonnet 5.5",
      supportedEffortLevels: ["low", "medium", "high"],
    },
    {
      value: "opus",
      displayName: "Opus",
      description: "Opus 5.5",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    { value: "haiku", displayName: "Haiku", description: "Haiku 4.5" },
  ],
  account: {
    email: "fake@example.com",
    subscriptionType: "max",
    tokenSource: "claude.ai",
    apiProvider: "firstParty",
  },
};

class Channel<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(v: T) {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  next(): Promise<IteratorResult<T>> {
    const v = this.items.shift();
    if (v !== undefined) return Promise.resolve({ value: v, done: false });
    if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((r) => this.waiters.push(r));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a fake `query`. Every call is recorded in `calls` (options + received prompts).
 */
export function createFakeClaudeQuery(opts: { delayMs?: number } = {}) {
  const calls: FakeClaudeCall[] = [];

  const query = (params: {
    prompt: string | AsyncIterable<Msg>;
    options?: Record<string, any>;
  }): FakeQuery => {
    const options = params.options ?? {};
    const out = new Channel<Msg>();
    const sessionId: string = options.resume ?? options.sessionId ?? randomUUID();
    let model: string = options.model ?? "claude-sonnet-5-5";
    let permissionMode: string = options.permissionMode ?? "default";
    let interruptSignal: (() => void) | undefined;
    let interrupted = false;
    let initSent = false;
    let closed = false;
    const abort = new AbortController();
    let costSoFar = 0;

    const base = () => ({ session_id: sessionId, uuid: randomUUID() });
    const emit = (m: Msg) => {
      if (!closed) out.push({ ...base(), ...m });
    };
    const stream = (event: Msg) => emit({ type: "stream_event", event, parent_tool_use_id: null });

    const streamText = async (text: string, chunks: string[]) => {
      const id = `msg_${randomUUID().slice(0, 8)}`;
      stream({
        type: "message_start",
        message: { id, type: "message", role: "assistant", model, content: [] },
      });
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      });
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } });
      stream({ type: "content_block_stop", index: 0 });
      stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
      for (const c of chunks) {
        stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: c } });
        if (opts.delayMs) await sleep(opts.delayMs);
      }
      emit({
        type: "assistant",
        message: { id, role: "assistant", model, content: [{ type: "text", text }] },
        parent_tool_use_id: null,
      });
      stream({ type: "content_block_stop", index: 1 });
      stream({ type: "message_delta", delta: { stop_reason: "end_turn" } });
      stream({ type: "message_stop" });
    };

    const toolUse = (name: string, input: Msg) => {
      const id = `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const mid = `msg_${randomUUID().slice(0, 8)}`;
      stream({ type: "message_start", message: { id: mid, content: [] } });
      stream({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id, name, input: {} },
      });
      stream({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      });
      emit({
        type: "assistant",
        message: { id: mid, role: "assistant", model, content: [{ type: "tool_use", id, name, input }] },
        parent_tool_use_id: null,
      });
      stream({ type: "content_block_stop", index: 0 });
      return id;
    };

    const toolResult = (id: string, content: unknown, isError = false, toolUseResult?: unknown) =>
      emit({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
          ],
        },
        parent_tool_use_id: null,
        ...(toolUseResult !== undefined ? { tool_use_result: toolUseResult } : {}),
      });

    const permission = async (
      name: string,
      input: Msg,
      toolUseID: string,
    ): Promise<{ allow: boolean; input: Msg }> => {
      // PreToolUse hooks run in every mode.
      const matchers = (options.hooks?.PreToolUse ?? []) as { matcher?: string; hooks: AnyFn[] }[];
      for (const m of matchers) {
        if (m.matcher && !new RegExp(`^(${m.matcher})$`).test(name)) continue;
        for (const h of m.hooks) {
          const r = await h(
            { hook_event_name: "PreToolUse", tool_name: name, tool_input: input, tool_use_id: toolUseID },
            toolUseID,
            { signal: abort.signal },
          );
          const hso = r?.hookSpecificOutput;
          if (hso?.permissionDecision === "deny") return { allow: false, input };
          if (hso?.updatedInput) input = hso.updatedInput;
          if (hso?.permissionDecision === "allow" && name === "AskUserQuestion")
            return { allow: true, input };
        }
      }
      if (permissionMode === "bypassPermissions") return { allow: true, input };
      if (permissionMode === "acceptEdits" && ["Edit", "Write"].includes(name)) return { allow: true, input };
      if (!options.canUseTool) return { allow: true, input };
      const r = await options.canUseTool(name, input, {
        signal: abort.signal,
        suggestions: [
          { type: "addRules", rules: [{ toolName: name }], behavior: "allow", destination: "session" },
        ],
        toolUseID,
        title: `Claude wants to use ${name}`,
      });
      return r.behavior === "allow"
        ? { allow: true, input: r.updatedInput ?? input }
        : { allow: false, input };
    };

    const result = (userUuid: string, ok = true) => {
      costSoFar += 0.01;
      emit({
        type: "result",
        subtype: ok ? "success" : "error_during_execution",
        is_error: !ok,
        duration_ms: 10,
        duration_api_ms: 8,
        num_turns: 1,
        result: ok ? "done" : "",
        stop_reason: ok ? "end_turn" : null,
        total_cost_usd: costSoFar,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        errors: ok ? [] : ["interrupted"],
        user_message_uuids: [userUuid],
        queued_turn_count: 0,
      });
    };

    async function runTurn(msg: Msg) {
      const content = (msg.message as Msg)?.content;
      const text = Array.isArray(content)
        ? content.map((b: Msg) => b.text ?? "").join(" ")
        : String(content ?? "");
      const userUuid = String(msg.uuid ?? randomUUID());
      interrupted = false;
      if (!initSent) {
        initSent = true;
        emit({
          type: "system",
          subtype: "init",
          cwd: options.cwd,
          model,
          permissionMode,
          tools: ["Bash", "Edit", "Read", "AskUserQuestion", "TodoWrite"],
          mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: "connected" })),
          apiKeySource: "none",
          claude_code_version: "2.1.285",
          slash_commands: [],
          output_style: "default",
          skills: [],
          plugins: [],
        });
      }

      if (/interrupt/i.test(text)) {
        const id = `msg_${randomUUID().slice(0, 8)}`;
        stream({ type: "message_start", message: { id, content: [] } });
        stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        const stopped = new Promise<void>((r) => {
          interruptSignal = r;
        });
        for (let i = 0; i < 500 && !interrupted; i++) {
          stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "." } });
          await Promise.race([sleep(10), stopped]);
        }
        stream({ type: "content_block_stop", index: 0 });
        result(userUuid, false);
        return;
      }

      if (/rate/i.test(text)) {
        emit({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            resetsAt: 1790000000,
            rateLimitType: "five_hour",
            utilization: 1,
          },
        });
        emit({
          type: "assistant",
          message: {
            id: "msg_rl",
            role: "assistant",
            model,
            content: [{ type: "text", text: "Limit reached" }],
          },
          parent_tool_use_id: null,
          error: "rate_limit",
        });
        result(userUuid, false);
        return;
      }

      if (/ask/i.test(text)) {
        const input = {
          questions: [
            {
              question: "Which color?",
              header: "Color",
              options: [
                { label: "Red", description: "Warm" },
                { label: "Blue", description: "Cool" },
              ],
              multiSelect: false,
            },
          ],
        };
        const id = toolUse("AskUserQuestion", input);
        const p = await permission("AskUserQuestion", input, id);
        const answers = (p.input.answers ?? {}) as Record<string, string>;
        if (!p.allow) toolResult(id, "The user dismissed the question.", true);
        else
          toolResult(
            id,
            `Your questions have been answered: "Which color?"="${answers["Which color?"]}".`,
            false,
            { questions: input.questions, answers },
          );
        await streamText(`You picked ${answers["Which color?"] ?? "nothing"}`, [
          "You picked ",
          answers["Which color?"] ?? "nothing",
        ]);
        result(userUuid);
        return;
      }

      await streamText("Hello there", ["Hello", " there"]);
      const leak = /leak/i.test(text);
      const bashInput = {
        command: leak ? "echo $CLAUDE_CODE_OAUTH_TOKEN" : "ls -la",
        description: "List files",
      };
      const bashId = toolUse("Bash", bashInput);
      const p = await permission("Bash", bashInput, bashId);
      if (!p.allow) toolResult(bashId, "Permission to use Bash has been denied.", true);
      else toolResult(bashId, leak ? `token=${options.env?.CLAUDE_CODE_OAUTH_TOKEN ?? ""}` : "file1\nfile2");

      const navInput = { url: "https://www.amazon.com/" };
      const navId = toolUse("mcp__browser__browser_navigate", navInput);
      await permission("mcp__browser__browser_navigate", navInput, navId);
      toolResult(navId, [
        { type: "text", text: "### Page\n- Page URL: https://www.amazon.com/" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
      ]);

      const todoInput = {
        todos: [
          { content: "Open Amazon", status: "completed", activeForm: "Opening Amazon" },
          { content: "Find the item", status: "in_progress", activeForm: "Finding the item" },
        ],
      };
      const todoId = toolUse("TodoWrite", todoInput);
      toolResult(todoId, "Todos have been modified successfully.");

      await streamText("Done.", ["Done."]);
      result(userUuid);
    }

    // Consume the streaming prompt.
    const prompts: Msg[] = [];
    const turnQueue: Msg[] = [];
    let running = false;
    const pump = async () => {
      if (running) return;
      running = true;
      while (turnQueue.length && !closed) {
        await runTurn(turnQueue.shift()!);
      }
      running = false;
    };
    if (typeof params.prompt !== "string") {
      void (async () => {
        for await (const m of params.prompt as AsyncIterable<Msg>) {
          prompts.push(m);
          turnQueue.push(m);
          void pump();
        }
        await sleep(0);
        if (!running) {
          closed = true;
          out.close();
        }
      })();
    }
    options.abortController?.signal?.addEventListener("abort", () => {
      closed = true;
      out.close();
    });

    const q: FakeQuery = {
      next: () => out.next(),
      return: async () => {
        closed = true;
        out.close();
        return { value: undefined, done: true };
      },
      throw: async (e: unknown) => {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async [Symbol.asyncDispose]() {},
      async interrupt() {
        interrupted = true;
        interruptSignal?.();
        return undefined;
      },
      async setModel(m?: string) {
        model = m ?? model;
      },
      async setPermissionMode(mode: string) {
        permissionMode = mode;
      },
      async initializationResult() {
        return FAKE_CLAUDE_INIT;
      },
      async supportedModels() {
        return FAKE_CLAUDE_INIT.models;
      },
      close() {
        closed = true;
        abort.abort();
        out.close();
      },
      get model() {
        return model;
      },
      get permissionMode() {
        return permissionMode;
      },
    } as FakeQuery;
    calls.push({ options, prompts, query: q });
    return q;
  };

  return { query, calls };
}

/**
 * Replay a JSONL recording of raw SDK messages (captured with scripts/live-smoke.ts YO_DUMP=...):
 * everything is emitted after the first user message arrives.
 */
export function createReplayClaudeQuery(jsonlPath: string) {
  const messages = readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Msg);
  const calls: { options: Record<string, any> }[] = [];
  const query = (params: { prompt: string | AsyncIterable<Msg>; options?: Record<string, any> }) => {
    calls.push({ options: params.options ?? {} });
    const out = new Channel<Msg>();
    void (async () => {
      const it = (params.prompt as AsyncIterable<Msg>)[Symbol.asyncIterator]();
      const first = await it.next();
      const uuid = (first.value as Msg | undefined)?.uuid;
      for (const m of messages) {
        out.push(m.type === "result" && uuid ? { ...m, user_message_uuids: [uuid] } : m);
        await sleep(0);
      }
    })();
    return {
      next: () => out.next(),
      return: async () => ({ value: undefined, done: true }),
      throw: async (e: unknown) => {
        throw e;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      async initializationResult() {
        return FAKE_CLAUDE_INIT;
      },
      close() {
        out.close();
      },
    };
  };
  return { query, calls };
}

/** Live recording (Claude Code 2.1.285, Haiku 4.5, full-access): AskUserQuestion answered "Blue". */
export const CLAUDE_ASK_FIXTURE = fileURLToPath(new URL("./fixtures/claude-ask-user.jsonl", import.meta.url));
