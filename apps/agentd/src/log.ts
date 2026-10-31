/** Structured JSON-lines logging to stderr with secret redaction. */

const extraSecrets = new Set<string>();

/** Register an exact secret value (e.g. the agentd token) to be scrubbed from all log output. */
export function addSecret(value: string | undefined): void {
  if (value && value.length >= 8) extraSecrets.add(value);
}

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
  /("?(?:token|secret|apiKey|api_key|claudeOauthToken|codexAuthJson|anthropicApiKey|openaiApiKey|xaiApiKey|authorization)"?\s*[:=]\s*"?)[^",\s}]+/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const s of extraSecrets) out = out.split(s).join("[REDACTED]");
  out = out.replace(PATTERNS[0]!, "sk-ant-[REDACTED]");
  out = out.replace(PATTERNS[1]!, "$1[REDACTED]");
  out = out.replace(PATTERNS[2]!, "$1[REDACTED]");
  return out;
}

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[(process.env.YO_LOG_LEVEL as Level) ?? "info"] ?? 20;

function write(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;
  let line: string;
  try {
    line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg, ...fields });
  } catch {
    line = JSON.stringify({ t: new Date().toISOString(), level, scope, msg });
  }
  process.stderr.write(`${redact(line)}\n`);
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => write("debug", scope, m, f),
    info: (m, f) => write("info", scope, m, f),
    warn: (m, f) => write("warn", scope, m, f),
    error: (m, f) => write("error", scope, m, f),
    child: (s) => createLogger(`${scope}.${s}`),
  };
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
