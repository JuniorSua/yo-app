import { beforeAll, describe, expect, it } from "vitest";
import { generateSignKey, signOut } from "../core/sign.mjs";
import { deriveKeys, hashOf, openBlob, randomBlobId, randomSecret, seal, sealBlob } from "../lib/crypto.js";
import { acceptOut } from "../lib/inbox.js";
import {
  attachImages,
  cleanPicRefs,
  expireQueued,
  helpersLabel,
  loosePics,
  moreLabel,
  PICS_WAIT_MS,
  picForSrc,
  QUEUE_FOR_MS,
  resendable,
  waitingForPics,
} from "../lib/pics.js";

let keys;
let sign;
beforeAll(async () => {
  keys = await deriveKeys(randomSecret());
  sign = await generateSignKey();
});

const ref = (over = {}) => ({
  id: "a".repeat(22),
  hash: "h".repeat(43),
  mime: "image/jpeg",
  w: 1280,
  h: 800,
  size: 120_000,
  src: "/home/yo/shot.png",
  alt: "The cart",
  ...over,
});

describe("v2.1 items through acceptOut (cursor and counter rules unchanged)", () => {
  async function item(seq, msg) {
    const box = await seal(keys.encKey, { v: 1, ...msg }, "out");
    return { seq, box, sig: await signOut(sign.pkcs8, box) };
  }

  it("accepts an images message and unknown kinds like any other, moving cursor and counter", async () => {
    const res = await acceptOut(
      [
        await item(1, { n: 10, t: "reply", id: "r1", text: "look", pics: 1 }),
        await item(2, { n: 11, t: "images", replyId: "r1", items: [ref()], more: 0 }),
        await item(3, { n: 12, t: "from-the-future", whatever: true }),
        await item(4, { n: 13, t: "reply", id: "r2", text: "after" }),
      ],
      { cursor: 0, lastN: null, signPub: sign.signPub, encKey: keys.encKey },
    );
    expect(res.messages.map((m) => m.t)).toEqual(["reply", "images", "from-the-future", "reply"]);
    expect(res).toMatchObject({ cursor: 4, lastN: 13, dropped: [] });
  });

  it("still drops a replayed images message", async () => {
    const res = await acceptOut([await item(5, { n: 9, t: "images", replyId: "r1", items: [] })], {
      cursor: 4,
      lastN: 13,
      signPub: sign.signPub,
      encKey: keys.encKey,
    });
    expect(res.messages).toEqual([]);
    expect(res.dropped).toEqual([{ seq: 5, why: "replay" }]);
    expect(res.cursor).toBe(4);
  });
});

describe("blobs", () => {
  it("round-trip, bound to their id and direction", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250]);
    const id = randomBlobId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const box = await sealBlob(keys.encKey, bytes, "out", id);
    expect(await openBlob(keys.encKey, box, "out", id)).toEqual(bytes);
    await expect(openBlob(keys.encKey, box, "in", id)).rejects.toThrow();
    await expect(openBlob(keys.encKey, box, "out", randomBlobId())).rejects.toThrow();
    expect(await hashOf(bytes)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("pictures on replies", () => {
  it("keeps only well-formed picture references", () => {
    const bad = [
      null,
      "x",
      ref({ id: "short" }),
      ref({ hash: "nope" }),
      ref({ mime: "text/html" }),
      ref({ mime: "image/svg+xml" }),
      ref({ size: 5_000_000 }),
      ref({ size: 0 }),
    ];
    expect(cleanPicRefs([...bad, ref()])).toEqual([ref()]);
    expect(cleanPicRefs("nope")).toEqual([]);
    expect(cleanPicRefs(Array.from({ length: 20 }, () => ref()))).toHaveLength(8);
    expect(cleanPicRefs([ref({ w: 1e9, h: -4, src: undefined, alt: "" })])[0]).toEqual({
      id: "a".repeat(22),
      hash: "h".repeat(43),
      mime: "image/jpeg",
      w: 8192,
      h: 1,
      size: 120_000,
    });
  });

  it("attaches images to their reply, and waits for them meanwhile", () => {
    const now = 1_000_000;
    const reply = { k: "yo", id: "r1", text: "![The cart](/home/yo/shot.png)", at: now, pics: 1 };
    const messages = [{ k: "me", id: "m1" }, reply];
    expect(waitingForPics(reply, now + 1000)).toBe(true);
    expect(waitingForPics(reply, now + PICS_WAIT_MS + 1)).toBe(false);
    expect(attachImages(messages, { replyId: "nope", items: [ref()] })).toBe(false);
    expect(attachImages(messages, { replyId: "r1", items: [ref(), ref({ src: "/x.png" })], more: 2 })).toBe(
      true,
    );
    expect(reply).toMatchObject({ picsDone: true, more: 2 });
    expect(waitingForPics(reply, now)).toBe(false);
    expect(picForSrc(reply, "/home/yo/shot.png")?.alt).toBe("The cart");
    expect(picForSrc(reply, "/elsewhere.png")).toBeNull();
    expect(loosePics(reply, ["/home/yo/shot.png"]).map((p) => p.src)).toEqual(["/x.png"]);
    // An older core: no pics, never waits.
    expect(waitingForPics({ k: "yo", at: now }, now)).toBe(false);
  });

  it("labels", () => {
    expect(moreLabel(1)).toBe("1 more picture in Yo");
    expect(moreLabel(3)).toBe("3 more pictures in Yo");
    expect(helpersLabel(0)).toBe("");
    expect(helpersLabel(1)).toBe("1 helper working");
    expect(helpersLabel(2)).toBe("2 helpers working");
  });
});

describe("offline queue", () => {
  it("resends queued messages while the core would still run them, then gives up with Retry", () => {
    const now = 10_000_000;
    const fresh = { k: "me", id: "a", st: "queued", at: now - 1000 };
    const stale = { k: "me", id: "b", st: "queued", at: now - QUEUE_FOR_MS - 1 };
    const sent = { k: "me", id: "c", st: "sent", at: now };
    const messages = [fresh, stale, sent];
    expect(resendable(messages, now)).toEqual([fresh]);
    expect(expireQueued(messages, now)).toBe(true);
    expect(stale).toMatchObject({ st: "failed", err: "Not sent" });
    expect(fresh.st).toBe("queued");
    expect(expireQueued(messages, now)).toBe(false);
  });
});
