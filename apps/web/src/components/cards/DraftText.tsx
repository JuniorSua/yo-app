import type { TimelineEntry } from "@yo/contracts";
import { useMemo } from "react";
import { isRevision, wordDiff } from "../../lib/wordDiff";
import { useTimeline } from "../../stores/timeline";

/**
 * The text of the most recent earlier card in this chat that `pick` finds a draft in (the version this card
 * revises), or undefined.
 */
export function usePreviousDraft(
  entry: TimelineEntry,
  pick: (e: TimelineEntry) => string | undefined,
): string | undefined {
  const entries = useTimeline((s) => s.byAgent[entry.agentId]);
  return useMemo(() => {
    if (!entries) return undefined;
    const at = entries.findIndex((e) => e.id === entry.id);
    for (let i = (at < 0 ? entries.length : at) - 1; i >= 0; i--) {
      const text = pick(entries[i]!);
      if (text !== undefined) return text;
    }
    return undefined;
  }, [entries, entry.id, pick]);
}

/**
 * A draft's text. When it revises the one before it (most words kept), the edits are highlighted: new words
 * marked, removed ones struck through, so it's easy to see what actually changed.
 */
export function DraftText({
  text,
  previous,
  className,
}: {
  text: string;
  previous?: string;
  className?: string;
}) {
  const parts = useMemo(
    () => (previous !== undefined && previous !== text ? wordDiff(previous, text) : null),
    [previous, text],
  );
  const revised = isRevision(parts);
  return (
    <div className={className}>
      <div className="whitespace-pre-wrap break-words" data-testid="draft-text">
        {revised
          ? parts.map((p, i) =>
              p.op === "same" ? (
                p.text
              ) : p.op === "add" ? (
                <mark key={i} className="draft-add" data-testid="draft-added">
                  {p.text}
                </mark>
              ) : (
                <del key={i} className="draft-del" data-testid="draft-removed">
                  {p.text}
                </del>
              ),
            )
          : text}
      </div>
      {revised && (
        <div className="mt-1.5 flex items-center gap-1.5 text-2xs text-muted" data-testid="draft-revised">
          <span className="draft-add rounded-sm px-1">Edited</span>
          Changes since the last draft are highlighted.
        </div>
      )}
    </div>
  );
}
