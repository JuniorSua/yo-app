/**
 * Commands for launching the TypeScript fakes as child processes (`node --import tsx <file>`),
 * suitable for the adapters' `command` options or YO_CODEX_BIN / YO_GROK_BIN.
 */
import { fileURLToPath } from "node:url";

const tsxLoader = import.meta.resolve("tsx");

function script(name: string): string {
  return fileURLToPath(new URL(`./${name}`, import.meta.url));
}

export const FAKE_CODEX_SCRIPT = script("fake-codex-appserver.ts");
export const FAKE_GROK_SCRIPT = script("fake-grok-acp.ts");

/** `[node, --import, <tsx>, fake-codex-appserver.ts]` — pass as CodexAdapterOptions.command. */
export function fakeCodexCommand(): string[] {
  return [process.execPath, "--import", tsxLoader, FAKE_CODEX_SCRIPT];
}

/** `[node, --import, <tsx>, fake-grok-acp.ts]` — pass as GrokAdapterOptions.command. */
export function fakeGrokCommand(): string[] {
  return [process.execPath, "--import", tsxLoader, FAKE_GROK_SCRIPT];
}
