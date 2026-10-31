import { beforeAll, describe, expect, it } from "vitest";
import { generateSignKey, signOut } from "../core/sign.mjs";
import { deriveKeys, randomSecret, seal } from "../lib/crypto.js";
import { acceptOut, isTurnedOff } from "../lib/inbox.js";

let keys;
let sign;
let forger;
let state;

beforeAll(async () => {
  keys = await deriveKeys(randomSecret());
  sign = await generateSignKey();
  forger = await generateSignKey();
});

/** An out item as the relay stores it: signed by the core's key unless `by` says otherwise. */
async function item(seq, msg, { by = sign, sig } = {}) {
  const box = await seal(keys.encKey, { v: 1, ...msg }, "out");
  return { seq, box, sig: sig === undefined ? await signOut(by.pkcs8, box) : sig };
}
const accept = (items, cursor = 0, lastN = null) =>
  acceptOut(items, { cursor, lastN, signPub: sign.signPub, encKey: keys.encKey });
const texts = (res) => res.messages.map((m) => m.text);

describe("acceptOut", () => {
  it("accepts signed items in seq order with a rising counter, and moves the cursor", async () => {
    const res = await accept([
      await item(2, { n: 11, t: "reply", text: "b" }),
      await item(1, { n: 10, t: "reply", text: "a" }),
    ]);
    expect(texts(res)).toEqual(["a", "b"]);
    expect(res).toMatchObject({ cursor: 2, lastN: 11, dropped: [], maxSeq: 2 });
  });

  it("never moves the cursor past an item whose signature fails", async () => {
    const forged = await item(9, { n: 50, t: "reply", text: "forged" }, { by: forger });
    const missing = await item(8, { n: 49, t: "reply", text: "unsigned" }, { sig: null });
    state = await accept([await item(1, { n: 10, t: "reply", text: "real" }), missing, forged]);
    expect(texts(state)).toEqual(["real"]);
    expect(state.cursor).toBe(1);
    expect(state.lastN).toBe(10);
    expect(state.dropped).toEqual([
      { seq: 8, why: "signature" },
      { seq: 9, why: "signature" },
    ]);
    expect(state.maxSeq).toBe(9);
  });

  it("a forged item with a huge seq can't make the phone skip the real replies after it", async () => {
    const forged = await item(1_000_000, { n: 99, t: "reply", text: "forged" }, { by: forger });
    const first = await accept([forged], 4, 10);
    expect(first).toMatchObject({ cursor: 4, lastN: 10, messages: [] });
    // The core's next real reply (seq 5) still gets through, and the forged one is refused again.
    const next = await accept([await item(5, { n: 11, t: "reply", text: "real" }), forged], first.cursor, 10);
    expect(texts(next)).toEqual(["real"]);
    expect(next.cursor).toBe(5);
  });

  it("drops a replayed or reordered item (its counter doesn't go up) without moving the cursor", async () => {
    const old = await item(1, { n: 10, t: "reply", text: "old" });
    const seen = await accept([old]);
    // The relay hands the same signed envelope back under a new seq.
    const replay = await accept([{ ...old, seq: 7 }], seen.cursor, seen.lastN);
    expect(replay).toMatchObject({
      messages: [],
      cursor: 1,
      lastN: 10,
      dropped: [{ seq: 7, why: "replay" }],
    });
    // Two genuine items swapped: the later counter wins, the earlier is refused.
    const swapped = await accept(
      [
        await item(2, { n: 12, t: "reply", text: "second" }),
        await item(3, { n: 11, t: "reply", text: "first" }),
      ],
      1,
      10,
    );
    expect(texts(swapped)).toEqual(["second"]);
    expect(swapped).toMatchObject({ cursor: 2, lastN: 12, dropped: [{ seq: 3, why: "replay" }] });
  });

  it("accepts items without a counter from an older core, until one with a counter arrives", async () => {
    const legacy = await accept([await item(1, { t: "reply", text: "old core" })]);
    expect(legacy).toMatchObject({ cursor: 1, lastN: null });
    expect(texts(legacy)).toEqual(["old core"]);
    const upgraded = await accept(
      [await item(2, { n: 10, t: "reply", text: "new core" }), await item(3, { t: "reply", text: "no n" })],
      1,
      null,
    );
    expect(texts(upgraded)).toEqual(["new core"]);
    expect(upgraded).toMatchObject({ cursor: 2, lastN: 10, dropped: [{ seq: 3, why: "replay" }] });
    // A counter that isn't a whole number is refused too.
    const bad = await accept([await item(4, { n: "11", t: "reply", text: "x" })], 2, 10);
    expect(bad).toMatchObject({ cursor: 2, dropped: [{ seq: 4, why: "replay" }] });
  });

  it("skips items at or below the cursor and anything without a seq", async () => {
    const res = await accept(
      [await item(3, { n: 10, t: "reply", text: "seen" }), { seq: "x", box: "", sig: "" }, null],
      3,
      null,
    );
    expect(res).toMatchObject({ messages: [], cursor: 3, maxSeq: 3, dropped: [] });
  });
});

describe("isTurnedOff", () => {
  it("treats 401 and 404 link_revoked as a link that no longer works, and nothing else", () => {
    expect(isTurnedOff({ status: 401, message: "Unauthorized" })).toBe(true);
    expect(isTurnedOff({ status: 404, message: "link_revoked" })).toBe(true);
    for (const err of [
      { status: 404, message: "Not found" },
      { status: 429, message: "Too many requests" },
      { status: 503, message: "This relay isn't set up yet" },
      { status: 0, message: "No connection" },
      null,
      undefined,
    ])
      expect(isTurnedOff(err), JSON.stringify(err)).toBe(false);
  });
});
