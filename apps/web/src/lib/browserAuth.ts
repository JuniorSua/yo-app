/**
 * Browser sign-in: Yo in Chrome, Edge or Firefox (the PC edition, later Yo Cloud). Design: docs/web-app/README.md
 * ("Browser sign-in"); wire format: packages/contracts/src/browser.ts.
 *
 * The browser keeps its own Ed25519 key (WebCrypto, non-extractable, in IndexedDB under the core's id). It enrolls
 * the key once with a one-time token from a `#signin=<token>` link, then signs a fresh challenge whenever it needs
 * a session. Core answers with an HttpOnly cookie, so page script never holds a session token.
 *
 * Only active in a plain browser against a real core: the desktop app signs in from its main process, and the mock
 * (`?mock=1`) fakes all of this (`&mockAuth=…`, `&mockEdition=pc`, see lib/mock/auth.ts).
 */
import { type AuthInfo, type AuthMe, type CoreEdition, SIGN_IN_FRAGMENT, signedText } from "@yo/contracts";
import { create } from "zustand";
import { api, type BrowserSession, coreHttpBase, isMockMode } from "./api";
import { isDesktop } from "./desktop";

/** What `ensureSession` found. "unreachable": core didn't answer (the connecting screens handle it). */
export type SessionResult = "ok" | "signed-out" | "unsupported" | "unreachable";
export type AuthStatus = "checking" | "signed-in" | "signed-out" | "unsupported";

/** A session lasts 12 hours on core; renew well before. */
export const RENEW_MS = 6 * 60 * 60 * 1000;

export const EXPIRED_LINK = "That link was already used or has expired. Make a new one.";
export const NOT_A_LINK =
  "That doesn't look like a sign-in link. Paste the whole link, like http://127.0.0.1:7777/#signin=…";
export const UNREACHABLE = "Couldn't reach Yo. Check that it's running, then try again.";
export const TOO_MANY = "Too many tries. Wait a minute, then try again.";
export const UNSUPPORTED =
  "This browser can't keep a secure sign-in key. Update Chrome, Edge or Firefox to the newest version, then open Yo again.";

/** A sign-in that failed for a reason the person can act on (the message is shown as is). */
export class SignInError extends Error {}

/* --------------------------------- Key store -------------------------------- */

export interface StoredKey {
  coreId: string;
  controllerId: string;
  /** Non-extractable: the browser can sign with it but never hand it out. */
  privateKey: CryptoKey;
  /** SPKI DER, base64. */
  publicKey: string;
  createdAt: number;
}

/** Where the key lives. IndexedDB in the app; tests pass an in-memory one. */
export interface KeyStore {
  get(coreId: string): Promise<StoredKey | null>;
  put(key: StoredKey): Promise<void>;
  delete(coreId: string): Promise<void>;
}

export function memoryKeyStore(): KeyStore & { keys: Map<string, StoredKey> } {
  const keys = new Map<string, StoredKey>();
  return {
    keys,
    get: async (id) => keys.get(id) ?? null,
    put: async (k) => void keys.set(k.coreId, k),
    delete: async (id) => void keys.delete(id),
  };
}

/** IndexedDB database "yo-auth", store "keys", keyed by coreId (CryptoKeys are stored as they are). */
export function indexedDbKeyStore(name = "yo-auth"): KeyStore {
  let open: Promise<IDBDatabase> | null = null;
  const db = () =>
    (open ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("keys", { keyPath: "coreId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        open = null;
        reject(req.error);
      };
    }));
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const t = d.transaction("keys", mode);
      const req = fn(t.objectStore("keys"));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    get: async (id) => {
      try {
        return ((await tx("readonly", (s) => s.get(id))) as StoredKey | undefined) ?? null;
      } catch {
        // No IndexedDB (a locked-down profile): nothing stored, so the sign-in screen shows.
        return null;
      }
    },
    put: async (k) => void (await tx("readwrite", (s) => s.put(k))),
    delete: async (id) => void (await tx("readwrite", (s) => s.delete(id))),
  };
}

/* ---------------------------------- Helpers --------------------------------- */

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const ED25519 = { name: "Ed25519" } as const;

/** decodeURIComponent that answers "" for a malformed value (`#signin=%`) instead of throwing. */
function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    return "";
  }
}

/**
 * Take the one-time token out of the address bar (`#signin=<token>`) and remove it at once, keeping the path and
 * query, so it never stays in history or gets bookmarked.
 */
export function consumeSignInToken(
  loc: Pick<Location, "hash" | "pathname" | "search"> = location,
  hist: Pick<History, "replaceState" | "state"> = history,
): string | null {
  const m = new RegExp(`^#${SIGN_IN_FRAGMENT}=([^&]*)`).exec(loc.hash);
  if (!m) return null;
  hist.replaceState(hist.state, "", `${loc.pathname}${loc.search}`);
  const token = safeDecode(m[1] ?? "").trim();
  return token || null;
}

/**
 * The token in what someone pasted on the sign-in screen: a whole link (`…/#signin=<token>`) or just the token.
 * Null when it isn't either.
 */
export function parseSignInInput(input: string): string | null {
  const text = input.trim();
  const at = text.indexOf(`#${SIGN_IN_FRAGMENT}=`);
  if (at >= 0) {
    const token = safeDecode(text.slice(at + SIGN_IN_FRAGMENT.length + 2).split(/[&\s]/)[0] ?? "");
    return token || null;
  }
  return /^[A-Za-z0-9_-]{16,}$/.test(text) ? text : null;
}

interface NavigatorLike {
  userAgent: string;
  userAgentData?: { platform?: string; brands?: { brand: string }[] };
}

/** The client's operating system, as people call it. */
export function clientOs(nav: NavigatorLike = navigator): string {
  const ua = nav.userAgent;
  const p = nav.userAgentData?.platform ?? "";
  if (/windows/i.test(p) || /Windows NT/.test(ua)) return "Windows";
  if (/android/i.test(p) || /Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return /iPad/.test(ua) ? "iPad" : "iPhone";
  if (/chrome ?os/i.test(p) || /CrOS/.test(ua)) return "ChromeOS";
  if (/mac/i.test(p) || /Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/linux/i.test(p) || /Linux|X11/.test(ua)) return "Linux";
  return "this computer";
}

/** "Edge on Windows", "Firefox on Linux": how a browser is listed in Settings → Browsers & apps. */
export function browserLabel(nav: NavigatorLike = navigator): string {
  const ua = nav.userAgent;
  const brands = (nav.userAgentData?.brands ?? []).map((b) => b.brand);
  const browser =
    brands.includes("Microsoft Edge") || /Edg(e|A|iOS)?\//.test(ua)
      ? "Edge"
      : brands.includes("Opera") || /OPR\//.test(ua)
        ? "Opera"
        : brands.includes("Brave")
          ? "Brave"
          : /Firefox\/|FxiOS\//.test(ua)
            ? "Firefox"
            : brands.includes("Google Chrome") || /Chrome\/|CriOS\//.test(ua)
              ? "Chrome"
              : /Safari\//.test(ua)
                ? "Safari"
                : "Browser";
  return `${browser} on ${clientOs(nav)}`;
}

/* --------------------------------- Sign-in core ------------------------------- */

export interface BrowserAuthDeps {
  fetch: typeof fetch;
  keys: KeyStore;
  subtle: SubtleCrypto;
  /** Core's HTTP base, e.g. http://127.0.0.1:7777. */
  base: string;
  label: () => string;
  now?: () => number;
}

/** Core didn't answer, or answered something other than yes/no. */
class Unreachable extends Error {}

/**
 * The sign-in steps against core's /auth/* endpoints. No UI state: the singleton below turns results into the
 * app's signed-in / signed-out state.
 */
export class BrowserAuth {
  private info: AuthInfo | null = null;
  private inflight: Promise<SessionResult> | null = null;
  private support: Promise<boolean> | null = null;
  /** This browser's controller id, once known. */
  controllerId: string | null = null;

  constructor(private d: BrowserAuthDeps) {}

  private async req(path: string, body?: unknown): Promise<Response> {
    try {
      return await this.d.fetch(`${this.d.base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Unreachable("network");
    }
  }

  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) throw new Unreachable(`HTTP ${res.status}`);
    try {
      return (await res.json()) as T;
    } catch {
      throw new Unreachable("bad answer");
    }
  }

  /** GET /auth/info, once (cached after the first answer). */
  async authInfo(): Promise<AuthInfo> {
    if (this.info) return this.info;
    const info = await this.json<AuthInfo>(await this.req("/auth/info"));
    this.info = info;
    return info;
  }

  /** The last /auth/info answer, if any. */
  cachedInfo(): AuthInfo | null {
    return this.info;
  }

  /** Whether this browser can make and use Ed25519 keys (Chrome/Edge 137+, Firefox 129+, Safari 17+). */
  supported(): Promise<boolean> {
    if (!this.support)
      this.support = this.d.subtle.generateKey(ED25519, false, ["sign", "verify"]).then(
        () => true,
        () => false,
      );
    return this.support;
  }

  /**
   * Make sure this browser has a session cookie. `force`: sign a new session even when the current one still
   * works (the 6-hourly renewal). Concurrent calls share one run.
   */
  ensureSession(force = false): Promise<SessionResult> {
    if (this.inflight) return this.inflight;
    const run = this.run(force).finally(() => {
      this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private async run(force: boolean): Promise<SessionResult> {
    try {
      const info = await this.authInfo();
      if (!force) {
        const res = await this.req("/auth/me");
        const me: AuthMe = res.status === 401 ? { signedIn: false } : await this.json<AuthMe>(res);
        if (me.signedIn) {
          if (me.kind === "controller") this.controllerId = me.controllerId;
          return "ok";
        }
      }
      const key = await this.d.keys.get(info.coreId);
      if (!key) return (await this.supported()) ? "signed-out" : "unsupported";
      // A refused signature is retried once with a fresh challenge (a challenge can expire between the two
      // requests); refused twice means the key was revoked or core forgot it.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (await this.signSession(key)) {
          this.controllerId = key.controllerId;
          return "ok";
        }
      }
      await this.dropKey(info.coreId, key.controllerId);
      this.controllerId = null;
      // Core may have been reinstalled (a new coreId): ask again next time.
      this.info = null;
      return "signed-out";
    } catch (e) {
      if (e instanceof Unreachable) return "unreachable";
      // WebCrypto refused to sign (no Ed25519 any more): nothing this browser can do.
      return "unsupported";
    }
  }

  /** Challenge, sign, session. False when core refuses the signature (401). */
  private async signSession(key: StoredKey): Promise<boolean> {
    const { nonce } = await this.json<{ nonce: string; expiresAt: number }>(
      await this.req("/auth/challenge", {}),
    );
    const text = signedText.controllerSession(nonce, key.controllerId);
    const sig = await this.d.subtle.sign(ED25519, key.privateKey, new TextEncoder().encode(text));
    const res = await this.req("/auth/session", {
      controllerId: key.controllerId,
      nonce,
      signature: b64(sig),
      cookie: true,
    });
    if (res.status === 401) return false;
    await this.json<unknown>(res);
    return true;
  }

  /**
   * Enroll a new key with a one-time sign-in token. Afterwards `ensureSession()` signs in with it. Throws
   * SignInError with a message for people.
   */
  async enroll(token: string): Promise<void> {
    let info: AuthInfo;
    try {
      this.info = null;
      info = await this.authInfo();
    } catch {
      throw new SignInError(UNREACHABLE);
    }
    if (!(await this.supported())) throw new SignInError(UNSUPPORTED);
    const pair = (await this.d.subtle.generateKey(ED25519, false, ["sign", "verify"])) as CryptoKeyPair;
    const publicKey = b64(await this.d.subtle.exportKey("spki", pair.publicKey));
    let res: Response;
    try {
      res = await this.req("/auth/enroll", { token, publicKey, label: this.d.label() });
    } catch {
      throw new SignInError(UNREACHABLE);
    }
    if (res.status === 429) throw new SignInError(TOO_MANY);
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404)
      throw new SignInError(EXPIRED_LINK);
    let controllerId: string;
    try {
      controllerId = (await this.json<{ controllerId: string }>(res)).controllerId;
    } catch {
      throw new SignInError(UNREACHABLE);
    }
    try {
      await this.d.keys.put({
        coreId: info.coreId,
        controllerId,
        privateKey: pair.privateKey,
        publicKey,
        createdAt: (this.d.now ?? Date.now)(),
      });
    } catch {
      throw new SignInError(
        "This browser couldn't save its sign-in key. Turn off private browsing (or allow site data for this page), then try again.",
      );
    }
    this.controllerId = controllerId;
  }

  /** Delete the stored key only if it's still this controller's (not one a newer sign-in just saved). */
  private async dropKey(coreId: string, controllerId: string | null) {
    try {
      const stored = await this.d.keys.get(coreId);
      if (stored && (!controllerId || stored.controllerId === controllerId)) await this.d.keys.delete(coreId);
    } catch {
      /* nothing stored, or storage gone: nothing to forget */
    }
  }

  /** Forget this browser's key and end its session (the caller revokes the controller first). */
  async forget(): Promise<void> {
    const coreId = this.info?.coreId;
    const controllerId = this.controllerId;
    if (coreId && controllerId) await this.dropKey(coreId, controllerId);
    this.controllerId = null;
    await this.req("/auth/signout", {}).catch(() => undefined);
  }
}

/* ----------------------------------- App state ------------------------------- */

interface BrowserAuthState {
  /** Yo runs in a plain browser (not the Mac app): wording, shortcuts and link opening follow. */
  browserMode: boolean;
  status: AuthStatus;
  /** Core's /auth/info (edition, helper command), once known. */
  info: Pick<AuthInfo, "edition" | "helperCommand"> | null;
  /** This browser's (or app's) controller, for the "This browser" badge. */
  controllerId: string | null;
  /** A sign-in link from the address bar that didn't work (shown on the sign-in screen). */
  error: string | null;
}

/** Desktop app and the default mock: signed in, not a browser, nothing known about the edition. */
export const useBrowserAuth = create<BrowserAuthState>(() => ({
  browserMode: false,
  status: "signed-in",
  info: null,
  controllerId: null,
  error: null,
}));

/** Core's edition ("pc" for the PC edition), when known. */
export function useEdition(): CoreEdition | null {
  return useBrowserAuth((s) => s.info?.edition ?? null);
}

/** What the sign-in screen and Settings need from whichever side does the signing in (real core or the mock). */
export interface SignInBackend {
  /** Enroll with a one-time token and start a session. Throws SignInError with a message for people. */
  signIn(token: string): Promise<void>;
  /** Revoke this browser, forget its key and end its session. */
  signOut(): Promise<void>;
}

let backend: SignInBackend | null = null;

/** The mock installs its own (lib/mock/auth.ts). */
export function setSignInBackend(b: SignInBackend | null) {
  backend = b;
}

/** Browser sign-in applies: a plain browser against a real core. */
export function browserAuthActive(): boolean {
  return !isDesktop && !isMockMode();
}

const INFO_CACHE = "yo.authInfo";

function readCachedInfo(): BrowserAuthState["info"] {
  try {
    const v = JSON.parse(localStorage.getItem(INFO_CACHE) ?? "null");
    return v && typeof v === "object" ? { edition: v.edition, helperCommand: v.helperCommand ?? null } : null;
  } catch {
    return null;
  }
}

function publishInfo(info: AuthInfo | null) {
  if (!info) return;
  const slim = { edition: info.edition, helperCommand: info.helperCommand ?? null };
  useBrowserAuth.setState({ info: slim });
  try {
    // The connecting screen's advice needs the edition even when core is down at the next start.
    localStorage.setItem(INFO_CACHE, JSON.stringify(slim));
  } catch {
    /* ignore */
  }
}

let auth: BrowserAuth | null = null;
let pendingToken: string | null = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;

function startRenewal() {
  if (renewTimer || !auth) return;
  renewTimer = setInterval(() => {
    void auth?.ensureSession(true).then((r) => {
      if (r === "signed-out" || r === "unsupported") settle(r);
    });
  }, RENEW_MS);
}

function stopRenewal() {
  if (renewTimer) clearInterval(renewTimer);
  renewTimer = null;
}

function settle(r: SessionResult): "go" | "retry" | "stop" {
  publishInfo(auth?.cachedInfo() ?? null);
  if (r === "unreachable") return "retry";
  if (r === "ok") {
    useBrowserAuth.setState({ status: "signed-in", controllerId: auth?.controllerId ?? null, error: null });
    startRenewal();
    return "go";
  }
  stopRenewal();
  useBrowserAuth.setState({ status: r, controllerId: null });
  return "stop";
}

/** Runs before every connect: sign in quietly when possible, else show the sign-in screen. */
async function connectGate(): Promise<"go" | "retry" | "stop"> {
  const a = auth;
  if (!a) return "go";
  if (pendingToken) {
    const now = await a.ensureSession();
    if (now === "unreachable") return "retry"; // keep the token for the next attempt
    const token = pendingToken;
    pendingToken = null;
    // Already signed in: the link isn't needed (and stays unused).
    if (now === "signed-out") {
      try {
        await a.enroll(token);
      } catch (e) {
        if (e instanceof SignInError && e.message === UNREACHABLE) {
          pendingToken = token;
          return "retry";
        }
        useBrowserAuth.setState({ error: e instanceof Error ? e.message : String(e) });
      }
    } else if (now === "unsupported") return settle(now);
  }
  return settle(await a.ensureSession());
}

/**
 * Core closed the socket because this browser was revoked or signed out (maybe from another tab or browser):
 * its key is no good any more, so forget it and show the sign-in screen.
 */
function onSignedOut() {
  void auth?.forget();
  settle("signed-out");
}

/**
 * Call once at startup, before the API client exists. In a plain browser against a real core it takes the
 * `#signin=` token out of the address bar and returns the socket's sign-in hooks; elsewhere it does nothing.
 */
export function prepareBrowserAuth(): BrowserSession | undefined {
  if (!browserAuthActive()) return undefined;
  pendingToken = consumeSignInToken();
  const a = new BrowserAuth({
    fetch: (...args) => fetch(...args),
    keys: indexedDbKeyStore(),
    subtle: crypto.subtle,
    base: coreHttpBase(),
    label: () => browserLabel(),
  });
  auth = a;
  useBrowserAuth.setState({ browserMode: true, status: "checking", info: readCachedInfo() });
  setSignInBackend({
    async signIn(token) {
      await a.enroll(token);
      const r = await a.ensureSession();
      if (r === "ok") return;
      throw new SignInError(
        r === "unsupported"
          ? UNSUPPORTED
          : r === "unreachable"
            ? UNREACHABLE
            : "Yo didn't accept this browser's key. Make a new link and try again.",
      );
    },
    async signOut() {
      const id = a.controllerId;
      if (id)
        await api()
          .call("auth.clients.revoke", { id })
          .catch(() => undefined);
      await a.forget();
    },
  });
  // A link pasted into the address bar of a tab that's already open only changes the fragment (no page load), so
  // startup never sees it: pick it up here. A browser that's already signed in just drops it.
  window.addEventListener("hashchange", () => {
    const token = consumeSignInToken();
    if (!token || useBrowserAuth.getState().status === "signed-in") return;
    void submitSignIn(token).then((error) => {
      if (error) useBrowserAuth.setState({ error });
    });
  });
  return { gate: connectGate, onSignedOut };
}

/**
 * The sign-in screen's button: sign in with a pasted link (or token). Resolves to an error message, or null once
 * signed in (the app then connects and loads).
 */
export async function submitSignIn(input: string): Promise<string | null> {
  const token = parseSignInInput(input);
  if (!token) return NOT_A_LINK;
  if (!backend) return UNREACHABLE;
  try {
    await backend.signIn(token);
  } catch (e) {
    return e instanceof SignInError ? e.message : UNREACHABLE;
  }
  useBrowserAuth.setState({
    status: "signed-in",
    error: null,
    controllerId: auth?.controllerId ?? useBrowserAuth.getState().controllerId,
  });
  if (auth) startRenewal();
  api().reconnectNow();
  return null;
}

/** Settings → Browsers & apps → Sign out on this browser's own row. */
export async function signOutThisBrowser(): Promise<void> {
  await backend?.signOut();
  stopRenewal();
  useBrowserAuth.setState({ status: "signed-out", controllerId: null, error: null });
}

/**
 * This app's or browser's own controller id, for the "This browser" badge. Known after a browser sign-in; the
 * desktop app asks core (its window carries the session cookie main installed).
 */
export async function ownControllerId(): Promise<string | null> {
  const known = useBrowserAuth.getState().controllerId;
  if (known || isMockMode()) return known;
  try {
    const res = await fetch(`${coreHttpBase()}/auth/me`, { credentials: "include", cache: "no-store" });
    const me = res.ok ? ((await res.json()) as AuthMe) : null;
    const id = me?.signedIn && me.kind === "controller" ? me.controllerId : null;
    if (id) useBrowserAuth.setState({ controllerId: id });
    return id;
  } catch {
    return null;
  }
}

/** `${origin}/#signin=<token>`: the link a sign-in token becomes. */
export function signInLinkUrl(token: string, base = coreHttpBase()): string {
  return `${base}/#${SIGN_IN_FRAGMENT}=${encodeURIComponent(token)}`;
}
