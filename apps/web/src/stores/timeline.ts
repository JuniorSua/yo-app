import type { ApiPushes, TimelineEntry } from "@yo/contracts";
import { create } from "zustand";
import { api } from "../lib/api";

interface TimelineState {
  byAgent: Record<string, TimelineEntry[]>;
  loaded: Record<string, boolean>;
  load(agentId: string, force?: boolean): Promise<void>;
  upsert(entry: TimelineEntry): void;
  delta(d: ApiPushes["timeline.delta"]): void;
  reset(): void;
}

function insertSorted(list: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
  const i = list.findIndex((e) => e.id === entry.id);
  if (i >= 0) {
    const next = [...list];
    next[i] = entry;
    return next;
  }
  const next = [...list, entry];
  if (list.length && list[list.length - 1]!.seq > entry.seq) next.sort((a, b) => a.seq - b.seq);
  return next;
}

export const useTimeline = create<TimelineState>((set, get) => ({
  byAgent: {},
  loaded: {},
  async load(agentId, force) {
    if (get().loaded[agentId] && !force) return;
    const entries = await api().call("timeline.list", { agentId, limit: 500 });
    set((s) => {
      // Merge: pushes that arrived while loading win if newer.
      let merged = [...entries].sort((a, b) => a.seq - b.seq);
      for (const e of s.byAgent[agentId] ?? []) merged = insertSorted(merged, e);
      return { byAgent: { ...s.byAgent, [agentId]: merged }, loaded: { ...s.loaded, [agentId]: true } };
    });
  },
  upsert(entry) {
    set((s) => ({
      byAgent: { ...s.byAgent, [entry.agentId]: insertSorted(s.byAgent[entry.agentId] ?? [], entry) },
    }));
  },
  delta({ agentId, entryId, delta, stream }) {
    set((s) => {
      const list = s.byAgent[agentId];
      if (!list) return s;
      const i = list.findIndex((e) => e.id === entryId);
      if (i < 0) return s;
      const e = list[i]!;
      const item =
        stream === "command_output"
          ? { ...e.item, output: `${e.item.output ?? ""}${delta}` }
          : { ...e.item, text: `${e.item.text ?? ""}${delta}` };
      const next = [...list];
      next[i] = { ...e, item };
      return { byAgent: { ...s.byAgent, [agentId]: next } };
    });
  },
  reset() {
    set({ loaded: {} });
  },
}));
