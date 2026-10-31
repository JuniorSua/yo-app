/**
 * Yo's own tools, exposed to every provider through the `yo-mcp` stdio shim inside the computer.
 * The shim forwards calls to agentd, which relays them to yo-core as `tool.call` frames.
 */
import { z } from "zod";

/**
 * Which tool set a session gets (session.start `toolset`, passed to yo-mcp as YO_TOOLSET):
 *  - "primary": the main agent (Yo), the front door. Routes work to teammates, adds them, and starts helpers.
 *  - "agent": any other long-lived agent (a teammate).
 *  - "helper": a one-off helper (start_helper). No team, routine, scratchpad, ledger or helper tools.
 */
export const YO_TOOLSETS = ["primary", "agent", "helper"] as const;
export type YoToolset = (typeof YO_TOOLSETS)[number];

export interface YoToolDef {
  name: string;
  description: string;
  /** JSON schema for MCP tools/list. */
  inputSchema: Record<string, unknown>;
  /** The tool sets that offer this tool. Absent: every one. */
  audience?: readonly YoToolset[];
}

/** Not offered to helpers: they do one job and report back. */
const NOT_HELPERS = ["primary", "agent"] as const;

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
        // --- life map (consolidate PR): which area of the user's life this belongs to ---
        area: {
          type: "string",
          description:
            "The area of the user's life this belongs to, one or two words (e.g. work, personal, yo-project). Tag facts about their goals, people, sites, routines and tasks so they show up in the life map.",
        },
        // --- end life map ---
        space: {
          type: "string",
          enum: ["work", "personal", "everywhere"],
          description:
            "Which space's agents see this fact (default: your own space). Use everywhere for core facts about the user: their name, family, home, health, and how they like to be talked to. Use work or personal when it clearly belongs to that side of their life.",
        },
      },
      ["fact"],
    ),
  },
  {
    name: "recall",
    description:
      "Search long-term memory for facts relevant to a query. Searches every space (Work, Personal and Everywhere), not just the facts you were shown.",
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
      "Replace your working scratchpad (markdown). It persists across sessions and is shown to you at the start of every session. Keep working notes here (open tasks belong in the task ledger: task_add).",
    inputSchema: obj({ content: { type: "string" } }, ["content"]),
    audience: NOT_HELPERS,
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
        details: {
          type: "string",
          description:
            "Amounts, recipients, URLs, etc. For a message or post: the full text you'll send, exactly as it will go out (ask again with the new text after any edit).",
        },
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
    name: "request_secure_input",
    description:
      "Use this whenever a site needs a code, password or other private value from the user (an SMS or email code, a password, a PIN), instead of asking in chat. First open the page with the field in your browser. The user gets a secure form in the chat; what they type goes straight into the page on that site and is submitted. You never see the values, and they're never saved. Afterwards take a snapshot to see the result. Sign-ins in several steps: call it again on each step.",
    inputSchema: obj(
      {
        site: {
          type: "string",
          description:
            "One specific website the values are for, e.g. 'uber.com'. Not a shared ending like 'github.io' or 'vercel.app'. The open page must be on that site.",
        },
        reason: {
          type: "string",
          description: "One short sentence the user sees, e.g. 'Uber texted a code to sign you in.'",
        },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          description:
            "What to ask for, in the order the page shows it: at most one name field (username, email, phone or text), one password and one one_time_code.",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["one_time_code", "password", "username", "email", "phone", "text"],
              },
              label: {
                type: "string",
                description: "What the user sees, e.g. 'Code from the text message'.",
              },
            },
            required: ["kind", "label"],
            additionalProperties: false,
          },
        },
      },
      ["site", "reason", "fields"],
    ),
  },
  {
    name: "onepassword_search",
    description:
      "Find logins in the user's 1Password (only the vaults they shared with Yo) by website or name, e.g. 'github.com' or 'GitHub'. Returns each login's name, websites and an item_ref for onepassword_fill. Never returns usernames, passwords or codes. Empty query: list them all.",
    inputSchema: obj(
      {
        query: { type: "string", description: "A website, domain or login name." },
        limit: { type: "number", description: "Most results to return (default 10, max 20)." },
      },
      ["query"],
    ),
  },
  {
    name: "onepassword_fill",
    description:
      "Sign in with a login from the user's 1Password. First open the site's sign-in page in your browser and do anything else the form needs (accept cookies, tick a box). Yo checks the page's address matches the login's website, asks the user (once per site unless they always allow it), types what the page shows (username, password or one-time code) and submits. You never see the values: take a snapshot afterwards to see the result. Sign-ins in several steps: call it again on each step.",
    inputSchema: obj(
      {
        item_ref: { type: "string", description: "From onepassword_search, e.g. '1p:abc123/def456'." },
        fields: {
          type: "array",
          items: { type: "string", enum: ["username", "password", "one_time_code"] },
          description: "Only these fields. Default: whichever the page shows.",
        },
      },
      ["item_ref"],
    ),
  },
  {
    name: "message_agent",
    description:
      "Hand work to a teammate (another of the user's Yo agents, listed under Your team), ask them something, or share an update. It returns at once (\"Sent to Dew\"): carry on with your own work. The teammate wakes, works on it in their own chat, and their reply (their final message) comes back to you later as a new message, so ask for everything you need in one go. Set wait=true only when you can't finish without their answer: then this waits for the reply and returns it.",
    inputSchema: obj(
      {
        to: { type: "string", description: "The teammate's name, e.g. 'Dew'." },
        message: {
          type: "string",
          description: "What you want to say, self-contained: they can't see your chat with the user.",
        },
        wait: {
          type: "boolean",
          description:
            "Wait for their reply and return it (default false: the reply comes later as a message).",
        },
      },
      ["to", "message"],
    ),
    audience: NOT_HELPERS,
  },
  {
    name: "create_agent",
    description:
      "Add a teammate to the user's team: a long-lived agent with one job, its own memory, screen and chat (for example when the user asks you to hire or set one up). The user sees a card and must approve it; this waits for their decision. Once added, the teammate introduces itself to the user and asks one question about its job; hand it work with message_agent.",
    inputSchema: obj(
      {
        name: { type: "string", description: "Short first name, e.g. 'Dew'." },
        role: { type: "string", description: "Their job in a few words, e.g. 'Research'." },
        instructions: {
          type: "string",
          description: "Standing instructions they'll always follow (what they own, how to work).",
        },
      },
      ["name", "role"],
    ),
    // Not for helpers. Always behind the user's approval card.
    audience: NOT_HELPERS,
  },
  {
    name: "create_phone_link",
    description:
      "Make a Yo Phone link: the user's own Yo in their pocket, a web app on their phone that talks to you as them. Use when the user asks you to set up Yo Phone on their phone. The user sees a card and must approve it; this waits for their decision. A new link turns off the old one. You never see the link: the user finds it in Settings → Phone. It's personal (whoever has it acts as the user), so never offer to make one for someone else.",
    inputSchema: obj({
      label: { type: "string", description: "Optional: which phone, e.g. 'my iPhone'." },
    }),
    // Only the main agent, and core also refuses it to anyone else (see Orchestrator.phoneTool).
    audience: ["primary"],
  },
  {
    name: "turn_off_phone",
    description:
      "Turn off Yo Phone: the current phone link stops working and that phone can't text you anymore. The user approves it first.",
    inputSchema: obj({}),
    audience: ["primary"],
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
    audience: NOT_HELPERS,
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
    audience: NOT_HELPERS,
  },
  {
    name: "start_helper",
    description:
      "Start a one-off helper: a fresh assistant with its own screen and browser (same logins) that does ONE self-contained job in parallel with you and reports back. Returns at once with its id. Its final report comes to you as a message when it finishes (or use check_helpers). At most 2 at a time. Use it when the user asks for several things at once, or for long browsing you want to keep out of your own context; do quick things yourself.",
    inputSchema: obj(
      {
        brief: {
          type: "string",
          description:
            "Everything the helper needs, self-contained (it can't see your chat): the goal, sites, exact details, what 'done' means and what to report back.",
        },
        title: {
          type: "string",
          description: "A short label the user sees on its card, e.g. 'Quote for VIN ...3924'.",
        },
        playbook: {
          type: "string",
          description: "Optional playbook it must follow, e.g. 'work/desk-quote.md' (see playbook_list).",
        },
        task_id: { type: "string", description: "Optional: the ledger task it works on (task_list)." },
      },
      ["brief"],
    ),
    audience: ["primary"],
  },
  {
    name: "check_helpers",
    description:
      "See how your helpers are doing: each one's title, state, time so far, last step, and whether it's waiting for a screen or for the user. Reports of helpers that finished are returned here (and then not sent to you again). With wait_seconds (max 600) it waits until one finishes and returns its report, so you can write one combined answer.",
    inputSchema: obj({
      wait_seconds: { type: "number", description: "Wait up to this long for a helper to finish (max 600)." },
    }),
    audience: ["primary"],
  },
  {
    name: "stop_helper",
    description:
      "Stop one of your helpers. A helper can't be messaged while it works: to correct one, stop it and start a new one with a better brief.",
    inputSchema: obj({ id: { type: "string", description: "The helper's id from start_helper." } }, ["id"]),
    audience: ["primary"],
  },
  {
    name: "task_add",
    description:
      "Add a task to your task ledger: what you still owe the user. It's kept outside the conversation, so it survives compaction and is shown to you on every new session.",
    inputSchema: obj(
      {
        title: { type: "string", description: "What needs doing, one line." },
        note: { type: "string", description: "Details, links, where you left off." },
        status: { type: "string", enum: ["open", "in_progress", "waiting"] },
      },
      ["title"],
    ),
    audience: NOT_HELPERS,
  },
  {
    name: "task_update",
    description:
      "Update a ledger task: its status (open, in_progress, waiting, review, done, cancelled) and/or its note. When you finish work the user should look at, set review (Ready for review) with a one-line note on what's ready; the user checks it off. Mark tasks done as soon as they are.",
    inputSchema: obj(
      {
        id: { type: "string" },
        status: {
          type: "string",
          enum: ["open", "in_progress", "waiting", "review", "done", "cancelled", "interrupted"],
        },
        note: { type: "string" },
      },
      ["id"],
    ),
    audience: NOT_HELPERS,
  },
  {
    name: "task_list",
    description: "List your ledger tasks (open ones; include_done for finished ones too).",
    inputSchema: obj({ include_done: { type: "boolean" } }),
    audience: NOT_HELPERS,
  },
  {
    name: "playbook_list",
    description:
      "List the playbooks in ~/Shared/playbooks (how to do each recurring job), with how their recent runs went: time taken, outcome and the user's corrections.",
    inputSchema: obj({}),
  },
  {
    name: "playbook_record_run",
    description:
      "Record how a run of a playbook went. Yo already logs each helper run; use this to add the user's corrections to it, or to log a run you did yourself.",
    inputSchema: obj(
      {
        playbook: { type: "string", description: "e.g. 'work/desk-quote.md'." },
        outcome: { type: "string", enum: ["success", "partial", "failed"] },
        helper_id: { type: "string", description: "The helper that ran it, if any (updates its run)." },
        minutes: { type: "number" },
        corrections: { type: "number", description: "How many times the user corrected the result." },
        note: { type: "string" },
      },
      ["playbook"],
    ),
    audience: NOT_HELPERS,
  },
  {
    name: "save_artifact",
    description:
      "Publish a file from your computer to the user's Artifacts shelf (reports, documents, images, spreadsheets). Path must exist on your computer.",
    inputSchema: obj({ path: { type: "string" }, title: { type: "string" } }, ["path"]),
  },
  {
    name: "create_page",
    description:
      "Make a Page: one self-contained HTML page that shows the user something visually (a chart of trends, a dashboard, a timeline, a comparison, a short visual explainer). It opens in Yo's page viewer and is kept in the user's files. Use it when a picture explains better than text, or when asked to visualize, chart or lay something out. Put everything in the one file: inline <style> and <script>, data inline as JSON, charts as inline SVG or <canvas>. Scripts and stylesheets may load only from https://cdn.jsdelivr.net (e.g. Chart.js, D3); the page can't fetch anything else, open other pages or reach Yo. Give either html, or path to an .html file on your computer. Then tell the user in one line what the page shows.",
    inputSchema: obj(
      {
        title: { type: "string", description: "Short title, e.g. 'Posting activity by hour'." },
        kind: {
          type: "string",
          enum: ["page", "dashboard", "slides", "doc", "design"],
          description:
            "What it is (default page): dashboard = numbers and charts at a glance; slides = a deck, one idea per screen; doc = a written document; design = a design or mockup; page = anything else.",
        },
        html: { type: "string", description: "The full HTML document (preferred)." },
        path: { type: "string", description: "Or: an .html file on your computer." },
      },
      ["title"],
    ),
  },
  {
    name: "suggest_task",
    description:
      "Offer to take something on that the user didn't ask for: a concrete next step you noticed (a reply to draft, a renewal to check, a price to watch). It shows under Up next on the Tasks page and above the message box with Start and Hide; nothing happens until the user taps Start, which sends you the title as their message and keeps `prompt` (your plan) on the task as your note. One clear, useful suggestion beats several. Don't suggest something the user already asked for, already hid, or that's already on the list (task_list include_done).",
    inputSchema: obj(
      {
        title: {
          type: "string",
          description: "What you'd do, one short line: 'Draft a reply to Ana about Friday'.",
        },
        why: { type: "string", description: "One line on why it's worth doing now." },
        prompt: {
          type: "string",
          description:
            "Your plan, kept on the task as your note: what you'll do once the user taps Start (Start sends them the title, not this). 'Draft a two-line reply to Ana confirming Friday.'",
        },
      },
      ["title", "why", "prompt"],
    ),
    audience: ["primary"],
  },
  {
    name: "post_brief",
    description:
      "Post the morning brief card: what needs the user today (each with Start, which sends you \"Take care of: <title>\" as their message), what can wait, today's calendar, and what you couldn't check (e.g. mail not connected). Gather first (mail, calendar, your task ledger, recent chat), then call it once. Keep rows short: a title and at most one sentence of detail. After it, write at most one sentence. Use it when asked for a brief or a morning summary, and when Yo asks you for the daily brief.",
    inputSchema: obj(
      {
        needs_you: {
          type: "array",
          description: "What needs the user, most urgent first (max 5).",
          items: obj(
            {
              title: { type: "string" },
              detail: { type: "string" },
              start: {
                type: "string",
                description:
                  "Your own note on how you'd take care of it, for when the user taps Start (Start sends you \"Take care of: <title>\", not this): 'Draft a reply to Ana confirming Friday's ship date'.",
              },
            },
            ["title"],
          ),
        },
        can_wait: {
          type: "array",
          description: "What can wait (max 5), e.g. '3 newsletters'.",
          items: obj({ title: { type: "string" }, detail: { type: "string" } }, ["title"]),
        },
        today: {
          type: "array",
          description: "Today's calendar in time order.",
          items: obj({ time: { type: "string" }, title: { type: "string" }, detail: { type: "string" } }, [
            "title",
          ]),
        },
        could_not_check: {
          type: "array",
          items: obj({ source: { type: "string" }, why: { type: "string" } }, ["source", "why"]),
        },
      },
      [],
    ),
    audience: ["primary"],
  },
  {
    name: "suggest_replies",
    description:
      "Show 2 or 3 short replies the user can tap under your message (each at most 24 characters, e.g. 'Yes, book it', 'Show cheaper ones'). A tap sends that text as their message. Use it when you ask the user to choose and the likely answers are obvious; then ask your question in one short sentence without listing the replies. Never use it to confirm sending, paying, signing or deleting (those go through approval), and at most once per turn.",
    inputSchema: obj(
      {
        replies: {
          type: "array",
          items: { type: "string" },
          description: "2 or 3 replies, 24 characters max each.",
        },
      },
      ["replies"],
    ),
    audience: NOT_HELPERS,
  },
  {
    name: "report_bug",
    description:
      'Report a bug in Yo (its app, tools or your computer setup) to Yo\'s developer, in two stages. Investigate first: reproduce it, read the errors/logs you can reach, check the settings. Then call with stage "draft": the facts, plus your suspected cause and the fix you recommend. The user sees a red draft; nothing is sent. Ask them "Would you like me to report it?" and end your turn. Only after they say yes, call again with stage "submit" and the draft_id (Yo refuses a submit the user hasn\'t answered). Yo then sends it to the developer (or keeps it and retries if that fails). The user can also send the draft themselves with the card\'s Report it button; a submit after that says it was already sent.',
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
      "Show which of the user's Macs are paired with Yo, whether each is online, and the folders/files the user has chosen to share (with read or read-and-change access). Your computer (a private workspace on their Mac or PC) is separate from it: use it for browsing, code and documents. Only use the user's Mac for data that lives there.",
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
      "Copy a file (up to 20 MB, any type: spreadsheets, PDFs, images) from a folder the user shared on their Mac onto your computer, under ~/from-mac/, so you can process it there.",
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

/** The tools a tool set offers (no or an unknown tool set gets every tool, like an older core). */
export function toolsFor(toolset?: string | null): YoToolDef[] {
  const set = YO_TOOLSETS.find((t) => t === toolset);
  return set ? YO_TOOLS.filter((t) => !t.audience || t.audience.includes(set)) : YO_TOOLS;
}

/** Whether a tool set may call a tool. */
export function toolAllowed(toolset: YoToolset, tool: string): boolean {
  const def = YO_TOOLS.find((t) => t.name === tool);
  return !def?.audience || def.audience.includes(toolset);
}

/** start_helper arguments as core reads them. */
export const StartHelperInput = z.object({
  brief: z.string().trim().min(1, "brief is required").max(20_000, "brief: at most 20000 characters"),
  title: z.string().trim().max(80).optional(),
  playbook: z.string().trim().max(200).optional(),
  task_id: z.string().trim().optional(),
});
export type StartHelperInput = z.infer<typeof StartHelperInput>;

export const CheckHelpersInput = z.object({ wait_seconds: z.coerce.number().min(0).optional() });
export const StopHelperInput = z.object({ id: z.string().trim().min(1, "id is required") });

export const TaskAddInput = z.object({
  title: z.string().trim().min(1, "title is required").max(200),
  note: z.string().trim().max(2000).optional(),
  status: z.enum(["open", "in_progress", "waiting"]).optional(),
});
export const TaskUpdateInput = z.object({
  id: z.string().trim().min(1, "id is required"),
  status: z.enum(["open", "in_progress", "waiting", "review", "done", "cancelled", "interrupted"]).optional(),
  note: z.string().trim().max(2000).optional(),
});
export const SuggestTaskInput = z.object({
  title: z.string().trim().min(1, "title is required").max(200),
  why: z.string().trim().min(1, "why is required").max(300),
  prompt: z.string().trim().min(1, "prompt is required").max(2000),
});

export const PlaybookRecordRunInput = z.object({
  playbook: z.string().trim().min(1, "playbook is required").max(200),
  outcome: z.enum(["success", "partial", "failed"]).optional(),
  helper_id: z.string().trim().optional(),
  minutes: z.coerce.number().min(0).optional(),
  corrections: z.coerce.number().int().min(0).optional(),
  note: z.string().trim().max(2000).optional(),
});

/**
 * A playbook path as stored: relative to ~/Shared/playbooks, e.g. "work/desk-quote.md" (the full
 * "~/Shared/playbooks/..." form is accepted too). Null when it isn't a playbook (outside the folder, not .md).
 */
export function normalizePlaybook(input: string): string | null {
  const p = input
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(~\/)?(Shared\/)?playbooks\//, "")
    .replace(/^\/+/, "");
  if (!p || p.split("/").some((seg) => !seg || seg === "." || seg === "..") || p.startsWith(".history/"))
    return null;
  return /\.md$/i.test(p) ? p : null;
}

/** message_agent arguments as core reads them. */
export const MessageAgentInput = z.object({
  to: z.string().trim().min(1, "to is required"),
  message: z.string().trim().min(1, "message is required"),
  wait: z.boolean().optional(),
});
export type MessageAgentInput = z.infer<typeof MessageAgentInput>;

/** create_agent arguments as core reads them. */
export const CreateAgentInput = z.object({
  name: z.string().trim().min(1, "name is required").max(40),
  role: z.string().trim().max(80).optional(),
  // The approval card shows them in full (Telegram shows up to 1500 characters): what the user approves is
  // exactly what's saved. A longer briefing goes in a message_agent after it's added.
  instructions: z.string().trim().max(1500, "instructions: at most 1500 characters").optional(),
});
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

/** create_phone_link arguments as core reads them. */
export const CreatePhoneLinkInput = z.object({
  label: z.string().trim().max(60, "label: at most 60 characters").optional(),
});
export type CreatePhoneLinkInput = z.infer<typeof CreatePhoneLinkInput>;

/** The Yo Phone tools: main agent only, never from a turn the phone itself started. */
export const PHONE_TOOLS: readonly string[] = ["create_phone_link", "turn_off_phone"];

export const YoToolName = z.enum(YO_TOOLS.map((t) => t.name) as [string, ...string[]]);

export interface ToolResult {
  ok: boolean;
  /** Text returned to the model. */
  text: string;
}
