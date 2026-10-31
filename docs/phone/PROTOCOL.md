# Yo Phone: text Yo from any phone

A web app on Vercel (`phone/`) that a Yo's **owner** opens on their own phone, adds to the Home Screen and uses to
text their Yo. It works on iPhone with no App Store and no Apple developer account.

**A phone link is personal: it's your Yo in your pocket.** Whoever holds it talks to Yo *as the owner*, with the
owner's chats, files and approvals. It is not meant for guests; a guest mode with its own limits is future work.

> **v2 (security round 2) overrides anything below that disagrees with it.** See "v2: admission, roles and
> signatures" at the end.

## Why a relay, and why the home PC stays closed

Yo's core runs on a home PC behind Tailscale. Nothing on it is reachable from the internet, and that doesn't change.
Yo Phone works like the Telegram channel: **the core only makes outbound HTTPS calls.**

```
phone (browser) ──HTTPS──▶  Vercel relay (phone/api)  ◀──HTTPS poll── Yo core (home PC)
                             Upstash Redis mailbox
```

- The relay is a dumb mailbox. It stores **encrypted** envelopes for a short time and can't read them.
- The phone link carries the key in the URL **fragment** (`#k=…`). Browsers never send the fragment to a server, so
  Vercel never sees it.
- Anyone holding the link can talk to Yo as the owner, the same as a paired Telegram chat. Turning Yo Phone off or
  creating a new link revokes the old one.

## Pairing link

```
https://<relay-host>/#k=<secret>
```

`secret` is 32 random bytes, base64url without padding (43 characters). The core creates it with
`channels.phone.pair` and keeps it in its SecretStore (`phone-link-secret`). The phone stores it in `localStorage`
and then strips the fragment from the address bar (`history.replaceState`).

The core registers the new mailbox with the relay (`POST /api/relay/register`, below) **before** it shows the link.
A phone that opens a link for an unregistered mailbox gets `link_revoked` on its first `hello`.

**iPhone Home Screen and pasting.** On iOS, a web app added to the Home Screen may not share `localStorage` with
Safari. By then the fragment is gone from the address bar, so the Home Screen copy can open with no key. The phone
handles this in two ways. The welcome screen has a **Paste your phone link** box that accepts the full link or just the
43-character key. After pairing in Safari, a dismissible tip says "Add Yo to your Home Screen… If it asks for your
link, paste it again." The note or message the owner sent themselves still holds the link, so they can copy it
from there.

## Keys (both sides use WebCrypto; Node's `globalThis.crypto.subtle` on the core)

From `secret` (raw 32 bytes) as the HKDF-SHA256 input key, with an **empty salt**:

| Name | HKDF `info` (UTF-8) | Output |
|---|---|---|
| `authToken` | `yo-phone/v1/auth` | 32 bytes → base64url, sent as `Authorization: Bearer <authToken>` |
| `encKey` | `yo-phone/v1/enc` | AES-GCM 256-bit key |

The relay derives the mailbox id itself: `box = hex(sha256(utf8(authToken)))`. There's no registration step:
knowing the token is the only way to reach the mailbox.

## Envelopes

`envelope = base64url( iv[12] || AES-GCM(encKey, iv, plaintext, aad) )`, where the plaintext is UTF-8 JSON and the
`aad` is UTF-8 `yo-phone/v1/in` (phone → core) or `yo-phone/v1/out` (core → phone). The AAD stops the relay from
reflecting a message back the other way.

Test vector (both implementations must have a unit test for it):
- secret = base64url of bytes `0x00..0x1f` (`AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8`)
- `authToken` and the decryption of a fixed envelope must match between `phone/lib/crypto.js` and
  `apps/core/src/channels/phoneCrypto.ts`. The phone side owns the canonical values in
  `phone/test/vector.json`; the core test reads that file.

## Relay HTTP API (`phone/api/relay.js`, mounted at `/api/relay/*` via `vercel.json` rewrites)

Every call except `health` needs `Authorization: Bearer <authToken>` (43-char base64url, otherwise 401). All
responses are JSON with `Cache-Control: no-store`. Envelopes over 64 KB get 413. Errors look like `{ error }`.

**Mailbox allowlist.** Any token names a mailbox, but only **registered** mailboxes accept writes, so a random token
can't fill the shared database. Registering takes the operator's register key (Vercel env `YO_PHONE_REGISTER_KEY`,
which the core also has), sent as `X-Yo-Register-Key` and compared in constant time. Registration sets
`box:ok` for 30 days. `POST in` and `POST out` check it in the same pipeline as the write; if it's missing, they undo
the write and answer **404 `{ "error": "link_revoked" }`**. Reads (`GET in`, `GET out`) and `ack` skip the check: on
a box nobody can write to, they only ever see an empty mailbox.

| Method + path | Caller | Body / query | Does | Response |
|---|---|---|---|---|
| `GET /api/relay/health` | anyone | — | No auth, no storage call | `{ ok: true, store: "upstash" \| "memory" \| "missing" }` |
| `POST /api/relay/register` | core | header `X-Yo-Register-Key` | `SET box:ok 1 EX 30d`. Env key unset → 503; wrong or missing key → 403. Safe to repeat. | `{ ok: true }` |
| `DELETE /api/relay/box` | core | — | `DEL box:ok box:in box:out box:outseq box:seen` (the whole mailbox) | `{ ok: true }` |
| `POST /api/relay/in` | phone | `{ "box": envelope }` | One pipeline: `EXISTS box:ok`, `RPUSH box:in`, `EXPIRE box:in 30d`. Not registered → `DEL box:in`, 404 `link_revoked`. `RPUSH` returned more than 100 → `RPOP box:in`, 429 (atomic cap: concurrent over-cap sends each pop their own). | `{ ok: true }` |
| `GET /api/relay/in?beat=1` | core | — | `LRANGE box:in 0 49`. With `beat=1`, also `SET box:seen <ms> EX 600 GET`. If the previous `seen` was empty (core was offline 10+ min) or from an earlier UTC day, it also refreshes the 30-day TTL on `ok`, `in`, `out` and `outseq` (at most about once a day). | `{ items: [envelope] }` |
| `POST /api/relay/in/ack` | core | `{ "count": n }` (0–100) | `LTRIM box:in n -1` (drops the first n it read) | `{ ok: true }` |
| `POST /api/relay/out` | core | `{ "box": envelope }` | Pipeline `EXISTS box:ok`, `INCR box:outseq`, `EXPIRE box:outseq 30d`. Not registered → `DEL box:outseq`, 404 `link_revoked`. Then `RPUSH box:out {seq, box}`, `LTRIM` to the last 300, `EXPIRE 30d`. | `{ seq }` |
| `GET /api/relay/out?after=<seq>` | phone | — | `LRANGE box:out -300 -1` filtered to `seq > after`, plus `GET box:seen`. At most about 1 MB of envelopes per response, oldest first. | `{ items: [{seq, box}], seen: ms or null, more?: true, reset?: true }` |

- `more: true` means more items are waiting. The phone fetches again right away with `after` set to the last
  `seq` it got.
- `reset: true` means the mailbox expired and its counter restarted (every stored seq is below `after`). The relay
  then returns everything it has, and the phone resets its cursor.
- **Revoking:** `channels.phone.off` and **New link** call `DELETE /api/relay/box` for the old mailbox. The next
  time the old phone sends anything, it gets `link_revoked` and shows "This link was turned off. Ask for a new
  one." with the paste box.
- **Staying registered:** the core calls `register` when it pairs and again on every start. While it's running,
  beats keep `ok` alive. A mailbox whose core hasn't beaten for 30 days drops off the allowlist until the core
  starts and registers again.

Redis keys: `yo:phone:<box>:{ok,in,out,outseq,seen}`. Storage is Upstash Redis over its REST API (`KV_REST_API_URL` /
`KV_REST_API_TOKEN`, falling back to `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`). There are no
dependencies, only `fetch` to the `/pipeline` endpoint. The handler takes an injectable store, so the tests and the
local dev server use an in-memory one. The dev server (`phone/dev/server.mjs`) sets the register key to
`yo-dev-register-key` unless `YO_PHONE_REGISTER_KEY` is set, and `phone/dev/fake-core.mjs` uses the same default.

Free-tier budget: the Upstash free database (500k commands/month) is shared with another project, so the keys never
leave the `yo:phone:` prefix, every key has a TTL, and the relay never runs KEYS, SCAN or FLUSH. The core polls every
15 s when idle (1 command, or 2 with a beat at most every 2 minutes, plus 4 once a day) and every 1.5 s for 5 minutes
after any phone message. That works out to about 200k commands a month. The phone polls `out` every 3 s, only while
it's visible (2 commands), and shows Yo as online if `seen` is less than 5 minutes old. A phone message costs 3
commands, a core message 6, a registration 1.

Rough monthly total: core idle polling about 200k, the phone's own polling about 2.4k for each hour it's open,
and each conversation about 200 fast polls plus its messages. An hour of phone use a day plus a few conversations
comes to about 300–400k of the shared 500k. If the other project grows, give Yo Phone its own database
(Upstash pay-as-you-go is about $0.20 per 100k commands), or raise `idlePollMs` in `phone.ts`.

## Messages (plaintext JSON inside envelopes; every message has `v: 1`)

Phone → core (`in`):

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `id`, `device` (short user-agent label) | First open or reconnect. The core answers with `hello` and resends open requests. |
| `msg` | `id` (random, used to dedupe), `text` (≤ 8000 chars), `at` (ms) | A text for Yo |
| `respond` | `id`, `requestId`, `decision`: `approve` or `deny`, optional `answer` (option label) | Answers an approval or question card |
| `stop` | `id` | Stop the current turn (`orchestrator.interrupt`) |

Core → phone (`out`):

| `t` | Fields | Meaning |
|---|---|---|
| `hello` | `agent: {name}`, `at` | Who is answering |
| `ack` | `ids: string[]` | These messages reached Yo (shows "Delivered") |
| `status` | `agent`, `state`: `working`, `queued` or `idle`, optional `detail` (short activity label) | Typing indicator. At most one every 15 s while working. |
| `reply` | `id`, `agent`, `text` (≤ 16000 chars, cut with "… the rest is in Yo."), `at` | Yo's answer |
| `request` | `requestId`, `agent`, `kind`: `approval`, `question` or `open_yo`, `title`, `detail`, `options?: string[]` | A card. `open_yo` (Mac changes, screen takeovers, secure forms) has no buttons, only "Open Yo on your computer". |
| `resolved` | `requestId`, `outcome` (short text) | The card was answered, here or elsewhere |
| `error` | `agent`, `text` | The turn failed |

The core dedupes `msg` ids (it remembers the last 500) because the relay delivers at least once: the core acks only
after it has handled the batch.

## Core side (`apps/core/src/channels/phone.ts`)

Built like `TelegramChannel`: hub subscription, `orchestrator.send/respond/interrupt`, and an `api` object spread
into `createApi`.

- KV state `_phone`: `{ enabled, relayUrl, pairedAt, lastSeenAt, device }`. The secret lives in the SecretStore.
- API (`ChannelApiMethods` in contracts):
  - `channels.phone.status` → `{ enabled, relayUrl, link: string|null, pairedAt, lastPhoneAt, device, polling,
    lastError }`. `link` is returned only to signed-in controllers, which can already do anything.
  - `channels.phone.pair` → `{ link }`. Makes a new secret (revoking the old link) and turns polling on.
  - `channels.phone.configure` `{ relayUrl? }`
  - `channels.phone.off` deletes the secret and stops polling.
- The relay URL defaults to `YO_PHONE_RELAY_URL`, or else `https://yo-phone.vercel.app`.
- Replies: like Telegram, it waits for `notify` `done` on a turn the phone started, then sends the last
  `assistant_message` after the turn's starting seq. It forwards `error`, every `timeline.upsert` request card while
  paired, and `resolved` when a card closes.
- The maintainer's ops script: `yo-ops phone status | pair | off | relay <url>`.

## Web settings (`apps/web`)

Settings has a **Phone** section. It shows the status (Off, Link ready — waiting for the phone, or Connected, last
seen …), with **Create phone link** (or **New link** to revoke the old one), **Copy link**, **Show QR code** (see the
last section), and **Turn off**. It says the link is personal: "This link is your Yo in your pocket. Keep it to
yourself: anyone with it can talk to Yo as you, including your chats, files and approvals. Turn it off anytime."

## v2: admission, roles and signatures

This section supersedes the link format, relay auth and `out` item format above.

### Link

```
https://<relay-host>/#k=<secret>&a=<admit>&p=<signPub>
```

| Value | How it's made | Who knows it |
|---|---|---|
| `secret` | 32 random bytes, base64url (unchanged). Gives `authToken` and `encKey` by HKDF. | phone + core |
| `box` | `hex(sha256(utf8(authToken)))` (unchanged) | anyone holding the token |
| `admit` | `base64url(HMAC-SHA256(key = utf8(registerKey), msg = utf8("yo-phone/v1/admit\n" + box)))` | phone + core + relay |
| `coreCred` | `base64url(HMAC-SHA256(key = utf8(registerKey), msg = utf8("yo-phone/v1/core\n" + box)))` | **core + relay only** (never in the link) |
| `signPub` | the raw 32-byte Ed25519 public key, base64url. Core makes a new key pair per link and keeps the private key (PKCS8) in its SecretStore as `phone-sign-key`. | phone + core |

`registerKey` is `YO_PHONE_REGISTER_KEY` on Vercel and `phone-register-key` in the core's SecretStore. A link
without `a` and `p` (v1) is rejected by the phone with "This link is from an older version. Ask Yo for a new one."

### Headers and admission (stateless, before any Redis call)

Every call sends `Authorization: Bearer <authToken>` and `X-Yo-Admit: <admit>`. Core calls also send
`X-Yo-Core: <coreCred>`. The relay recomputes `box`, `admit` and (when needed) `coreCred` from the token and its env
key and compares them in constant time. **Anything that fails is rejected before it touches Redis** (401). If the env
key is missing, the relay returns 503.

Rate limits are in memory per instance, also checked before Redis: **120 requests a minute per IP**, and per box
a separate budget for each role: **60 a minute for the phone's routes** and **90 a minute for the core's**. Past a
limit the relay answers 429 with `Retry-After`. Because the budgets are separate, someone flooding with a stolen link
only uses up the phone's budget; the core keeps polling, so the owner can still turn the link off. (Vercel WAF rate
limiting can be added in the dashboard as a second layer.)

### Roles

| Route | Who | Needs | Notes |
|---|---|---|---|
| `POST /register` | core | admit + core | SETs `ok`. Replaces `X-Yo-Register-Key`. |
| `POST /in` | phone | admit | Needs `ok` (else 404 `link_revoked`, nothing written) |
| `GET /out?after=` | phone | admit | Checks `ok` in the same pipeline. Not registered → 404 `link_revoked`. |
| `GET /in?beat=1` | core | admit + core | Plain poll (no `beat`): `LRANGE` only, 1 command, never writes; an unregistered box just reads as empty, because `POST in` needs `ok`. With `beat=1`: `EXISTS ok` + `LRANGE` in one pipeline, then writes `seen` **only if `ok`**. Not registered → 404 `link_revoked` (core re-registers). |
| `POST /in/ack` | core | admit + core | |
| `POST /out` | core | admit + core | Body `{ box, sig }` |
| `DELETE /box` | core | admit + core | Wipes every key of the box |

Budget: the core's idle poll is back to 1 command; only a beat (at most every 2 minutes) adds `EXISTS ok` and the `seen` write, so the core notices a lost registration within one beat.

The phone can no longer read `in`, drop messages, post to `out` or wipe the box. The core can't be impersonated by
the link holder.

### Signed replies

`sig = base64url(Ed25519-sign(phone-sign-key, utf8("yo-phone/v1/out\n" + envelope)))`. The relay stores `out` items as
`{ seq, box, sig }`. The phone verifies every item against `signPub` (WebCrypto Ed25519) **before** decrypting, and
drops items with a missing or bad signature. **A dropped item never moves the phone's read cursor**: the cursor only
moves past items it accepted, so a forged item with a huge `seq` can't make the phone skip the real replies after it.
(It still fetches the next page after the highest `seq` it saw, so paging works.)

### Counter (`n`)

Every core → phone message carries `n`, a counter for the link, next to `v` inside the encrypted envelope. The
envelope is what's signed, so `n` is covered by the signature (and by AES-GCM). The core makes it
`max(last n + 1, now in ms)` and saves the last value, so it keeps going up across restarts, and a retried post
reuses the same `n`. The phone saves the last `n` it accepted (`yo-phone:outN`) and drops any item whose `n` isn't
higher: a genuine item replayed by the relay, or items put out of order, are refused (and don't move the cursor).
Paging and the cursor are in `phone/lib/inbox.js`.

Compatibility: the signature format is unchanged, so `vector.json` still holds. A phone accepts items without `n`
(from a core that predates the counter) until it has seen one with `n`; after that, it requires it. An older phone
app ignores `n`. Both sides ship together anyway: the phone app is served by the relay, so a phone gets the new app
on its next reload.

`phone/test/vector.json` adds a fixed `registerKey`, the expected `admit` and `coreCred`, a fixed Ed25519 PKCS8
private key with its `signPub`, and the (deterministic) signature over the vector's envelope. Both implementations
test against it.

### Core-side limits

- **Flood cap:** at most 3 phone messages in flight (queued or running) and 10 a minute. Beyond that, the core
  doesn't call `orchestrator.send`. It replies `error`: "Yo is busy. Send it again in a minute.", at most once a
  minute per mailbox (every reply is a relay post, so a flood mustn't turn into a flood of replies).
- **No steering across senders:** phone text is always queued, never steered into a turn the owner started. If the
  owner steers into a phone turn, that turn stops being the phone's: no more replies or cards from it go to the phone.
- **Revoke retries:** a failed wipe (Turn off, New link, or a relay change) is saved and retried with backoff.
  Status shows `revokePending`, and Settings says "Couldn't turn off the old link yet. Retrying." If the relay answers
  **401** (its register key changed, so the old credentials are void there), the core drops that wipe instead of
  retrying forever: the old link can't get in either, and the relay's 30-day TTL clears the mailbox.
- **Turned off on the phone:** the phone treats **401** from the relay like `link_revoked`. A register-key change
  voids every link's `a`, and retrying can't fix that, so it stops polling and shows "This link was turned off" with
  the paste box.
- **The link never reaches the model:** `create_phone_link` returns "Link created. It's in Settings → Phone." The
  link itself is shown only in the owner's UI.

## v2.1: pictures, photos and helpers (minor, backward compatible)

Everything above still holds: the link format, admission, signatures and the counter `n` are unchanged, and nobody
pairs again. v2.1 only adds optional fields, one message kind and four relay routes. Each side ignores what it doesn't
know: an older phone app skips an unknown `t` (its cursor and `n` still move past it, see `acceptOut` and the iOS
`Inbox`), and an older core ignores `pics` on a message and `caps` never reaches it.

### New fields and messages

| Direction | Message | Addition |
|---|---|---|
| core → phone | `hello` | `caps: ["images", "photos", "helpers"]`: what this core understands. The phone shows the photo button only when `photos` is there. |
| core → phone | `reply` | `pics: n` (1–4): how many pictures follow in an `images` message. Without it the reply has none, as before. |
| core → phone | `images` (new) | `{ replyId, items: [PicRef], more }`. `more` counts the reply's pictures that didn't come (over the caps, unreadable, or the relay refused): the phone says "N more pictures in Yo". |
| core → phone | `status` | `helpers: n`: helpers this agent started that are still working. Sent with `working`, and with `idle` when only helpers are left ("2 helpers working"). Only on a change. |
| phone → core | `msg` | `pics: [PicRef]` (at most 3): photos from the phone. `text` may be empty when there are photos. |

`PicRef = { id, mime, w, h, size, hash, src?, alt? }`. `id` is 16 random bytes in base64url (22 characters).
`hash` is `base64url(sha256(bytes))` of the picture. `src` and `alt` come from the reply's markdown
(`![alt](src)`), so the phone can show the picture in its place; pictures without a matching `src` go under the reply.
The `images` message is signed and counted like every other `out` item, so `hash` ties each blob to the core.

### Blobs (relay routes)

A picture travels beside the mailbox, never in the `out` list (the phone reads that list every 3 seconds, so pictures
in it would be downloaded again and again):

`blob = base64url( iv[12] || AES-GCM(encKey, iv, bytes, aad = "yo-phone/v1/blob-<dir>\n<id>") )`

The AAD binds a blob to its id and direction. The reader checks `hash` after decrypting and drops a mismatch.

| Method + path | Who | Body / query | Does | Commands |
|---|---|---|---|---|
| `POST /api/relay/blob/out` | core | `{ id, box }` | Picture for the phone. `EXISTS ok`, `INCRBY` the relay's daily byte counter (+`EXPIRE`), then `SET yo:phone:<box>:blob:out:<id> box EX 2d NX`. | 4 |
| `GET /api/relay/blob/out?id=` | phone | | `EXISTS ok` + `GET`. Not registered → 404 `link_revoked`; expired → 404 `gone`. | 2 |
| `POST /api/relay/blob/in` | phone | `{ id, box }` | Photo for the core, same as above with a 6-hour TTL (the core runs a message within 10 minutes). | 4 |
| `GET /api/relay/blob/in?id=` | core | | Same as `GET blob/out`. | 2 |

- **Limits:** a blob is at most 720,000 characters (about 540 KB of picture). Everyone together may store 25 MB of
  pictures a UTC day (`yo:phone:blobday:<day>`, one counter); past it, 429 until midnight. Each box may post 60 a day
  per direction (in memory, per function instance). `NX` means a retried post never overwrites.
- **Revoking:** `DELETE /box` can't list blob keys (the relay never scans), but every read checks `ok`, so an old
  link stops seeing pictures at once, and the TTL clears them.
- **Storage:** with these caps the shared free database holds at most about 50 MB of pictures (2 days × 25 MB).

### Core side

- Pictures come from the reply's markdown images that point at the agent's computer (the same rule as the desktop
  chat's snapshots): the chat-images snapshot when there is one, else the file itself. Web (`https://`) images aren't
  fetched; the phone shows them as links.
- `apps/core/src/imageShrink.ts` makes each one phone-sized with no image library: PNGs (screenshots) are decoded,
  box-filtered to at most 1280 px on the longest side and encoded as JPEG (quality 80, then lower) to fit 300 KB.
  JPEG, GIF and WebP pass through only if they already fit (no decoder).
- **Caps:** 4 pictures a reply; per link, 40 pictures and 8 MB a day (KV `_phone.pics`). An older relay (no blob
  routes) or one over its budget stops the rest of that reply's pictures, which become `more`.
- Photos from the phone: fetched with `GET blob/in`, decrypted, hash-checked, sniffed (JPEG, PNG or WebP, at most
  1.5 MB) and passed to the agent as picture attachments, like pictures attached in Yo. One that fails gets an
  `error` ("Yo couldn't get one of your photos. Send it again.").

### Phone side

- Pictures are fetched once, decrypted, checked, and kept in Cache Storage (`yo-phone-pics`, the newest 80) so they
  show offline and don't cost the relay twice. A new link or Forget clears them. Tap opens them full screen (pinch or
  double-tap to zoom, swipe down to close); a copy button copies the picture itself (PNG, as Safari needs), or opens
  the share sheet where the clipboard can't take pictures. The CSP allows `img-src blob:` for this.
- Photos are shrunk on the phone (canvas, JPEG, longest side 1600 px, about 1.2 MB at most) before they're
  encrypted.
- A message sent without a connection waits ("Waiting for a connection") and goes by itself when the phone is back
  online, for up to 9 minutes (the core refuses messages older than 10). Its envelope's `at` is the time it was sent,
  not the time it was typed. After that it shows Retry.
- **Updates:** the service worker cache is versioned; a new version takes over by itself, and the app reloads at a
  calm moment (nothing typed, no photo picked, not in Drive mode) and says "Updated". The link and history live in
  `localStorage`, so an update never needs a new link.

## Bug mailbox

The relay also carries Yo's one-click bug reports. Any Yo can drop a report in; only the owner's core can take them
out, and only the owner's core can read them (they're encrypted to its bug inbox key).

| Route | Who | What |
|---|---|---|
| `POST /api/relay/bugs` | any Yo, no credential | body `{ v: 1, install, epk, iv, ct }`, exactly those fields, at most 600 KB → `{ ok: true, reportId: "YO-XXXXXX" }` |
| `GET /api/relay/bugs` | owner's core | `{ items: [{ id, at, v, install, epk, iv, ct }], more? }`, the oldest 5 |
| `POST /api/relay/bugs/ack` | owner's core | `{ ids: ["YO-…"] }` removes those reports → `{ ok, removed }` |

- **Envelope.** `install` is 32 hex characters of `sha256("yo-bug-install\n" + installId)`. `epk` is a one-time
  X25519 public key (32 bytes, base64url), `iv` 12 bytes, `ct` the AES-256-GCM ciphertext with its 16-byte tag.
  Key: `HKDF-SHA256(ikm = X25519(epk, inboxKey), salt = epk ‖ inboxPublicKey, info = "yo-bugs/v1/aes-256-gcm")`.
  AAD: `"yo-bugs/v1\n" + install + "\n" + epk`. Plaintext: one line of JSON (the report's text fields), `\n`, then
  the diagnostics zip. The inbox public key ships in every Yo (`BUG_INBOX_PUBLIC_KEY`, packages/contracts).
- **Core credential.** `X-Yo-Core: coreCredFor(registerKey, "bugs")`, the same HMAC as a phone mailbox's core
  credential with the reserved box name `bugs` (real box ids are 64 hex characters, so they never collide). No
  bearer token or admit. Core routes share the core's per-minute budget.
- **Limits, before Redis** (in memory, per function instance): 10 posts an hour per IP, 20 a day per `install`.
  **Global:** 300 a day, one `INCR yo:bugs:day:<n>`; over it, 429 with `Retry-After` until midnight UTC.
- **Storage.** One list, `yo:bugs:inbox`: `RPUSH` the item, `LTRIM` to the newest 200, 14-day TTL (set on the day's
  first report and whenever the list is created). A report costs 3 commands, an idle poll 1 (`LRANGE`), an ack one
  `LRANGE` plus one `LREM` per report. Nothing from a report is ever logged.
- **Owner's core** (`apps/core/src/tools/bugInbox.ts`) polls every 5 minutes, files each report as a GitHub issue,
  and acks it only after that.

## QR code and the iPhone app (universal links)

**QR code.** Settings → Phone has **Show QR code** next to **Copy link**. It draws the full link as a QR code
(error correction M, 4-module quiet zone, dark on white in both themes) on the computer, with
`qrcode-generator`; nothing goes over the network. It's hidden until asked for, because it is the secret on screen,
and it hides again on a new link, on Turn off, and when you leave the section.

**Universal links.** `phone/.well-known/apple-app-site-association` (JSON, no extension) tells iOS that a phone link
belongs to the Yo iPhone app (`D5MC3NH58Y.dev.yo.phone`):

```json
{ "applinks": { "details": [{ "appIDs": ["D5MC3NH58Y.dev.yo.phone"], "components": [{ "/": "/", "#": "*k=*" }] }] } }
```

Only the root path with a fragment that contains `k=` matches, so tapping or scanning a phone link opens the app when
it's installed and the web app otherwise. Every other page stays on the web. The app needs the
`applinks:yo-phone.vercel.app` Associated Domains entitlement and gets the full URL, fragment included, from
`NSUserActivity.webpageURL`. The fragment still never reaches a server: Apple's CDN fetches only the AASA file.
`vercel.json` serves it as `application/json`; the relay rewrite doesn't match it and `.vercelignore` doesn't skip it
(`phone/test/aasa.test.js` checks all of this). Apple's CDN caches the file for up to a day or so, so deploy it before
the app ships.

## v2.2: peek at the screen (minor, backward compatible)

Nothing above changes. A core that can take screenshots (agentd's `GET /screenshot/:agentId`) adds `peek` to the
`caps` in its `hello`, and the phone (1.2.0+) then shows a **Peek at the screen** button.

| Direction | Message | Meaning |
|---|---|---|
| phone → core | `{ t: "peek", id }` | "Show me your screen now." Runs no model and starts no turn. |
| core → phone | `reply` with `peek: true` | `text` "Here's my screen right now." with `pics: 1`, then the usual `images` message (same blob path, caps and daily picture budget as replies' pictures; the picture has no `src`, so it shows under the text). If the agent's computer isn't running, the reply says so and has no `pics`. The phone keeps its working indicator for a `peek` reply (it isn't the turn's answer). |

Rate limit: one screenshot per 5 seconds; a peek that comes sooner is dropped, and the phone gets one `error` ("One
peek at a time…") at most once a minute. An older phone never sends `peek`; an older core never says `peek`, so the
button stays hidden.

## v2.3: Tasks, the morning brief and quick replies (minor, backward compatible)

Nothing above changes. A v2.3 core adds `tasks`, `brief` and `replies` to the `caps` in its `hello`, and the phone
(1.3.0+) uses each feature only when its cap is there. An older phone never sends the new messages and ignores the
new fields, so it never gets a message type it doesn't know: `tasks` only ever goes to a phone that asked for it.

| Direction | Message | Meaning |
|---|---|---|
| phone → core | `hello` with `localDate: "YYYY-MM-DD"` (optional) | The phone's own date. The core runs the same once-a-day claim as `brief.claim` (`apps/core/src/tools/brief.ts`: the brief is on, it isn't Yo's first day, the date is within a day of the server's, and today's brief hasn't been claimed from the Mac or the phone). If it posts, the brief's request is the phone's own turn (never steered into another), so its reply comes back like any reply. |
| phone → core | `{ t: "tasks", id }` | "Send me the task list." The core answers with `tasks`, and from then on also pushes it when the ledger changes. |
| phone → core | `{ t: "task", id, taskId, action }` | `action`: `start` (a suggestion, or a task the user saved), `hide` (a suggestion) or `done` (check off). |
| core → phone | `{ t: "tasks", items: PhoneTask[], at }` | The active space's main agent's Tasks page (what `tasks.list` returns): at most 40, sorted by status (review, waiting, in_progress, open, suggested, done), newest first within a status. Kept under 40 KB of UTF-8 JSON (see Size). |
| core → phone | `reply` with `brief?: MorningBrief` | The brief the turn posted (its last completed `post_brief` call, read with `briefFromInput`, without the rows' `start` notes; left out when empty). A turn that posted a brief but wrote no text still gets a reply with the `post_brief` entry's id, `briefText: true`, and as `text` the "Needs you" titles in words ("Your brief: • Reply to Dana • Decide on the venue", or "Here's your brief. Nothing needs you right now."), so a phone that can't draw the card still reads something useful. A phone that draws the card hides a `briefText` text. |
| core → phone | `reply` with `replies?: string[]` | Quick replies (2–3, ≤ 24 chars, as `readReplies` accepts them) when the turn's last tool call was a completed `suggest_replies`. None if another tool ran after it. |

`PhoneTask = { id, title, status, note?, why?, origin?, updatedAt }`: `status` is a ledger status (`review`,
`waiting`, `in_progress`, `open`, `done`, `suggested`); `origin` is `asked`, `suggestion` or `user`; `title` is
clipped to 200 characters, `note` and `why` to 300. A suggestion's plan (`prompt`) never goes to the phone.
`MorningBrief = { needsYou, canWait, today, couldNotCheck }` as in `packages/contracts/src/domain.ts`.

### Task actions

- Same code and rules as the Tasks page (`createTasksApi` in `apps/core/src/tasks/tasks.ts`): Start sends what the
  user saw (a suggestion's title only; a saved task's title and details) and marks it Working; only a suggestion can
  be hidden; a suggestion can't be checked off; Yo's own to-dos aren't started from here.
- Only the active space's main agent's tasks: one on another agent's list is refused.
- A started task is the phone's own turn (like a `msg`): its reply, cards and status come to the phone. It counts
  toward the phone's flood cap (3 in flight, 10 a minute). A Start refused by the cap always gets an `error` (not
  the once-a-minute "busy" of `msg`), up to 10 a minute. The phone shows "Started" only once a `tasks` list has that
  task in progress (it gives up after about 20 seconds).
- A refusal comes back as `{ t: "error", agent, text }` in plain words ("Only a suggestion can be hidden."). After
  every action, refused or not, the core sends the list, so the phone shows what's really there. An unknown `action`
  gets only the error.

### Pushes (the relay's database is a shared free one)

- Only to a phone that has sent `tasks` (or `task`) at least once since the link was made (`tasksCap` in the KV
  state `_phone`; a new link or Off clears it).
- Only for changes to the active space's main agent's tasks, gathered for 5 seconds into one push, and only when the
  list differs from the last one sent (an answer to `tasks` or an action counts as sent).
- `updatedAt` alone changing isn't a change (the order it gives is).
- None to a phone that hasn't been seen in the last 15 minutes: a closed phone doesn't read its mailbox, so pushes
  would pile up on the relay. The phone asks for the list (`tasks`, at most every 15 s) whenever it comes back to
  the foreground, whichever tab is showing.

### Size

The relay refuses envelopes over 64 KiB (413), and a sealed box is about 4/3 of its JSON. So `tasks` is cut to 40 KB
of UTF-8 JSON: first the `note`s and `why`s go, from the bottom of the list up, then the rows at the bottom (the
order keeps what needs the user). A `reply` whose `brief` would take it past 40 KB is sent without the `brief` (and
without `briefText`).
