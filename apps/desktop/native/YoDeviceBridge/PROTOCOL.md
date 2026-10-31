# YoDeviceBridge wire protocol (version 1)

Helper version **0.3.0** adds selected-window observation and control (R3: `windows.list`,
`window.capture`, `window.click`, `window.type`, `window.key`, `window.scroll`) and Apple Notes and
Mail through fixed Apple Events templates (R4: `notes.*`, `mail.*`, drafts only). 0.2.0 (R2) added
Contacts, Calendar and Reminders. The wire protocol (framing, handshake, `protocol: 1`) is
unchanged, and every 0.2.0 method behaves exactly as before.

YoDeviceBridge is a native helper launched by Electron main as a child process. It talks only over
the private stdin/stdout pipes it inherits. It never runs shell commands, never loads code, and
never opens a network connection. The only AppleScript it runs is its own two fixed, compiled-in
templates for Notes and Mail (see "Notes and Mail"); it never runs script text received over the
protocol. stderr is for short diagnostic logs only (no paths, no file contents).

Core and Electron main enforce grants, leases and approvals before a request reaches the helper.
The helper is the last line: it re-validates everything it can check locally (deny list, window
identity, focus, user activity, secure input) on every call and refuses rather than guesses.

## Framing

Every message in both directions is a frame:

```
+----------------------------+----------------------------------+
| length: UInt32 big-endian  | length bytes of UTF-8 JSON       |
+----------------------------+----------------------------------+
```

- Maximum frame body: 32 MiB (33,554,432 bytes). If the parent declares a larger length, the
  helper writes `{"id":null,"ok":false,"error":{"code":"too_large","message":"frame exceeds 32 MiB"}}`
  (best effort) and exits with status **2**.
- EOF on stdin between frames: the helper exits with status **0** immediately.
- EOF in the middle of a frame: exit status **2**.
- If stdout is closed, the helper exits with status 0.

## Handshake

The first frame from the parent must be exactly:

```json
{"type":"hello","nonce":"<hex>","protocol":1}
```

- `nonce`: 16 to 256 hex characters (`0-9a-fA-F`), chosen randomly per launch by the parent.
- `protocol`: the integer `1`.
- No other keys are allowed.

The helper replies:

```json
{"type":"hello","nonce":"<same nonce>","protocol":1,"version":"0.3.0","macos":"Version 27.0 (Build 26A428)","arch":"arm64"}
```

`macos` is `ProcessInfo.operatingSystemVersionString`. Exit status **3** if the first frame is
anything else (including malformed JSON), or if any later frame contains a `type` key (for
example a second hello).

## Requests and responses

```json
{"id":"<string>","method":"<name>","params":{...}}
{"id":"<same>","ok":true,"result":{...}}
{"id":"<same>","ok":false,"error":{"code":"<code>","message":"<short text>"}}
```

- Requests are handled strictly one at a time, in order. Each request gets exactly one response.
- `id` must be a non-empty string of at most 256 bytes. `params` may be omitted (treated as `{}`).
  Any other top-level key is rejected.
- If a frame is not a JSON object or has no valid `id`, the response has `"id": null` and code
  `invalid_params`.
- Parameter validation is strict: every parameter must have the documented JSON type (`true` is
  not an integer, `2.5` is not an integer, `"5"` is not a number), and **unknown parameters are
  rejected** with `invalid_params`.
- Error messages are fixed short strings. They never contain file contents or paths.
- If a response would exceed the frame limit, `too_large` is returned instead.

### Error codes

| code | meaning |
| --- | --- |
| `invalid_params` | missing, unknown or wrongly typed parameter; value out of range; bad base64; bad cursor |
| `invalid_path` | malformed `relPath` (absolute, `.`/`..`, empty component, NUL, component > 255 bytes, path > 4096 bytes), non-absolute `scope.create` path, non-empty `relPath` on a file scope |
| `not_found` | path or parent directory does not exist; window gone, not eligible, not listed in this session or now owned by another process; note, folder or message not found |
| `protected` | scope root outside the allowed locations, or a protected name anywhere in the path; a password-protected note (`notes.read`) |
| `symlink` | a symlink was met at any component; links are never followed |
| `hardlink` | regular file with more than one link (read/write) |
| `too_large` | write data over 20 MiB, or a frame/response over 32 MiB |
| `conflict` | write precondition failed (hash mismatch, file missing for a replace, file changed during the operation) |
| `not_a_directory` | listing a file or a file scope; a file used as an intermediate directory |
| `not_a_file` | reading/writing a directory, FIFO, socket or device; writing to a directory scope root |
| `exists` | create (`expectedSha256: null`) when anything already exists at the path |
| `stale_scope` | bookmark cannot be resolved, or the scope changed while it was being opened |
| `io` | other OS error, including file permission denied; a Contacts/EventKit failure or timeout; a capture or event-creation failure; an Apple Event failure other than those mapped below (message `"automation failed (<number>)"`) |
| `unsupported` | unknown method (including any send/reply/forward/delete method: none exists) |
| `permission` | an OS privacy permission is not granted. The message is `"<kind>: <status>"` using the status word from `permissions.status`, e.g. `"calendars: denied"`, `"accessibility: not-requested"`, `"screenRecording: not-requested"`, or `"automation: denied"` for Notes/Mail |
| `read_only` | the calendar or reminder list does not allow modifications |
| `denied` | the window belongs to an app on the deny list (see "Deny list") |
| `secure_input` | secure keyboard entry is on (for example a password field has focus) or the screen is locked; no input is posted |
| `user_active` | a keyboard or mouse event that the helper did not post happened in the last 1.5 s; no input is posted |
| `not_frontmost` | the target window could not be raised, or is not the focused window, or another app-level window covers the input point; no input is posted |

## Scopes

A scope is a user-chosen directory or single file, identified by an opaque `bookmark` (base64 of
`URL.bookmarkData()`, no security-scope options; the app is not sandboxed). Bookmarks track the
item's file identity, so a moved folder keeps working, but every call re-resolves the bookmark,
`realpath`s it, and re-applies the rules below to the new location.

**Allowed scope roots** (after `realpath`):

- Inside the user's home directory, except the home directory itself, anything under `~/Library`,
  and anything under `~/.Trash` (case-insensitive).
- On a volume under `/Volumes/<name>/` (the volume root or any folder in it). The boot volume's
  `/Volumes/Macintosh HD` entry resolves to `/` and is rejected.

Everything else is `protected`, which covers `/`, `/System`, `/Library`, `/Applications`,
`/private`, `/usr`, `/bin`, `/sbin`, `/etc`, `/opt`, `/dev` and `/cores`. A path is also
`protected` if any component is a protected name (below).

**Protected names** (case-insensitive, Unicode-normalized), checked on every component of a scope
root and of every `relPath`, and omitted from listings:

- exact: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.netrc`, `.npmrc`, `.pypirc`,
  `.git-credentials`, `.password-store`, `keychains`, `login data`, `cookies`, `.env`
- prefixes: `.env.`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`
- suffixes: `.pem`, `.p12`, `.pfx`, `.key`, `.keychain`, `.keychain-db`, `.kdbx`, `.ovpn`

**How paths are opened.** The scope root is opened with `open(O_NOFOLLOW_ANY | O_DIRECTORY)`
(for a file scope: its parent directory), and the kernel's path for that descriptor
(`F_GETPATH`) is validated again. Every `relPath` component is then opened relative to the
previous descriptor with `openat(O_NOFOLLOW)`; intermediate components also require
`O_DIRECTORY`. The final component is inspected with `fstatat(AT_SYMLINK_NOFOLLOW)`, opened with
`O_NOFOLLOW`, and the descriptor's `fstat` must match the same device and inode. Symlinks at any
level produce `symlink`. FIFOs and devices are never opened.

**Single-file scopes.** `relPath` must be `""`; operations apply to that file. `files.list`
returns `not_a_directory`.

## Methods

All sizes are bytes, all `mtimeMs` are integer milliseconds since the Unix epoch, all hashes are
lowercase hex SHA-256. Limits: 20 MiB = 20,971,520 bytes.

### `status`

Params: none. Result: `{"version":"0.3.0","macos":"...","arch":"arm64"}`.

### `permissions.status`

Params: none. Result: `{"contacts","calendars","reminders","accessibility","screenRecording"}`,
each one of `not-requested | denied | restricted | granted | limited | write-only | unknown`.

This method never prompts. Only non-prompting status APIs are used: `CNContactStore.authorizationStatus(for: .contacts)`,
`EKEventStore.authorizationStatus(for: .event / .reminder)` (`fullAccess` → `granted`,
`writeOnly` → `write-only`, `notDetermined` → `not-requested`), `AXIsProcessTrusted()` and
`CGPreflightScreenCaptureAccess()`. Limitation: the last two only report true/false, so `false`
is reported as `not-requested` even if the user explicitly denied access. TCC attributes these
checks to the responsible (parent) process, so results reflect the launching app's grants.

### `scope.create`

Params: `{"path": string}` (absolute, must exist; a trailing symlink is resolved first).
Result: `{"bookmark", "canonicalPath", "kind": "dir"|"file", "displayPath"}`. `displayPath` replaces
the home prefix with `~`. Only directories and regular files can be scopes.

### `scope.resolve`

Params: `{"bookmark": string}`. Result: `{"canonicalPath", "kind", "displayPath", "stale": bool}`.
`stale: true` means the bookmark resolved but should be recreated (for example after an atomic
replace of a single-file scope gave the file a new identity). A resolved location that now
violates the scope rules returns `protected` (for example a folder moved into `~/Library`).

### `files.list`

Params: `{"bookmark", "relPath": string ("" = root), "limit"?: integer 1..500 (default 200),
"cursor"?: string | null}`.
Result: `{"entries":[{"name","kind":"file"|"dir"|"symlink"|"other","size","mtimeMs"}],
"nextCursor": string | null}`.

Entries are sorted by the byte order of their UTF-8 names. The cursor encodes the last name
examined, so pagination is stable while the directory changes: entries are never repeated, and
entries added behind the cursor are not returned on later pages. Symlinks are listed (never
followed) with `size`/`mtimeMs` of the link itself. Protected names and names that are not valid
UTF-8 are omitted.

### `files.stat`

Params: `{"bookmark", "relPath"}`.
Result: `{"kind", "size", "mtimeMs", "sha256": string | null, "nlink"}`.
`sha256` is set only for a regular file of at most 20 MiB with `nlink == 1` (a hard link may
share an inode with a file outside the scope, so it is not hashed). A symlink returns `symlink`.
`relPath: ""` stats the scope root.

### `files.read`

Params: `{"bookmark", "relPath", "maxBytes": integer 1..20971520}`.
Result: `{"dataBase64", "size", "sha256": string | null, "truncated": bool, "mtimeMs"}`.
Regular files only (`not_a_file`), `nlink == 1` only (`hardlink`). Returns the first `maxBytes`
bytes; `truncated` is true when the file is larger. `sha256` covers the **whole** file when it is
at most 20 MiB, else it is `null`.

### `files.write`

Params: `{"bookmark", "relPath", "dataBase64": string (decoded at most 20 MiB),
"expectedSha256": string (64 hex) | null}`. The `expectedSha256` key is **required**; pass `null`
explicitly to create. Result: `{"sha256", "size"}` of the file as re-read from disk after the write.

- `expectedSha256: null` — create. Fails with `exists` if anything (file, directory, symlink) is
  already at the path.
- `expectedSha256: <hash>` — replace. The existing entry must be a regular file (`symlink`,
  `not_a_file` otherwise) with `nlink == 1` (`hardlink`) whose SHA-256 equals the expected hash
  (`conflict`; a missing file is also `conflict`).
- The parent directory must already exist (`not_found`); no directories are created.

Atomic procedure: create `.yo-tmp-<24 hex>` in the target directory with
`openat(O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW)`, set its mode (`0644` for a new file, the existing
file's permission bits for a replace), write all data, `fsync`, re-check the precondition
(replace: same inode, still single-link, same hash), then `renameatx_np(RENAME_EXCL)` for a create
or `renameat` for a replace, then `fsync` the directory. The temporary file is unlinked on every
failure path.

## Contacts, Calendar and Reminders (0.2.0)

These methods use the Contacts framework and one long-lived `EKEventStore`. Common rules:

- **Timestamps** are integer milliseconds since the Unix epoch. Output values are floored to the
  millisecond. Inputs must lie in [1900-01-01, 2200-01-01) UTC, else `invalid_params`.
- **String limits** are in UTF-8 bytes: `title` 500 (must not be blank), `location` 500,
  `notes` 8000, `query` 200, any id 512 (must not be empty). Id arrays (`calendarIds`,
  `listIds`) hold 1 to 100 non-empty strings (duplicates are ignored). `[]` is `invalid_params`;
  use `null` to mean "all". `timeZone` is at most 100 bytes and must be a known IANA identifier.
- Optional keys are marked `?`. An absent optional key takes its default (`null` unless stated).
  Unknown keys are `invalid_params`, both at the top level and inside `changes`.
- **Order of checks**: parameters (`invalid_params`), then OS access (`permission`), then existence
  (`not_found`), then preconditions (`conflict`), then writability (`read_only`). Nothing is read
  or written until the parameters are valid.
- **Access required**: `contacts.search` needs Contacts status `granted` or `limited`. Every
  `calendar.*` method needs Calendars `granted` (full access; `write-only` is not enough). Every
  `reminders.*` method needs Reminders `granted`. Anything else returns `permission`.
- **No prompts**: only `permissions.request` may trigger an OS privacy prompt. No other method calls
  any request API. (Exception, by design of macOS: the first `notes.*`/`mail.*` call shows the
  Automation prompt; see "Notes and Mail".)
- **Data minimization**: listings never include event notes, attendees, alarms, contact notes or
  images. Writes never add attendees, alarms or recurrence rules, and never touch future occurrences.

### `permissions.request`

Params: `{"kind": "contacts"|"calendars"|"reminders"|"accessibility"|"screenRecording"}`.
Result: `{"status"}`, using the same status words as `permissions.status`.

`accessibility` and `screenRecording` (0.3.0): if `AXIsProcessTrusted()` /
`CGPreflightScreenCaptureAccess()` already report access, `granted` is returned without prompting.
Otherwise the helper calls `AXIsProcessTrustedWithOptions` with `AXTrustedCheckOptionPrompt: true`
or `CGRequestScreenCaptureAccess()`. Both return immediately: macOS shows its dialog (which sends
the user to System Settings) and the result is the current status, normally `not-requested` until
the user enables Yo there. Screen Recording access usually takes effect only after Yo restarts.
These are the only two calls in the helper that can prompt for these permissions. The rest of
this section describes `contacts`, `calendars` and `reminders`.

If the current status is anything other than `not-requested`, it is returned without calling any
request API. Otherwise the helper calls `CNContactStore.requestAccess(for: .contacts)`,
`EKEventStore.requestFullAccessToEvents` or `requestFullAccessToReminders` on a background queue.
It blocks the synchronous session for up to **180 s** waiting for the callback, then returns the
re-read status. If the user has not answered within 180 s, the result is the current status
(normally `not-requested`). A later answer is ignored by this request but applies to later calls.
No `NSApplication` or run loop is needed. macOS attributes the prompt to the responsible process
(Yo.app), whose `Info.plist` must contain the matching usage descriptions.

### `contacts.search`

Params: `{"query": string (1..200 bytes after trimming whitespace), "limit"?: integer 1..50 (default 20)}`.
Result: `{"contacts":[{"id", "name", "organization": string|null, "phones":[{"label": string|null,
"value"}], "emails":[{"label": string|null, "value"}]}]}`.

- Fetches only `identifier`, given/middle/family name, `nickname`, `organizationName`,
  `phoneNumbers` and `emailAddresses` (unified contacts). Never notes or images.
- Always matches with `CNContact.predicateForContacts(matchingName:)`. A query that looks like a
  phone number (only digits, spaces and `+-().`, with at least 3 digits) is also matched with
  `predicateForContacts(matching: CNPhoneNumber)`. A query that looks like an email address
  (contains `@`, no whitespace) is also matched with `predicateForContacts(matchingEmailAddress:)`.
- Results are merged, de-duplicated by `id`, sorted by `name` (`localizedStandardCompare`, then
  `id`) and cut to `limit`.
- `name` is "given middle family" (non-empty parts only). If that is empty it is the nickname,
  then the organization, then `""`. `organization` is `null` when empty. `label` is the localized
  label from `CNLabeledValue.localizedString(forLabel:)`, or `null` when the entry has no label.

### `calendar.calendars`

Params: none. Result: `{"calendars":[{"id", "title", "account", "sourceType", "writable"}]}` for
event calendars. `id` is `calendarIdentifier`. `account` is the source title. `sourceType` is one
of `local | exchange | caldav | mobileme | subscribed | birthdays | unknown`. `writable` is
`allowsContentModifications`. Sorted by account, then title (`localizedStandardCompare`), then id.

### `calendar.events`

Params: `{"start", "end": integer ms, "calendarIds"?: [string]|null, "limit"?: integer 1..500
(default 200)}`. `end` must be after `start`, and `end - start` must be at most 366 days. An unknown
calendar id returns `not_found`. `null` means all event calendars.
Result: `{"events":[{"id", "calendarId", "title", "start", "end", "allDay", "location": string|null,
"url": string|null, "recurring", "occurrenceDate", "lastModified": integer|null}], "truncated": bool}`.

Every occurrence that overlaps the range is listed, so recurring series are expanded. Events are
sorted by `start`, then `end`, `id` and `occurrenceDate`, and cut to `limit`. `truncated` is true
when more events matched. `id` is `eventIdentifier`, which all occurrences of a series share.
`recurring` is `hasRecurrenceRules`. `occurrenceDate` is the occurrence's original start and
identifies it for `calendar.updateEvent`. `lastModified` is `lastModifiedDate`. Notes and attendees
are not returned.

### `calendar.createEvent`

Params: `{"calendarId", "title", "start", "end": integer ms, "allDay": bool, "location"?: string|null,
"notes"?: string|null, "timeZone"?: string|null}`. `end` must be after `start`.
Result: `{"id", "lastModified": integer|null}`.

Returns `not_found` for an unknown calendar and `read_only` if the calendar does not allow
modifications. `timeZone` is an IANA identifier (`invalid_params` if unknown). `null` uses the
system time zone. It is ignored for all-day events, which are floating. The event is saved with
span `.thisEvent` and `commit: true`. No attendees, alarms or recurrence are set.

### `calendar.updateEvent`

Params: `{"id", "occurrenceDate": integer ms|null, "expectedLastModified": integer ms|null,
"changes": {"title"?: string, "start"?: integer, "end"?: integer, "allDay"?: bool,
"location"?: string|null, "notes"?: string|null}}`.
The `occurrenceDate` and `expectedLastModified` keys are **required**; pass `null` explicitly.
Result: `{"id", "lastModified": integer|null}`.

1. `changes` must contain at least one key, and only the keys above. `title`, `start`, `end` and
   `allDay` must not be `null`. Setting `location` or `notes` to `null` clears that field.
2. The event is looked up with `event(withIdentifier:)` (`not_found` if missing).
3. With `occurrenceDate`, the helper lists that event's calendar for `occurrenceDate ± 1 day` and
   picks the occurrence whose `eventIdentifier` equals `id` and whose `occurrenceDate` (ms, floored)
   equals `occurrenceDate` (`not_found` if none). For a **recurring** event, `occurrenceDate` is
   required (`invalid_params` if `null`), so an update never silently edits the first occurrence.
4. If `expectedLastModified` is not `null` and differs from the selected occurrence's
   `lastModified` (ms, floored), the result is `conflict`. A missing date also counts as different.
5. Returns `read_only` if the calendar does not allow modifications, and `invalid_params` if the
   resulting `end` is not after `start`.
6. The change is saved with span `.thisEvent` only (never future events) and `commit: true`.

### `reminders.lists`

Params: none. Result: `{"lists":[{"id", "title", "account", "writable"}]}`, sorted like
`calendar.calendars`.

### `reminders.list`

Params: `{"listIds"?: [string]|null, "includeCompleted"?: bool (default false), "limit"?: integer
1..500 (default 200)}`. An unknown list id returns `not_found`.
Result: `{"reminders":[{"id", "listId", "title", "due": integer|null, "dueAllDay", "completed",
"completedAt": integer|null, "priority": integer}], "truncated": bool}`.

Reminders are fetched with `fetchReminders(matching:)`, using the incomplete-only predicate unless
`includeCompleted` is true. The call is bridged synchronously with a 30 s timeout (`io` on
timeout). `id` is `calendarItemIdentifier`. `due` is the due date components resolved in their
calendar and time zone. `dueAllDay` is true when the components have no hour. Sorting puts
incomplete reminders first, by `due` ascending with undated ones last. Completed reminders follow,
by `completedAt` descending with undated ones last. Ties are broken by title, then id. The list is
cut to `limit`, and `truncated` is true when more reminders matched. Notes are not returned.

### `reminders.create`

Params: `{"listId", "title", "due"?: integer ms|null, "dueAllDay"?: bool (default false),
"notes"?: string|null}`. `dueAllDay: true` requires `due`. Result: `{"id"}`.

`not_found` and `read_only` work as for events. `due` becomes `dueDateComponents` in the current
calendar and time zone: year/month/day only when `dueAllDay` is true, otherwise year through second
plus the time zone. No alarms or recurrence are set.

### `reminders.complete`

Params: `{"id", "completed": bool}`. Result: `{"id", "completed"}`.
Returns `not_found` if no reminder has that id, and `read_only` if its list does not allow
modifications. Nothing is saved when the reminder is already in the requested state.

## Selected windows (0.3.0)

Observation and bounded input for one window at a time. Core binds a screen lease to a window and
Electron main shows the stop control; the helper independently refuses anything it cannot verify.
Nothing is captured or posted in the background: every capture and every input unit is one request.

### Deny list

Windows of these apps are never listed, captured or controlled. Matching is on the bundle
identifier, case-insensitively. The single source is `AppDenyList` in `WindowPolicy.swift`.

- Terminals: `com.apple.Terminal`, `com.googlecode.iterm2`, `dev.warp.Warp-Stable`,
  `com.mitchellh.ghostty`, `io.alacritty`, `net.kovidgoyal.kitty`
- System settings and security UI: `com.apple.systempreferences`, `com.apple.Settings`,
  `com.apple.keychainaccess`, `com.apple.loginwindow`, `com.apple.SecurityAgent`
- Script editors and system inspection: `com.apple.ScriptEditor2`, `com.apple.Automator`,
  `com.apple.ActivityMonitor`, `com.apple.Console`
- IDEs: `com.apple.dt.Xcode`, `com.microsoft.VSCode`, `com.todesktop.230313mzl4w4u92` (Cursor)
- Password managers: `com.1password.1password`, `com.agilebits.onepassword7`,
  `com.bitwarden.desktop`, `com.apple.Passwords`
- Yo itself: `dev.yo.app` and any `dev.yo.app.*`
- T3 Code: any bundle id containing `t3code`, `t3.code` or `t3tools`
- Fail closed: a process with no bundle identifier, the helper's own process, and its parent
  process (Yo, including an unbundled development Electron) are denied too.

The deny list is a floor, not a semantic guarantee. An allowed app (for example Finder or a
browser) can still open a denied app or a web terminal; the denied app's windows can never be
targeted, and once focus moves to it every input request fails with `not_frontmost`.

### Eligible windows and identity

A window is **eligible** when it is on screen, at layer 0 (normal windows), has alpha > 0, is at
least 80 × 60 points, and belongs to a running app with `NSRunningApplication.activationPolicy ==
.regular` that is not denied. Windows are identified by their `CGWindowID` (`windowId`).

The helper remembers `windowId → pid` for every window returned by `windows.list` (the list replaces
the remembered set) or `window.capture` in the current process. Input methods only accept a
remembered window, and only while it still has the same pid; otherwise `not_found`. After a helper
restart the parent must list again.

**Coordinates.** Bounds are global display points as reported by CGWindowList: origin at the
top-left of the main display, y down; displays to the left of or above the main display have
negative coordinates. Capture pixels relate to points by `scale`.

### `windows.list`

Params: none. Result: `{"windows":[{"windowId", "pid", "bundleId", "appName", "title",
"bounds":{"x","y","width","height"}, "onScreen": true}]}`.

Every eligible window, sorted front to back (CGWindowList order). `title` is `""` when the window
has none. Requires Screen Recording (`CGPreflightScreenCaptureAccess()`; window titles are only
visible with it), else `permission` with `"screenRecording: <status>"`. Uses
`CGWindowListCopyWindowInfo(.optionOnScreenOnly | .excludeDesktopElements)`; never prompts.

### `window.capture`

Params: `{"windowId": integer 1..4294967295, "maxWidth"?: integer 320..2560 (default 1600)}`.
Result: `{"pngBase64", "width", "height", "scale", "bounds":{...}, "title"}`.

Order: parameters, Screen Recording (`permission`), then the window is re-validated immediately
before capturing: gone or not eligible → `not_found`, denied app → `denied`. The capture uses
ScreenCaptureKit for that one window only (`SCShareableContent` → `SCContentFilter(desktopIndependentWindow:)`
→ `SCScreenshotManager.captureImage`), without the cursor or the window shadow. The image is
scaled down so `width` ≤ `maxWidth` pixels (never up). `scale` = `width / bounds.width` (pixels
per point). A capture that takes more than 15 s returns `io`. A successful capture also makes the
window remembered for input. The image is returned once and not kept.

### Input methods

`window.click`, `window.type`, `window.key` and `window.scroll` all take `windowId` and act only
inside that window. Result for all four: `{"ok": true, "bounds": {...}}` with the window's bounds
after the input.

**Units.** A request is split into units (a click with its down/up pairs, one key press, one text
chunk, one scroll). A unit is always posted whole, so a key or button is never left pressed.

**Preconditions**, checked in this order immediately before *every* unit. If one fails, the request
stops with that error and nothing more is posted (units already posted by the same request stay
posted):

1. Parameters (`invalid_params`), including the key allowlist; checked once, before anything else.
2. Accessibility is trusted (`AXIsProcessTrusted()`), else `permission` `"accessibility: not-requested"`.
3. The window is still on screen, eligible and remembered with the same pid (`not_found`), and its
   app is not denied (`denied`).
4. The screen is not locked (`CGSessionCopyCurrentDictionary`) and secure keyboard entry is off
   (`IsSecureEventInputEnabled()`), else `secure_input`.
5. The user is idle: the newest keyboard/mouse event in the HID system state
   (`CGEventSource.secondsSinceLastEventType(.hidSystemState, …)`, minimum over key, flags, mouse
   move/down/up/drag and scroll events) is at least 1.5 s old, **or** it is no newer than the
   helper's own last posted unit (+ 0.2 s delivery tolerance). Events the helper posts carry
   `eventSourceUserData = 0x596F427269646765` ("YoBridge"). Else `user_active`.
6. The window is the focused front window: the Accessibility focused application
   (`AXUIElementCreateSystemWide` → `AXFocusedApplication`) has the window's pid, its
   `AXFocusedWindow` maps to the same `windowId`, and the first window in CGWindowList front-to-back
   order with layer 0..19 and alpha > 0 that contains the input point is this window. Before the
   first unit only, if this does not hold, the helper activates the app (`AXFrontmost`,
   `NSRunningApplication.activate()`), raises the matching AX window (`AXRaise`, `AXMain`) and
   re-checks every 50 ms for up to 1 s. Later units are never re-raised: a focus change mid-request
   stops it. Failure → `not_frontmost`.
7. The input point is inside the window's current bounds (`invalid_params`).

The AX window is matched to the `windowId` with `_AXUIElementGetWindow` (looked up with `dlsym`;
private but long-stable). If that symbol is unavailable, the AX window must be the only window of
the pid with the same position and size (±1 point) and title. No match or more than one match →
`not_frontmost`. Windows at layer 20 and above (Dock, menu bar, status items, notification and
other system overlays) are ignored by the cover check because they are mostly click-through and
some cover the whole screen.

Events are created from a `.privateState` `CGEventSource` (keys the user is holding are not merged
in) and posted with `CGEventPost(.cghidEventTap)`. Consecutive units are 15 ms apart.

#### `window.click`

Params: `{"windowId", "x": number, "y": number, "button"?: "left"|"right" (default "left"),
"count"?: 1|2 (default 1)}`.

**Coordinate convention**: `x` and `y` are fractions of the window's current width and height,
each in [0, 1], origin at the window's top-left (including the title bar). They are independent of
capture size and display scale: a point at pixel (px, py) of a capture is
`x = px / width`, `y = py / height`. The screen point is `bounds.x + min(x·w, w−1)`,
`bounds.y + min(y·h, h−1)`, so `1` maps to the last point inside the window. The helper moves the
pointer there, then posts `count` down/up pairs with click states 1…count.

#### `window.type`

Params: `{"windowId", "text": string (1..500 characters, at most 8000 UTF-8 bytes)}`.

Text is posted as key events carrying the Unicode string (`CGEventKeyboardSetUnicodeString`), in
chunks of at most 20 UTF-16 code units that never split a character. `\n`, `\r` and `\r\n` are
posted as the Return key and `\t` as the Tab key. Any other control character, or a single character
longer than 20 UTF-16 units, is `invalid_params`. The keyboard layout and input method of the
target are bypassed for chunks (the characters arrive as-is).

#### `window.key`

Params: `{"windowId", "key": string, "modifiers"?: ["cmd"|"shift"|"option"|"control"] (default [],
no duplicates)}`.

Allowed keys: `return`, `tab`, `escape`, `delete` (backspace), `space`, `up`, `down`, `left`,
`right`, `pageup`, `pagedown`, `home`, `end`, the lowercase letters `a`–`z` and the digits `0`–`9`
(use `shift` for capitals). Letters and digits are the ANSI-layout key positions (`kVK_ANSI_*`).
Everything else (function keys, punctuation, `fn`, …) is `invalid_params`.

Refused combinations (`invalid_params`), because they leave the window or reach system-wide
surfaces:

| combination | reason |
| --- | --- |
| any with `control`+`option`+`cmd` | system shortcuts |
| `cmd`+`q` with any other modifiers | quit, log out (`shift`), lock screen (`control`) |
| `cmd`+`option`+`escape` (with or without `shift`) | Force Quit |
| `cmd`+`tab` (any) | app switcher |
| `space` with `cmd` or `control` | Spotlight, input source switching |
| `control`+arrow keys | Spaces, Mission Control |
| `cmd`+`shift`+`3`/`4`/`5`/`6` | screenshots |
| `cmd`+`h`, `cmd`+`m` (any) | hide, minimize |
| `cmd`+`option`+`d` | Dock |

`cmd`+`w` and other in-app shortcuts (`cmd`+`c`/`v`/`z`/`a`, `shift`+`tab`, …) are allowed.
Arrow keys carry the numeric-pad and function flags, and `home`/`end`/`pageup`/`pagedown` the
function flag, as a physical keyboard sends them.

#### `window.scroll`

Params: `{"windowId", "dx"?: integer, "dy"?: integer}` (default 0, each |v| ≤ 2000, at least one
non-zero). Pixel units. `dy > 0` scrolls toward the end of the content (down), `dx > 0` toward
the right. The helper moves the pointer to the window's center (`bounds.x + ⌊w/2⌋`,
`bounds.y + ⌊h/2⌋`) and posts one pixel scroll-wheel event there.

## Notes and Mail (0.3.0)

### How Apple Events are sent

The helper contains two fixed AppleScript templates (`AutomationTemplates` in
`AppleScriptBackend.swift`), one that only talks to Notes and one that only talks to Mail. Each is
compiled once per helper process with `NSAppleScript`. A method calls one named handler of a
template by sending the script a handler-call event (`kASAppleScriptSuite`/`kASSubroutineEvent`,
handler name in `keyASSubroutineName`, arguments as an `NSAppleEventDescriptor` list in
`keyDirectObject`) with `executeAppleEvent`. Request data only ever becomes descriptor values
(text, integers, lists); **script source is never built by string interpolation** of request
data, and there is no method that runs arbitrary script. Results come back as AppleScript lists and
are parsed positionally into JSON; anything unexpected is `io`.

Handlers: `notes_search`, `notes_folders`, `notes_read`, `notes_create`, `mail_scan`, `mail_read`,
`mail_create_draft`. **There is no send method** and the Mail template contains no `send`,
`forward`, `reply`, `redirect`, `move` or `delete` command (unit tests assert this). Drafts are
created invisible and saved; the user sends them from Mail.

### Automation permission

macOS asks "Yo wants to control Notes/Mail" the first time the helper sends that app an event (the
prompt is attributed to Yo.app, which needs `NSAppleEventsUsageDescription`). This is the one
prompt not routed through `permissions.request`. Errors are mapped from the Apple Event error
number, never from the script's message text:

| error | result |
| --- | --- |
| -1743 `errAEEventNotPermitted` | `permission` `"automation: denied"` |
| -1744 `errAEEventWouldRequireUserConsent` | `permission` `"automation: not-requested"` |
| -1728 `errAENoSuchObject`, -1719 | `not_found` `"item not found"` |
| -600 `procNotFound`, -609 | `io` `"app is not running"` |
| -10810, -10827, -10660 | `io` `"app could not be launched"` |
| -1712 `errAETimeout` | `io` `"automation timed out"` |
| -128 | `io` `"automation was cancelled"` |
| other | `io` `"automation failed (<number>)"` |

The templates address the apps with `tell application`, which launches Notes or Mail if needed.
Each handler runs under `with timeout of 60 seconds` (120 s for Mail scans and reads).

String limits are UTF-8 bytes. `query` (1..200 after trimming, single line) matches
case- and diacritic-insensitively; `limit` is 1..50 (default 20). Timestamps are integer ms or
`null` when unknown. Long text is cut to 100,000 characters with `truncated: true`.

### `notes.search`

Params: `{"query", "limit"?}`. Result: `{"notes":[{"id", "name", "folder", "modified"}]}`.

Reads the id, name, modification date and password-protection flag of every note (one bulk event
each) and the ids of notes whose plain text contains the query (Notes' own `whose plaintext
contains`, inside `ignoring case and diacriticals`). Only the 2,000 most recently modified notes
are considered. A note matches when its name contains the query, or its body does and it is not
password-protected. Results are sorted newest first (undated last), cut to `limit`, and then their
folder names are fetched. Body text is never returned by search.

### `notes.read`

Params: `{"id": string ("x-coredata://…", at most 512 bytes, no whitespace)}`.
Result: `{"id", "name", "folder", "modified", "text", "truncated"}`. `text` is the note's
`plaintext`. A password-protected note returns `protected`; an unknown id `not_found`.

### `notes.create`

Params: `{"folder"?: string|null (1..200, single line; null/absent = the default account's default
folder, normally "Notes"), "title": string (1..500, single line), "body": string (≤ 50,000; may be
empty)}`. Result: `{"id"}`.

The note body is generated HTML: `<div><h1>title</h1></div>` followed by one `<div>line</div>` per
body line (`<div><br></div>` for empty lines). `&`, `<`, `>`, `"` and `'` are escaped as entities.
Notes names the note after its first line. A named folder is the first top-level folder with that
exact name in the default account, then in the other accounts; none → `not_found`. Control
characters other than tab and line breaks in the body are `invalid_params`.

### `mail.search`

Params: `{"query", "limit"?, "mailbox"?: "inbox"|"sent"|"drafts" (default "inbox")}`.
Result: `{"messages":[{"id", "subject", "sender", "date", "account", "mailbox", "read"}]}`.

For each account's mailbox under Mail's top-level `inbox`/`sent mailbox`/`drafts mailbox` (or the
top-level mailbox itself if it has no per-account children), only the newest 500 messages are read
(subject, sender, date received, read status, id, one bulk event each). A message matches when its
subject or sender contains the query. Results from all accounts are merged, sorted by date
(newest first, undated last) and cut to `limit`. Message content is never returned by search.
Accounts whose Mail account id contains characters other than `A–Z a–z 0–9 - . _` are skipped.

Message `id`s are `<mailbox>:<Mail account id>:<Mail message id>`, e.g.
`inbox:6C1F2A9E-…:48213` (the account id is empty for local mailboxes).

### `mail.read`

Params: `{"id": string (a `mail.search` id)}`. Result: `{"id", "subject", "sender", "to":[…],
"cc":[…], "date", "content", "truncated"}`. `to`/`cc` are addresses; `content` is Mail's plain-text
content. A malformed id is `invalid_params`; a message no longer in that mailbox is `not_found`.

### `mail.createDraft`

Params: `{"to": [string] (1..20), "cc"?: [string] (0..20, default []), "subject": string (≤ 500,
single line, may be empty), "body": string (≤ 50,000, plain text)}`. Result: `{"id": "outgoing:<n>"}`.

Creates an outgoing message with `visible: false`, adds the recipients, and `save`s it to Drafts.
It is never sent. Addresses are validated loosely: at most 320 bytes, exactly one `@` with text on
both sides, and no whitespace, control characters or address-list syntax (`, ; < > " ( ) [ ] \ :`),
so one entry is exactly one recipient. There is no `bcc`. The returned id is Mail's outgoing-message
id; it identifies the draft only while Mail keeps it open and is not a `mail.read` id.

## Known limitations

- There is a small window between the final precondition re-check and `renameat` for a replace in
  which another process could modify the target; the returned `sha256` reflects what is on disk
  afterwards, so callers can detect this.
- An atomic replace gives the file a new inode. Bookmarks of single-file scopes then resolve by
  path and report `stale: true`; the parent should refresh them.
- Listing reads all names of a directory into memory before sorting.
- Scope roots whose canonical path exceeds `MAXPATHLEN` (1024 bytes) cannot be opened.
- `calendar.updateEvent` cannot find a recurring-event occurrence that was moved more than a day
  away from its original date, because the lookup window is `occurrenceDate ± 1 day`.
- Each Calendar/Reminders request calls `EKEventStore.reset()` so cached objects are not stale. If
  access was granted outside Yo after the store was created, the store is recreated once.
- `calendar.events` and `reminders.list` load every match in the range or lists into memory before
  sorting and cutting to `limit`.
- Window control depends on the target app's Accessibility support: an app whose AX windows cannot
  be matched to a `windowId` can be listed and captured but not controlled (`not_frontmost`).
- An overlay at layer 20 or above (for example a notification banner) can still receive a click
  aimed at the window below; the cover check ignores those layers (see "Input methods").
- User input during the 0.2 s after one of the helper's own units is attributed to the helper.
- Clicking can open a denied app (for example from Finder or a browser); it then cannot be
  targeted and stops further input, but the helper cannot prevent the launch itself.
- `window.capture` needs Screen Recording; on recent macOS the system may periodically show its own
  screen-capture confirmation to the user.
- Notes: the body search uses Notes' own comparison over all notes and is then limited to the 2,000
  most recent; locked notes are only matched by title. Notes in "Recently Deleted" can appear.
  Folder lookup in `notes.create` covers top-level folders only.
- Mail: "newest 500" compares the first and last message's date received to decide which end of a
  mailbox is newest. A draft's returned id is not stable across Mail restarts.
