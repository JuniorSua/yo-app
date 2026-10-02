/**
 * Everything the desktop app does for "Yo on this Mac": signing in to core, pairing this Mac as a device,
 * the folders the user shares, the native helper, and the narrow IPC surface the UI may call.
 *
 * Trust: the renderer can *ask* for things, but every grant comes from a native picker and pairing / widening
 * access needs a native confirmation dialog, both owned by main. IPC calls are accepted only from the main
 * frame of Yo's own window at the exact UI origin.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type DeviceApp,
  type DeviceGrant,
  type GrantMode,
  type OsPermissionState,
  signedText,
} from "@yo/contracts";
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  type IpcMainInvokeEvent,
  ipcMain,
  screen,
  session,
  shell,
} from "electron";
import WebSocket from "ws";
import { Controller, type ControllerKeys } from "./Controller";
import { DeviceAgent, type DeviceState, type LocalGrant } from "./DeviceAgent";
import { HelperClient } from "./HelperClient";
import { SecureFile } from "./secureStore";

interface PairingRecord {
  deviceId: string;
  coreId: string;
  corePublicKey: string;
  privateKey: string; // PKCS8 DER base64
  publicKey: string; // SPKI DER base64
  name: string;
}

export interface DeviceStatusView {
  supported: boolean;
  signedIn: boolean;
  needsEnrollment: boolean;
  paired: boolean;
  deviceId: string | null;
  deviceName: string;
  connected: boolean;
  paused: boolean;
  helper: { available: boolean; version: string | null };
  grants: DeviceGrant[];
  permissions: Record<string, OsPermissionState>;
  /** Active window session (R3), shown with a banner + Stop. */
  lease: { leaseId: string; windowId: number; title: string; control: boolean; expiresAt: number } | null;
}

export class DeviceService {
  private controller: Controller;
  private helper: HelperClient;
  private pairings: SecureFile<Record<string, PairingRecord>>;
  private stateFile: SecureFile<DeviceState>;
  private agent: DeviceAgent | null = null;
  private needsEnrollment = false;
  private signedIn = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();
  private lastPermissions: Record<string, OsPermissionState> = {};
  private helperVersion: string | null = null;

  constructor(
    private readonly o: {
      coreUrl: string;
      uiUrl: string;
      helperPath: string;
      /** Local mode: main spawned this core and may open enrollment for itself. */
      ownsCore: () => boolean;
      window: () => BrowserWindow | null;
    },
  ) {
    const dir = app.getPath("userData");
    this.controller = new Controller(
      o.coreUrl,
      new SecureFile<ControllerKeys>(path.join(dir, "controller.bin")),
      dir,
      `Yo on ${os.hostname().replace(/\.local$/, "")}`,
    );
    this.helper = new HelperClient(o.helperPath);
    this.pairings = new SecureFile(path.join(dir, "device-pairing.bin"));
    this.stateFile = new SecureFile(path.join(dir, "device-state.bin"));
  }

  get sessionToken() {
    return this.signedIn ? this.controller.token : null;
  }

  onChanged(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
    this.o.window()?.webContents.send("yo:device-changed");
  }

  /* --------------------------------- sign-in --------------------------------- */

  /** Sign in (enrolling first if needed) and install the session cookie for the UI origin only. */
  async signIn(): Promise<"legacy" | "signed-in" | "needs-enrollment"> {
    const r = await this.controller.signIn(() => {
      // For a core this app spawned (same data folder), main itself is the machine owner.
      if (this.o.ownsCore() && !fs.existsSync(this.controller.enrollTokenFile))
        fs.writeFileSync(this.controller.enrollTokenFile, crypto.randomBytes(32).toString("hex"), {
          mode: 0o600,
        });
    });
    if (r.kind === "legacy") {
      this.signedIn = false;
      return "legacy";
    }
    if (r.kind === "needs-enrollment") {
      if (!this.controller.authRequired) return "legacy";
      this.needsEnrollment = true;
      this.signedIn = false;
      this.changed();
      return "needs-enrollment";
    }
    this.needsEnrollment = false;
    this.signedIn = true;
    await session.defaultSession.cookies.set({
      url: this.o.uiUrl,
      name: "yo_session",
      value: r.token,
      httpOnly: true,
      sameSite: "strict",
      expirationDate: Math.floor(r.expiresAt / 1000),
    });
    // Renew well before the 12h expiry.
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.signIn().catch(() => undefined), 6 * 60 * 60 * 1000);
    this.refreshTimer.unref();
    await this.startAgent(r.coreId);
    this.changed();
    return "signed-in";
  }

  /* --------------------------------- pairing --------------------------------- */

  private pairing(coreId: string): PairingRecord | null {
    return this.pairings.read()?.[coreId] ?? null;
  }

  private async startAgent(coreId: string) {
    const p = this.pairing(coreId);
    if (!p) {
      this.agent?.stop();
      this.agent = null;
      return;
    }
    if (this.agent) return;
    // The helper's real version decides which capabilities this Mac advertises.
    const helperVersion = this.helper.available()
      ? await this.helper
          .ensure()
          .then((i) => i.version)
          .catch(() => null)
      : null;
    if (this.agent) return;
    this.helperVersion = helperVersion;
    const key = crypto.createPrivateKey({
      key: Buffer.from(p.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    this.agent = new DeviceAgent({
      wsUrl: `${this.o.coreUrl.replace(/^http/, "ws")}/device`,
      pairing: {
        deviceId: p.deviceId,
        coreId: p.coreId,
        corePublicKey: p.corePublicKey,
        sign: (text) => crypto.sign(null, Buffer.from(text), key).toString("base64"),
      },
      helper: this.helper,
      state: {
        load: () => this.stateFile.read() ?? { grants: [], paused: false, journal: [] },
        save: (s) => this.stateFile.write(s),
      },
      appVersion: app.getVersion(),
      helperVersion,
      osVersion: `macOS ${process.getSystemVersion?.() ?? os.release()}`,
      permissions: () => this.permissions(),
    });
    this.agent.on("connected", () => this.changed());
    this.agent.on("disconnected", () => this.changed());
    this.agent.on("changed", () => {
      this.syncLeaseUi();
      this.changed();
    });
    this.agent.on("unpaired", () => this.forgetPairing(p.coreId));
    this.agent.start();
  }

  private forgetPairing(coreId: string) {
    const all = this.pairings.read() ?? {};
    delete all[coreId];
    this.pairings.write(all);
    this.stateFile.remove();
    this.agent?.stop();
    this.agent = null;
    this.changed();
  }

  async pair(): Promise<DeviceStatusView> {
    if (!this.signedIn || !this.controller.coreId) throw new Error("Yo isn't signed in yet.");
    if (this.pairing(this.controller.coreId)) return this.status();
    const win = this.o.window();
    const name = os.hostname().replace(/\.local$/, "") || "Mac";
    const opts = {
      type: "question" as const,
      buttons: ["Pair this Mac", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "Pair this Mac with Yo?",
      detail:
        "Yo's agents keep working on their own computer. Pairing lets them ask for folders you choose on this Mac. Nothing is shared until you pick it, and every change to your files needs your approval.",
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (response !== 0) return this.status();

    const start = await this.apiCall("devices.pair.start", {});
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const deviceId = `dev_${crypto.randomBytes(12).toString("hex")}`;
    const signature = crypto
      .sign(null, Buffer.from(signedText.pairing(start.challenge, deviceId, pub)), privateKey)
      .toString("base64");
    await this.controller.post("/auth/pair-device", {
      challenge: start.challenge,
      deviceId,
      publicKey: pub,
      signature,
      name,
      osVersion: `macOS ${process.getSystemVersion?.() ?? os.release()}`,
      appVersion: app.getVersion(),
    });
    const all = this.pairings.read() ?? {};
    all[start.coreId] = {
      deviceId,
      coreId: start.coreId,
      corePublicKey: start.corePublicKey,
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      publicKey: pub,
      name,
    };
    this.pairings.write(all);
    await this.startAgent(start.coreId);
    this.changed();
    return this.status();
  }

  async unpair(): Promise<DeviceStatusView> {
    const coreId = this.controller.coreId;
    const p = coreId ? this.pairing(coreId) : null;
    if (!p || !coreId) return this.status();
    const win = this.o.window();
    const opts = {
      type: "warning" as const,
      buttons: ["Unpair", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Unpair this Mac?",
      detail: "Yo will lose access to every folder you shared from this Mac.",
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (response !== 0) return this.status();
    await this.apiCall("devices.unpair", { deviceId: p.deviceId }).catch(() => undefined);
    this.forgetPairing(coreId);
    return this.status();
  }

  /* ---------------------------------- grants --------------------------------- */

  async chooseFolder(mode: GrantMode): Promise<DeviceStatusView> {
    if (!this.agent) throw new Error("Pair this Mac first.");
    const win = this.o.window();
    const opts = {
      title: "Share with Yo",
      buttonLabel: "Share",
      message:
        mode === "read-write"
          ? "Choose a folder or file Yo may read and change (each change needs your approval)."
          : "Choose a folder or file Yo may read.",
      properties: ["openDirectory" as const, "openFile" as const, "createDirectory" as const],
    };
    const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (pick.canceled || !pick.filePaths[0]) return this.status();
    const scope = await this.helper.call("scope.create", { path: pick.filePaths[0] }).catch((err) => {
      throw new Error(
        err?.code === "protected"
          ? "That location can't be shared (home folder itself, Library, system folders, or keys/credentials)."
          : `Couldn't share that: ${err?.message ?? err}`,
      );
    });
    this.agent.addGrant({
      bookmark: scope.bookmark,
      kind: scope.kind,
      displayPath: scope.displayPath,
      name: path.basename(scope.canonicalPath),
      mode,
      expiresAt: null,
    });
    return this.status();
  }

  async setMode(grantId: string, mode: GrantMode): Promise<DeviceStatusView> {
    if (!this.agent) return this.status();
    if (mode === "read-write") {
      const g = this.agent.grants().find((x) => x.id === grantId);
      if (!g) return this.status();
      if (
        !(await this.confirmChanges(g.kind === "app" ? `your ${g.displayPath}` : `files in ${g.displayPath}`))
      )
        return this.status();
    }
    this.agent.setMode(grantId, mode);
    return this.status();
  }

  /**
   * Share one Mac app's data with Yo. macOS asks the user itself (only now, after this click); Yo's grant is
   * created only if macOS allows it. Widening to "read and change" also needs a native confirmation.
   */
  async allowApp(appName: DeviceApp, mode: GrantMode): Promise<DeviceStatusView & { osStatus: string }> {
    if (!this.agent) throw new Error("Pair this Mac first.");
    const osStatus = await this.askMacOS(appName, mode).catch((err) => {
      throw new Error(
        err?.code === "unsupported" ? "Update Yo on this Mac to share this." : String(err?.message ?? err),
      );
    });
    await this.agent.refreshPermissions();
    if (osStatus !== "granted" && osStatus !== "limited") return { ...this.status(), osStatus };
    const label = APP_LABEL[appName];
    const existing = this.agent.grants().find((g) => g.kind === "app" && g.app === appName && !g.revokedAt);
    if (existing) {
      await this.setMode(existing.id, mode);
      return { ...this.status(), osStatus };
    }
    if (
      mode === "read-write" &&
      !(await this.confirmChanges(
        appName === "screen" ? "windows you approve (click and type)" : `your ${label}`,
      ))
    )
      // The dialog defaults to Cancel on purpose; report it instead of silently sharing nothing.
      return { ...this.status(), osStatus: "cancelled" };
    this.agent.addGrant({
      bookmark: "",
      kind: "app",
      app: appName,
      displayPath: label,
      name: label,
      mode,
      expiresAt: null,
    });
    return { ...this.status(), osStatus };
  }

  /**
   * Ask macOS on the user's click. Contacts/Calendar/Reminders have real prompts; Notes/Mail are Apple Events, so
   * a harmless search triggers macOS's "control Notes/Mail" prompt; window control needs Screen Recording (and
   * Accessibility to click/type), which macOS grants in System Settings.
   */
  private async askMacOS(appName: DeviceApp, mode: GrantMode): Promise<string> {
    if (appName === "notes" || appName === "mail") {
      const probe =
        appName === "notes"
          ? this.helper.call("notes.search", { query: "yo", limit: 1 })
          : this.helper.call("mail.search", { query: "yo", limit: 1, mailbox: "inbox" });
      return probe.then(
        () => "granted",
        (err) => (err?.code === "permission" ? "denied" : "granted"),
      );
    }
    if (appName === "screen") {
      const screen = String(
        (await this.helper.call("permissions.request", { kind: "screenRecording" })).status,
      );
      if (screen !== "granted") return screen === "denied" ? "denied" : "needs-settings";
      if (mode === "read-write") {
        const ax = String((await this.helper.call("permissions.request", { kind: "accessibility" })).status);
        if (ax !== "granted") return "needs-settings";
      }
      return "granted";
    }
    const kind = appName === "calendar" ? "calendars" : appName;
    return String((await this.helper.call("permissions.request", { kind })).status);
  }

  private async confirmChanges(what: string): Promise<boolean> {
    const win = this.o.window();
    const opts = {
      type: "question" as const,
      buttons: ["Allow changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: `Let Yo change ${what}?`,
      detail: "Yo will still show you each change and wait for your approval before making it.",
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return response === 0;
  }

  /** Open the right pane of System Settings (when macOS access was denied earlier). */
  openPrivacySettings(appName: DeviceApp) {
    const screenPane =
      this.lastPermissions.screenRecording === "granted" ? "Privacy_Accessibility" : "Privacy_ScreenCapture";
    const pane = {
      calendar: "Privacy_Calendars",
      contacts: "Privacy_Contacts",
      reminders: "Privacy_Reminders",
      notes: "Privacy_Automation",
      mail: "Privacy_Automation",
      screen: screenPane,
    }[appName];
    void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  }

  /* ------------------------- window session banner + Stop ------------------------- */

  private banner: BrowserWindow | null = null;
  private shortcutOn = false;

  /** While a window session is active: a small always-on-top banner with Stop, a tray item and ⌃⌥⌘. */
  private syncLeaseUi() {
    const lease = this.agent?.activeLease ?? null;
    if (lease && !this.banner) {
      this.banner = new BrowserWindow({
        width: 420,
        height: 46,
        x:
          Math.round((screen.getPrimaryDisplay().workArea.width - 420) / 2) +
          screen.getPrimaryDisplay().workArea.x,
        y: screen.getPrimaryDisplay().workArea.y + 8,
        frame: false,
        resizable: false,
        movable: true,
        alwaysOnTop: true,
        focusable: false,
        skipTaskbar: true,
        transparent: true,
        hasShadow: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
      });
      this.banner.setAlwaysOnTop(true, "screen-saver");
      this.banner.setVisibleOnAllWorkspaces(true);
      // The Stop "button" is a link main intercepts: the page itself has no script and no bridge.
      this.banner.webContents.on("will-navigate", (e, url) => {
        e.preventDefault();
        if (url.startsWith("yo-stop:")) this.agent?.endLease("stopped by the user");
      });
      this.banner.on("closed", () => {
        this.banner = null;
      });
    }
    if (lease && this.banner) {
      const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:13px -apple-system,system-ui;-webkit-app-region:drag">
<div style="display:flex;align-items:center;gap:10px;height:46px;padding:0 8px 0 14px;border-radius:12px;background:#1b1b1f;color:#f2f2f2;border:1px solid #f5c84299;box-sizing:border-box">
<span style="width:8px;height:8px;border-radius:50%;background:#f5c842"></span>
<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Yo is ${lease.control ? "using" : "looking at"} <b>${esc(lease.title)}</b></span>
<a href="yo-stop:" style="-webkit-app-region:no-drag;text-decoration:none;color:#111;background:#f5c842;border-radius:8px;padding:6px 12px;font-weight:600">Stop</a></div>`;
      void this.banner.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      this.banner.showInactive();
      if (!this.shortcutOn) {
        this.shortcutOn = globalShortcut.register("Control+Alt+Command+.", () =>
          this.agent?.endLease("stopped with the shortcut"),
        );
      }
    }
    if (!lease) {
      this.banner?.destroy();
      this.banner = null;
      if (this.shortcutOn) globalShortcut.unregister("Control+Alt+Command+.");
      this.shortcutOn = false;
    }
  }

  get activeLease() {
    return this.agent?.activeLease ?? null;
  }

  stopLease() {
    this.agent?.endLease("stopped by the user");
  }

  revoke(grantId: string): DeviceStatusView {
    this.agent?.revokeGrant(grantId);
    return this.status();
  }

  setPaused(paused: boolean): DeviceStatusView {
    this.agent?.setPaused(paused);
    this.changed();
    return this.status();
  }

  get paused() {
    return this.agent?.paused ?? false;
  }

  get hasPairing() {
    return !!this.agent;
  }

  /* ---------------------------------- status --------------------------------- */

  private async permissions(): Promise<Record<string, OsPermissionState>> {
    if (!this.helper.available()) return {};
    try {
      this.lastPermissions = await this.helper.call("permissions.status", {});
    } catch {
      /* keep last known */
    }
    return this.lastPermissions;
  }

  status(): DeviceStatusView {
    const p = this.controller.coreId ? this.pairing(this.controller.coreId) : null;
    return {
      supported: process.platform === "darwin",
      signedIn: this.signedIn,
      needsEnrollment: this.needsEnrollment,
      paired: !!p,
      deviceId: p?.deviceId ?? null,
      deviceName: p?.name ?? (os.hostname().replace(/\.local$/, "") || "Mac"),
      connected: this.agent?.connected ?? false,
      paused: this.agent?.paused ?? false,
      helper: {
        available: this.helper.available(),
        version: this.helper.info?.version ?? this.helperVersion,
      },
      grants: this.agent?.grants().filter((g) => !g.revokedAt) ?? [],
      permissions: this.lastPermissions,
      lease: this.agent?.activeLease ?? null,
    };
  }

  /** Memory of Yo's own processes on this Mac (MiB), measured by Electron + the helper's RSS when running. */
  metrics() {
    const procs = app.getAppMetrics().map((m) => ({
      type: m.type,
      name: m.name ?? null,
      memMB: Math.round((m.memory.workingSetSize ?? 0) / 1024),
      cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10,
    }));
    return { at: Date.now(), procs, totalMB: procs.reduce((a, p) => a + p.memMB, 0) };
  }

  /* -------------------------------- core calls ------------------------------- */

  /** One API call over a short-lived authenticated WebSocket (main has no long-lived API socket of its own). */
  private apiCall(method: string, params: unknown): Promise<any> {
    const token = this.controller.token;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.o.coreUrl.replace(/^http/, "ws")}/ws`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const t = setTimeout(() => {
        ws.terminate();
        reject(new Error("core didn't answer"));
      }, 15_000);
      ws.on("open", () => ws.send(JSON.stringify({ id: "1", method, params })));
      ws.on("message", (raw) => {
        let f: any;
        try {
          f = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (f.id !== "1") return;
        clearTimeout(t);
        ws.close();
        if (f.error) reject(new Error(f.error));
        else resolve(f.result);
      });
      ws.on("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
  }

  /* ----------------------------------- IPC ----------------------------------- */

  registerIpc() {
    const trusted = (e: IpcMainInvokeEvent) => {
      const win = this.o.window();
      const frame = e.senderFrame;
      // Only Yo's own window, only its top-level frame (no iframes), only at the exact UI origin.
      if (!win || e.sender !== win.webContents || !frame || frame.parent !== null) return false;
      try {
        return new URL(frame.url).origin === new URL(this.o.uiUrl).origin;
      } catch {
        return false;
      }
    };
    const handle = (channel: string, fn: (...args: any[]) => unknown) =>
      ipcMain.handle(channel, async (e, ...args) => {
        if (!trusted(e)) throw new Error("not allowed");
        return fn(...args);
      });
    const mode = (m: unknown): GrantMode => (m === "read-write" ? "read-write" : "read");
    const id = (v: unknown) => (typeof v === "string" && /^grt_[A-Za-z0-9_-]{8,64}$/.test(v) ? v : "");

    handle("yo:device:status", () => this.status());
    handle("yo:device:pair", () => this.pair());
    handle("yo:device:unpair", () => this.unpair());
    handle("yo:device:chooseFolder", (m) => this.chooseFolder(mode(m)));
    handle("yo:device:setMode", (g, m) => this.setMode(id(g), mode(m)));
    handle("yo:device:revoke", (g) => this.revoke(id(g)));
    handle("yo:device:setPaused", (p) => this.setPaused(p === true));
    handle("yo:device:metrics", () => this.metrics());
    const appOf = (v: unknown): DeviceApp => {
      if (["calendar", "contacts", "reminders", "notes", "mail", "screen"].includes(v as string))
        return v as DeviceApp;
      throw new Error("unknown app");
    };
    handle("yo:device:allowApp", (a, m) => this.allowApp(appOf(a), mode(m)));
    handle("yo:device:openPrivacy", (a) => this.openPrivacySettings(appOf(a)));
    handle("yo:device:stopLease", () => this.stopLease());
  }

  stop() {
    this.agent?.stop();
    this.helper.stop();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}

export type { LocalGrant };

const APP_LABEL: Record<DeviceApp, string> = {
  contacts: "Contacts",
  calendar: "Calendar",
  reminders: "Reminders",
  notes: "Notes",
  mail: "Mail",
  screen: "Window control",
};
