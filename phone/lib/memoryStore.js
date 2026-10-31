// In-memory stand-in for Upstash Redis, for tests and the local dev server. It implements only the commands the
// relay uses, with Redis semantics (negative list indexes, EX expiry). Same interface as the Upstash store:
// `pipeline(commands) -> results`.

/** @param {{ now?: () => number }} [opts] */
export function createMemoryStore(opts = {}) {
  const now = opts.now ?? Date.now;
  /** @type {Map<string, {value: any, expiresAt: number | null}>} */
  const data = new Map();

  const live = (key) => {
    const entry = data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      data.delete(key);
      return undefined;
    }
    return entry;
  };
  const list = (key) => {
    const entry = live(key);
    if (!entry) return [];
    if (!Array.isArray(entry.value)) throw new Error("WRONGTYPE");
    return entry.value;
  };
  const range = (len, start, stop) => {
    let s = Number(start);
    let e = Number(stop);
    if (s < 0) s = Math.max(len + s, 0);
    if (e < 0) e = len + e;
    if (e >= len) e = len - 1;
    return [s, e];
  };

  const commands = {
    RPUSH(key, ...values) {
      const arr = list(key);
      arr.push(...values.map(String));
      const entry = live(key);
      if (entry) entry.value = arr;
      else data.set(key, { value: arr, expiresAt: null });
      return arr.length;
    },
    LLEN: (key) => list(key).length,
    LRANGE(key, start, stop) {
      const arr = list(key);
      const [s, e] = range(arr.length, start, stop);
      return s > e ? [] : arr.slice(s, e + 1);
    },
    LTRIM(key, start, stop) {
      const entry = live(key);
      if (!entry) return "OK";
      const [s, e] = range(entry.value.length, start, stop);
      entry.value = s > e ? [] : entry.value.slice(s, e + 1);
      if (entry.value.length === 0) data.delete(key);
      return "OK";
    },
    /** count > 0 only (from the head), which is all the relay uses. */
    LREM(key, count, value) {
      const entry = live(key);
      if (!entry) return 0;
      let left = Number(count) > 0 ? Number(count) : Number.POSITIVE_INFINITY;
      let removed = 0;
      entry.value = entry.value.filter((v) => {
        if (left > 0 && v === String(value)) {
          left--;
          removed++;
          return false;
        }
        return true;
      });
      if (entry.value.length === 0) data.delete(key);
      return removed;
    },
    INCR(key) {
      return commands.INCRBY(key, 1);
    },
    INCRBY(key, by) {
      const entry = live(key);
      const next = (entry ? Number(entry.value) : 0) + Number(by);
      if (entry) entry.value = String(next);
      else data.set(key, { value: String(next), expiresAt: null });
      return next;
    },
    GET: (key) => live(key)?.value ?? null,
    SET(key, value, ...args) {
      const upper = args.map((a) => String(a).toUpperCase());
      if (upper.includes("NX") && live(key)) return null;
      const previous = upper.includes("GET") ? (live(key)?.value ?? null) : "OK";
      let expiresAt = null;
      const ex = upper.indexOf("EX");
      if (ex >= 0) expiresAt = now() + Number(args[ex + 1]) * 1000;
      data.set(key, { value: String(value), expiresAt });
      return previous;
    },
    EXISTS: (...keys) => keys.filter((k) => live(k)).length,
    DEL(...keys) {
      let n = 0;
      for (const k of keys) if (live(k) && data.delete(k)) n++;
      return n;
    },
    RPOP(key) {
      const entry = live(key);
      if (!entry) return null;
      const value = entry.value.pop() ?? null;
      if (entry.value.length === 0) data.delete(key);
      return value;
    },
    EXPIRE(key, seconds) {
      const entry = live(key);
      if (!entry) return 0;
      entry.expiresAt = now() + Number(seconds) * 1000;
      return 1;
    },
    TTL(key) {
      const entry = live(key);
      if (!entry) return -2;
      if (entry.expiresAt === null) return -1;
      return Math.ceil((entry.expiresAt - now()) / 1000);
    },
  };

  return {
    kind: "memory",
    /** @param {Array<Array<string|number>>} cmds */
    async pipeline(cmds) {
      return cmds.map(([name, ...args]) => {
        const fn = commands[String(name).toUpperCase()];
        if (!fn) throw new Error(`memory store: unsupported command ${name}`);
        return fn(...args.map(String));
      });
    },
    /** For tests: every live key. */
    keys: () => [...data.keys()].filter((k) => live(k)),
  };
}
