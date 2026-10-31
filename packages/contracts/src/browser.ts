/**
 * Yo in a web browser (the PC edition, and later Yo Cloud). A browser signs in like the Mac app does: it keeps its
 * own Ed25519 key (WebCrypto, non-extractable, in IndexedDB), enrolls it once with a one-time sign-in token, then
 * signs a fresh challenge whenever it needs a session. The session comes back as an HttpOnly cookie, so page
 * script never holds it. Design and long-term plan: docs/web-app/README.md.
 *
 * HTTP (no session needed, same origin only):
 *   GET  /auth/info      AuthInfo
 *   GET  /auth/me        AuthMe (reads the session cookie)
 *   POST /auth/enroll    { token, publicKey (SPKI DER, base64), label } -> { controllerId }
 *   POST /auth/challenge -> { nonce, expiresAt }
 *   POST /auth/session   { controllerId, nonce, signature (base64), cookie: true } -> { ok: true, expiresAt }
 *                        plus Set-Cookie yo_session (HttpOnly; SameSite=Strict; Path=/). Without `cookie` it
 *                        answers { token, expiresAt } as before (the Mac app and yo-ops).
 *   POST /auth/signout   ends this browser's session and clears the cookie.
 */

/** URL fragment that carries a one-time sign-in token: http://127.0.0.1:7777/#signin=<token>. */
export const SIGN_IN_FRAGMENT = "signin";

/** How long a sign-in token (from `yo-app signin` or Settings → Sign in another browser) stays valid. */
export const SIGN_IN_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Where this core runs. "pc": the PC edition (Docker on Windows or Linux, used in a browser). */
export type CoreEdition = "mac" | "pc" | "home-server";

export interface AuthInfo {
  protocol: 1;
  /** false only for YO_DEV cores (development). */
  authRequired: boolean;
  /** At least one app or browser has been signed in. */
  enrolled: boolean;
  coreId: string;
  /** This core accepts browser sign-in (cookie sessions). Absent on cores before the web app. */
  browserSignIn?: boolean;
  edition?: CoreEdition;
  /** The helper command on the machine running Yo ("yo-app" in the PC edition), or null. */
  helperCommand?: string | null;
}

export type AuthMe =
  | { signedIn: true; kind: "controller"; controllerId: string; expiresAt: number }
  | { signedIn: true; kind: "dev" }
  | { signedIn: false };

/** A signed-in app or browser (a "controller"). */
export interface SignedInClient {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface SignInLink {
  /** One-time token; the UI turns it into `${origin}/#signin=<token>`. */
  token: string;
  expiresAt: number;
}

/** `auth.*` WS methods (signed-in callers only). */
export interface BrowserApiMethods {
  /** Apps and browsers that can open Yo (not revoked). */
  "auth.clients.list": { params: Record<string, never>; result: SignedInClient[] };
  /** Sign one out for good: its sessions end and its open windows disconnect. */
  "auth.clients.revoke": { params: { id: string }; result: { ok: true } };
  "auth.clients.rename": { params: { id: string; label: string }; result: SignedInClient };
  /** A one-time link for signing in another browser (valid SIGN_IN_TOKEN_TTL_MS, works once). */
  "auth.signInLink.create": { params: Record<string, never>; result: SignInLink };
}
