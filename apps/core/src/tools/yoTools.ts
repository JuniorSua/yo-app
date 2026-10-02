import fs from "node:fs";
import path from "node:path";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import type { Scheduler } from "../scheduler/Scheduler";
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

/** Non-interactive Yo tools. Interactive ones (ask_user, request_approval, request_takeover) live in the orchestrator. */
export function createYoTools(d: YoToolDeps) {
  return async (agentId: string, tool: string, args: Record<string, unknown>): Promise<string> => {
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
    switch (tool) {
      case "remember": {
        const fact = str("fact").trim();
        if (!fact) throw new Error("fact is required");
        const m = d.store.addMemory(fact, str("scope") === "agent" ? agentId : null);
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
        const found = d.store.searchMemories(str("query"), agentId);
        if (!found.length) return "No matching memories.";
        return found.map((m) => `[${m.id}] ${m.content}`).join("\n");
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
      case "report_bug":
        return d.bugReports.handle(agentId, args);
      default:
        throw new Error(`Unknown tool ${tool}`);
    }
  };
}
