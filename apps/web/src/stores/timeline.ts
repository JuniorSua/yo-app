import type { ApiPushes, TimelineEntry } from "@yo/contracts";
import { create } from "zustand";
import { api } from "../lib/api";
import { friendlyError } from "../lib/connection";

interface TimelineState {
  byAgent: Record<string, TimelineEntry[]>;
  loaded: Record<string, boolean>;
  /** Why the last load of an agent's conversation failed (cleared when a load starts or succeeds). */
  errors: Record<string, string>;
  /** Never rejects: a failure lands in `errors`, so the page can say so and offer a retry. */
  load(agentId: string, force?: boolean): Promise<void>;
  upsert(entry: TimelineEntry): void;
  delta(d: ApiPushes["timeline.delta"]): void;
  reset(): void;
}

/*
 * Streamed text arrives in tiny pieces, often several per frame. Re-rendering the chat for each piece kept the
 * main thread busy for the whole reply, so pieces are buffered and applied together once per frame. Anything
 * else that changes a timeline applies the buffer first, so the order of events is unchanged.
 */
let pending: ApiPushes["timeline.delta"][] = [];
let scheduled: (() => void) | null = null;

function schedule(flush: () => void) {
  if (scheduled) return;
  // A hidden window doesn't paint, so there's no frame to wait for (rAF stops), but text should keep up.
  if (document.visibilityState === "hidden") {
    const t = setTimeout(flush, 100);
    scheduled = () => clearTimeout(t);
  } else {
    const f = requestAnimationFrame(flush);
    scheduled = () => cancelAnimationFrame(f);
  }
}

function applyDeltas(
  byAgent: Record<string, TimelineEntry[]>,
  deltas: ApiPushes["timeline.delta"][],
): Record<string, TimelineEntry[]> {
  const out = { ...byAgent };
  const copied = new Set<string>();
  for (const { agentId, entryId, delta, stream } of deltas) {
    let list = out[agentId];
    if (!list) continue;
    // The streaming entry is almost always the newest one.
    const i = list.findLastIndex((e) => e.id === entryId);
    if (i < 0) continue;
    // Copy each changed list once per batch, then edit the copy.
    if (!copied.has(agentId)) {
      list = out[agentId] = [...list];
      copied.add(agentId);
    }
    const e = list[i]!;
    const item =
      stream === "command_output"
        ? { ...e.item, output: `${e.item.output ?? ""}${delta}` }
        : { ...e.item, text: `${e.item.text ?? ""}${delta}` };
    list[i] = { ...e, item };
  }
  return copied.size ? out : byAgent;
}

function omit(errors: Record<string, string>, key: string): Record<string, string> {
  if (!(key in errors)) return errors;
  const { [key]: _gone, ...rest } = errors;
  return rest;
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

export const useTimeline = create<TimelineState>((set, get) => {
  /** Apply buffered deltas now (before any other change, and once per frame). */
  const flush = () => {
    scheduled?.();
    scheduled = null;
    if (!pending.length) return;
    const deltas = pending;
    pending = [];
    set((s) => {
      const byAgent = applyDeltas(s.byAgent, deltas);
      return byAgent === s.byAgent ? s : { byAgent };
    });
  };
  return {
    byAgent: {},
    loaded: {},
    errors: {},
    async load(agentId, force) {
      if (get().loaded[agentId] && !force) return;
      if (get().errors[agentId]) set((s) => ({ errors: omit(s.errors, agentId) }));
      let entries: TimelineEntry[];
      try {
        entries = await api().call("timeline.list", { agentId, limit: 500 });
      } catch (e) {
        set((s) => ({ errors: { ...s.errors, [agentId]: friendlyError(e) } }));
        return;
      }
      flush();
      set((s) => {
        // Merge: pushes that arrived while loading win if newer.
        let merged = [...entries].sort((a, b) => a.seq - b.seq);
        for (const e of s.byAgent[agentId] ?? []) merged = insertSorted(merged, e);
        return {
          byAgent: { ...s.byAgent, [agentId]: merged },
          loaded: { ...s.loaded, [agentId]: true },
          errors: omit(s.errors, agentId),
        };
      });
    },
    upsert(entry) {
      flush();
      set((s) => ({
        byAgent: { ...s.byAgent, [entry.agentId]: insertSorted(s.byAgent[entry.agentId] ?? [], entry) },
      }));
    },
    delta(d) {
      pending.push(d);
      schedule(flush);
    },
    reset() {
      flush();
      set({ loaded: {}, errors: {} });
    },
  };
});
