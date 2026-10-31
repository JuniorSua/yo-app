/**
 * Yo puts anything the user should copy in a fenced block: a command, but also a text message, an email or a
 * note. Code and commands read best monospaced; a message reads best as normal, wrapped text. This decides which
 * card a fence gets from its language tag, or from its content when it has none.
 */
export type CodeKind = "text" | "code";

/** Tags Yo (or a model) uses for words meant for people, not computers. */
const TEXT_LANGS = new Set([
  "text",
  "txt",
  "plain",
  "plaintext",
  "message",
  "msg",
  "draft",
  "email",
  "note",
  "sms",
]);

/** Friendly names for the tags people are most likely to meet. Anything else shows as written. */
const LANG_LABELS: Record<string, string> = {
  sh: "Terminal",
  bash: "Terminal",
  zsh: "Terminal",
  shell: "Terminal",
  console: "Terminal",
  powershell: "PowerShell",
  ps1: "PowerShell",
  js: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  py: "Python",
  python: "Python",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  md: "Markdown",
  markdown: "Markdown",
};

/** `language-sh` → `sh`; react-markdown puts the fence's tag on the inner `<code>` like that. */
export function fenceLang(className: string | undefined): string | undefined {
  const m = /(?:^|\s)language-([\w+#.-]+)/.exec(className ?? "");
  return m?.[1]?.toLowerCase();
}

/** Signs a line is meant for a computer: shell prompts and operators, braces, assignments, tags, common commands. */
const CODE_LINE =
  /^\s*(?:[$>#]\s|\/\/|<\/?[a-z]|[{}[\]()]\s*$)|[;{}]\s*$|=>|&&|\|\||\s\|\s|^\s*[\w.-]+\s*=\s*\S+$|^\s*[a-z_][\w.-]*:\s*\S+$|^\s*(?:sudo|brew|npm|npx|pnpm|git|cd|ls|curl|python3?|node|pip|docker|open|export|echo)\b/;

/**
 * What a fence's content is. A tag wins; with no tag, words in sentences (letters, spaces, sentence punctuation
 * and no code-like lines) are text, anything else is code.
 */
export function codeKind(lang: string | undefined, body: string): CodeKind {
  if (lang) return TEXT_LANGS.has(lang) ? "text" : "code";
  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "code";
  if (lines.some((l) => CODE_LINE.test(l))) return "code";
  const words = body.trim().split(/\s+/).length;
  return words >= 4 && /[a-z]{2,}\s+[a-z]{2,}/i.test(body) ? "text" : "code";
}

/** The small label above the block. */
export function kindLabel(kind: CodeKind, lang: string | undefined): string {
  if (kind === "text") return "Text";
  if (!lang) return "Code";
  return LANG_LABELS[lang] ?? lang;
}
