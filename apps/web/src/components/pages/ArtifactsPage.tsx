import type { AgentView, Artifact } from "@yo/contracts";
import { Download, Pin, Sparkles } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  filterMade,
  KIND_COLOUR,
  KIND_LABEL,
  kindTint,
  MAKE_STARTERS,
  type MakeFilter,
  makeFilters,
  makeKindOf,
  starterDraft,
} from "../../lib/make";
import { sortPinnedFirst } from "../../lib/pins";
import { ago, cn, fileSize } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { useActiveAgent } from "../../stores/space";
import { load } from "../../stores/sync";
import { ui } from "../../stores/ui";
import { openPage, PageThumb, PinButton } from "../agent/Pages";
import { LoadState, useLoad } from "../LoadState";
import { EmptyNote, PageShell } from "../PageHeader";
import { Fab } from "../ui/Fab";
import { KindIcon } from "./KindIcon";

/** Small round buttons on a card's preview: 32px to see, 44px to tap. */
const CHIP_BUTTON =
  "relative size-8 rounded-full bg-elevated/95 shadow-soft backdrop-blur before:absolute before:-inset-1.5 before:content-['']";

/**
 * Make: everything Yo made for the user (pages, dashboards, slides, docs, designs, saved files, bug reports),
 * pinned first, with a chip per kind. The + offers what Yo can make and opens the chat with a line to finish.
 */
export function ArtifactsPage() {
  const artifacts = useApp((s) => s.artifacts);
  const yo = useActiveAgent();
  const status = useLoad(() => load.artifacts(true));
  const [filter, setFilter] = useState<MakeFilter>("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const filters = makeFilters(artifacts ?? []);
  // The last of a kind was removed: back to All.
  const current = filters.some((f) => f.id === filter) ? filter : "all";
  const shown = filterMade(sortPinnedFirst(artifacts ?? []), current);
  return (
    <PageShell title="Make" subtitle={`What ${yo?.name ?? "Yo"} made for you.`} wide>
      <LoadState ready={!!artifacts} {...status} what="what was made" />
      {artifacts && artifacts.length === 0 && (
        <EmptyNote icon={<Sparkles />} title="Nothing made yet." body="Tap + to choose what to make." />
      )}
      {artifacts && artifacts.length > 0 && (
        <div
          role="group"
          aria-label="Show"
          data-testid="make-filters"
          className="-mx-8 mb-4 flex gap-2 overflow-x-auto px-8 pb-1 [scrollbar-width:none] max-sm:-mx-5 max-sm:px-5"
        >
          {filters.map((f) => {
            const on = f.id === current;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                data-testid={`make-filter-${f.id}`}
                onClick={() => setFilter(f.id)}
                className={cn(
                  "flex min-h-11 shrink-0 items-center rounded-full px-4 font-medium text-sm transition-colors focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 sm:min-h-9",
                  on
                    ? "bg-fg text-bg"
                    : "bg-card text-fg shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-active",
                )}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      )}
      <div
        className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4"
        data-testid="artifacts-grid"
      >
        {shown.map((a) => (
          <MadeCard key={a.id} a={a} />
        ))}
      </div>
      {artifacts && artifacts.length > 0 && shown.length === 0 && (
        <p className="pt-2 text-muted text-sm">Nothing here yet. Tap + to make one.</p>
      )}
      {yo && <MakeMenu agent={yo} open={menuOpen} onOpenChange={setMenuOpen} />}
    </PageShell>
  );
}

/** One thing in the grid: a page's live thumbnail, or a tinted tile with its kind's icon; then title and when. */
function MadeCard({ a }: { a: Artifact }) {
  const kind = makeKindOf(a);
  const isPage = a.kind === "page";
  const ext = a.path.split(".").pop()?.toLowerCase() ?? "";
  const meta =
    isPage || kind === "bug"
      ? `${KIND_LABEL[kind]} · ${ago(a.createdAt)}`
      : `${fileSize(a.size)} · ${ago(a.createdAt)}`;
  return (
    <div
      data-record-id={a.id}
      data-kind={a.kind ?? "file"}
      data-make-kind={kind}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-[20px] border bg-card shadow-card transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-soft",
        kind === "bug" ? "border-danger/45" : "border-border",
      )}
    >
      {isPage ? (
        <button
          type="button"
          onClick={() => openPage(a.id)}
          aria-label={`Open the page ${a.title}`}
          className="relative block h-28 w-full cursor-zoom-in overflow-hidden border-border border-b text-left sm:h-36"
        >
          <PageThumb a={a} className="h-full w-full" />
        </button>
      ) : (
        <div
          className="relative grid h-28 place-items-center border-border border-b sm:h-36"
          style={{ background: kindTint(kind) }}
        >
          <span
            className="grid size-12 place-items-center rounded-2xl bg-card shadow-card"
            style={{ color: KIND_COLOUR[kind] }}
          >
            <KindIcon kind={kind} mime={a.mime} className="size-6" />
          </span>
          {kind === "file" && ext && (
            <span className="absolute bottom-2.5 left-3 font-semibold text-[10px] text-muted uppercase tracking-wide">
              {ext}
            </span>
          )}
        </div>
      )}
      {a.pinnedAt ? (
        <span
          data-testid="pinned-badge"
          className="absolute top-2 left-2 grid size-7 place-items-center rounded-full bg-elevated text-brand-ink shadow-soft"
          title="Pinned"
        >
          <Pin className="size-3.5" />
        </span>
      ) : null}
      {/* Pin and Download: always there on touch screens, on hover (or keyboard focus) with a mouse. */}
      <div className="absolute top-2 right-2 flex gap-3 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
        <PinButton a={a} className={CHIP_BUTTON} />
        <a
          href={api().artifactUrl(a.id)}
          download={isPage ? `${a.title.replace(/[^\w\- ]/g, "_")}.html` : a.path.split("/").pop()}
          aria-label={`Download ${a.title}`}
          className={cn(CHIP_BUTTON, "grid place-items-center text-muted transition-colors hover:text-fg")}
        >
          <Download className="size-4" />
        </a>
      </div>
      <div className="min-h-[64px] px-3 pt-2.5 pb-3">
        <div
          title={a.title}
          className={cn(
            "line-clamp-2 font-semibold text-[14.5px] leading-[19px] tracking-[-0.01em]",
            kind === "bug" && "text-danger",
          )}
        >
          {a.title}
        </div>
        <div className="mt-0.5 truncate text-muted text-xs">{meta}</div>
      </div>
    </div>
  );
}

/**
 * The + and what it fans out: a pill per kind, nearest the + first, 45ms apart (in place with reduced motion).
 * Picking one opens the chat with that kind's line in the message box, ready to finish.
 */
function MakeMenu({
  agent,
  open,
  onOpenChange,
}: {
  agent: AgentView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const nearest = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    nearest.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  const last = MAKE_STARTERS.length - 1;
  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close"
          tabIndex={-1}
          onClick={() => onOpenChange(false)}
          className="fixed inset-0 z-20 cursor-default bg-bg/70 backdrop-blur-[3px] animate-fade-in"
        />
      )}
      {open && (
        <ul
          id="make-kinds"
          aria-label="What to make"
          data-testid="make-menu"
          className="make-menu flex flex-col items-end gap-2.5"
        >
          {MAKE_STARTERS.map((k, i) => (
            <li key={k.id} style={{ "--fan-order": last - i } as CSSProperties}>
              <button
                ref={i === last ? nearest : undefined}
                type="button"
                data-testid={`make-kind-${k.id}`}
                title={k.starter}
                onClick={() => {
                  onOpenChange(false);
                  ui.prefillComposer(agent.id, starterDraft(k.starter));
                }}
                className="flex min-h-11 items-center gap-2.5 rounded-full py-1.5 pr-5 pl-1.5 font-semibold text-fg text-sm shadow-soft transition-transform focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 active:scale-95"
                style={{ background: kindTint(k.id) }}
              >
                <span
                  className="grid size-8 shrink-0 place-items-center rounded-full bg-card shadow-card"
                  style={{ color: KIND_COLOUR[k.id] }}
                >
                  <KindIcon kind={k.id} className="size-[18px]" />
                </span>
                {k.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Fab
        label={open ? "Close" : "Make something"}
        open={open}
        onClick={() => onOpenChange(!open)}
        testId="make-fab"
      />
    </>
  );
}
