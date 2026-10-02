/**
 * Human-readable titles and item-kind classification for tool calls, shared by all providers.
 * The timeline shows these as collapsible activity lines ("Opened amazon.com", "Saved a memory").
 */
import type { ItemKind } from "@yo/contracts";
import { isRecord, oneLine, str } from "./util";

export interface ToolRef {
  /** MCP server name when known ("browser", "yo", "desktop", ...). */
  server?: string;
  /** Bare tool name (without mcp__server__ prefix). */
  tool: string;
}

/** Split `mcp__server__tool` (Claude) / `server.tool` / `server/tool` into server + tool. */
export function parseToolName(name: string): ToolRef {
  const claude = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (claude) return { server: claude[1]!, tool: claude[2]! };
  const sep = name.match(/^(yo|browser|desktop)[./:](.+)$/);
  if (sep) return { server: sep[1]!, tool: sep[2]! };
  return { tool: name };
}

export function hostOf(url: unknown): string | undefined {
  const s = str(url);
  if (!s) return undefined;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.replace(/^www\./, "") || s;
  } catch {
    return oneLine(s, 60);
  }
}

function quoted(v: unknown, max = 40): string | undefined {
  const s = str(v);
  return s ? `'${oneLine(s, max)}'` : undefined;
}

/** Titles for Playwright MCP tools (the `browser` server). */
export function browserTitle(tool: string, input: unknown): string {
  const a = isRecord(input) ? input : {};
  const t = tool.replace(/^browser_/, "");
  const el = quoted(a.element) ?? quoted(a.ref);
  switch (t) {
    case "navigate":
      return `Opened ${hostOf(a.url) ?? "a page"}`;
    case "navigate_back":
      return "Went back";
    case "navigate_forward":
      return "Went forward";
    case "click":
      return el ? `Clicked ${el}` : "Clicked on the page";
    case "type":
      return str(a.element) ? `Typed into ${oneLine(String(a.element), 40)}` : "Typed on the page";
    case "fill_form":
      return "Filled out a form";
    case "select_option":
      return el ? `Chose an option in ${el}` : "Chose an option";
    case "hover":
      return el ? `Hovered over ${el}` : "Hovered on the page";
    case "drag":
      return "Dragged on the page";
    case "press_key":
      return str(a.key) ? `Pressed ${a.key}` : "Pressed a key";
    case "snapshot":
      return "Read the page";
    case "take_screenshot":
    case "screenshot":
      return "Took a screenshot";
    case "tabs":
    case "tab_list":
    case "tab_new":
    case "tab_select":
    case "tab_close":
      return str(a.action) === "new" || t === "tab_new" ? "Opened a new tab" : "Switched tabs";
    case "wait_for":
      return str(a.text) ? `Waited for ${quoted(a.text)}` : "Waited for the page";
    case "evaluate":
    case "run_code":
      return "Ran a script on the page";
    case "file_upload":
      return "Uploaded a file";
    case "handle_dialog":
      return "Answered a page dialog";
    case "close":
      return "Closed the browser";
    case "resize":
      return "Resized the browser";
    case "console_messages":
      return "Checked the console";
    case "network_requests":
      return "Checked network activity";
    case "pdf_save":
      return "Saved the page as PDF";
    default:
      return `Browser: ${t.replace(/_/g, " ")}`;
  }
}

/** Titles for Yo's own tools (the `yo` MCP server). */
export function yoTitle(tool: string, input: unknown): string {
  const a = isRecord(input) ? input : {};
  switch (tool) {
    case "remember":
      return "Saved a memory";
    case "recall":
      return str(a.query) ? `Searched memory for "${oneLine(String(a.query), 40)}"` : "Searched memory";
    case "forget":
      return "Forgot a memory";
    case "scratchpad_write":
      return "Updated the scratchpad";
    case "ask_user":
      return "Asked you a question";
    case "request_approval":
      return str(a.action) ? `Asked for approval: ${oneLine(String(a.action), 60)}` : "Asked for approval";
    case "request_takeover":
      return "Asked you to take over";
    case "notify_user":
      return "Sent you an update";
    case "schedule_task":
      return str(a.name) ? `Scheduled "${oneLine(String(a.name), 40)}"` : "Scheduled a task";
    case "list_tasks":
      return "Checked scheduled tasks";
    case "cancel_task":
      return "Canceled a scheduled task";
    case "save_artifact":
      return str(a.title) ? `Saved "${oneLine(String(a.title), 40)}"` : "Saved an artifact";
    default:
      return tool.replace(/_/g, " ");
  }
}

/** Titles for the desktop MCP (xdotool/scrot). Tool names are matched loosely. */
export function desktopTitle(tool: string, input: unknown): string {
  const a = isRecord(input) ? input : {};
  if (/screenshot|screen/.test(tool)) return "Looked at the screen";
  if (/click/.test(tool)) return "Clicked on the desktop";
  if (/type/.test(tool)) return "Typed on the desktop";
  if (/key/.test(tool)) return str(a.keys ?? a.key) ? `Pressed ${a.keys ?? a.key}` : "Pressed keys";
  if (/scroll/.test(tool)) return "Scrolled";
  if (/move/.test(tool)) return "Moved the mouse";
  if (/launch|open|run/.test(tool))
    return str(a.app ?? a.command) ? `Opened ${a.app ?? a.command}` : "Opened an app";
  return `Desktop: ${tool.replace(/_/g, " ")}`;
}

export function commandTitle(command: unknown): string {
  const c = str(Array.isArray(command) ? command.join(" ") : command);
  return c ? `Ran \`${oneLine(c, 60)}\`` : "Ran a command";
}

export function fileTitle(verb: "Edited" | "Created" | "Deleted" | "Changed", path: unknown): string {
  const p = str(path);
  if (!p) return `${verb} a file`;
  const base = p.split("/").filter(Boolean).pop() ?? p;
  return `${verb} ${base}`;
}

export interface Classified {
  kind: ItemKind;
  title: string;
}

/** Classify an MCP tool call by server. */
export function classifyMcp(server: string | undefined, tool: string, input: unknown): Classified {
  if (server === "browser" || (!server && /^browser_/.test(tool))) {
    return { kind: "browser", title: browserTitle(tool, input) };
  }
  if (server === "yo") return { kind: "tool", title: yoTitle(tool, input) };
  if (server === "desktop") return { kind: "tool", title: desktopTitle(tool, input) };
  return { kind: "tool", title: `${server ? `${server}: ` : ""}${tool.replace(/_/g, " ")}` };
}
