/**
 * Mock Yo Phone (`channels.phone.*`, Settings → Phone).
 *
 *   &mockPhone=off        no link yet (default)
 *   &mockPhone=ready      a link waiting for the phone
 *   &mockPhone=connected  a phone opened the link a few minutes ago
 *   &mockPhone=nokey      off, and the relay key isn't set (so no link can be made)
 *   &mockPhone=revoking   ready, and wiping the old link's mailbox is still being retried
 *
 * After "Create phone link" / "New link", the pretend phone opens it a few seconds later.
 */
import type { PhoneStatus } from "@yo/contracts";

export type MockPhoneScenario = "off" | "ready" | "connected" | "nokey" | "revoking";

export function mockPhoneScenario(q: URLSearchParams): MockPhoneScenario {
  const v = q.get("mockPhone");
  return v === "ready" || v === "connected" || v === "nokey" || v === "revoking" ? v : "off";
}

const RELAY = "https://yo-phone.vercel.app";

function fakeSecret(): string {
  return fakeB64(32);
}

function fakeB64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class MockPhone {
  private secret: string | null = null;
  private pairedAt: number | null = null;
  private lastPhoneAt: number | null = null;
  private device: string | null = null;
  private relayUrl = RELAY;
  private registerKeySet: boolean;
  private revokePending: boolean;
  /** The link's admit and signing key (v2 link: #k=&a=&p=). */
  private admit = fakeB64(32);
  private signPub = fakeB64(32);
  private opener: ReturnType<typeof setTimeout> | null = null;

  constructor(
    scenario: MockPhoneScenario,
    private scale: number,
  ) {
    this.registerKeySet = scenario !== "nokey";
    this.revokePending = scenario === "revoking";
    if (scenario === "off" || scenario === "nokey") return;
    this.secret = fakeSecret();
    this.pairedAt = Date.now() - 2 * 86_400_000;
    if (scenario === "connected") {
      this.lastPhoneAt = Date.now() - 4 * 60_000;
      this.device = "iPhone · Safari";
    }
  }

  status(): PhoneStatus {
    const on = !!this.secret;
    return {
      enabled: on,
      relayUrl: this.relayUrl,
      link: on ? this.link() : null,
      pairedAt: on ? this.pairedAt : null,
      lastPhoneAt: on ? this.lastPhoneAt : null,
      device: on ? this.device : null,
      polling: on,
      lastError: null,
      registerKeySet: this.registerKeySet,
      revokePending: this.revokePending,
    };
  }

  pair(): { link: string } {
    if (!this.registerKeySet) throw new Error("Relay key missing — run `yo-ops phone key`.");
    this.secret = fakeSecret();
    this.admit = fakeB64(32);
    this.signPub = fakeB64(32);
    this.pairedAt = Date.now();
    this.lastPhoneAt = null;
    this.device = null;
    if (this.opener) clearTimeout(this.opener);
    const secret = this.secret;
    // The phone opens the link a little later.
    this.opener = setTimeout(() => {
      if (this.secret !== secret) return;
      this.lastPhoneAt = Date.now();
      this.device = "iPhone · Safari";
    }, 8000 * this.scale);
    return { link: this.link() };
  }

  private link(): string {
    return `${this.relayUrl}/#k=${this.secret}&a=${this.admit}&p=${this.signPub}`;
  }

  configure(relayUrl: string | null | undefined, registerKey?: string | null): PhoneStatus {
    if (registerKey !== undefined) this.registerKeySet = !!registerKey?.trim();
    if (relayUrl !== undefined) {
      const url = relayUrl?.trim();
      if (url && !/^https:\/\//.test(url)) throw new Error("The relay must be an https:// address.");
      this.relayUrl = url ? url.replace(/\/+$/, "") : RELAY;
    }
    return this.status();
  }

  off(): PhoneStatus {
    if (this.opener) clearTimeout(this.opener);
    this.secret = null;
    this.pairedAt = null;
    this.lastPhoneAt = null;
    this.device = null;
    return this.status();
  }
}
