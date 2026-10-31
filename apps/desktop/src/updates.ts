/**
 * Yo.app updates. The channel is fixed when the app is built (apps/desktop/scripts/channel.mjs):
 *
 * feed (the owner's signed builds): electron-updater with a generic feed that yo-core serves at
 * /api/updates/desktop (files from `<core data>/updates/desktop/`, written by `release.py publish-app`).
 *  - Checks after sign-in, every 4 minutes and when the UI asks; downloads in the background.
 *  - Squirrel.Mac (inside Electron) verifies the new build is signed like the running one before it counts
 *    as ready; only then does the UI offer "Restart to update". Quitting normally installs it too.
 *  - Requests carry main's controller session as a bearer token, like the rest of /api/.
 *
 * github (public, ad-hoc signed builds from GitHub Releases): Squirrel.Mac refuses ad-hoc signed updates, so
 * nothing is downloaded. The app asks the GitHub API for the newest release at startup, every 6 hours and when
 * the UI asks (unauthenticated: 60 requests/hour/IP), and offers "Yo 0.1.N is available: Download", which
 * downloads the release's .dmg in the browser (or opens the release page if it has none). Offline, rate limits and "no release yet" stay quiet.
 *
 * Both are off in unpackaged (development) builds.
 *
 * IPC (preload `updates`): getState / check / install / download, plus the "yo:updates:state" push. Calls are
 * accepted only from the main frame of Yo's own window at the UI origin, and take no arguments: Download opens
 * the URL main got from GitHub itself, after checking it is one of this repo's release pages or downloads.
 */
import fs from "node:fs";
import path from "node:path";
import {
  app,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  autoUpdater as nativeUpdater,
  net,
  shell,
} from "electron";
import { type AppUpdater, autoUpdater } from "electron-updater";
import { DEFAULT_UPDATE_REPO } from "../scripts/channel.mjs";
import {
  GITHUB_MIN_CHECK_GAP_MS,
  GITHUB_TICK_MS,
  githubCheckDue,
  isReleasePageUrl,
  latestReleaseApiUrl,
  readLatestRelease,
} from "./githubRelease";
import {
  type DesktopUpdateState,
  friendlyUpdateError,
  initialUpdateState,
  isNothingPublished,
  reduceUpdate,
  type UpdateChannel,
  type UpdateEvent,
} from "./updateState";

declare const __YO_UPDATE_CHANNEL__: string | undefined;
declare const __YO_UPDATE_REPO__: string | undefined;
/** Baked in by build.mjs. */
export const UPDATE_CHANNEL: UpdateChannel =
  typeof __YO_UPDATE_CHANNEL__ === "string" && __YO_UPDATE_CHANNEL__ === "github" ? "github" : "feed";
const UPDATE_REPO = typeof __YO_UPDATE_REPO__ === "string" ? __YO_UPDATE_REPO__ : DEFAULT_UPDATE_REPO;

const CHECK_INTERVAL_MS = 4 * 60 * 1000;
/** If the app is still running this long after Restart, the install didn't start. */
const INSTALL_WATCHDOG_MS = 20_000;

export interface DesktopUpdatesOptions {
  coreUrl: string;
  uiUrl: string;
  window: () => BrowserWindow | null;
  /** Main's session with core (null for cores without sign-in). */
  token: () => string | null;
  /** Let the window really close (not hide to the menu bar) and stop a core this app runs, before the swap. */
  prepareForRestart: () => Promise<void>;
  /** Undo `prepareForRestart` when the install didn't happen. */
  abortRestart: () => void;
}

export class DesktopUpdates {
  private state: DesktopUpdateState;
  private updater: AppUpdater | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pendingVersion: string | null = null;
  private lastPercent = -1;
  private readonly logFile: string;
  private githubStarted = false;
  private githubLastCheck = 0;
  /** When GitHub last answered (newer or nothing newer); 0 = not yet. */
  private githubLastAnswer = 0;
  private githubInFlight: Promise<DesktopUpdateState> | null = null;

  constructor(private readonly o: DesktopUpdatesOptions) {
    this.state = initialUpdateState(
      app.getVersion(),
      app.isPackaged && process.platform === "darwin",
      UPDATE_CHANNEL,
    );
    this.logFile = path.join(app.getPath("userData"), "logs", "updates.log");
  }

  /** The feed is served by core behind sign-in; GitHub Releases can be checked right away. */
  get needsSignIn() {
    return UPDATE_CHANNEL === "feed";
  }

  /** Start checking (idempotent). Call once main has signed in to core (or at launch, without needsSignIn). */
  start() {
    if (this.state.status === "disabled") return;
    if (UPDATE_CHANNEL === "github") return this.startGithub();
    if (this.updater) return;
    const u = autoUpdater;
    u.logger = this.logger();
    u.autoDownload = true;
    u.autoInstallOnAppQuit = true;
    u.allowDowngrade = false;
    u.disableDifferentialDownload = true; // the feed carries full zips only, no blockmaps
    u.setFeedURL({ provider: "generic", url: `${this.o.coreUrl}/api/updates/desktop` });
    u.on("checking-for-update", () => this.apply({ type: "check", at: Date.now() }));
    u.on("update-not-available", () => this.apply({ type: "none", at: Date.now() }));
    u.on("update-available", (info) =>
      this.apply({ type: "available", version: info.version, at: Date.now() }),
    );
    u.on("download-progress", (p) => {
      // Push whole percents only: the renderer doesn't need a message per network chunk.
      const percent = Math.floor(p.percent);
      if (percent === this.lastPercent) return;
      this.lastPercent = percent;
      this.apply({ type: "progress", percent });
    });
    // electron-updater's own "update-downloaded" comes before Squirrel.Mac has checked the signature and
    // staged the build; Squirrel's event is the one that means Restart will work.
    u.on("update-downloaded", (info) => {
      this.pendingVersion = info.version;
      this.apply({ type: "progress", percent: 100 });
    });
    nativeUpdater.on("update-downloaded", () =>
      this.apply({ type: "downloaded", version: this.pendingVersion ?? this.state.availableVersion ?? "" }),
    );
    u.on("error", (err) => {
      if (isNothingPublished(err)) this.apply({ type: "none", at: Date.now() });
      else this.apply({ type: "error", message: friendlyUpdateError(err) });
    });
    this.updater = u;
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.timer.unref();
  }

  async check(): Promise<DesktopUpdateState> {
    if (UPDATE_CHANNEL === "github") return this.githubStarted ? this.checkGithub() : this.state;
    // Once a build is staged, re-checking would only make Squirrel copy it again.
    if (!this.updater || this.state.status === "downloaded") return this.state;
    const token = this.o.token();
    this.updater.requestHeaders = token ? { authorization: `Bearer ${token}` } : null;
    try {
      const r = await this.updater.checkForUpdates();
      // With autoDownload the download runs on its own promise; its failures arrive through "error" too.
      r?.downloadPromise?.catch(() => {});
    } catch {
      /* reported through the "error" event */
    }
    return this.state;
  }

  /** github channel: download the newer release's .dmg in the browser (or open its release page). */
  async download() {
    const url = this.state.releaseUrl;
    if (UPDATE_CHANNEL !== "github" || this.state.status !== "available") return;
    if (!isReleasePageUrl(url, UPDATE_REPO)) {
      this.log("error", "refusing to open an unexpected release URL");
      return;
    }
    this.log("info", `opening the download for ${this.state.availableVersion}`);
    try {
      await shell.openExternal(url);
    } catch (err) {
      this.log("warn", `couldn't open the download: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }

  async install() {
    if (!this.updater || this.state.status !== "downloaded") return;
    this.log("info", `restarting to install ${this.state.downloadedVersion}`);
    await this.o.prepareForRestart();
    try {
      this.updater.quitAndInstall(false, true);
    } catch (err) {
      this.failInstall(err);
      return;
    }
    setTimeout(
      () => this.failInstall(new Error("Yo didn't quit to install the update.")),
      INSTALL_WATCHDOG_MS,
    ).unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  registerIpc() {
    const trusted = (e: IpcMainInvokeEvent) => {
      const win = this.o.window();
      const frame = e.senderFrame;
      if (!win || e.sender !== win.webContents || !frame || frame.parent !== null) return false;
      try {
        return new URL(frame.url).origin === new URL(this.o.uiUrl).origin;
      } catch {
        return false;
      }
    };
    const handle = (channel: string, fn: () => unknown) =>
      ipcMain.handle(channel, async (e) => {
        if (!trusted(e)) throw new Error("not allowed");
        return fn();
      });
    handle("yo:updates:get", () => this.state);
    handle("yo:updates:check", () => this.check());
    handle("yo:updates:install", () => this.install());
    handle("yo:updates:download", () => this.download());
  }

  private startGithub() {
    if (this.githubStarted) return;
    this.githubStarted = true;
    this.log("info", `checking GitHub Releases of ${UPDATE_REPO}`);
    // Never let a background check reject unhandled in main (it would only be noise: the next one retries).
    const background = () =>
      void this.checkGithub().catch((err) => this.log("warn", `github check: ${String(err).slice(0, 200)}`));
    background();
    // Every 6 hours of real time (sleep included), and again soon after a check that got no answer.
    this.timer = setInterval(() => {
      if (githubCheckDue(Date.now(), this.githubLastCheck, this.githubLastAnswer)) background();
    }, GITHUB_TICK_MS);
    this.timer.unref();
  }

  private checkGithub(): Promise<DesktopUpdateState> {
    if (this.githubInFlight) return this.githubInFlight;
    // Repeated clicks reuse the last answer: the unauthenticated API allows 60 requests an hour.
    if (Date.now() - this.githubLastCheck < GITHUB_MIN_CHECK_GAP_MS) return Promise.resolve(this.state);
    this.githubLastCheck = Date.now();
    this.githubInFlight = (async () => {
      this.apply({ type: "check", at: Date.now() });
      let status = 0;
      let body: unknown = null;
      try {
        const res = await net.fetch(latestReleaseApiUrl(UPDATE_REPO), {
          headers: {
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": `Yo/${this.state.currentVersion}`,
          },
          signal: AbortSignal.timeout(20_000),
        });
        status = res.status;
        if (res.ok) body = await res.json().catch(() => null);
      } catch (err) {
        this.log("warn", `github check failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
      const r = readLatestRelease(status, body, this.state.currentVersion, UPDATE_REPO);
      if (r.kind !== "quiet") this.githubLastAnswer = Date.now();
      if (r.kind === "newer")
        this.apply({ type: "available", version: r.version, url: r.url, at: Date.now() });
      else if (r.kind === "none") this.apply({ type: "none", at: Date.now() });
      else {
        this.log("info", `github check: no answer (${r.reason})`);
        this.apply({
          type: "quiet",
          message: "Couldn't check for updates right now. Yo will try again later.",
        });
      }
      return this.state;
    })().finally(() => {
      this.githubInFlight = null;
    });
    return this.githubInFlight;
  }

  private failInstall(err: unknown) {
    this.log("error", `install failed: ${String((err as Error)?.message ?? err)}`);
    this.o.abortRestart();
    this.apply({ type: "install-failed", message: friendlyUpdateError(err) });
  }

  private apply(e: UpdateEvent) {
    const next = reduceUpdate(this.state, e);
    if (next === this.state) return;
    if (next.status !== this.state.status) this.log("info", `state ${this.state.status} -> ${next.status}`);
    this.state = next;
    const win = this.o.window();
    if (win && !win.isDestroyed()) win.webContents.send("yo:updates:state", next);
  }

  private log(level: string, msg: string) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${level.toUpperCase()} ${msg}\n`);
    } catch {
      /* logging must never break updates */
    }
  }

  private logger() {
    // Keep the log from growing forever: start over past 1 MB.
    try {
      if (fs.statSync(this.logFile).size > 1024 * 1024) fs.rmSync(this.logFile);
    } catch {}
    const at = (level: string) => (m: unknown) => this.log(level, String(m).slice(0, 2000));
    return { info: at("info"), warn: at("warn"), error: at("error"), debug: at("debug") };
  }
}
