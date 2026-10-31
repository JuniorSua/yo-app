/**
 * Minimal hand-written subset of the Codex app-server v2 protocol (codex-cli 0.159.2).
 * Source of truth: `codex app-server generate-ts --out <dir>` (ts-rs generated). Only the fields
 * Yo reads/writes are listed; everything is structurally compatible with the generated types.
 * Regenerate and diff when bumping the pinned Codex version.
 */

export type AskForApproval = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    optOutNotificationMethods?: string[] | null;
  } | null;
}

export type UserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string };

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  serviceName?: string | null;
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
  excludeTurns?: boolean;
}

export interface Thread {
  id: string;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  reasoningEffort: string | null;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface TurnError {
  message: string;
  codexErrorInfo: unknown;
  additionalDetails: string | null;
}

export interface Turn {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
}

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  model?: string | null;
  effort?: string | null;
}

export interface TurnSteerParams {
  threadId: string;
  input: UserInput[];
  expectedTurnId: string;
}

export interface CommandAction {
  type: string;
  command?: string;
  path?: string;
  query?: string | null;
}

export interface FileUpdateChange {
  path: string;
  kind: unknown;
  diff: string;
}

export interface McpToolCallResult {
  content: unknown[];
  structuredContent: unknown;
}

export type WebSearchAction =
  | { type: "search"; query: string | null; queries: string[] | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };

export type ThreadItem =
  | { type: "userMessage"; id: string }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "plan"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      status: string;
      commandActions: CommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: "fileChange"; id: string; changes: FileUpdateChange[]; status: string }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: unknown;
      result: McpToolCallResult | null;
      error: { message: string } | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: unknown;
      status: string;
      success: boolean | null;
    }
  | { type: "webSearch"; id: string; query: string; action: WebSearchAction | null }
  | { type: "imageView"; id: string; path: string }
  | { type: "contextCompaction"; id: string }
  | { type: string; id: string };

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  rateLimitReachedType: string | null;
}

export type PlanType = string;

export type Account =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; planType: PlanType }
  | { type: "amazonBedrock"; usesCodexManagedCredentials: boolean };

export interface GetAccountResponse {
  account: Account | null;
  requiresOpenaiAuth: boolean;
}

export interface Model {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
  isDefault: boolean;
}

export interface ModelListResponse {
  data: Model[];
  nextCursor: string | null;
}

export type LoginAccountParams = { type: "chatgptDeviceCode" } | { type: "apiKey"; apiKey: string };

export type LoginAccountResponse =
  | { type: "apiKey" }
  | { type: "chatgptDeviceCode"; loginId: string; verificationUrl: string; userCode: string }
  | { type: "chatgpt"; loginId: string; authUrl: string };

export interface AccountLoginCompletedNotification {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
}

export type CommandExecutionApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
