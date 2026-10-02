/**
 * Signs the desktop app in to core (see apps/core/src/auth/ControllerAuth.ts).
 * Keys are per core (a local core and the Home PC core are different cores). The private key never
 * leaves main; the renderer only ever gets an HttpOnly cookie for the UI origin.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { signedText } from "@yo/contracts";
import type { SecureFile } from "./secureStore";

export interface ControllerKeys {
  [coreId: string]: { controllerId: string; privateKey: string; publicKey: string };
}

export type SignInResult =
  | { kind: "legacy" } // core predates sign-in: nothing to do
  | { kind: "signed-in"; token: string; expiresAt: number; coreId: string }
  | { kind: "needs-enrollment"; coreId: string };

export class Controller {
  token: string | null = null;
  expiresAt = 0;
  coreId: string | null = null;
  /** False for a development core that lets loopback clients in without signing in. */
  authRequired = true;

  constructor(
    private readonly coreUrl: string,
    private readonly keys: SecureFile<ControllerKeys>,
    private readonly userData: string,
    private readonly label: string,
  ) {}

  /** The one-time enrollment token the owner placed on this Mac (or that main wrote for its own core). */
  get enrollTokenFile() {
    return path.join(this.userData, "enroll-token");
  }

  /** `beforeEnroll` runs when this core doesn't know us yet (lets main open enrollment for its own core). */
  async signIn(beforeEnroll?: () => void): Promise<SignInResult> {
    const info = await fetch(`${this.coreUrl}/auth/info`, { signal: AbortSignal.timeout(5000) }).catch(
      () => null,
    );
    if (!info) throw new Error("core unreachable");
    if (info.status === 404) return { kind: "legacy" };
    const { coreId, authRequired } = (await info.json()) as { coreId: string; authRequired: boolean };
    this.coreId = coreId;
    this.authRequired = authRequired !== false;
    const all = this.keys.read() ?? {};
    let mine = all[coreId];
    if (!mine) {
      beforeEnroll?.();
      const token = readToken(this.enrollTokenFile);
      if (!token) return { kind: "needs-enrollment", coreId };
      const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
      const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
      const res = await this.post("/auth/enroll", { token, publicKey: pub, label: this.label });
      fs.rmSync(this.enrollTokenFile, { force: true });
      mine = {
        controllerId: String(res.controllerId),
        privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
        publicKey: pub,
      };
      this.keys.write({ ...all, [coreId]: mine });
    }
    const { nonce } = await this.post("/auth/challenge", {});
    const key = crypto.createPrivateKey({
      key: Buffer.from(mine.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const signature = crypto
      .sign(null, Buffer.from(signedText.controllerSession(String(nonce), mine.controllerId)), key)
      .toString("base64");
    const s = await this.post("/auth/session", { controllerId: mine.controllerId, nonce, signature }).catch(
      (err) => {
        // The core forgot us (revoked, or its data was reset): drop the stale key so we can re-enroll.
        if (/rejected/.test(String(err?.message))) {
          delete all[coreId];
          this.keys.write(all);
        }
        throw err;
      },
    );
    this.token = String(s.token);
    this.expiresAt = Number(s.expiresAt);
    return { kind: "signed-in", token: this.token, expiresAt: this.expiresAt, coreId };
  }

  async post(p: string, body: unknown): Promise<any> {
    const res = await fetch(`${this.coreUrl}${p}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json.error ?? `HTTP ${res.status}`));
    return json;
  }
}

function readToken(file: string): string | null {
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    return t.length >= 32 ? t : null;
  } catch {
    return null;
  }
}
