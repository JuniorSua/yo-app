import type { WorkspaceSearchResult } from "@yo/contracts";
import { chatFor, useApp } from "../stores/app";
import { run } from "../stores/sync";
import { useTimeline } from "../stores/timeline";
import { ui, useUI } from "../stores/ui";
import { api } from "./api";

export async function openMessage(agentId: string, entryId: string) {
  // Load the saved context before navigating, so a failed lookup doesn't leave an empty conversation.
  const entries = await run(
    api().call("timeline.around", { agentId, entryId }),
    "Couldn't open this message",
  );
  if (!entries) return;
  for (const e of entries) useTimeline.getState().upsert(e);
  ui.openAgent(agentId);
  useUI.setState({ focusEntryId: entryId });
}

export function openSearchResult(r: WorkspaceSearchResult) {
  if (r.kind === "message" && r.agentId) {
    // A helper's own chat isn't shown: its messages open the chat that started it (where its card is).
    const chat = chatFor(useApp.getState().agents, r.agentId);
    if (chat !== r.agentId) return ui.openAgent(chat);
    return openMessage(r.agentId, r.id);
  }
  ui.goto(r.kind === "memory" ? "memory" : r.kind === "routine" ? "routines" : "artifacts");
  useUI.setState({ focusRecordId: r.id });
}
