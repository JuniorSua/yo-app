// What the phone does with the relay's answers: which `out` items it accepts (docs/phone/PROTOCOL.md, "Signed
// replies" and "Counter"), and which errors mean the link is turned off. Plain ESM, no DOM, so it's unit tested in
// phone/test/inbox.test.js.
//
// Two rules keep a relay (or anyone who can write to its database) from steering the phone:
// - The read cursor only moves past items that verified and were accepted. A forged item with a huge `seq` can't
//   make the phone skip the real replies after it.
// - Each message carries `n`, the core's counter for the link, inside the signed and encrypted envelope. It must go
//   up. An old genuine item replayed (or items reordered) fails that check and is dropped. A core from before the
//   counter sends no `n`; those items are accepted until the phone has seen one with `n`.

import { open, verifyOut } from "./crypto.js";

/**
 * @param {Array<{ seq: number, box: string, sig: string | null }>} items one page from `GET out`
 * @param {{ cursor: number, lastN: number | null, signPub: string, encKey: CryptoKey }} state
 * @returns {Promise<{ messages: any[], cursor: number, lastN: number | null,
 *   dropped: Array<{ seq: number, why: "signature" | "replay" }>, maxSeq: number }>}
 *   messages: decrypted messages to handle, in order; cursor and lastN: the new values to save;
 *   dropped: items refused (the cursor didn't move for them); maxSeq: the highest seq on the page (for paging)
 */
export async function acceptOut(items, { cursor, lastN, signPub, encKey }) {
  const sorted = (Array.isArray(items) ? items : [])
    .filter((i) => i && Number.isSafeInteger(i.seq))
    .sort((a, b) => a.seq - b.seq);
  const messages = [];
  const dropped = [];
  let maxSeq = cursor;
  for (const item of sorted) {
    maxSeq = Math.max(maxSeq, item.seq);
    if (item.seq <= cursor) continue;
    // Only the core holds the signing key, so a bad signature means the item didn't come from your Yo.
    if (!(await verifyOut(signPub, item.box, item.sig))) {
      dropped.push({ seq: item.seq, why: "signature" });
      continue;
    }
    let msg;
    try {
      msg = await open(encKey, item.box, "out");
    } catch {
      // Signed by the core but unreadable (shouldn't happen): skip it, but it was the core's, so move on.
      cursor = item.seq;
      continue;
    }
    const n = msg?.n;
    if (n !== undefined || lastN !== null) {
      if (!Number.isSafeInteger(n) || (lastN !== null && n <= lastN)) {
        dropped.push({ seq: item.seq, why: "replay" });
        continue;
      }
      lastN = n;
    }
    messages.push(msg);
    cursor = item.seq;
  }
  return { messages, cursor, lastN, dropped, maxSeq };
}

/**
 * Whether a relay error means this link no longer works, so the phone shows "This link was turned off" instead of
 * retrying: the owner turned it off or made a new one (404 `link_revoked`), or the relay no longer admits it (401,
 * e.g. its register key changed, which voids every link's `a`). The phone only calls phone routes and sends what the
 * link gave it, so a 401 never fixes itself.
 * @param {{ status?: number, message?: string } | null | undefined} err
 */
export function isTurnedOff(err) {
  return err?.status === 401 || (err?.status === 404 && err?.message === "link_revoked");
}
