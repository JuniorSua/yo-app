/** agentd entrypoint (runs inside the yo-computer container). */
import { validateToken } from "./auth";
import { config } from "./config";
import { addSecret, createLogger, errMsg } from "./log";
import { AgentdServer } from "./server";

const log = createLogger("main");

let token: string;
try {
  token = validateToken(process.env.YO_AGENTD_TOKEN);
} catch (err) {
  log.error(errMsg(err));
  process.exit(2);
}
addSecret(token);
// Never leak the control token (or any YO_AGENTD_* setting) into child processes: shells, provider
// CLIs, MCP servers and browsers all inherit process.env. (config.ts has already captured its values.)
delete process.env.YO_AGENTD_TOKEN;
for (const k of Object.keys(process.env)) if (k.startsWith("YO_AGENTD_")) delete process.env[k];
if (config.allowLocal)
  log.warn("YO_AGENTD_ALLOW_LOCAL=1: in-container clients may authenticate (tests only)");
process.umask(0o022);

const server = new AgentdServer(token);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("shutting down", { signal });
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await server.stop();
  } catch (err) {
    log.error("shutdown error", { err: errMsg(err) });
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) =>
  log.error("uncaught exception", { err: errMsg(err), stack: err.stack }),
);
process.on("unhandledRejection", (err) => log.error("unhandled rejection", { err: errMsg(err) }));

server.start().catch((err) => {
  log.error("failed to start", { err: errMsg(err) });
  process.exit(1);
});
