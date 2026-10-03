/**
 * Yo desktop shell (Electron). Thin by design:
 *  - starts yo-core (bundled Node server) using Electron's own Node (ELECTRON_RUN_AS_NODE)
 *  - shows the web UI served by core at http://127.0.0.1:7777
 *  - native notifications, tray/menu-bar icon, keeps running when the window is closed
 *  - keeps the Mac awake while an agent is working
 *  - Home PC mode (`<userData>/remote.json`): core runs on another machine and is reached through a
 *    tunnel on the same local port. The app never starts a local core, so there's only ever one Yo.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  powerSaveBlocker,
  shell,
  Tray,
} from "electron";
import WebSocket from "ws";
import { DeviceService } from "./device/DeviceService";
import { keychainHint, readKeychainState, rememberSignedInVersion } from "./keychainWait";
import { DesktopUpdates, UPDATE_CHANNEL } from "./updates";

const CORE_PORT = Number(process.env.YO_PORT ?? 7777);
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const UI_URL = process.env.YO_UI_URL ?? CORE_URL;
// A second, isolated Yo (update tests) gets its own data folder; with YO_PORT, nothing is shared with the real one.
if (process.env.YO_USER_DATA_DIR) app.setPath("userData", path.resolve(process.env.YO_USER_DATA_DIR));

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let core: ChildProcess | null = null;
let coreOwned = false;
let quitting = false;
let powerBlockId: number | null = null;
let devices: DeviceService | null = null;
let updates: DesktopUpdates | null = null;
const workingAgents = new Set<string>();
const agentNames = new Map<string, string>();

interface RemoteConfig {
  /** Shown while waiting for the tunnel, e.g. "Home PC". */
  label?: string;
}

function readRemote(): RemoteConfig | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "remote.json"), "utf8"));
  } catch {
    return null;
  }
}

const remote = readRemote();

/** dist/yo-config.json, written by build.mjs. */
interface YoConfig {
  /** Source checkout to build the agent's computer from (the owner's and source builds). */
  repoRoot?: string;
  /** Public builds: pull the agent's computer as <computerImageRepo>:<app version> instead. */
  computerImageRepo?: string;
}

function readConfig(): YoConfig | null {
  const candidates = [
    path.join(process.resourcesPath ?? "", "yo-config.json"),
    path.join(__dirname, "yo-config.json"),
  ];
  for (const c of candidates) {
    try {
      return JSON.parse(fs.readFileSync(c, "utf8")) as YoConfig;
    } catch {
      /* next */
    }
  }
  return null;
}

function resourcePath(...p: string[]) {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, "..", "..", ...p);
}

async function coreHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${CORE_URL}/healthz`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startCore() {
  if (remote) return; // core lives on the Home PC; the window waits for the tunnel
  if (await coreHealthy()) {
    coreOwned = false; // a dev core is already running
    return;
  }
  const cfg = readConfig();
  const coreEntry = app.isPackaged
    ? resourcePath("core", "core.mjs")
    : path.join(__dirname, "..", "..", "core", "dist", "core.mjs");
  const webDist = app.isPackaged ? resourcePath("web") : path.join(__dirname, "..", "..", "web", "dist");
  const logDir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = fs.openSync(path.join(logDir, "core.log"), "a");
  core = spawn(process.execPath, [coreEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      YO_CORE_MAIN: "1",
      YO_PORT: String(CORE_PORT),
      YO_WEB_DIST: webDist,
      YO_COMPOSE_FILE: app.isPackaged
        ? resourcePath("compose.runtime.yaml")
        : path.join(__dirname, "..", "..", "..", "computer", "compose.runtime.yaml"),
      ...(cfg?.repoRoot ? { YO_REPO_ROOT: cfg.repoRoot } : {}),
      // The computer image published with this exact version (see .github/workflows/release.yml).
      ...(app.isPackaged && cfg?.computerImageRepo && !process.env.YO_COMPUTER_IMAGE
        ? { YO_COMPUTER_IMAGE: `${cfg.computerImageRepo}:${app.getVersion()}` }
        : {}),
      // Core's data folder defaults to the app's own; keep them together when the app's is moved.
      ...(process.env.YO_USER_DATA_DIR && !process.env.YO_DATA_DIR
        ? { YO_DATA_DIR: app.getPath("userData") }
        : {}),
      NODE_NO_WARNINGS: "1",
    },
    stdio: ["ignore", logFile, logFile, "ipc"],
  });
  coreOwned = true;
  core.on("exit", (code) => {
    core = null;
    if (!quitting) {
      console.error(`yo-core exited (${code}); restarting in 2s`);
      setTimeout(() => void startCore(), 2000);
    }
  });
  for (let i = 0; i < 150; i++) {
    if (await coreHealthy()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Yo core did not start. See ~/Library/Application Support/Yo/logs/core.log");
}

function createWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    title: "Yo",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0B0C0E" : "#FAFAF8",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  void loadUi();
  // External links open in the user's browser, never inside Yo. Yo's own files (artifacts, files from the
  // agent's computer) need the signed-in session, so they download inside Yo instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url, CORE_URL) || sameOrigin(url, UI_URL)) {
      if (new URL(url).pathname.startsWith("/api/")) win?.webContents.downloadURL(url);
    } else if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const keepInYo = (e: Electron.Event, url: string) => {
    if (!sameOrigin(url, UI_URL)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  };
  win.webContents.on("will-navigate", keepInYo);
  win.webContents.on("will-redirect", keepInYo);
  // Only what the UI uses (notifications, copy/paste, the live screen's fullscreen and key capture);
  // camera, microphone, location and the rest are refused, and nothing is granted to other origins.
  const ses = win.webContents.session;
  const allowed = (permission: string, origin: string) =>
    WEB_PERMISSIONS.has(permission) && (sameOrigin(origin, UI_URL) || sameOrigin(origin, CORE_URL));
  ses.setPermissionRequestHandler((wc, permission, done, details) =>
    done(allowed(permission, details.requestingUrl || wc.getURL())),
  );
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed(permission, origin));
  win.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

const WEB_PERMISSIONS = new Set([
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "keyboardLock",
]);

function sameOrigin(a: string, b: string) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "YoDeviceBridge")
    : path.join(__dirname, "..", "native", "bin", "YoDeviceBridge");
}

function enrollmentPage() {
  const dark = nativeTheme.shouldUseDarkColors;
  return `<!doctype html><meta charset="utf-8"><title>Yo</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;-webkit-app-region:drag;
font:14px -apple-system,system-ui;background:${dark ? "#0B0C0E" : "#FAFAF8"};color:${dark ? "#ECECEE" : "#1A1A1C"}">
<div style="text-align:center;max-width:420px;line-height:1.5"><div style="font-size:28px;margin-bottom:10px">🔐</div>
<b>This Yo app isn't connected to your Yo yet.</b><br>
<span style="opacity:.7">For your security, Yo now signs in each app once. Run the Home PC connect step on this Mac, then reopen Yo.</span></div>`;
}

function waitingPage(label: string) {
  const dark = nativeTheme.shouldUseDarkColors;
  return `<!doctype html><meta charset="utf-8"><title>Yo</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;-webkit-app-region:drag;
font:14px -apple-system,system-ui;background:${dark ? "#0B0C0E" : "#FAFAF8"};color:${dark ? "#85858A" : "#6B6B70"}">
<div style="text-align:center"><div style="font-size:28px;margin-bottom:10px">⏳</div>
Connecting to Yo on your ${label}…<br><small>Make sure the PC is on and you're online.</small></div>`;
}

/**
 * Show the local "Starting Yo…" page and wait until it's on screen. Signing in reads Yo's saved login
 * (safeStorage → the "Yo Safe Storage" Keychain item); on an updated ad-hoc build macOS asks for the password
 * first and main's thread is blocked until it's answered, so this must be painted before that (#74).
 */
async function showStartingPage() {
  const w = win;
  if (!w || w.isDestroyed()) return;
  const hint = keychainHint({
    platform: process.platform,
    channel: UPDATE_CHANNEL,
    version: app.getVersion(),
    ...readKeychainState(app.getPath("userData")),
  });
  const shown = w.isVisible() ? null : new Promise<void>((r) => w.once("show", () => r()));
  await w
    .loadFile(path.join(__dirname, "starting.html"), { query: { keychain: hint } })
    .catch(() => undefined);
  if (shown) await Promise.race([shown, new Promise((r) => setTimeout(r, 2000))]);
  await new Promise((r) => setTimeout(r, 150)); // let the window server present the frame
}

/** Load the UI; in Home PC mode show a small waiting screen until the tunnel answers. */
async function loadUi() {
  await showStartingPage();
  if (!updates?.needsSignIn) updates?.start(); // github channel: no need to wait for core
  if (remote && !(await coreHealthy())) {
    void win?.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(waitingPage(remote.label ?? "Home PC"))}`,
    );
    while (win && !win.isDestroyed() && !(await coreHealthy())) await new Promise((r) => setTimeout(r, 2000));
    await showStartingPage();
  }
  // Sign in before the UI loads so its first request already carries the session cookie, and before
  // main's own connection to core (notifications, tray) so it doesn't race the sign-in.
  const state = await signInWithRetry();
  if (state === "signed-in") rememberSignedInVersion(app.getPath("userData"), app.getVersion());
  if (!watching) {
    watching = true;
    watchCore();
  }
  if (state === "needs-enrollment") {
    await recoverSession(); // shows the explanation and waits for the owner's one-time token
    return;
  }
  updates?.start();
  if (win && !win.isDestroyed()) void win.loadURL(UI_URL);
}

let recovering = false;
let watching = false;
/** Sign in again and reload the UI so its socket picks up the new session cookie. */
async function recoverSession() {
  if (recovering) return;
  recovering = true;
  try {
    let state = await signInWithRetry();
    if (state === "needs-enrollment") {
      void win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(enrollmentPage())}`);
      // The owner's setup drops a one-time token on this Mac; pick it up as soon as it appears.
      while (state === "needs-enrollment" && !quitting) {
        await new Promise((r) => setTimeout(r, 3000));
        state = await signInWithRetry();
      }
    }
    if (state === "signed-in") updates?.start();
    if (state === "signed-in" && win && !win.isDestroyed()) void win.loadURL(UI_URL);
  } finally {
    recovering = false;
  }
}

async function signInWithRetry(): Promise<"legacy" | "signed-in" | "needs-enrollment"> {
  for (let i = 0; ; i++) {
    try {
      return await devices!.signIn();
    } catch (err) {
      if (i >= 4) {
        console.error("sign-in failed", err);
        return "legacy";
      }
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

function showAgent(agentId: string | null) {
  createWindow();
  if (agentId) win?.webContents.send("yo:navigate", { agentId });
}

function trayIcon() {
  const p = path.join(__dirname, "trayTemplate.png");
  const img = fs.existsSync(p) ? nativeImage.createFromPath(p) : nativeImage.createEmpty();
  img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!tray) return;
  const working = [...workingAgents].map((id) => agentNames.get(id) ?? "Agent");
  tray.setToolTip(working.length ? `Yo — ${working.join(", ")} working…` : "Yo");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Yo", click: () => createWindow() },
      { type: "separator" },
      ...(working.length
        ? working.map((n) => ({ label: `● ${n} is working`, enabled: false }))
        : [{ label: "All agents idle", enabled: false }]),
      { type: "separator" },
      ...(devices?.activeLease
        ? [
            {
              label: `Stop Yo using “${devices.activeLease.title.slice(0, 40)}”`,
              click: () => devices?.stopLease(),
            },
            { type: "separator" as const },
          ]
        : []),
      ...(devices?.hasPairing
        ? [
            {
              // Works even when the window or the connection to core is stuck: enforced right here in main.
              label: "Pause Yo's access to this Mac",
              type: "checkbox" as const,
              checked: devices.paused,
              click: () => {
                devices?.setPaused(!devices.paused);
                updateTray();
              },
            },
            { type: "separator" as const },
          ]
        : []),
      { label: "Quit Yo", accelerator: "Command+Q", click: () => app.quit() },
    ]),
  );
}

function setBusy(busy: boolean) {
  // Agents run on the Home PC in remote mode; no reason to keep this Mac awake.
  if (remote) busy = false;
  if (busy && powerBlockId == null) powerBlockId = powerSaveBlocker.start("prevent-app-suspension");
  if (!busy && powerBlockId != null) {
    powerSaveBlocker.stop(powerBlockId);
    powerBlockId = null;
  }
}

/** Main-process subscription to core pushes: notifications + busy state, even when the window is hidden. */
function watchCore() {
  let ws: WebSocket | null = null;
  const connect = () => {
    if (quitting) return;
    const token = devices?.sessionToken;
    ws = new WebSocket(`${CORE_URL.replace("http", "ws")}/ws?channels=agent.updated,notify`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    ws.on("open", () => ws?.send(JSON.stringify({ id: "boot", method: "bootstrap", params: {} })));
    ws.on("message", (raw) => {
      const text = raw.toString();
      // Main only cares about a few pushes; skip parsing the stream of timeline deltas.
      if (!/^\{"(id":"boot|push":"(agent\.updated|notify)")/.test(text)) return;
      let f: any;
      try {
        f = JSON.parse(text);
      } catch {
        return;
      }
      if (f.id === "boot" && f.result) {
        for (const a of f.result.agents) {
          agentNames.set(a.id, a.name);
          if (a.activity === "working") workingAgents.add(a.id);
        }
      } else if (f.push === "agent.updated") {
        agentNames.set(f.data.id, f.data.name);
        if (f.data.activity === "working") workingAgents.add(f.data.id);
        else workingAgents.delete(f.data.id);
      } else if (f.push === "notify") {
        const focused = win?.isFocused() && win.isVisible();
        if (!focused && Notification.isSupported()) {
          const n = new Notification({
            title: f.data.title,
            body: String(f.data.body ?? "").slice(0, 240),
            silent: f.data.kind === "info",
          });
          n.on("click", () => showAgent(f.data.agentId));
          n.show();
        }
        if (f.data.kind === "needs_you" && !focused) app.dock?.bounce("informational");
      } else {
        return;
      }
      setBusy(workingAgents.size > 0);
      updateTray();
      app.dock?.setBadge(workingAgents.size ? "●" : "");
    });
    let unauthorized = false;
    let retrying = false;
    const retry = () => {
      if (retrying) return;
      retrying = true;
      setTimeout(async () => {
        if (unauthorized && !devices?.sessionToken) {
          // Core now requires sign-in and this app hasn't signed in yet (core was just updated).
          await recoverSession();
        } else if (unauthorized || devices?.sessionToken) {
          // Session expired or core restarted (sessions live in its memory): refresh quietly.
          await devices?.signIn().catch(() => undefined);
        }
        connect();
      }, 1500);
    };
    // With a listener here, ws leaves the refused request to us: end it and retry ourselves.
    ws.on("unexpected-response", (req, res) => {
      unauthorized = res.statusCode === 401;
      res.resume();
      req.destroy();
      retry();
    });
    ws.on("close", retry);
    ws.on("error", () => {});
  };
  connect();
}

/** Restart to update: let the window close for real, and stop the core this app runs before Yo.app is swapped. */
async function prepareForUpdateRestart() {
  quitting = true;
  const owned = coreOwned ? core : null;
  if (!owned) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 5000);
    owned.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    owned.kill("SIGTERM");
  });
}

function abortUpdateRestart() {
  quitting = false;
  if (!remote && !core) void startCore().catch((err) => console.error(err));
}

function stopComputerVm() {
  // Give RAM back to the Mac when Yo quits. Detached so quitting stays instant.
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };
  const child = spawn("/bin/sh", ["-c", "colima stop --profile yo >/dev/null 2>&1"], {
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

// Smaller V8 young generation in the UI: ~12–19 MB less renderer memory for a little more GC CPU
// (measured; the user prefers saving Mac RAM over CPU).
app.commandLine.appendSwitch("js-flags", "--max-semi-space-size=2");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => createWindow());
  app.whenReady().then(async () => {
    app.setName("Yo");
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "Yo",
          submenu: [
            { role: "about" },
            { type: "separator" },
            {
              label: "Settings…",
              accelerator: "Command+,",
              click: () => win?.webContents.send("yo:navigate", { view: "settings" }),
            },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { label: "Close Window", accelerator: "Command+W", click: () => win?.hide() },
            { role: "quit", label: "Quit Yo" },
          ],
        },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { role: "reload" },
            { role: "toggleDevTools" },
            { type: "separator" },
            { role: "resetZoom" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { type: "separator" },
            { role: "togglefullscreen" },
          ],
        },
        { role: "windowMenu" },
      ]),
    );
    devices = new DeviceService({
      coreUrl: CORE_URL,
      uiUrl: UI_URL,
      helperPath: helperPath(),
      ownsCore: () => coreOwned || (!remote && core != null),
      window: () => win,
    });
    devices.registerIpc();
    updates = new DesktopUpdates({
      coreUrl: CORE_URL,
      uiUrl: UI_URL,
      window: () => win,
      token: () => devices?.sessionToken ?? null,
      prepareForRestart: prepareForUpdateRestart,
      abortRestart: abortUpdateRestart,
    });
    updates.registerIpc();
    devices.onChanged(() => updateTray());
    tray = new Tray(trayIcon());
    tray.on("click", () => createWindow());
    updateTray();
    try {
      await startCore();
    } catch (err) {
      console.error(err);
    }
    createWindow(); // signs in, then starts watching core (see loadUi)
  });
  app.on("activate", () => createWindow());
  app.on("before-quit", () => {
    quitting = true;
    setBusy(false);
    devices?.stop();
    updates?.stop();
    if (core && coreOwned) {
      core.kill("SIGTERM");
      if (process.env.YO_KEEP_VM !== "1") stopComputerVm();
    }
  });
  app.on("window-all-closed", () => {
    /* keep running in the menu bar */
  });
}

// Silence unused import warning for execFile in some builds.
void execFile;
