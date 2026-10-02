"""Smoke test for the built YoDeviceBridge binary: hello, status, scope, write, read, list,
read-only Contacts/Calendar/Reminders calls (expect `permission` errors without OS access),
windows.list (non-prompting), and window/Notes/Mail refusal paths that cannot post input or send
an Apple Event.

Usage: smoke.py [--request-permissions] [--capture] [--automation] [path/to/YoDeviceBridge]
       (the binary defaults to ../../bin/YoDeviceBridge)
The temp folder is created under the real home directory because scopes outside it are protected.
Opt-in flags (never run automatically):
  --request-permissions  calls permissions.request, which CAN SHOW REAL macOS PRIVACY PROMPTS.
  --capture              captures the front-most listed window with ScreenCaptureKit (only if Screen
                         Recording is already granted); macOS may show its screen-capture alert.
  --automation           runs notes.search on a harmless query; the first run SHOWS macOS's
                         "control Notes" Automation prompt.
Personal data (contacts, events, windows, notes) is printed as counts only. This script never sends
input events: every window input call below is built to be refused before anything is posted.
"""
import base64, json, os, secrets, shutil, struct, subprocess, sys, tempfile, time

here = os.path.dirname(os.path.abspath(__file__))
flags = {"--request-permissions", "--capture", "--automation"}
args = [a for a in sys.argv[1:] if a not in flags]
request_permissions = "--request-permissions" in sys.argv[1:]
capture = "--capture" in sys.argv[1:]
automation = "--automation" in sys.argv[1:]
binary = args[0] if args else os.path.join(here, "..", "..", "bin", "YoDeviceBridge")
DENIED_HINTS = ("terminal", "iterm", "t3code", "t3tools", "dev.yo.app", "1password", "xcode", "vscode")


def send(proc, message):
    body = json.dumps(message).encode()
    proc.stdin.write(struct.pack(">I", len(body)) + body)
    proc.stdin.flush()
    header = proc.stdout.read(4)
    if len(header) < 4:
        raise SystemExit(f"helper exited (code {proc.wait()})")
    (length,) = struct.unpack(">I", header)
    return json.loads(proc.stdout.read(length))


def show(label, response):
    print(f"{label}: {json.dumps(response, sort_keys=True)}")
    return response


def summarize(label, response, key):
    """Prints an error as-is, but only the number of returned items for a success."""
    if response.get("ok"):
        items = response["result"][key]
        extra = f", truncated={response['result']['truncated']}" if "truncated" in response["result"] else ""
        print(f"{label}: ok, {len(items)} {key}{extra}")
    else:
        print(f"{label}: {json.dumps(response, sort_keys=True)}")
    return response


scratch = tempfile.mkdtemp(prefix="yo-bridge-smoke-", dir=os.path.expanduser("~"))
proc = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env={})
try:
    show("hello", send(proc, {"type": "hello", "nonce": secrets.token_hex(16), "protocol": 1}))
    show("status", send(proc, {"id": "1", "method": "status", "params": {}}))
    show("permissions.status", send(proc, {"id": "2", "method": "permissions.status", "params": {}}))
    scope = show("scope.create", send(proc, {"id": "3", "method": "scope.create", "params": {"path": scratch}}))
    bookmark = scope["result"]["bookmark"]
    data = base64.b64encode(b"hello from smoke.py\n").decode()
    show("files.write", send(proc, {"id": "4", "method": "files.write", "params": {
        "bookmark": bookmark, "relPath": "hello.txt", "dataBase64": data, "expectedSha256": None}}))
    read = show("files.read", send(proc, {"id": "5", "method": "files.read", "params": {
        "bookmark": bookmark, "relPath": "hello.txt", "maxBytes": 1024}}))
    print("decoded:", base64.b64decode(read["result"]["dataBase64"]))
    show("files.list", send(proc, {"id": "6", "method": "files.list", "params": {"bookmark": bookmark, "relPath": ""}}))
    show("traversal", send(proc, {"id": "7", "method": "files.read", "params": {
        "bookmark": bookmark, "relPath": "../.ssh/id_rsa", "maxBytes": 10}}))
    show("protected scope", send(proc, {"id": "8", "method": "scope.create", "params": {"path": os.path.expanduser("~/Library")}}))
    now_ms = int(time.time() * 1000)
    for i, (method, params, key) in enumerate([
        ("calendar.calendars", {}, "calendars"),
        ("calendar.events", {"start": now_ms, "end": now_ms + 7 * 86_400_000, "limit": 50}, "events"),
        ("contacts.search", {"query": "a", "limit": 5}, "contacts"),
        ("reminders.lists", {}, "lists"),
        ("reminders.list", {"includeCompleted": False, "limit": 20}, "reminders"),
    ]):
        started = time.monotonic()
        summarize(method, send(proc, {"id": f"p{i}", "method": method, "params": params}), key)
        print(f"  ({time.monotonic() - started:.2f}s)")
    show("bad range", send(proc, {"id": "p9", "method": "calendar.events", "params": {"start": now_ms, "end": now_ms}}))
    show("unknown param", send(proc, {"id": "p10", "method": "contacts.search", "params": {"query": "a", "notes": True}}))

    # Windows: listing is non-prompting (CGWindowList). Only counts are printed.
    listed = send(proc, {"id": "w1", "method": "windows.list", "params": {}})
    windows = listed["result"]["windows"] if listed.get("ok") else []
    if listed.get("ok"):
        leaked = [w["bundleId"] for w in windows if any(h in w["bundleId"].lower() for h in DENIED_HINTS)]
        print(f"windows.list: ok, {len(windows)} windows, denied apps listed: {len(leaked)}")
    else:
        show("windows.list", listed)
    # Refusals decided before any OS input call: nothing can be posted.
    show("window.click bad x", send(proc, {"id": "w2", "method": "window.click", "params": {
        "windowId": 1, "x": 2, "y": 0.5}}))
    show("window.key cmd+q", send(proc, {"id": "w3", "method": "window.key", "params": {
        "windowId": 1, "key": "q", "modifiers": ["cmd"]}}))
    show("window.key ctrl+opt+cmd", send(proc, {"id": "w4", "method": "window.key", "params": {
        "windowId": 1, "key": "a", "modifiers": ["control", "option", "cmd"]}}))
    # A window id that is never on screen: refused with permission (no Accessibility) or not_found.
    show("window.click missing window", send(proc, {"id": "w5", "method": "window.click", "params": {
        "windowId": 4294967295, "x": 0.5, "y": 0.5}}))
    show("window.type unknown param", send(proc, {"id": "w6", "method": "window.type", "params": {
        "windowId": 4294967295, "text": "x", "delay": 1}}))
    if capture and windows:
        started = time.monotonic()
        shot = send(proc, {"id": "w7", "method": "window.capture", "params": {
            "windowId": windows[0]["windowId"], "maxWidth": 640}})
        if shot.get("ok"):
            r = shot["result"]
            print(f"window.capture: ok, {r['width']}x{r['height']} px, scale {r['scale']:.3f}, "
                  f"{len(base64.b64decode(r['pngBase64']))} PNG bytes ({time.monotonic() - started:.2f}s)")
        else:
            show("window.capture", shot)
    else:
        print("window.capture: skipped (pass --capture; macOS may show its screen-capture alert)")

    # Notes and Mail: validation and unsupported methods never reach Apple Events.
    show("notes.search empty query", send(proc, {"id": "n1", "method": "notes.search", "params": {"query": " "}}))
    show("mail.send", send(proc, {"id": "n2", "method": "mail.send", "params": {"id": "x"}}))
    show("mail.createDraft bad address", send(proc, {"id": "n3", "method": "mail.createDraft", "params": {
        "to": ["a@b.example, c@d.example"], "subject": "x", "body": "y"}}))
    if automation:
        started = time.monotonic()
        summarize("notes.search (automation)", send(proc, {"id": "n4", "method": "notes.search", "params": {
            "query": "yo-bridge-smoke-harmless-query", "limit": 1}}), "notes")
        print(f"  ({time.monotonic() - started:.2f}s)")
    else:
        print("notes.search: skipped (pass --automation; the first run shows the Automation prompt)")

    if request_permissions:
        for kind in ("contacts", "calendars", "reminders", "accessibility", "screenRecording"):
            started = time.monotonic()
            show(f"permissions.request {kind}", send(proc, {"id": f"q-{kind}", "method": "permissions.request",
                                                           "params": {"kind": kind}}))
            print(f"  ({time.monotonic() - started:.2f}s)")
    else:
        print("permissions.request: skipped (pass --request-permissions; may show real OS prompts)")
    proc.stdin.close()
    print("exit code after EOF:", proc.wait(timeout=5))
finally:
    if proc.poll() is None:
        proc.kill()
    shutil.rmtree(scratch, ignore_errors=True)
