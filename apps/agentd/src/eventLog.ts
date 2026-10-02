/** Per-session event sequencing + bounded ring buffer for replay after a control reconnect. */

export interface SeqEntry<T> {
  seq: number;
  value: T;
}

export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private start = 0;
  private len = 0;
  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error("capacity must be >= 1");
    this.buf = new Array(capacity);
  }
  push(v: T): void {
    if (this.len < this.capacity) {
      this.buf[(this.start + this.len) % this.capacity] = v;
      this.len++;
    } else {
      this.buf[this.start] = v;
      this.start = (this.start + 1) % this.capacity;
    }
  }
  get size(): number {
    return this.len;
  }
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.len; i++) out.push(this.buf[(this.start + i) % this.capacity] as T);
    return out;
  }
}

export interface ReplayResult<T> {
  entries: SeqEntry<T>[];
  /** True when events after lastSeq were evicted and cannot be replayed. */
  gap: boolean;
}

export class SessionEventLog<T> {
  private sessions = new Map<string, { nextSeq: number; ring: RingBuffer<SeqEntry<T>> }>();
  constructor(private readonly capacity = 2000) {}

  append(sessionKey: string, value: T): SeqEntry<T> {
    let s = this.sessions.get(sessionKey);
    if (!s) {
      s = { nextSeq: 1, ring: new RingBuffer(this.capacity) };
      this.sessions.set(sessionKey, s);
    }
    const entry = { seq: s.nextSeq++, value };
    s.ring.push(entry);
    return entry;
  }

  lastSeq(sessionKey: string): number {
    const s = this.sessions.get(sessionKey);
    return s ? s.nextSeq - 1 : 0;
  }

  /** Events with seq > lastSeq still in the buffer. */
  since(sessionKey: string, lastSeq: number): ReplayResult<T> {
    const s = this.sessions.get(sessionKey);
    if (!s) return { entries: [], gap: false };
    const all = s.ring.toArray();
    const entries = all.filter((e) => e.seq > lastSeq);
    const oldest = all[0]?.seq ?? s.nextSeq;
    const gap = lastSeq + 1 < oldest && s.nextSeq - 1 > lastSeq;
    return { entries, gap };
  }

  sessionKeys(): string[] {
    return [...this.sessions.keys()];
  }

  drop(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}
