const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, sortable-ish random id with a prefix, e.g. `agt_m1x2k3...`. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  let rand = "";
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) rand += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${time}${rand}`;
}
