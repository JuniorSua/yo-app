const extraSecrets = new Set<string>();

/** Register an exact secret value (e.g. the agentd token) to be scrubbed from all log output. */
export function addSecret(value: string | undefined): void {
  if (value && value.length >= 8) extraSecrets.add(value);
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[redacted]"],
  [/xai-[A-Za-z0-9]{16,}/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]"],
  [/\b\d{6,12}:[A-Za-z0-9_-]{30,}/g, "[redacted]"], // Telegram bot tokens
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]"],
  [
    /("?(?:token|secret|password|apiKey|api_key|claudeOauthToken|codexAuthJson|anthropicApiKey|openaiApiKey|xaiApiKey|authorization)"?\s*[:=]\s*"?)[^",\s}]{8,}/gi,
    "$1[redacted]",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const s of extraSecrets) out = out.split(s).join("[redacted]");
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

type Level = "debug" | "info" | "warn" | "error";

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (level === "debug" && process.env.YO_DEBUG !== "1") return;
  const tail =
    extra === undefined
      ? ""
      : ` ${extra instanceof Error ? (extra.stack ?? extra.message) : JSON.stringify(extra)}`;
  process.stderr.write(
    `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${redact(msg + tail)}\n`,
  );
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write("debug", scope, m, e),
    info: (m: string, e?: unknown) => write("info", scope, m, e),
    warn: (m: string, e?: unknown) => write("warn", scope, m, e),
    error: (m: string, e?: unknown) => write("error", scope, m, e),
  };
}
export type Logger = ReturnType<typeof logger>;
