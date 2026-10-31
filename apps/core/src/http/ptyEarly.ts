/**
 * Terminal output that arrives before the browser's terminal socket attaches. `pty.open` starts the shell on the
 * agent's computer and only then does the UI open `/api/pty/:id`; a shell that prints its prompt in between used to
 * lose it, and the terminal sat blank until the user pressed Enter. This keeps that output (bounded, short-lived)
 * and hands it to the socket when it attaches.
 */
import type { AgentdPush } from "@yo/contracts";

/** Per terminal: more than this before anyone attaches is dropped from the front (a prompt is a few hundred bytes). */
const MAX_BYTES = 256 * 1024;
/** A terminal nobody attached to within this long is forgotten. */
const TTL_MS = 60_000;

interface Pending {
  chunks: string[];
  bytes: number;
  exited: boolean;
  since: number;
}

export class PtyEarlyOutput {
  private pending = new Map<string, Pending>();
  private attached = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed every agentd push; keeps pty output for terminals with no socket yet. */
  onPush(p: AgentdPush) {
    if (p.type !== "pty.data" && p.type !== "pty.exit") return;
    if (this.attached.has(p.ptyId)) return;
    this.sweep();
    const entry = this.pending.get(p.ptyId) ?? { chunks: [], bytes: 0, exited: false, since: this.now() };
    this.pending.set(p.ptyId, entry);
    if (p.type === "pty.exit") {
      entry.exited = true;
      return;
    }
    entry.chunks.push(p.data);
    entry.bytes += p.data.length;
    while (entry.bytes > MAX_BYTES && entry.chunks.length > 1) entry.bytes -= entry.chunks.shift()!.length;
  }

  /** The socket for this terminal attached: what it missed, and whether the shell already exited. */
  attach(ptyId: string): { output: string; exited: boolean } {
    this.attached.add(ptyId);
    const entry = this.pending.get(ptyId);
    this.pending.delete(ptyId);
    return { output: entry?.chunks.join("") ?? "", exited: entry?.exited ?? false };
  }

  /** The socket closed: the terminal is gone. */
  detach(ptyId: string) {
    this.attached.delete(ptyId);
    this.pending.delete(ptyId);
  }

  private sweep() {
    const t = this.now();
    for (const [id, e] of this.pending) if (t - e.since > TTL_MS) this.pending.delete(id);
  }
}
