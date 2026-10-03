/**
 * Is Yo's core answering, and if not, why? Used by main before it loads the UI, so a core that didn't start
 * shows an explanation instead of a blank window.
 */
import net from "node:net";

/**
 * True when Yo's core answers on `url`. Core's /healthz says exactly "ok"; another app on the same port
 * (say a web dev server that answers every path with its page) doesn't count.
 */
export async function coreHealthy(url: string, timeoutMs = 800): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && (await res.text()).trim() === "ok";
  } catch {
    return false;
  }
}

/** True when something accepts connections on 127.0.0.1:`port`. */
export function portInUse(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * What the window says while core isn't answering. `portTaken`: something that isn't Yo holds core's port,
 * so core can't start until it's gone.
 */
export function coreTroubleText(o: { portTaken: boolean; port: number; logFile: string }) {
  return o.portTaken
    ? {
        title: `Another app is using port ${o.port}`,
        body: `Yo needs that port to start. Quit the other app (or restart your Mac) and Yo will open by itself.`,
      }
    : {
        title: "Yo is taking longer than usual to start",
        body: `It keeps trying. If this doesn't go away, quit Yo from the menu bar and open it again. Details: ${o.logFile}`,
      };
}

const escapeHtml = (t: string) =>
  t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** The whole page (main loads it as a data: URL), styled like main's other waiting pages. */
export function coreTroubleHtml(o: { portTaken: boolean; port: number; logFile: string; dark: boolean }) {
  const t = coreTroubleText(o);
  return `<!doctype html><meta charset="utf-8"><title>Yo</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;-webkit-app-region:drag;
font:14px -apple-system,system-ui;background:${o.dark ? "#0B0C0E" : "#FAFAF8"};color:${o.dark ? "#ECECEE" : "#1A1A1C"}">
<div style="text-align:center;max-width:440px;line-height:1.5"><div style="font-size:28px;margin-bottom:10px">⚠️</div>
<b>${escapeHtml(t.title)}</b><br>
<span style="opacity:.7;-webkit-app-region:no-drag;user-select:text;overflow-wrap:anywhere">${escapeHtml(t.body)}</span></div>`;
}
