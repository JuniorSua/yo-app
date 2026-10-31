/**
 * Fold a long-lived agent into the main agent. Yo 2 keeps teammates (they're first-class: a job, a memory and a
 * seat each), so nothing is offered on its own anymore: `plan()` is always empty and the app's one-time
 * "Yo is now one assistant" dialog never opens. `consolidate()` still does it for agents asked for by id.
 *
 * For each agent, in this order (each step can be repeated, so a run that stopped half way is finished by the
 * next one, and a double click does nothing twice):
 *   1. copy its home files into the shared folder (`~/Shared/from-<name>/`), the one step that needs agentd;
 *   2. save its role and instructions as a memory of the main agent (once);
 *   3. hand its memories and its routines to the main agent (routines stay as they were, on or off);
 *   4. archive it (its chats stay readable).
 * If step 1 fails the agent is left exactly as it was and reported as pending. Steps 2-4 only touch the
 * database, back to back, so they don't fail half way.
 *
 * Agents the owner hands over by hand (`settings.consolidateSkip`, Pepe on the owner's install) and helpers are
 * never touched, nor are the Work and Personal agents (Yo and Pip, see ./spaces.ts).
 */
import type { Agent, ConsolidationAgentResult, ConsolidationPlan, ConsolidationResult } from "@yo/contracts";
import type { AgentdClient } from "../agentd/AgentdClient";
import type { Store } from "../db/store";
import type { Hub } from "../hub";

export interface ConsolidatorDeps {
  store: Store;
  hub: Hub;
  agentd: AgentdClient;
  /** Stop it, put its computer to sleep, archive it and tell the apps (the same as the Archive button). */
  archive: (agentId: string) => Promise<void>;
}

/** Helpers (one-off workers, `kind: "helper"`) are not part of the team being folded. */
const isHelper = (a: Agent) => a.kind === "helper";

/** Role and instructions are saved as one memory; this keeps a runaway prompt from filling the memory page. */
const MAX_HANDOVER_CHARS = 4000;

/** The folder name under ~/Shared. */
export const handoverDir = (name: string) => `from-${name.trim().replace(/\s+/g, "-") || "agent"}`;

export class Consolidator {
  private running = new Set<string>();

  constructor(private d: ConsolidatorDeps) {}

  private primary(): Agent | null {
    return this.d.store.listAgents().find((a) => a.isPrimary) ?? null;
  }

  /** Why this agent is left alone, or null when it should be folded in. */
  private whySkipped(a: Agent, primary: Agent): string | null {
    if (a.id === primary.id) return "This is the main agent.";
    if (a.archivedAt) return "Already archived.";
    if (isHelper(a)) return "Helpers go away on their own.";
    if (a.space) return "This is your Work or Personal agent.";
    const skip = this.d.store.getSettings().consolidateSkip.map((n) => n.trim().toLowerCase());
    if (skip.includes(a.name.trim().toLowerCase())) return "You're handing this one over yourself.";
    return null;
  }

  /** Who would be folded in on their own: nobody, since teammates stay (an app from before Yo 2 asks this). */
  plan(): ConsolidationPlan {
    return { primaryId: this.primary()?.id ?? null, agents: [] };
  }

  async consolidate(agentIds: string[]): Promise<ConsolidationResult> {
    const primary = this.primary();
    if (!primary) throw new Error("There is no main agent to move things to.");
    const results: ConsolidationAgentResult[] = [];
    for (const id of [...new Set(agentIds)]) results.push(await this.one(id, primary));
    return { primaryId: primary.id, agents: results };
  }

  private async one(id: string, primary: Agent): Promise<ConsolidationAgentResult> {
    const { store, hub } = this.d;
    const a = store.getAgent(id);
    const blank = { memories: 0, routines: 0, files: null };
    if (!a)
      return { agentId: id, name: "Unknown agent", status: "skipped", error: "Unknown agent.", ...blank };
    const why = this.whySkipped(a, primary);
    if (why)
      return {
        agentId: id,
        name: a.name,
        // An agent that was already moved and archived counts as done: running it again is not an error.
        status: a.archivedAt ? "done" : "skipped",
        ...(a.archivedAt ? {} : { error: why }),
        ...blank,
      };
    if (this.running.has(id))
      return { agentId: id, name: a.name, status: "pending", error: "Already moving.", ...blank };
    this.running.add(id);
    try {
      // 1. Files first: if this fails nothing else has changed.
      const dir = handoverDir(a.name);
      let files: ConsolidationAgentResult["files"];
      try {
        if (!this.d.agentd.connected) throw new Error("Yo's computer isn't running. Start it and try again.");
        files = await this.d.agentd.request("fs.copyHome", { fromAgentId: id, toDir: dir });
        if (files.failed > 0 && files.copied === 0 && files.skipped === 0)
          throw new Error("Some files couldn't be copied.");
      } catch (err) {
        return {
          agentId: id,
          name: a.name,
          status: "pending",
          error: err instanceof Error ? err.message : String(err),
          ...blank,
        };
      }

      // 2. Role and instructions, once.
      const marker = `[handover:${a.id}]`;
      if (
        !store.listMemories(primary.id).some((m) => m.agentId === primary.id && m.content.includes(marker))
      ) {
        const m = store.addMemory(this.handoverMemory(a, dir, marker), primary.id);
        hub.push("memory.updated", m);
      }

      // 3. Memories and routines move to the main agent; a routine keeps its schedule and stays on.
      const memories = store.reownMemories(id, primary.id);
      for (const m of memories) hub.push("memory.updated", m);
      const routines = store.reownRoutines(id, primary.id);
      for (const r of routines) hub.push("routine.updated", r);

      // 4. Archive. Its routines already belong to the main agent, so archiving doesn't switch them off.
      try {
        await this.d.archive(id);
      } catch (err) {
        // Everything is moved already; running it again only has the archiving left.
        return {
          agentId: id,
          name: a.name,
          status: "pending",
          error: err instanceof Error ? err.message : String(err),
          memories: memories.length,
          routines: routines.length,
          files,
        };
      }
      store.addActivity({
        agentId: primary.id,
        kind: "system",
        summary: `Moved ${a.name} into Yo: ${memories.length} memories, ${routines.length} routines, files in ~/Shared/${dir}`,
        ref: null,
      });
      return {
        agentId: id,
        name: a.name,
        status: "done",
        memories: memories.length,
        routines: routines.length,
        files,
      };
    } finally {
      this.running.delete(id);
    }
  }

  private handoverMemory(a: Agent, dir: string, marker: string): string {
    const parts = [
      `Handover from ${a.name}, an agent that now lives inside Yo. ${marker}`,
      a.role.trim() && `Role: ${a.role.trim()}`,
      a.instructions.trim() && `Instructions: ${a.instructions.trim()}`,
      `Its files are in ~/Shared/${dir}/. Its chats are in the archive.`,
    ].filter(Boolean);
    return parts.join("\n").slice(0, MAX_HANDOVER_CHARS);
  }
}
