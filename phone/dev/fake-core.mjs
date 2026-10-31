// A pretend Yo core for demos and end-to-end checks of Yo Phone. It polls the relay like the real core does
// (outbound HTTPS only) and answers every message.
//
//   node phone/dev/fake-core.mjs [secret] [--relay http://localhost:5199] [--approval] [--name Yo] [--slow ms]
//
// Without a secret (argument or YO_PHONE_SECRET) it makes one and prints the phone link.
// Text it "approval", "question" or "open yo" to get that kind of card back ("dinner" gets a sample list,
// "terminal" a command to copy, "research" a long job with helpers; the phone's Peek button gets a mock screen,
// "revoke" makes it wipe the mailbox like turning the link off does); "--approval" sends one at start.
// v2.3: it has Tasks (a seeded list like the desktop mock: Start, Hide and check off work), "brief" gets a morning
// brief back ("brief only": the brief-only kind, with its titles as text), and "choose" a question with the quick
// replies Yo picked.
//
// v2: it derives admit and coreCred from YO_PHONE_REGISTER_KEY (defaults to the dev server's key), registers its
// mailbox, makes an Ed25519 key pair for this link, signs every out item, and prints the v2 link
// (#k=<secret>&a=<admit>&p=<signPub>).

import { deflateSync } from "node:zlib";
import { createCoreClient, isRevoked, linkCreds, phoneLink } from "../core/client.mjs";
import { generateSignKey } from "../core/sign.mjs";
import { randomSecret } from "../lib/crypto.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

const relay = option("relay", process.env.YO_PHONE_RELAY_URL ?? "http://localhost:5199").replace(/\/+$/, "");
const name = option("name", "Yo");
const slow = Number(option("slow", "1600"));
const secret = positional[0] ?? process.env.YO_PHONE_SECRET ?? randomSecret();
// Same default as dev/server.mjs (not imported, because importing it would start the server).
const registerKey = process.env.YO_PHONE_REGISTER_KEY || "yo-dev-register-key";
const creds = await linkCreds(secret, registerKey);
const sign = await generateSignKey();
const client = createCoreClient({ relayUrl: relay, creds, signPkcs8: sign.pkcs8 });

console.log(`fake core: relay ${relay}`);
console.log(`phone link: ${phoneLink(relay, secret, creds.admit, sign.signPub)}`);

async function register() {
  try {
    await client.register();
  } catch (err) {
    console.error(`register failed: ${err.status ?? ""} ${err.message}`);
    process.exit(1);
  }
  console.log("mailbox registered");
}
await register();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = new Set();
const openRequests = new Map();
let lastBeat = 0;
let busy = Promise.resolve();

// v2.3: the main agent's tasks (made up), newest first within each status.
const MIN = 60_000;
const t0 = Date.now();
const tasks = [
  {
    id: "t-macbook",
    title: "Compare the M4 MacBook Air deals",
    status: "review",
    origin: "asked",
    note: "Best price is $899 at B&H, with a free case.",
    updatedAt: t0 - 20 * MIN,
  },
  {
    id: "t-landlord",
    title: "Draft a reply to the landlord about the lease",
    status: "review",
    origin: "asked",
    note: "Draft is in the chat. It asks to renew for 12 months.",
    updatedAt: t0 - 55 * MIN,
  },
  {
    id: "t-dentist",
    title: "Book the dentist for next week",
    status: "waiting",
    origin: "asked",
    note: "Tuesday 9:30 or Thursday 2:00?",
    updatedAt: t0 - 35 * MIN,
  },
  {
    id: "t-lisbon",
    title: "Plan the Lisbon weekend",
    status: "in_progress",
    origin: "asked",
    note: "Checking flights for Oct 17–20.",
    updatedAt: t0 - 4 * MIN,
  },
  {
    id: "t-car",
    title: "Renew the car registration",
    status: "open",
    origin: "asked",
    note: "Due Nov 15. I'll start once the form is out.",
    updatedAt: t0 - 3 * 60 * MIN,
  },
  {
    id: "t-filters",
    title: "Order more coffee filters",
    status: "done",
    origin: "asked",
    note: "Arrives Friday.",
    updatedAt: t0 - 26 * 60 * MIN,
  },
  {
    id: "t-sony",
    title: "Watch the price of the Sony WH-1000XM5",
    status: "suggested",
    origin: "suggestion",
    why: "They're $50 off at two stores this week, and you looked at them twice.",
    updatedAt: t0 - 10 * MIN,
  },
  {
    id: "t-notes",
    title: "Send Sam the notes from Tuesday's call",
    status: "suggested",
    origin: "suggestion",
    why: "You told Sam you'd send them by Friday.",
    updatedAt: t0 - 90 * MIN,
  },
  {
    id: "t-gift",
    title: "Find a gift for Mia's birthday",
    status: "open",
    origin: "user",
    note: "Under $40. She likes ceramics.",
    updatedAt: t0 - 2 * 24 * 60 * MIN,
  },
];

async function sendTasks() {
  await send({ t: "tasks", items: tasks.filter((t) => t.status !== "hidden"), at: Date.now() });
}

/** Start / Hide / check off, with the same rules as the core's tasks.ts (roughly). */
async function taskAction(msg) {
  const t = tasks.find((x) => x.id === msg.taskId);
  const fail = (text) => send({ t: "error", agent: name, text });
  if (!t) return fail("I couldn't find that task. It may have been removed.");
  if (msg.action === "hide") {
    if (t.status !== "suggested") return fail("Only my suggestions can be hidden.");
    t.status = "hidden";
  } else if (msg.action === "start") {
    if (!(t.status === "suggested" || (t.status === "open" && t.origin === "user")))
      return fail("That one's already under way.");
    t.status = "in_progress";
    t.note = "Just started.";
  } else if (msg.action === "done") {
    t.status = "done";
  } else return fail("I don't know how to do that to a task.");
  t.updatedAt = Date.now();
  await sendTasks();
  if (msg.action === "start") {
    await send({ t: "status", agent: name, state: "working", detail: t.title });
    await sleep(slow);
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: `On it: **${t.title}**.`,
      at: Date.now(),
    });
    await send({ t: "status", agent: name, state: "idle" });
  }
}

/** A made-up morning brief (the shape of MorningBrief in packages/contracts). */
const BRIEF = {
  needsYou: [
    {
      title: "Reply to Dana about the launch date",
      detail: "She asked twice; the team is waiting on your call before Friday.",
    },
    { title: "Decide on the Lisbon hotel hold", detail: "The hold at Casa Alfama expires at 6 PM today." },
  ],
  canWait: [
    { title: "3 newsletters", detail: "Morning Brew, The Verge, Platformer" },
    { title: "Receipt from Bluebottle", detail: "$14.50, nothing to do" },
    { title: "Package from REI", detail: "Arrives Thursday" },
    { title: "Invite: Q4 offsite", detail: "No answer needed until next week" },
    { title: "Gym renewal", detail: "Renews on the 30th at $49" },
  ],
  today: [
    { title: "Team standup", detail: "Zoom", time: "9:30 AM" },
    { title: "Lunch with Priya", detail: "Tartine", time: "12:30 PM" },
    { title: "Call with the contractor", time: "4:00 PM" },
  ],
  couldNotCheck: [{ source: "Slack", why: "it needs you to sign in again" }],
};

async function send(msg) {
  // The client gives every message a rising `n` (the phone drops replays) and signs it.
  await client.post(msg);
  console.log(`→ ${msg.t}${msg.text ? `: ${msg.text.slice(0, 60)}` : ""}`);
}

let reqCounter = 0;
async function sendRequest(kind) {
  reqCounter += 1;
  const requestId = `req-${Date.now().toString(36)}-${reqCounter}`;
  const card =
    kind === "question"
      ? {
          kind,
          title: "Which flight should I book?",
          detail: "Both land before noon on Friday.",
          options: ["United 8:05am · $214", "Delta 9:40am · $189"],
        }
      : kind === "open_yo"
        ? {
            kind,
            title: "Yo wants to use your Mac",
            detail: "To finish the expense report it needs the screen.",
          }
        : {
            kind: "approval",
            title: "Buy 2 tickets to Dune: Part Three?",
            detail: "AMC Lincoln Square · Sat 7:30pm · $38.50 total, paid with the saved Visa.",
          };
  const req = { t: "request", requestId, agent: name, ...card };
  openRequests.set(requestId, req);
  await send(req);
}

async function handle(msg) {
  if (msg.t === "hello") {
    // v2.1: pictures in replies, photos from the phone, helper counts. v2.2: peeks at the screen.
    await send({
      t: "hello",
      agent: { name },
      at: Date.now(),
      caps: ["images", "photos", "helpers", "peek", "tasks", "brief", "replies"],
    });
    if (msg.localDate) console.log(`  phone's date: ${msg.localDate}`);
    for (const req of openRequests.values()) await send(req);
    return;
  }
  if (msg.t === "respond") {
    const req = openRequests.get(msg.requestId);
    openRequests.delete(msg.requestId);
    const outcome = msg.answer
      ? `Picked “${msg.answer}”`
      : msg.decision === "approve"
        ? "Approved"
        : "Denied";
    await send({ t: "resolved", requestId: msg.requestId, outcome });
    if (req)
      await send({
        t: "reply",
        id: `r-${Date.now()}`,
        agent: name,
        text:
          msg.decision === "approve"
            ? "Done. **All set** — I'll text you the confirmation."
            : "No problem, I won't.",
        at: Date.now(),
      });
    return;
  }
  if (msg.t === "peek") {
    // v2.2: a picture of the screen right now (mock), as a reply marked `peek`. No turn, no status.
    const id = `peek-${Date.now()}`;
    await sleep(600);
    await send({
      t: "reply",
      id,
      agent: name,
      text: "Here's my screen right now.",
      at: Date.now(),
      pics: 1,
      peek: true,
    });
    const item = await client.postPicture(mockScreenshot(), {
      mime: "image/png",
      w: 960,
      h: 600,
      alt: "Yo's screen",
    });
    await send({ t: "images", replyId: id, items: [item], more: 0 });
    return;
  }
  if (msg.t === "tasks") {
    await sendTasks();
    return;
  }
  if (msg.t === "task") {
    await taskAction(msg);
    return;
  }
  if (msg.t === "stop") {
    await send({ t: "status", agent: name, state: "idle" });
    return;
  }
  if (msg.t !== "msg") return;
  const text = String(msg.text ?? "");
  const lower = text.toLowerCase();
  if (Array.isArray(msg.pics) && msg.pics.length) {
    const sizes = [];
    for (const p of msg.pics) {
      const bytes = await client.getPhoto(p.id).catch(() => null);
      sizes.push(bytes ? `${p.w}×${p.h}, ${Math.round(bytes.length / 1024)} KB` : "couldn't open it");
    }
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: `Got your photo${sizes.length > 1 ? "s" : ""} (${sizes.join("; ")}).${text ? ` You said: ${text}` : ""}`,
      at: Date.now(),
    });
    await send({ t: "status", agent: name, state: "idle" });
    return;
  }
  if (lower.includes("research")) {
    // A longer job: what it's doing, and helpers working on parts of it.
    await send({ t: "status", agent: name, state: "working", detail: "Checking Roadster…", helpers: 2 });
    await sleep(slow * 2);
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: "### Best e-bikes under $2k\n\n> Short version: the **Aventon Level.2** is the best all-rounder.\n\n- [x] Compared 9 models\n- [x] Checked owner reviews\n- [ ] Test ride (your call)",
      at: Date.now(),
    });
    await send({ t: "status", agent: name, state: "idle" });
    return;
  }
  await send({ t: "status", agent: name, state: "working", detail: "Thinking" });
  await sleep(slow);
  if (lower.includes("screenshot") || lower.includes("picture")) {
    const id = `r-${Date.now()}`;
    const src = "/home/yo/screens/cart.png";
    await send({
      t: "reply",
      id,
      agent: name,
      text: `Here's the cart right now:\n\n![The cart on the store's site](${src})\n\nTwo items, **$84.20** with shipping.`,
      at: Date.now(),
      pics: 1,
    });
    const shot = mockScreenshot();
    const item = await client.postPicture(shot, {
      mime: "image/png",
      w: 960,
      h: 600,
      src,
      alt: "The cart on the store's site",
    });
    await send({ t: "images", replyId: id, items: [item], more: 0 });
  } else if (lower.includes("brief only")) {
    // A brief-only turn: the core puts the "Needs you" titles in the text for phones without the card.
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: `Your brief: ${BRIEF.needsYou.map((r) => `• ${r.title}`).join(" ")}`,
      briefText: true,
      at: Date.now(),
      brief: BRIEF,
    });
  } else if (lower.includes("brief")) {
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: "That's your day. The hotel hold is the one with a clock on it.",
      at: Date.now(),
      brief: BRIEF,
    });
  } else if (lower.includes("choose")) {
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: "Dr. Patel has two openings next week. Which one works for you?",
      at: Date.now(),
      replies: ["Tuesday 9:30", "Thursday 2:00", "Neither works"],
    });
  } else if (lower.includes("table")) {
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: "Both land before noon:\n\n| Flight | Leaves | Lands | Price |\n|---|---|---|--:|\n| United 512 | 8:05am | 11:20am | $214 |\n| Delta 1180 | 9:40am | 11:55am | $189 |\n\nDelta is **$25 cheaper**; United gets you in earlier.",
      at: Date.now(),
    });
  } else if (lower.includes("approv")) {
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: "Found them. I need your OK first:",
      at: Date.now(),
    });
    await sendRequest("approval");
  } else if (lower.includes("question")) {
    await sendRequest("question");
  } else if (lower.includes("revoke")) {
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: "Turning this link off now.",
      at: Date.now(),
    });
    await sleep(4000); // give the phone a poll to show the reply
    await client.wipe().catch((err) => console.error(`wipe failed: ${err.message}`));
    console.log("mailbox wiped; exiting");
    process.exit(0);
  } else if (lower.includes("open yo")) {
    await sendRequest("open_yo");
  } else if (lower.includes("terminal")) {
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: "Open **Terminal** on your Mac and paste this:\n\n```sh\nbrew install --cask yo && open -a Yo\n```\n\nTell me if you see an error.",
      at: Date.now(),
    });
  } else if (lower.includes("dinner")) {
    await send({
      t: "reply",
      id: `r-${Date.now()}`,
      agent: name,
      text: "Three quiet spots near you with tables Friday at 7:30:\n\n1. **Via Carota** · Italian, cozy, $$\n2. **Cervo's** · seafood, small plates\n3. **Hart's** · natural wine, *very* chill\n\nWant me to book one?",
      at: Date.now(),
    });
  } else {
    await send({ t: "reply", id: `r-${Date.now()}`, agent: name, text: `Got it — ${text}`, at: Date.now() });
  }
  await send({ t: "status", agent: name, state: "idle" });
}

async function poll() {
  const beat = Date.now() - lastBeat > 60_000;
  let items;
  try {
    items = await client.pollIn({ beat });
  } catch (err) {
    if (!isRevoked(err)) throw err;
    // link_revoked: the registration lapsed (e.g. the dev server restarted). The real core re-registers too.
    await register();
    return;
  }
  if (beat) lastBeat = Date.now();
  if (!items.length) return;
  const msgs = [];
  for (const box of items) {
    const m = await client.openIn(box);
    if (m) msgs.push(m);
    else console.warn("skipped an envelope that didn't decrypt");
  }
  const fresh = msgs.filter((m) => m.t !== "msg" || !seen.has(m.id));
  for (const m of fresh) if (m.t === "msg") seen.add(m.id);
  const ackIds = fresh.filter((m) => m.t === "msg").map((m) => m.id);
  await client.ack(items.length);
  if (ackIds.length) await send({ t: "ack", ids: ackIds });
  for (const m of fresh) {
    console.log(`← ${m.t}${m.text ? `: ${m.text}` : ""}`);
    busy = busy.then(() => handle(m)).catch((e) => console.error("handle failed:", e.message));
  }
}

if (flag("approval")) await sendRequest("approval");
for (;;) {
  try {
    await poll();
  } catch (err) {
    console.error("poll failed:", err.message);
  }
  await sleep(1000);
}

/** A made-up "screenshot" (a browser window with a cart), as a PNG. Mock data only. */
function mockScreenshot(w = 960, h = 600) {
  const px = Buffer.alloc((w * 3 + 1) * h);
  const fill = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
        const i = y * (w * 3 + 1) + 1 + x * 3;
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
      }
  };
  fill(0, 0, w, h, [246, 245, 241]);
  fill(0, 0, w, 44, [229, 228, 222]);
  for (const [i, c] of [
    [0, [255, 95, 87]],
    [1, [254, 188, 46]],
    [2, [40, 200, 64]],
  ])
    fill(16 + i * 22, 16, 28 + i * 22, 28, c);
  fill(110, 12, 720, 32, [255, 255, 255]);
  fill(40, 76, 600, 104, [40, 42, 38]);
  for (let r = 0; r < 2; r++) {
    const y = 140 + r * 150;
    fill(40, y, 620, y + 128, [255, 255, 255]);
    fill(56, y + 16, 152, y + 112, r ? [143, 178, 255] : [255, 212, 59]);
    fill(176, y + 24, 520, y + 40, [60, 62, 58]);
    fill(176, y + 56, 400, y + 68, [160, 160, 152]);
    fill(176, y + 84, 260, y + 100, [47, 158, 95]);
  }
  fill(660, 140, 920, 420, [255, 255, 255]);
  fill(680, 164, 860, 180, [60, 62, 58]);
  for (let i = 0; i < 4; i++) fill(680, 210 + i * 34, 900, 222 + i * 34, [214, 213, 206]);
  fill(680, 360, 900, 400, [255, 212, 59]);
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(px)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}
