/**
 * Grok (ACP) tool-call and CLI-output mapping. `grok models` parsing adapted from
 * T3 Code's GrokProvider.ts (MIT); ask_user_question shape from T3's XAiAcpExtension.ts.
 */
import type { ItemKind, ModelInfo, TodoEntry, UserQuestion } from "@yo/contracts";
import { classifyMcp, commandTitle, fileTitle, hostOf, parseToolName } from "../shared/titles";
import { isRecord, oneLine, str, stringifyOutput } from "../shared/util";

export interface GrokToolClass {
  kind: ItemKind;
  title: string;
}

export function classifyGrokTool(u: {
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  rawInput?: unknown;
  locations?: { path: string }[] | null;
  content?: unknown[] | null;
}): GrokToolClass {
  const input = isRecord(u.rawInput) ? u.rawInput : {};
  const name = str(u.name) ?? str(u.title) ?? "";
  const ref = parseToolName(name);
  if (ref.server) return classifyMcp(ref.server, ref.tool, u.rawInput);
  if (/^browser_/.test(name)) return classifyMcp("browser", name, u.rawInput);
  const path =
    u.locations?.[0]?.path ??
    str(input.file_path) ??
    str(input.path) ??
    (Array.isArray(u.content)
      ? (u.content.find((c) => isRecord(c) && c.type === "diff") as { path?: string } | undefined)?.path
      : undefined);
  switch (u.kind) {
    case "execute":
      return { kind: "command", title: commandTitle(input.command ?? input.cmd ?? u.title) };
    case "edit":
      return { kind: "file_change", title: fileTitle("Edited", path) };
    case "delete":
      return { kind: "file_change", title: fileTitle("Deleted", path) };
    case "move":
      return { kind: "file_change", title: fileTitle("Changed", path) };
    case "fetch":
      return {
        kind: "web",
        title: str(input.url) ? `Read ${hostOf(input.url)}` : (str(u.title) ?? "Read a web page"),
      };
    case "search":
      if (/web|x_/.test(name) || str(input.query)) {
        return {
          kind: "web",
          title: str(input.query)
            ? `Searched the web for "${oneLine(String(input.query), 50)}"`
            : (str(u.title) ?? "Searched"),
        };
      }
      return { kind: "tool", title: str(u.title) ?? "Searched files" };
    case "read":
      return {
        kind: "tool",
        title: path ? `Read ${path.split("/").pop()}` : (str(u.title) ?? "Read a file"),
      };
    default:
      return { kind: "tool", title: str(u.title) ?? (name || "Used a tool") };
  }
}

/** Text of ACP ToolCallContent[] (content blocks + diffs) with an optional first image. */
export function toolCallOutput(
  content: unknown[] | null | undefined,
  rawOutput?: unknown,
): { text?: string; image?: string } {
  const texts: string[] = [];
  let image: string | undefined;
  for (const c of content ?? []) {
    if (!isRecord(c)) continue;
    if (c.type === "content" && isRecord(c.content)) {
      if (c.content.type === "text" && typeof c.content.text === "string") texts.push(c.content.text);
      if (c.content.type === "image" && typeof c.content.data === "string" && !image) image = c.content.data;
    } else if (c.type === "diff") {
      texts.push(`--- ${String(c.path)}\n${str(c.newText) ?? ""}`);
    }
  }
  if (!texts.length && rawOutput !== undefined) {
    const s = stringifyOutput(rawOutput);
    if (s) texts.push(s);
  }
  return { text: texts.length ? texts.join("\n") : undefined, image };
}

export function todosFromPlan(entries: unknown): TodoEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(isRecord).map((e) => ({
    text: str(e.content) ?? "Step",
    status: e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending",
  }));
}

/** `grok models` output → login state + models (exits 0 either way). */
export function parseGrokModels(output: string): { authenticated: boolean | null; models: ModelInfo[] } {
  const authenticated = /you are logged in/i.test(output)
    ? true
    : /not authenticated|not logged in/i.test(output)
      ? false
      : null;
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*[*-]\s+(\S+)(.*)$/);
    if (!m?.[1] || seen.has(m[1])) continue;
    seen.add(m[1]);
    models.push({
      id: m[1],
      label: m[1]
        .split(/[-_]/)
        .map((p) => (p === "grok" ? "Grok" : p))
        .join(" "),
      ...(/\(default\)/i.test(m[2] ?? "") ? { isDefault: true } : {}),
    });
  }
  return { authenticated, models };
}

/** Models from the ACP initialize `_meta.modelState` (Grok extension), with reasoning efforts. */
export function modelsFromInitializeMeta(meta: unknown): ModelInfo[] {
  if (!isRecord(meta) || !isRecord(meta.modelState)) return [];
  const state = meta.modelState;
  const current = str(state.currentModelId);
  const list = Array.isArray(state.availableModels) ? state.availableModels.filter(isRecord) : [];
  return list.map((m) => {
    const id = String(m.modelId);
    const mm = isRecord(m._meta) ? m._meta : {};
    const efforts = Array.isArray(mm.reasoningEfforts)
      ? mm.reasoningEfforts
          .filter(isRecord)
          .map((e) => str(e.value) ?? str(e.id))
          .filter((e): e is string => !!e)
      : [];
    return {
      id,
      label: str(m.name) ?? id,
      ...(str(m.description) ? { description: String(m.description) } : {}),
      ...(id === current ? { isDefault: true } : {}),
      ...(efforts.length ? { efforts } : {}),
    };
  });
}

/* ------------------------- x.ai/ask_user_question ------------------------- */

interface XAiQuestion {
  id?: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean | null;
}

export function unwrapAskParams(params: unknown): { questions: XAiQuestion[] } {
  const p = isRecord(params) && isRecord(params.params) ? params.params : params;
  const qs = isRecord(p) && Array.isArray(p.questions) ? p.questions.filter(isRecord) : [];
  return {
    questions: qs.map((q) => ({
      ...(str(q.id) ? { id: String(q.id) } : {}),
      question: str(q.question) ?? "",
      options: Array.isArray(q.options)
        ? q.options.filter(isRecord).map((o) => ({
            label: str(o.label) ?? "",
            ...(str(o.description) ? { description: String(o.description) } : {}),
          }))
        : [],
      multiSelect: q.multiSelect === true,
    })),
  };
}

export function askQuestionsToYo(params: unknown): UserQuestion[] {
  return unwrapAskParams(params).questions.map((q) => ({
    question: q.question,
    options: q.options,
    multiSelect: q.multiSelect === true,
  }));
}

/** Build the x.ai ask_user_question response: answers keyed by question text → selected labels. */
export function askResponse(params: unknown, answers: Record<string, string> | undefined) {
  if (!answers) return { outcome: "cancelled" };
  const out: Record<string, string[]> = {};
  for (const q of unwrapAskParams(params).questions) {
    const a = answers[q.question] ?? (q.id ? answers[q.id] : undefined);
    if (a === undefined) continue;
    out[q.question] = q.multiSelect
      ? a
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : [a];
  }
  return { outcome: "accepted", answers: out };
}
