import fs from "node:fs";
import path from "node:path";
import {
  normalizePlaybook,
  PageKind,
  PlaybookRecordRunInput,
  Space,
  SuggestTaskInput,
  spaceOfArea,
  TaskAddInput,
  TaskUpdateInput,
  tagArea,
} from "@yo/contracts";
import type { z } from "zod";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import type { Scheduler } from "../scheduler/Scheduler";
import { suggestTask } from "../tasks/tasks";
import { focusOf } from "../team/spaces";
import { postBrief, suggestReplies } from "./brief";
import type { BugReports } from "./bugReports";

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

/** create_page: big enough for inline data and SVG, small enough to keep files light. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

export interface YoToolDeps {
  store: Store;
  hub: Hub;
  scheduler: Scheduler;
  dataDir: string;
  /** Download a file from the agent's computer. */
  fetchFile: (agentId: string, filePath: string) => Promise<Buffer>;
  /** report_bug: draft, the user's OK, then submit. */
  bugReports: BugReports;
}

/** Tool arguments read with a schema; a bad call gets its first problem in plain words. */
function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw new Error(i ? `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}` : "Invalid arguments");
}

/** Non-interactive Yo tools. Interactive ones (ask_user, request_approval, request_takeover) live in the orchestrator. */
export function createYoTools(d: YoToolDeps) {
  return async (agentId: string, tool: string, args: Record<string, unknown>): Promise<string> => {
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
    /**
     * remember's space: the one asked for ("everywhere" = null), else the one its area names ("work"), else the
     * agent's own space (a helper's parent's) when Work & Personal is on, else Everywhere.
     */
    const spaceFor = (id: string): Space | null => {
      const asked = str("space").trim().toLowerCase();
      if (asked === "everywhere") return null;
      const parsed = Space.safeParse(asked);
      if (parsed.success) return parsed.data;
      return spaceOfArea(str("area")) ?? focusOf(d.store, d.store.getAgent(id)) ?? null;
    };
    switch (tool) {
      case "remember": {
        const fact = tagArea(str("area"), str("fact").trim()); // life map: "[area:work] …"
        if (!str("fact").trim()) throw new Error("fact is required");
        const m = d.store.addMemory(fact, str("scope") === "agent" ? agentId : null, spaceFor(agentId));
        d.hub.push("memory.updated", m);
        d.store.addActivity({
          agentId,
          kind: "memory",
          summary: `Remembered: ${fact.slice(0, 140)}`,
          ref: m.id,
        });
        return `Saved to memory (id ${m.id}).`;
      }
      case "recall": {
        const prefer = focusOf(d.store, d.store.getAgent(agentId));
        const found = d.store.searchMemories(str("query"), agentId, { prefer });
        if (!found.length) return "No matching memories.";
        const labelled = d.store.getSettings().spacesOn;
        return found
          .map((m) => `[${m.id}]${labelled && m.space ? ` (${m.space})` : ""} ${m.content}`)
          .join("\n");
      }
      case "forget": {
        d.store.deleteMemory(str("id"));
        return "Forgotten.";
      }
      case "scratchpad_write": {
        d.store.setScratchpad(agentId, str("content"));
        return "Scratchpad updated.";
      }
      case "notify_user": {
        const agent = d.store.getAgent(agentId);
        d.hub.push("notify", { agentId, title: agent?.name ?? "Yo", body: str("message"), kind: "info" });
        return "Notification sent.";
      }
      case "schedule_task": {
        const r = d.scheduler.create({
          agentId,
          name: str("name") || "Routine",
          prompt: str("prompt"),
          cron: str("cron") || null,
          runAt: str("runAt") ? Date.parse(str("runAt")) : null,
        });
        return `Scheduled routine ${r.id} "${r.name}". Next run: ${r.nextRunAt ? new Date(r.nextRunAt).toString() : "n/a"}.`;
      }
      case "list_tasks": {
        const list = d.store.listRoutines(agentId);
        if (!list.length) return "No routines.";
        return list
          .map(
            (r) =>
              `[${r.id}] ${r.name} — ${r.cron ?? (r.runAt ? new Date(r.runAt).toISOString() : "")} — ${r.enabled ? "enabled" : "paused"} — prompt: ${r.prompt.slice(0, 200)}`,
          )
          .join("\n");
      }
      case "cancel_task": {
        d.scheduler.remove(str("id"));
        return "Routine cancelled.";
      }
      case "save_artifact": {
        const p = str("path");
        const buf = await d.fetchFile(agentId, p);
        const dir = path.join(d.dataDir, "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        const base = path.basename(p).replace(/[^\w.\- ]/g, "_") || "file";
        const stored = path.join(dir, `${Date.now()}-${base}`);
        fs.writeFileSync(stored, buf);
        const art = d.store.addArtifact({
          agentId,
          title: str("title") || base,
          path: p,
          mime: MIME[path.extname(base).toLowerCase()] ?? "application/octet-stream",
          size: buf.length,
          storedPath: stored,
        });
        d.hub.push("artifact.new", art);
        return `Saved "${art.title}" to the user's Artifacts (${art.size} bytes).`;
      }
      case "create_page": {
        const title = str("title").trim().slice(0, 120);
        if (!title) throw new Error("title is required");
        // What it is (the Make page's filters). An unknown kind is a plain page rather than an error.
        const pageKind = PageKind.safeParse(str("kind").trim().toLowerCase()).data ?? "page";
        const p = str("path").trim();
        const buf = str("html").trim()
          ? Buffer.from(str("html"), "utf8")
          : p
            ? await d.fetchFile(agentId, p)
            : null;
        if (!buf) throw new Error("Give the page as html, or the path of an .html file on your computer.");
        if (buf.length > MAX_PAGE_BYTES)
          throw new Error(`That page is ${Math.round(buf.length / 1024)} KB; keep it under 2 MB.`);
        if (!/<(html|body|div|svg|canvas|h1|p|table|main|section)\b/i.test(buf.toString("utf8", 0, 65536)))
          throw new Error("That doesn't look like an HTML page.");
        const dir = path.join(d.dataDir, "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        const base = `${
          title
            .replace(/[^\w\- ]/g, "_")
            .replace(/\s+/g, "-")
            .slice(0, 60) || "page"
        }.html`;
        const stored = path.join(dir, `${Date.now()}-${base}`);
        fs.writeFileSync(stored, buf);
        const art = d.store.addArtifact({
          agentId,
          title,
          path: p || base,
          mime: "text/html",
          size: buf.length,
          storedPath: stored,
          kind: "page",
          pageKind,
        });
        d.hub.push("artifact.new", art);
        return `The page "${art.title}" is ready; the user sees it in the chat and on their Make page. [page:${art.id}]`;
      }
      case "report_bug":
        return d.bugReports.handle(agentId, args);
      /* The morning brief card and quick-reply chips: the chat draws them from the call's input. */
      case "post_brief":
        return postBrief(args);
      case "suggest_replies":
        return suggestReplies(args);
      /* The task ledger: what the agent still owes the user (kept outside the conversation). */
      case "task_add": {
        const p = parseArgs(TaskAddInput, args);
        const t = d.store.addTask({
          ownerId: agentId,
          title: p.title,
          status: p.status,
          note: p.note ?? null,
        });
        return `Added task ${t.id}: ${t.title}${t.status === "open" ? "" : ` (${t.status.replace("_", " ")})`}.`;
      }
      case "task_update": {
        const p = parseArgs(TaskUpdateInput, args);
        const t = d.store.getTask(p.id);
        if (!t || t.ownerId !== agentId)
          throw new Error(`There's no task ${p.id} in your ledger (see task_list).`);
        // A suggestion is the user's to start or hide, and a hidden one stays hidden.
        if (t.status === "suggested")
          throw new Error(
            `"${t.title}" is a suggestion waiting for the user: only they can start or hide it. It becomes yours to update once they tap Start.`,
          );
        if (t.status === "hidden")
          throw new Error(
            `The user hid "${t.title}". Leave it hidden, and don't take it on unless they ask.`,
          );
        const u = d.store.updateTask(t.id, { status: p.status, note: p.note })!;
        return `Task ${u.id} "${u.title}" is ${u.status.replace("_", " ")}${u.note ? `: ${u.note}` : ""}.`;
      }
      case "task_list": {
        const all = args.include_done === true;
        const tasks = d.store.listTasks(agentId, { all });
        const line = (t: (typeof tasks)[number]) =>
          `[${t.id}] ${t.title} (${t.status === "hidden" ? "suggestion the user hid" : t.status.replace("_", " ")}${t.helperId ? `, helper ${t.helperId}` : ""})${t.note ? `: ${t.note}` : ""}`;
        // Suggestions waiting for the user aren't owed yet: listed apart (with include_done they're in the list).
        const offered = all
          ? []
          : d.store.listTasks(agentId, { all: true }).filter((t) => t.status === "suggested");
        const out = tasks.length ? tasks.map(line).join("\n") : "Your task ledger is empty.";
        return offered.length
          ? `${out}\nYour suggestions waiting for the user: ${offered.map((t) => `"${t.title}"`).join(", ")}`
          : out;
      }
      /* A suggestion: Up next on the Tasks page and above the message box, until the user starts or hides it. */
      case "suggest_task":
        return suggestTask(d.store, agentId, parseArgs(SuggestTaskInput, args));
      /* Playbook runs: how each run of a recurring job went (core logs helpers' runs itself). */
      case "playbook_record_run": {
        const p = parseArgs(PlaybookRecordRunInput, args);
        const playbook = normalizePlaybook(p.playbook);
        if (!playbook)
          throw new Error(
            `"${p.playbook}" isn't a playbook path (e.g. work/desk-quote.md under ~/Shared/playbooks).`,
          );
        const now = Date.now();
        let run = p.helper_id ? d.store.playbookRunOfHelper(p.helper_id) : null;
        if (run && run.playbook !== playbook) run = null;
        run ??= d.store.addPlaybookRun({
          playbook,
          agentId,
          helperId: p.helper_id ?? null,
          startedAt: p.minutes !== undefined ? now - p.minutes * 60_000 : now,
        });
        const u = d.store.updatePlaybookRun(run.id, {
          endedAt: run.endedAt ?? now,
          outcome: p.outcome ?? run.outcome ?? "success",
          corrections: run.corrections + (p.corrections ?? 0),
          note: p.note ?? run.note,
        })!;
        return `Recorded for ${playbook}: ${u.outcome}${u.corrections ? `, ${u.corrections} correction${u.corrections === 1 ? "" : "s"}` : ""}.`;
      }
      default:
        throw new Error(`Unknown tool ${tool}`);
    }
  };
}
