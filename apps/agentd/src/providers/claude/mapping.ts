/**
 * Claude tool-call classification and small SDK-shape helpers.
 * Todo/Task handling adapted from T3 Code's ClaudeAdapter (MIT).
 */
import type { ItemKind, TodoEntry } from "@yo/contracts";
import { classifyMcp, commandTitle, fileTitle, hostOf, parseToolName } from "../shared/titles";
import { isRecord, oneLine, str } from "../shared/util";

export interface ClaudeToolClass {
  kind: ItemKind;
  title: string;
  todos?: TodoEntry[];
}

/** Built-in tools Yo turns off: Yo owns scheduling, memory, notifications and worktrees. */
export const CLAUDE_DISALLOWED_TOOLS = [
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "ReadNotifications",
  "Monitor",
  "EnterWorktree",
  "ExitWorktree",
  "EnterPlanMode",
  "Workflow",
  "ProposeGoal",
  "ProposeSkills",
  "ShowOnboardingRolePicker",
  "SendFeedback",
  "ClaudeDesign",
  "Projects",
  "Artifact",
  "DesignSync",
];

export function todosFromTodoWrite(input: unknown): TodoEntry[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.todos)) return undefined;
  return input.todos.filter(isRecord).map((t) => ({
    text: str(t.content) ?? str(t.activeForm) ?? "Task",
    status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "in_progress" : "pending",
  }));
}

export function classifyClaudeTool(name: string, input: unknown): ClaudeToolClass {
  const a = isRecord(input) ? input : {};
  const ref = parseToolName(name);
  if (ref.server) return classifyMcp(ref.server, ref.tool, input);
  switch (name) {
    case "Bash":
      return { kind: "command", title: commandTitle(a.command) };
    case "BashOutput":
    case "KillShell":
    case "KillBash":
      return {
        kind: "command",
        title: name === "BashOutput" ? "Checked command output" : "Stopped a command",
      };
    case "Edit":
    case "MultiEdit":
      return { kind: "file_change", title: fileTitle("Edited", a.file_path) };
    case "Write":
      return { kind: "file_change", title: fileTitle("Created", a.file_path) };
    case "NotebookEdit":
      return { kind: "file_change", title: fileTitle("Edited", a.notebook_path) };
    case "Read":
      return { kind: "tool", title: `Read ${str(a.file_path)?.split("/").pop() ?? "a file"}` };
    case "Glob":
      return {
        kind: "tool",
        title: str(a.pattern) ? `Looked for files matching ${a.pattern}` : "Looked for files",
      };
    case "Grep":
      return {
        kind: "tool",
        title: str(a.pattern) ? `Searched files for "${oneLine(String(a.pattern), 40)}"` : "Searched files",
      };
    case "WebSearch":
    case "web_search":
      return {
        kind: "web",
        title: str(a.query) ? `Searched the web for "${oneLine(String(a.query), 50)}"` : "Searched the web",
      };
    case "WebFetch":
    case "web_fetch":
      return { kind: "web", title: `Read ${hostOf(a.url) ?? "a web page"}` };
    case "TodoWrite":
      return { kind: "todo", title: "Updated the plan", todos: todosFromTodoWrite(input) };
    case "TaskCreate":
    case "TaskUpdate":
    case "TaskList":
    case "TaskGet":
      return { kind: "todo", title: "Updated the plan" };
    case "Task":
    case "Agent":
      return {
        kind: "tool",
        title: str(a.description)
          ? `Started a helper: ${oneLine(String(a.description), 50)}`
          : "Started a helper",
      };
    case "AskUserQuestion":
      return { kind: "tool", title: "Asked you a question" };
    case "Skill":
      return { kind: "tool", title: str(a.skill) ? `Used skill ${a.skill}` : "Used a skill" };
    default:
      return { kind: "tool", title: name };
  }
}

/** Flatten a tool_result `content` (string | blocks) into text and an optional image. */
export function toolResultContent(content: unknown): { text?: string; image?: string } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return {};
  const texts: string[] = [];
  let image: string | undefined;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (block.type === "image" && isRecord(block.source) && typeof block.source.data === "string" && !image) {
      image = block.source.data;
    }
  }
  return { text: texts.length ? texts.join("\n") : undefined, image };
}

/** Stateful tracker for Claude's TaskCreate/TaskUpdate tools (newer replacement for TodoWrite). */
export class ClaudeTaskTracker {
  private tasks = new Map<string, { subject: string; status: TodoEntry["status"] }>();

  apply(toolName: string, input: unknown, result: unknown): TodoEntry[] | undefined {
    const inp = isRecord(input) ? input : {};
    const res = isRecord(result) ? result : {};
    const norm = (v: unknown): TodoEntry["status"] =>
      v === "completed" ? "completed" : v === "in_progress" ? "in_progress" : "pending";
    if (toolName === "TaskList" && Array.isArray(res.tasks)) {
      this.tasks.clear();
      for (const t of res.tasks.filter(isRecord)) {
        const id = str(t.id);
        const subject = str(t.subject);
        if (id && subject) this.tasks.set(id, { subject, status: norm(t.status) });
      }
    } else if (toolName === "TaskCreate") {
      const task = isRecord(res.task) ? res.task : {};
      const id = str(task.id) ?? str(res.taskId) ?? `t${this.tasks.size + 1}`;
      const subject = str(task.subject) ?? str(inp.subject) ?? "Task";
      this.tasks.set(id, { subject, status: norm(inp.status) });
    } else if (toolName === "TaskUpdate") {
      const id = str(inp.taskId) ?? str(res.taskId);
      const t = id ? this.tasks.get(id) : undefined;
      if (!t) return undefined;
      if (str(inp.subject)) t.subject = String(inp.subject);
      if (typeof inp.status === "string") t.status = norm(inp.status);
    } else {
      return undefined;
    }
    return [...this.tasks.values()].map((t) => ({ text: t.subject, status: t.status }));
  }
}

export function planLabel(subscriptionType: string | undefined): string | undefined {
  if (!subscriptionType) return undefined;
  const s = subscriptionType.toLowerCase();
  if (s.includes("max")) return "Claude Max";
  if (s.includes("pro")) return "Claude Pro";
  if (s.includes("team")) return "Claude Team";
  if (s.includes("enterprise")) return "Claude Enterprise";
  return `Claude ${subscriptionType.charAt(0).toUpperCase()}${subscriptionType.slice(1)}`;
}
