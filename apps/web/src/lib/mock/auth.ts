/**
 * Mock browser sign-in (lib/browserAuth.ts) and Settings → Browsers & apps (`auth.*`).
 *
 *   &mockAuth=signed-out   this browser isn't signed in: the sign-in screen shows. Pasting any link with
 *                          `#signin=` (or a 64-hex token) signs in and loads the app; `#signin=expired`, or a
 *                          link that was already used, fails like an expired one.
 *   &mockAuth=unsupported  this browser has no Ed25519 in WebCrypto: the "Update your browser" screen.
 *   &mockEdition=pc        core is the PC edition (Docker on Windows/Linux, opened in a browser): PC wording,
 *                          `yo-app` commands, "This PC" placement.
 *
 * Either flag turns on browser mode (the UI as a plain browser shows it). Without them the mock is the Mac app's
 * UI as before, and Settings → Browsers & apps lists this app and a couple of browsers.
 */
import type { AuthInfo, SignedInClient, SignInLink } from "@yo/contracts";
import { browserLabel, EXPIRED_LINK, SignInError, setSignInBackend, useBrowserAuth } from "../browserAuth";

export type MockAuthScenario = "signed-in" | "signed-out" | "unsupported";

export function mockAuthScenario(q: URLSearchParams): MockAuthScenario {
  const v = q.get("mockAuth");
  return v === "signed-out" || v === "unsupported" ? v : "signed-in";
}

export const MOCK_SELF_ID = "ctl_this";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export class MockAuth {
  readonly browserMode: boolean;
  readonly info: AuthInfo;
  private clients: SignedInClient[];
  private links = new Map<string, number>();
  private used = new Set<string>();
  /** Calls wait here while this browser isn't signed in (like a socket that can't open yet). */
  private gate: { promise: Promise<void>; open: () => void } | null = null;

  constructor(
    q: URLSearchParams,
    private hooks: {
      /** The app may connect now: the socket "opens". */
      connected: () => void;
      /** This browser was signed out: the socket "closes". */
      disconnected: () => void;
    },
  ) {
    const scenario = mockAuthScenario(q);
    const pc = q.get("mockEdition") === "pc";
    this.browserMode = pc || q.has("mockAuth");
    this.info = {
      protocol: 1,
      authRequired: true,
      enrolled: true,
      coreId: "core_mock",
      browserSignIn: true,
      edition: pc ? "pc" : "mac",
      helperCommand: pc ? "yo-app" : null,
    };
    const now = Date.now();
    const self: SignedInClient = {
      id: MOCK_SELF_ID,
      label: this.browserMode ? browserLabel() : "Yo app on this Mac",
      createdAt: now - 12 * DAY,
      lastUsedAt: now,
    };
    this.clients = [
      ...(scenario === "signed-in" ? [self] : []),
      { id: "ctl_laptop", label: "Edge on Windows", createdAt: now - 30 * DAY, lastUsedAt: now - 2 * DAY },
      { id: "ctl_tablet", label: "Firefox on Linux", createdAt: now - 5 * DAY, lastUsedAt: null },
    ];
    if (scenario !== "signed-in") this.gate = gateOpenedLater();
    useBrowserAuth.setState({
      browserMode: this.browserMode,
      status: scenario,
      info: { edition: this.info.edition, helperCommand: this.info.helperCommand },
      controllerId: scenario === "signed-in" ? MOCK_SELF_ID : null,
    });
    setSignInBackend({
      signIn: async (token) => this.signIn(token),
      signOut: async () => this.signOut(),
    });
  }

  /** True while calls must wait for a sign-in. */
  get waiting(): Promise<void> | null {
    return this.gate?.promise ?? null;
  }

  private async signIn(token: string) {
    await new Promise((r) => setTimeout(r, 150));
    if (useBrowserAuth.getState().status === "unsupported")
      throw new SignInError("Update your browser first.");
    const known = this.links.has(token);
    if (token === "expired" || this.used.has(token) || (known && this.links.get(token)! < Date.now()))
      throw new SignInError(EXPIRED_LINK);
    this.used.add(token);
    this.links.delete(token);
    const now = Date.now();
    this.clients = [
      { id: MOCK_SELF_ID, label: browserLabel(), createdAt: now, lastUsedAt: now },
      ...this.clients.filter((c) => c.id !== MOCK_SELF_ID),
    ];
    useBrowserAuth.setState({ controllerId: MOCK_SELF_ID });
    const g = this.gate;
    this.gate = null;
    this.hooks.connected();
    g?.open();
  }

  private async signOut() {
    this.revoke(MOCK_SELF_ID);
    this.gate = gateOpenedLater();
    this.hooks.disconnected();
  }

  list(): SignedInClient[] {
    return [...this.clients].sort((a, b) => (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt));
  }

  revoke(id: string): { ok: true } {
    if (!this.clients.some((c) => c.id === id)) throw new Error("That app or browser isn't signed in to Yo.");
    this.clients = this.clients.filter((c) => c.id !== id);
    return { ok: true };
  }

  rename(id: string, label: string): SignedInClient {
    const c = this.clients.find((x) => x.id === id);
    if (!c) throw new Error("That app or browser isn't signed in to Yo.");
    const clean = label.trim();
    if (!clean) throw new Error("The name can't be empty.");
    if (clean.length > 80) throw new Error("Keep the name under 80 characters.");
    c.label = clean;
    return c;
  }

  createLink(): SignInLink {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const expiresAt = Date.now() + 10 * 60_000;
    this.links.set(token, expiresAt);
    return { token, expiresAt };
  }

  /** Test hook: another browser signs in with a link made in Settings. */
  useLink(token: string, label = "Chrome on Android") {
    if (!this.links.delete(token)) return false;
    this.used.add(token);
    const now = Date.now();
    this.clients.push({ id: `ctl_${token.slice(0, 6)}`, label, createdAt: now, lastUsedAt: now });
    return true;
  }
}

function gateOpenedLater() {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}
