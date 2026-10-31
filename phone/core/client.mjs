// The core's side of the Yo Phone relay protocol (docs/phone/PROTOCOL.md, v2), for small Node-side cores such as
// the dev fake core (dev/fake-core.mjs). The real core does the same in apps/core/src/channels/phone.ts.
//
// Every call sends the bearer token, the link's admit and the core-only credential. Out items are sealed with a
// rising counter `n` and signed with the link's Ed25519 key, so the phone accepts them.

import {
  admitFor,
  boxFor,
  coreCredFor,
  deriveKeys,
  hashOf,
  open,
  openBlob,
  randomBlobId,
  seal,
  sealBlob,
} from "../lib/crypto.js";
import { signOut } from "./sign.mjs";

/**
 * Upstash commands each relay call costs (see phone/api/relay.js). A beat is EXISTS + LRANGE + SET (plus 4 EXPIREs on
 * the first beat of a UTC day, which this ignores). Posting out is EXISTS + INCR + EXPIRE + RPUSH + LTRIM + EXPIRE.
 */
export const COMMANDS = Object.freeze({ poll: 1, beat: 3, ack: 1, out: 6, register: 1, wipe: 1 });

export class RelayError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** True when the relay forgot (or never had) this mailbox: register again, or the link was turned off. */
export const isRevoked = (err) => err instanceof RelayError && err.status === 404;

/**
 * Everything the core derives from a link secret and the relay's register key.
 * @param {string} secret 32 bytes, base64url
 * @param {string} registerKey
 */
export async function linkCreds(secret, registerKey) {
  const { authToken, encKey } = await deriveKeys(secret);
  const box = await boxFor(authToken);
  const [admit, coreCred] = await Promise.all([admitFor(registerKey, box), coreCredFor(registerKey, box)]);
  return { authToken, encKey, box, admit, coreCred };
}

/** The v2 phone link: `https://<relay>/#k=<secret>&a=<admit>&p=<signPub>`. */
export function phoneLink(relayUrl, secret, admit, signPub) {
  return `${relayUrl.replace(/\/+$/, "")}/#k=${secret}&a=${admit}&p=${signPub}`;
}

/**
 * @param {{
 *   relayUrl: string,
 *   creds: { authToken: string, encKey: CryptoKey, admit: string, coreCred: string },
 *   signPkcs8: string,
 *   outN?: number,
 *   fetch?: typeof globalThis.fetch,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 *   onCommands?: (n: number) => void,
 * }} opts
 *   outN: the last counter used for this link (saved by the caller, so it keeps rising across restarts)
 *   onCommands: told roughly how many Upstash commands each call cost, for a budget meter
 */
export function createCoreClient(opts) {
  const relayUrl = opts.relayUrl.replace(/\/+$/, "");
  const { creds, signPkcs8 } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const count = opts.onCommands ?? (() => {});
  let outN = opts.outN ?? 0;

  const headers = {
    authorization: `Bearer ${creds.authToken}`,
    "x-yo-admit": creds.admit,
    "x-yo-core": creds.coreCred,
  };

  async function call(method, path, body) {
    const res = await doFetch(`${relayUrl}/api/relay/${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) {
      const err = new RelayError(res.status, json?.error ?? `HTTP ${res.status}`);
      const retry = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retry) && retry > 0) err.retryAfterMs = retry * 1000;
      throw err;
    }
    return json;
  }

  return {
    get outN() {
      return outN;
    },

    /** Allow writes to this mailbox for 30 days. Safe to repeat. */
    async register() {
      count(COMMANDS.register);
      await call("POST", "register");
    },

    /** Delete the whole mailbox: the link stops working. */
    async wipe() {
      count(COMMANDS.wipe);
      await call("DELETE", "box");
    },

    /**
     * Read up to 50 waiting envelopes. A beat also tells the phone the core is online, and 404s if the mailbox
     * isn't registered.
     * @returns {Promise<string[]>}
     */
    async pollIn({ beat = false } = {}) {
      count(beat ? COMMANDS.beat : COMMANDS.poll);
      const { items } = await call("GET", `in${beat ? "?beat=1" : ""}`);
      return Array.isArray(items) ? items.map(String) : [];
    },

    /** Drop the first `n` envelopes read (after they've been handled). */
    async ack(n) {
      if (n <= 0) return;
      count(COMMANDS.ack);
      await call("POST", "in/ack", { count: n });
    },

    /** Decrypt an `in` envelope; null if it isn't for this link (or isn't valid). */
    async openIn(envelope) {
      try {
        return await open(creds.encKey, envelope, "in");
      } catch {
        return null;
      }
    },

    /**
     * Seal, sign and post one message to the phone. `n` goes up with every message and a retry reuses it, so if a
     * "failed" post did land, the phone drops the copy. Retries once on network errors and 5xx.
     * @param {Record<string, unknown>} msg
     * @returns {Promise<{ seq: number, n: number }>}
     */
    async post(msg) {
      outN = Math.max(outN + 1, now());
      const n = outN;
      const box = await seal(creds.encKey, { v: 1, n, ...msg }, "out");
      const sig = await signOut(signPkcs8, box);
      for (let attempt = 0; ; attempt++) {
        try {
          count(COMMANDS.out);
          const { seq } = await call("POST", "out", { box, sig });
          return { seq, n };
        } catch (err) {
          const retryable = !(err instanceof RelayError) || err.status >= 500;
          if (attempt >= 1 || !retryable) throw err;
          await sleep(1000);
        }
      }
    },

    /**
     * v2.1: store one picture for the phone (encrypted, as a blob) and return the reference an `images` message
     * carries. Costs 4 commands.
     * @param {Uint8Array} bytes @param {{ mime: string, w: number, h: number, src?: string, alt?: string }} info
     */
    async postPicture(bytes, info) {
      const id = randomBlobId();
      const box = await sealBlob(creds.encKey, bytes, "out", id);
      count(4);
      await call("POST", "blob/out", { id, box });
      return { id, size: bytes.length, hash: await hashOf(bytes), ...info };
    },

    /** v2.1: a photo the phone stored with a message, decrypted. */
    async getPhoto(id) {
      count(2);
      const { box } = await call("GET", `blob/in?id=${encodeURIComponent(id)}`);
      return openBlob(creds.encKey, box, "in", id);
    },
  };
}
