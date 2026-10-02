/**
 * Normalized provider runtime events.
 * Every provider adapter (one per ProviderKind) translates its native protocol into these.
 * Adapted from T3 Code's providerRuntime contracts (MIT).
 */
import { z } from "zod";

/** Every provider an adapter exists for. Not all of them are offered: see ENABLED_PROVIDERS. */
export const ProviderKind = z.enum(["claude", "codex", "grok"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

/**
 * The providers Yo offers, in display order. The single switch for what users can see, add, sign in to and
 * run on: core hides accounts of any other provider and never runs an agent on them; the web app filters
 * them out too. To bring a provider back, add it here.
 */
export const ENABLED_PROVIDERS: readonly ProviderKind[] = ["claude", "codex"];

export function isProviderEnabled(provider: string | null | undefined): provider is ProviderKind {
  return !!provider && (ENABLED_PROVIDERS as readonly string[]).includes(provider);
}

export const RuntimeMode = z.enum(["approval-required", "auto", "full-access"]);
export type RuntimeMode = z.infer<typeof RuntimeMode>;

export const ItemKind = z.enum([
  "user_message",
  "assistant_message",
  "reasoning",
  "command",
  "file_change",
  "tool",
  "browser",
  "web",
  "todo",
  "notice",
]);
export type ItemKind = z.infer<typeof ItemKind>;

export const ItemStatus = z.enum(["running", "completed", "failed"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const TodoEntry = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type TodoEntry = z.infer<typeof TodoEntry>;

export const Item = z.object({
  id: z.string(),
  kind: ItemKind,
  status: ItemStatus,
  /** Short human label, e.g. "Opened amazon.com" or "Ran `ls -la`". */
  title: z.string().optional(),
  /** Primary text content (assistant markdown, reasoning, command output...). */
  text: z.string().optional(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  output: z.string().optional(),
  todos: z.array(TodoEntry).optional(),
  /** Base64 PNG thumbnail (e.g. screenshot results). */
  image: z.string().optional(),
  /**
   * Assistant messages: snapshot of each picture they embed, taken when the message finished
   * (markdown src -> content-addressed name served at /api/chat-images/<name>). Keeps history showing
   * the picture it was written with even if the agent later overwrites the same file.
   */
  images: z.record(z.string(), z.string()).optional(),
});
export type Item = z.infer<typeof Item>;

export const Usage = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  costUsd: z.number().optional(),
  /**
   * Size of the context the model read on its LAST request of the turn (input incl. cached). The fields
   * above are summed over every request in a multi-step turn, so they can't tell how big the conversation is.
   */
  contextTokens: z.number().optional(),
});
export type Usage = z.infer<typeof Usage>;

export const UserQuestion = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).default([]),
  multiSelect: z.boolean().default(false),
});
export type UserQuestion = z.infer<typeof UserQuestion>;

export const PendingRequest = z.object({
  requestId: z.string(),
  kind: z.enum(["tool_approval", "user_input"]),
  toolName: z.string().optional(),
  title: z.string(),
  detail: z.string().optional(),
  input: z.unknown().optional(),
  questions: z.array(UserQuestion).optional(),
  /** Exact-action approval for a change on a paired device. Shown as a typed card; never "always allow". */
  deviceWrite: z
    .object({
      operationId: z.string(),
      deviceName: z.string(),
      displayPath: z.string(),
      bytes: z.number(),
      sha256: z.string(),
      replaces: z.object({ bytes: z.number(), modifiedAt: z.number().nullable() }).nullable(),
      /** First few KB if the new content is text. */
      preview: z.string().nullable(),
      expiresAt: z.number(),
    })
    .optional(),
  /** Exact-action approval for a change in a Mac app (Calendar, Reminders). */
  deviceAction: z
    .object({
      operationId: z.string(),
      deviceName: z.string(),
      app: z.enum(["contacts", "calendar", "reminders", "notes", "mail", "screen"]),
      /** Exactly what will change, as label/value rows (e.g. Calendar, Title, When). */
      lines: z.array(z.object({ label: z.string(), value: z.string() })),
      expiresAt: z.number(),
    })
    .optional(),
});
export type PendingRequest = z.infer<typeof PendingRequest>;

export const Decision = z.enum(["allow", "allowAlways", "deny"]);
export type Decision = z.infer<typeof Decision>;

export const RateLimitInfo = z.object({
  status: z.enum(["ok", "warning", "limited"]),
  resetsAt: z.number().optional(),
  utilization: z.number().optional(),
  message: z.string().optional(),
});
export type RateLimitInfo = z.infer<typeof RateLimitInfo>;

export const ResumeCursor = z.record(z.string(), z.unknown());
export type ResumeCursor = z.infer<typeof ResumeCursor>;

export const ProviderEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.started"),
    resumeCursor: ResumeCursor.optional(),
    model: z.string().optional(),
  }),
  z.object({ type: z.literal("session.state"), state: z.enum(["idle", "running", "waiting", "error"]) }),
  z.object({ type: z.literal("session.exited"), reason: z.string().optional() }),
  z.object({ type: z.literal("turn.started"), turnId: z.string() }),
  z.object({
    type: z.literal("turn.completed"),
    turnId: z.string(),
    status: z.enum(["completed", "interrupted", "failed"]),
    usage: Usage.optional(),
    error: z.string().optional(),
    resumeCursor: ResumeCursor.optional(),
  }),
  z.object({ type: z.literal("item.started"), turnId: z.string().optional(), item: Item }),
  z.object({ type: z.literal("item.updated"), turnId: z.string().optional(), item: Item }),
  z.object({ type: z.literal("item.completed"), turnId: z.string().optional(), item: Item }),
  z.object({
    type: z.literal("content.delta"),
    turnId: z.string().optional(),
    itemId: z.string(),
    stream: z.enum(["text", "reasoning", "command_output"]),
    delta: z.string(),
  }),
  z.object({ type: z.literal("request.opened"), turnId: z.string().optional(), request: PendingRequest }),
  z.object({ type: z.literal("request.resolved"), requestId: z.string(), decision: Decision }),
  z.object({ type: z.literal("rate_limit"), info: RateLimitInfo }),
  z.object({ type: z.literal("runtime.error"), message: z.string(), fatal: z.boolean().default(false) }),
]);
export type ProviderEvent = z.infer<typeof ProviderEvent>;

export const InputPart = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), mediaType: z.string(), data: z.string() }),
]);
export type InputPart = z.infer<typeof InputPart>;
