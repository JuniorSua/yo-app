import { contextBridge, ipcRenderer } from "electron";

type MacApp = "contacts" | "calendar" | "reminders" | "notes" | "mail" | "screen";
type NavigateTarget = { agentId?: string; view?: string };

/**
 * Surface exposed to the web UI as `window.yoDesktop`.
 * Native notifications are raised by the main process (it watches core pushes directly),
 * so `notify` here is intentionally a no-op to avoid duplicates.
 */
contextBridge.exposeInMainWorld("yoDesktop", {
  platform: process.platform,
  isDesktop: true,
  notify: (_title: string, _body: string, _agentId?: string | null) => {},
  openExternal: (url: string) => {
    if (/^https?:\/\//.test(url)) window.open(url, "_blank");
  },
  onNavigate: (cb: (target: NavigateTarget) => void) => {
    const handler = (_e: unknown, target: NavigateTarget) => cb(target);
    ipcRenderer.on("yo:navigate", handler);
    return () => ipcRenderer.off("yo:navigate", handler);
  },
  /**
   * "Yo on this Mac". Each call only *asks*: pairing and widening access open native dialogs, and folders
   * come from the native picker. There is deliberately no way to pass a path or run anything.
   */
  device: {
    status: () => ipcRenderer.invoke("yo:device:status"),
    pair: () => ipcRenderer.invoke("yo:device:pair"),
    unpair: () => ipcRenderer.invoke("yo:device:unpair"),
    chooseFolder: (mode: "read" | "read-write") => ipcRenderer.invoke("yo:device:chooseFolder", mode),
    setMode: (grantId: string, mode: "read" | "read-write") =>
      ipcRenderer.invoke("yo:device:setMode", grantId, mode),
    revoke: (grantId: string) => ipcRenderer.invoke("yo:device:revoke", grantId),
    setPaused: (paused: boolean) => ipcRenderer.invoke("yo:device:setPaused", paused),
    metrics: () => ipcRenderer.invoke("yo:device:metrics"),
    /** Share Contacts / Calendar / Reminders. macOS shows its own prompt; nothing is shared if it says no. */
    allowApp: (app: MacApp, mode: "read" | "read-write") =>
      ipcRenderer.invoke("yo:device:allowApp", app, mode),
    openPrivacy: (app: MacApp) => ipcRenderer.invoke("yo:device:openPrivacy", app),
    /** End the active window session right now. */
    stopLease: () => ipcRenderer.invoke("yo:device:stopLease"),
    onChanged: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on("yo:device-changed", handler);
      return () => ipcRenderer.off("yo:device-changed", handler);
    },
  },
  /**
   * Yo.app updates (see src/updates.ts). Install only works once a build is downloaded and verified (feed
   * channel); download opens the newer release's page (github channel, main checks the URL).
   */
  updates: {
    getState: () => ipcRenderer.invoke("yo:updates:get"),
    check: () => ipcRenderer.invoke("yo:updates:check"),
    install: () => ipcRenderer.invoke("yo:updates:install"),
    download: () => ipcRenderer.invoke("yo:updates:download"),
    onState: (cb: (state: unknown) => void) => {
      const handler = (_e: unknown, state: unknown) => cb(state);
      ipcRenderer.on("yo:updates:state", handler);
      return () => ipcRenderer.off("yo:updates:state", handler);
    },
  },
});
