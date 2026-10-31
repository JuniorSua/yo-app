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

/** After this long waiting for the Home PC, the page says what to check (it used to say the same thing forever). */
export const REMOTE_SLOW_MS = 45_000;

/** What the Home PC waiting page says: at first, and once it's been a while (`{time}` = how long so far). */
export function remoteWaitingText(label: string) {
  return {
    title: `Connecting to Yo on your ${label}…`,
    body: "Make sure the PC is on and you're online.",
    slowTitle: `Still waiting for your ${label} · {time}`,
    slowBody:
      "Check that the PC is awake (not asleep) and Yo is running on it, and that this Mac is online (and connected to your VPN, like Tailscale, if you use one). Yo opens by itself as soon as the PC answers; no need to restart it.",
  };
}

/**
 * The Home PC waiting page (main loads it as a data: URL and polls the tunnel meanwhile). Its own script counts
 * the time and switches to the "what to check" text, so main doesn't have to reload it.
 */
export function remoteWaitingHtml(o: { label: string; dark: boolean }) {
  const t = remoteWaitingText(o.label);
  const slow = JSON.stringify({ title: escapeHtml(t.slowTitle), body: escapeHtml(t.slowBody) }).replace(
    /</g,
    "\\u003c",
  );
  return `<!doctype html><meta charset="utf-8"><title>Yo</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;-webkit-app-region:drag;
font:14px -apple-system,system-ui;background:${o.dark ? "#0B0C0E" : "#FAFAF8"};color:${o.dark ? "#85858A" : "#6B6B70"}">
<div style="text-align:center;max-width:440px;line-height:1.5"><div style="font-size:28px;margin-bottom:10px">⏳</div>
<span id="title">${escapeHtml(t.title)}</span><br><small id="body">${escapeHtml(t.body)}</small></div>
<script>(()=>{const s=${slow},t0=Date.now();const fmt=(ms)=>{const m=Math.floor(ms/60000);return m<1?Math.floor(ms/1000)+"s":m+" min"};
setInterval(()=>{const ms=Date.now()-t0;if(ms<${REMOTE_SLOW_MS})return;
document.getElementById("title").innerHTML=s.title.replace("{time}",fmt(ms));document.getElementById("body").innerHTML=s.body},1000)})()</script>`;
}

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
