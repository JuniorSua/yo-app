import crypto from "node:crypto";
import { type HelperApi, HelperError } from "../../desktop/src/device/DeviceAgent";

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/**
 * In-memory stand-in for the native YoDeviceBridge helper (the real one is tested with `swift test`).
 * One bookmark = one folder; files are keyed by relative path. Mirrors the helper's error codes.
 */
export class FakeHelper implements HelperApi {
  folders = new Map<string, Map<string, Buffer>>();
  calls: { method: string; params: Record<string, unknown> }[] = [];
  /** Delay for files.write (lets tests drop the connection mid-write). */
  writeDelayMs = 0;

  folder(bookmark: string, files: Record<string, string>) {
    this.folders.set(bookmark, new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));
  }

  /* In-memory Mac apps for R2 tests. */
  calendarAccess = "granted";
  calendars = [
    { id: "cal-home", title: "Home", account: "iCloud", sourceType: "calDAV", writable: true },
    { id: "cal-work", title: "Work", account: "Google", sourceType: "calDAV", writable: true },
    { id: "cal-hol", title: "Holidays", account: "Subscribed", sourceType: "subscribed", writable: false },
  ];
  events: {
    id: string;
    calendarId: string;
    title: string;
    start: number;
    end: number;
    allDay: boolean;
    location: string | null;
    lastModified: number;
  }[] = [];
  contacts = [
    {
      id: "c1",
      name: "Alex Rivera",
      organization: null,
      phones: [{ label: "mobile", value: "+1 305 555 0101" }],
      emails: [],
    },
    {
      id: "c2",
      name: "Alex Chen",
      organization: "Polestar",
      phones: [{ label: "work", value: "+1 305 555 0199" }],
      emails: [],
    },
  ];
  reminderLists = [{ id: "rl-1", title: "Reminders", account: "iCloud", writable: true }];
  reminders: {
    id: string;
    listId: string;
    title: string;
    due: number | null;
    dueAllDay: boolean;
    completed: boolean;
  }[] = [];
  private seq = 0;

  notes = [
    { id: "n1", name: "Jupiter desk notes", folder: "Notes", modified: 1, text: "Dealer discount 23,000" },
  ];
  drafts: { to: string[]; subject: string; body: string }[] = [];
  windows = [
    {
      windowId: 101,
      pid: 10,
      bundleId: "com.google.Chrome",
      appName: "Chrome",
      title: "CDK Desking",
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      onScreen: true,
    },
  ];
  inputs: { method: string; params: Record<string, any> }[] = [];

  private app(method: string, p: Record<string, any>): any {
    switch (method) {
      case "notes.search":
        return {
          notes: this.notes.filter((n) => n.name.toLowerCase().includes(String(p.query).toLowerCase())),
        };
      case "notes.read": {
        const n = this.notes.find((x) => x.id === p.id);
        if (!n) throw new HelperError("not_found", "note");
        return { ...n, truncated: false };
      }
      case "notes.create": {
        const n = {
          id: `n${++this.seq}`,
          name: p.title,
          folder: p.folder ?? "Notes",
          modified: 2,
          text: p.body,
        };
        this.notes.push(n);
        return { id: n.id };
      }
      case "mail.search":
        return { messages: [] };
      case "mail.createDraft":
        this.drafts.push({ to: p.to, subject: p.subject, body: p.body });
        return { id: `d${++this.seq}` };
      case "windows.list":
        return { windows: this.windows };
      case "window.capture":
        if (!this.windows.some((w) => w.windowId === p.windowId))
          throw new HelperError("not_found", "window");
        return {
          pngBase64: Buffer.from("PNG").toString("base64"),
          width: 800,
          height: 600,
          scale: 1,
          bounds: this.windows[0]!.bounds,
          title: "CDK Desking",
        };
      case "window.click":
      case "window.type":
      case "window.key":
      case "window.scroll":
        this.inputs.push({ method, params: p });
        return { ok: true, bounds: this.windows[0]!.bounds };
    }
    if (method.startsWith("calendar.") && this.calendarAccess !== "granted")
      throw new HelperError("permission", `calendars: ${this.calendarAccess}`);
    switch (method) {
      case "permissions.request":
        return { status: p.kind === "calendars" ? this.calendarAccess : "granted" };
      case "contacts.search":
        return {
          contacts: this.contacts
            .filter((c) => c.name.toLowerCase().includes(String(p.query).toLowerCase()))
            .slice(0, p.limit),
        };
      case "calendar.calendars":
        return { calendars: this.calendars };
      case "calendar.events": {
        const list = this.events
          .filter(
            (e) =>
              e.end > p.start && e.start < p.end && (!p.calendarIds || p.calendarIds.includes(e.calendarId)),
          )
          .sort((a, b) => a.start - b.start)
          .map((e) => ({ ...e, url: null, recurring: false, occurrenceDate: e.start }));
        return { events: list.slice(0, p.limit), truncated: list.length > p.limit };
      }
      case "calendar.createEvent": {
        const cal = this.calendars.find((c) => c.id === p.calendarId);
        if (!cal) throw new HelperError("not_found", "calendar");
        if (!cal.writable) throw new HelperError("read_only", "calendar");
        const e = {
          id: `ev${++this.seq}`,
          calendarId: p.calendarId,
          title: p.title,
          start: p.start,
          end: p.end,
          allDay: p.allDay,
          location: p.location,
          lastModified: 1000 + this.seq,
        };
        this.events.push(e);
        return { id: e.id, lastModified: e.lastModified };
      }
      case "calendar.updateEvent": {
        const e = this.events.find((x) => x.id === p.id);
        if (!e) throw new HelperError("not_found", "event");
        if (p.expectedLastModified != null && p.expectedLastModified !== e.lastModified)
          throw new HelperError("conflict", "changed");
        Object.assign(e, p.changes, { lastModified: e.lastModified + 1 });
        return { id: e.id, lastModified: e.lastModified };
      }
      case "reminders.lists":
        return { lists: this.reminderLists };
      case "reminders.list": {
        const list = this.reminders.filter(
          (r) => (p.includeCompleted || !r.completed) && (!p.listIds || p.listIds.includes(r.listId)),
        );
        return { reminders: list.map((r) => ({ ...r, completedAt: null, priority: 0 })), truncated: false };
      }
      case "reminders.create": {
        const r = {
          id: `rm${++this.seq}`,
          listId: p.listId,
          title: p.title,
          due: p.due,
          dueAllDay: p.dueAllDay,
          completed: false,
        };
        this.reminders.push(r);
        return { id: r.id };
      }
      case "reminders.complete": {
        const r = this.reminders.find((x) => x.id === p.id);
        if (!r) throw new HelperError("not_found", "reminder");
        r.completed = p.completed;
        return { id: r.id, completed: r.completed };
      }
    }
    return undefined;
  }

  async call(method: string, params: Record<string, any>): Promise<any> {
    this.calls.push({ method, params });
    if (/^(contacts|calendar|reminders|notes|mail|windows?)\.|^permissions\.request$/.test(method)) {
      const r = this.app(method, params);
      if (r !== undefined) return r;
    }
    const files = this.folders.get(params.bookmark);
    if (method === "permissions.status") return { contacts: "not-requested" };
    if (method === "scope.resolve")
      return { canonicalPath: "/x", kind: "dir", displayPath: "~/x", stale: false };
    if (!files) throw new HelperError("stale_scope", "unknown bookmark");
    const rel = String(params.relPath ?? "");
    if (rel.split("/").some((c) => c === ".." || c === "."))
      throw new HelperError("invalid_path", "bad path");
    if (/(^|\/)\.ssh(\/|$)/.test(rel)) throw new HelperError("protected", "protected");
    switch (method) {
      case "files.list":
        return {
          entries: [...files.keys()]
            .sort()
            .map((name) => ({ name, kind: "file", size: files.get(name)!.length, mtimeMs: 1 })),
          nextCursor: null,
        };
      case "files.stat": {
        const f = files.get(rel);
        if (!f) throw new HelperError("not_found", "missing");
        return { kind: "file", size: f.length, mtimeMs: 1, sha256: sha(f), nlink: 1 };
      }
      case "files.read": {
        const f = files.get(rel);
        if (!f) throw new HelperError("not_found", "missing");
        const out = f.subarray(0, params.maxBytes);
        return {
          dataBase64: out.toString("base64"),
          size: f.length,
          sha256: sha(f),
          truncated: out.length < f.length,
          mtimeMs: 1,
        };
      }
      case "files.write": {
        if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
        const cur = files.get(rel);
        if (params.expectedSha256 === null && cur) throw new HelperError("exists", "exists");
        if (params.expectedSha256 !== null && (!cur || sha(cur) !== params.expectedSha256))
          throw new HelperError("conflict", "changed");
        const data = Buffer.from(params.dataBase64, "base64");
        files.set(rel, data);
        return { sha256: sha(data), size: data.length };
      }
      default:
        throw new HelperError("unsupported", method);
    }
  }
}
