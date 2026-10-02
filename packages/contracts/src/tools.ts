/**
 * Yo's own tools, exposed to every provider through the `yo-mcp` stdio shim inside the computer.
 * The shim forwards calls to agentd, which relays them to yo-core as `tool.call` frames.
 */
import { z } from "zod";

export interface YoToolDef {
  name: string;
  description: string;
  /** JSON schema for MCP tools/list. */
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const YO_TOOLS: YoToolDef[] = [
  {
    name: "remember",
    description:
      "Save a durable fact about the user or their preferences to long-term memory (e.g. 'User prefers window seats'). Use when you learn something worth knowing next time.",
    inputSchema: obj(
      {
        fact: { type: "string", description: "The fact to remember, one sentence." },
        scope: {
          type: "string",
          enum: ["user", "agent"],
          description: "user = shared by all agents (default).",
        },
      },
      ["fact"],
    ),
  },
  {
    name: "recall",
    description: "Search long-term memory for facts relevant to a query.",
    inputSchema: obj({ query: { type: "string" } }, ["query"]),
  },
  {
    name: "forget",
    description: "Delete a memory by id (ids are returned by recall).",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "scratchpad_write",
    description:
      "Replace your working scratchpad (markdown). It persists across sessions and is shown to you at the start of every session. Keep open tasks and notes here.",
    inputSchema: obj({ content: { type: "string" } }, ["content"]),
  },
  {
    name: "ask_user",
    description:
      "Ask the user a question and wait for their answer. Use for decisions you cannot make yourself. Provide options when possible.",
    inputSchema: obj(
      {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" } },
      },
      ["question"],
    ),
  },
  {
    name: "request_approval",
    description:
      "REQUIRED before any consequential real-world action: purchases/payments, sending emails or messages, posting publicly, submitting forms with personal data, deleting the user's data, or entering credentials. Blocks until the user approves or denies.",
    inputSchema: obj(
      {
        action: { type: "string", description: "What you are about to do, concretely." },
        details: { type: "string", description: "Amounts, recipients, URLs, etc." },
        category: {
          type: "string",
          enum: ["purchase", "message", "post", "form", "delete", "credentials", "other"],
        },
      },
      ["action", "category"],
    ),
  },
  {
    name: "request_takeover",
    description:
      "Ask the user to take control of your computer screen (for logins, 2FA, CAPTCHAs, passwords, payment details). Blocks until they hand control back, then tells you what changed.",
    inputSchema: obj({ reason: { type: "string" } }, ["reason"]),
  },
  {
    name: "notify_user",
    description:
      "Send the user a short progress update or finished-result notification without stopping your work.",
    inputSchema: obj({ message: { type: "string" } }, ["message"]),
  },
  {
    name: "schedule_task",
    description:
      "Create a recurring or one-off routine for yourself. cron uses 5-field syntax in the user's timezone (e.g. '0 8 * * 1-5'). For one-off use runAt (ISO date).",
    inputSchema: obj(
      {
        name: { type: "string" },
        prompt: { type: "string", description: "What you should do when it fires." },
        cron: { type: "string" },
        runAt: { type: "string" },
      },
      ["name", "prompt"],
    ),
  },
  {
    name: "list_tasks",
    description: "List your scheduled routines.",
    inputSchema: obj({}),
  },
  {
    name: "cancel_task",
    description: "Cancel a scheduled routine by id.",
    inputSchema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "save_artifact",
    description:
      "Publish a file from your computer to the user's Artifacts shelf (reports, documents, images, spreadsheets). Path must exist on your computer.",
    inputSchema: obj({ path: { type: "string" }, title: { type: "string" } }, ["path"]),
  },
  {
    name: "report_bug",
    description:
      'Report a bug in Yo (its app, tools or your computer setup) to Yo\'s developer, in two stages. Investigate first: reproduce it, read the errors/logs you can reach, check the settings. Then call with stage "draft": the facts, plus your suspected cause and the fix you recommend. The user sees a red draft; nothing is sent. Ask them "Would you like me to report it?" and end your turn. Only after they say yes, call again with stage "submit" and the draft_id (Yo refuses a submit the user hasn\'t answered). Yo then files it on GitHub or saves it for them to file.',
    inputSchema: obj(
      {
        stage: {
          type: "string",
          enum: ["draft", "submit"],
          description: "draft = show the user (nothing is sent). submit = file it, after the user said yes.",
        },
        draft_id: { type: "string", description: "submit only: the id the draft returned." },
        title: {
          type: "string",
          description: "Short summary, e.g. 'Chat shows an old image after overwrite'.",
        },
        what_happened: { type: "string" },
        expected: { type: "string", description: "What should have happened." },
        steps: { type: "array", items: { type: "string" }, description: "How to reproduce, in order." },
        evidence: { type: "string", description: "Exact errors, log lines, values, file paths, times." },
        suspected_cause: { type: "string", description: "Your best explanation of why it happens." },
        suggested_fix: { type: "string", description: "The fix you recommend, in plain words." },
        area: {
          type: "string",
          description: "Part of Yo, e.g. 'chat', 'computer', 'mac access', 'settings'.",
        },
        severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
      },
      ["stage"],
    ),
  },
  {
    name: "mac_access",
    description:
      "Show which of the user's Macs are paired with Yo, whether each is online, and the folders/files the user has chosen to share (with read or read-and-change access). Your own computer is separate: use it for browsing, code and documents. Only use the user's Mac for data that lives there.",
    inputSchema: obj({}),
  },
  {
    name: "mac_list_files",
    description:
      "List a folder the user shared from their Mac. `folder` is the shared folder's name or id from mac_access; `path` is relative inside it ('' for the top).",
    inputSchema: obj(
      {
        folder: { type: "string" },
        path: { type: "string", description: "Relative path inside the shared folder." },
        cursor: { type: "string", description: "From a previous call's nextCursor." },
      },
      ["folder"],
    ),
  },
  {
    name: "mac_read_file",
    description:
      "Read a text file from a folder the user shared from their Mac (up to 256 KB is returned; larger or binary files: use mac_copy_to_computer). The content reaches you and your model provider.",
    inputSchema: obj({ folder: { type: "string" }, path: { type: "string" } }, ["folder", "path"]),
  },
  {
    name: "mac_copy_to_computer",
    description:
      "Copy a file (up to 20 MB, any type: spreadsheets, PDFs, images) from a folder the user shared on their Mac into your own computer, under ~/from-mac/, so you can process it there.",
    inputSchema: obj({ folder: { type: "string" }, path: { type: "string" } }, ["folder", "path"]),
  },
  {
    name: "mac_write_file",
    description:
      "Create or replace a file in a folder the user shared from their Mac with read-and-change access. The user sees the exact file and content and must approve it; this call waits for their decision. Give either `content` (text) or `fromComputerPath` (a file on your computer, e.g. a spreadsheet you made).",
    inputSchema: obj(
      {
        folder: { type: "string" },
        path: {
          type: "string",
          description: "Relative path inside the shared folder; parent folders must exist.",
        },
        content: { type: "string" },
        fromComputerPath: { type: "string" },
      },
      ["folder", "path"],
    ),
  },
  {
    name: "mac_contacts_search",
    description:
      "Look up people in the Contacts app on the user's Mac (name, company, phone numbers, emails), if the user shared Contacts with Yo. If several people match, ask the user which one before using a number or email.",
    inputSchema: obj({ query: { type: "string", description: "Name, phone number or email." } }, ["query"]),
  },
  {
    name: "mac_calendar_events",
    description:
      "List events from the Calendar app on the user's Mac between two times (ISO 8601 with offset). Each event names its calendar and account. If the user has several calendars (e.g. personal and work) and the request doesn't say which, ask or show them separately; never treat one calendar as 'their calendar' by guessing. Use mac_calendar_list to see calendars.",
    inputSchema: obj(
      {
        start: { type: "string", description: "ISO 8601, e.g. 2026-10-02T00:00:00-04:00" },
        end: { type: "string" },
        calendars: {
          type: "array",
          items: { type: "string" },
          description: "Calendar ids or names; omit for all shared.",
        },
      },
      ["start", "end"],
    ),
  },
  {
    name: "mac_calendar_list",
    description:
      "List the calendars in the Calendar app on the user's Mac (name, account, whether Yo may add events).",
    inputSchema: obj({}),
  },
  {
    name: "mac_calendar_create_event",
    description:
      "Add an event to a calendar in the user's Mac Calendar app. The user sees the exact event and must approve it; this waits for their decision. Doesn't invite anyone.",
    inputSchema: obj(
      {
        calendar: { type: "string", description: "Calendar id or exact name (ask the user if unsure)." },
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 with offset; for all-day use the date." },
        end: { type: "string" },
        all_day: { type: "boolean" },
        location: { type: "string" },
        notes: { type: "string" },
      },
      ["calendar", "title", "start", "end"],
    ),
  },
  {
    name: "mac_calendar_update_event",
    description:
      "Change one event (only that occurrence) in the user's Mac Calendar app: title, time, location or notes. Get the event id from mac_calendar_events. The user approves the exact change first.",
    inputSchema: obj(
      {
        event_id: { type: "string" },
        occurrence_start: {
          type: "string",
          description: "For repeating events: the start of the occurrence to change.",
        },
        title: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        location: { type: "string" },
        notes: { type: "string" },
      },
      ["event_id"],
    ),
  },
  {
    name: "mac_reminders",
    description:
      "List reminders from the Reminders app on the user's Mac (open ones by default), with their lists. Use list names/ids to narrow it.",
    inputSchema: obj({
      lists: { type: "array", items: { type: "string" } },
      include_completed: { type: "boolean" },
    }),
  },
  {
    name: "mac_reminders_create",
    description:
      "Add a reminder to a list in the user's Mac Reminders app (approved by the user first). A reminder mentioning a person doesn't need their contact details.",
    inputSchema: obj(
      {
        list: { type: "string", description: "List id or exact name (ask if unsure)." },
        title: { type: "string" },
        due: { type: "string", description: "ISO 8601; a plain date means all-day." },
        notes: { type: "string" },
      },
      ["list", "title"],
    ),
  },
  {
    name: "mac_reminders_complete",
    description:
      "Mark a reminder done (or not done) in the user's Mac Reminders app (approved by the user first).",
    inputSchema: obj({ reminder_id: { type: "string" }, completed: { type: "boolean" } }, ["reminder_id"]),
  },
  {
    name: "mac_notes_search",
    description: "Search the Notes app on the user's Mac (titles and text), if they shared Notes with Yo.",
    inputSchema: obj({ query: { type: "string" } }, ["query"]),
  },
  {
    name: "mac_notes_read",
    description: "Read one note from the user's Mac Notes app (id from mac_notes_search).",
    inputSchema: obj({ note_id: { type: "string" } }, ["note_id"]),
  },
  {
    name: "mac_notes_create",
    description: "Create a new note in the user's Mac Notes app. The user sees it and approves first.",
    inputSchema: obj({ title: { type: "string" }, body: { type: "string" }, folder: { type: "string" } }, [
      "title",
      "body",
    ]),
  },
  {
    name: "mac_mail_search",
    description:
      "Search recent messages in the Mail app on the user's Mac by subject or sender, if they shared Mail with Yo.",
    inputSchema: obj(
      { query: { type: "string" }, mailbox: { type: "string", enum: ["inbox", "sent", "drafts"] } },
      ["query"],
    ),
  },
  {
    name: "mac_mail_read",
    description: "Read one message from the user's Mac Mail app (id from mac_mail_search).",
    inputSchema: obj({ message_id: { type: "string" } }, ["message_id"]),
  },
  {
    name: "mac_mail_draft",
    description:
      "Prepare an email as a DRAFT in the user's Mac Mail app (approved by the user first). Yo never sends mail itself: the user reviews the draft in Mail and sends it.",
    inputSchema: obj(
      {
        to: { type: "array", items: { type: "string" } },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      ["to", "subject", "body"],
    ),
  },
  {
    name: "mac_windows",
    description:
      "List windows open on the user's Mac that you could ask to use (apps like terminals, password managers and System Settings are never available). Only for tasks no dedicated tool can do.",
    inputSchema: obj({}),
  },
  {
    name: "mac_window_session",
    description:
      "Ask the user to let you see (and optionally click and type in) ONE window on their Mac for a few minutes. Waits for their approval. They can stop it anytime. Don't use it to send, buy, post or delete: prepare things and let the user do the final click.",
    inputSchema: obj(
      {
        window_id: { type: "number", description: "From mac_windows." },
        purpose: { type: "string", description: "What you'll do, in one sentence the user will see." },
        minutes: { type: "number", description: "1–30, default 10." },
        control: { type: "boolean", description: "false = look only. Default true." },
      },
      ["window_id", "purpose"],
    ),
  },
  {
    name: "mac_window_look",
    description:
      "Take a screenshot of the window in your current session. It's saved on your computer; open the returned path to see it.",
    inputSchema: obj({}),
  },
  {
    name: "mac_window_click",
    description:
      "Click in the session window. x and y are fractions (0–1) of the screenshot's width and height, e.g. 0.5, 0.5 is the center.",
    inputSchema: obj(
      {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"] },
        double: { type: "boolean" },
      },
      ["x", "y"],
    ),
  },
  {
    name: "mac_window_type",
    description: "Type text into the focused field of the session window (≤500 characters).",
    inputSchema: obj({ text: { type: "string" } }, ["text"]),
  },
  {
    name: "mac_window_key",
    description:
      "Press one key in the session window: return, tab, escape, delete, space, arrows, pageup/pagedown, home/end, or a letter/digit, optionally with cmd/shift/option/control.",
    inputSchema: obj({ key: { type: "string" }, modifiers: { type: "array", items: { type: "string" } } }, [
      "key",
    ]),
  },
  {
    name: "mac_window_scroll",
    description: "Scroll the session window (pixels; positive dy scrolls down).",
    inputSchema: obj({ dy: { type: "number" }, dx: { type: "number" } }, ["dy"]),
  },
  {
    name: "mac_window_end",
    description: "End your window session as soon as you're done.",
    inputSchema: obj({}),
  },
];

/** Tools that reach the user's paired devices (routed and permission-checked by core). */
export const DEVICE_TOOLS = new Set([
  "mac_notes_search",
  "mac_notes_read",
  "mac_notes_create",
  "mac_mail_search",
  "mac_mail_read",
  "mac_mail_draft",
  "mac_windows",
  "mac_window_session",
  "mac_window_look",
  "mac_window_click",
  "mac_window_type",
  "mac_window_key",
  "mac_window_scroll",
  "mac_window_end",
  "mac_contacts_search",
  "mac_calendar_events",
  "mac_calendar_list",
  "mac_calendar_create_event",
  "mac_calendar_update_event",
  "mac_reminders",
  "mac_reminders_create",
  "mac_reminders_complete",
  "mac_access",
  "mac_list_files",
  "mac_read_file",
  "mac_copy_to_computer",
  "mac_write_file",
]);

/** report_bug arguments as core reads them. A call without `stage` (an older computer image) is a draft. */
export const ReportBugInput = z.object({
  stage: z.enum(["draft", "submit"]).optional(),
  draft_id: z.string().optional(),
  title: z.string().optional(),
  what_happened: z.string().optional(),
  expected: z.string().optional(),
  steps: z.array(z.coerce.string()).optional(),
  evidence: z.string().optional(),
  suspected_cause: z.string().optional(),
  suggested_fix: z.string().optional(),
  area: z.string().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).optional(),
});
export type ReportBugInput = z.infer<typeof ReportBugInput>;

export const YoToolName = z.enum(YO_TOOLS.map((t) => t.name) as [string, ...string[]]);

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model. */
  text: string;
}
