/** Applies a one-shot browser carry-over (see sessionRestore.ts) through Chromium's loopback CDP port. */
import { renameSync, rmSync } from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { errMsg, type Logger } from "../log";
import { missingTabs, RESTORE_FILE, readPendingRestore, toCookieParam } from "./sessionRestore";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cdpCall(
  wsUrl: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id !== 1) return;
      clearTimeout(t);
      ws.close();
      if (m.error) reject(new Error(m.error.message ?? method));
      else resolve(m.result);
    });
    ws.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

export async function applyPendingRestore(cdpPort: number, profileDir: string, log: Logger): Promise<void> {
  const pending = readPendingRestore(profileDir);
  if (!pending) return;
  // Claim it so a second launch can't apply it twice; it's removed whatever happens below.
  const claimed = path.join(profileDir, `${RESTORE_FILE}.applying`);
  try {
    renameSync(path.join(profileDir, RESTORE_FILE), claimed);
  } catch {
    return;
  }
  const base = `http://127.0.0.1:${cdpPort}`;
  try {
    const version = (await (await fetch(`${base}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const cookies = pending.cookies.map(toCookieParam).filter((c): c is Record<string, unknown> => !!c);
    if (cookies.length) await cdpCall(version.webSocketDebuggerUrl, "Storage.setCookies", { cookies });
    // Give session restore a moment to open the previous tabs.
    await sleep(3000);
    const pages = (
      (await (await fetch(`${base}/json/list`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl?: string;
      }[]
    ).filter((t) => t.type === "page");
    if (cookies.length)
      for (const p of pages)
        if (p.webSocketDebuggerUrl && /^https?:/.test(p.url))
          await cdpCall(p.webSocketDebuggerUrl, "Page.reload", {}).catch(() => undefined);
    const missing = missingTabs(
      pending.tabs,
      pages.map((p) => p.url),
    );
    for (const url of missing)
      await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).catch(() => undefined);
    log.info("restored browser session", {
      cookies: cookies.length,
      reopened: missing.length,
      open: pages.length,
    });
  } catch (err) {
    log.warn("browser session carry-over failed", { err: errMsg(err) });
  } finally {
    rmSync(claimed, { force: true });
  }
}
