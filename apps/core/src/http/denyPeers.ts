/**
 * YO_DENY_PEERS: hosts that must never reach core. In the PC edition core listens on 0.0.0.0 inside its container
 * (Docker publishes it on the PC's 127.0.0.1 only), and the agent's computer shares core's Docker network, so
 * core drops every connection from the computer's addresses before reading a byte. A prompt-injected agent then
 * can't even reach the sign-in endpoints.
 *
 * Names are looked up again every 15 s (a recreated container can get a new address). Addresses once seen are
 * kept for good: forgetting one could let the computer in if a lookup briefly answers something else.
 */
import dns from "node:dns";
import { logger } from "../log";

const log = logger("deny-peers");

const REFRESH_MS = 15_000;
const FIRST_TRY_MS = 5_000;
const RETRY_MS = 500;

type Lookup = (name: string) => Promise<string[]>;

const lookupAll: Lookup = async (name) =>
  (await dns.promises.lookup(name, { all: true })).map((a) => a.address);

/** One spelling per address: IPv4-mapped IPv6 (::ffff:a.b.c.d) as plain IPv4, IPv6 in lower case. */
export function normalizeAddress(address: string): string {
  const a = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  return mapped ? mapped[1]! : a;
}

export class PeerDenyList {
  private denied = new Set<string>();
  private resolved = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly names: string[],
    private readonly lookup: Lookup = lookupAll,
  ) {}

  get active() {
    return this.names.length > 0;
  }

  /** True when a connection from this address must be dropped. */
  denies(address: string | undefined): boolean {
    return !!address && this.denied.has(normalizeAddress(address));
  }

  /** Every name has resolved at least once. */
  get ready() {
    return this.names.every((n) => this.resolved.has(n));
  }

  /** Look every name up again, adding what's new. */
  async refresh(): Promise<void> {
    await Promise.all(
      this.names.map(async (name) => {
        try {
          const before = this.denied.size;
          for (const a of await this.lookup(name)) this.denied.add(normalizeAddress(a));
          this.resolved.add(name);
          if (this.denied.size > before) log.info(`refusing connections from ${name}`);
        } catch (err: any) {
          log.debug(`couldn't look up ${name}: ${err?.code ?? err?.message ?? err}`);
        }
      }),
    );
  }

  /**
   * Resolve before core starts listening (retrying for a few seconds while the computer's container comes up),
   * then keep refreshing. Never throws: if a name still doesn't resolve, the refresh keeps trying.
   */
  async start(): Promise<void> {
    if (!this.active) return;
    const until = Date.now() + FIRST_TRY_MS;
    for (;;) {
      await this.refresh();
      if (this.ready || Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
    if (!this.ready)
      log.warn(
        `couldn't look up ${this.names.filter((n) => !this.resolved.has(n)).join(", ")} yet; listening anyway and retrying every ${REFRESH_MS / 1000} s`,
      );
    this.timer ??= setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
