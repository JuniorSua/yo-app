import type { Artifact } from "@yo/contracts";
import { Download, LayoutTemplate, Maximize2, Pin, PinOff, X } from "lucide-react";
import { useEffect } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { KIND_COLOUR, KIND_LABEL, kindTint, makeKindOf } from "../../lib/make";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load } from "../../stores/sync";
import { useUI } from "../../stores/ui";
import { KindIcon } from "../pages/KindIcon";
import { Button } from "../ui/button";
import { Modal, Tip } from "../ui/overlay";

/**
 * A Page (create_page) in a sandboxed frame: core serves it with its own opaque origin and a CSP that allows
 * inline code plus the chart CDN only, and the frame's sandbox repeats that (scripts, nothing else).
 */
export function PageFrame({
  artifactId,
  title,
  preview,
  className,
}: {
  artifactId: string;
  title: string;
  /** A still thumbnail: no clicks or focus inside it. */
  preview?: boolean;
  className?: string;
}) {
  return (
    <iframe
      src={api().pageUrl(artifactId)}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
      tabIndex={preview ? -1 : undefined}
      aria-hidden={preview || undefined}
      data-testid={preview ? "page-preview" : "page-frame"}
      className={cn("block border-0 bg-white", preview && "pointer-events-none", className)}
    />
  );
}

/** A thumbnail of the page's top: rendered at desktop width, scaled down. */
export function PageThumb({ a, className }: { a: Pick<Artifact, "id" | "title">; className?: string }) {
  return (
    <div className={cn("relative overflow-hidden bg-white", className)}>
      <PageFrame
        artifactId={a.id}
        title={a.title}
        preview
        className="absolute top-0 left-0 h-[300%] w-[300%] origin-top-left scale-[0.3334]"
      />
    </div>
  );
}

export function openPage(id: string) {
  useUI.setState({ pageViewerId: id });
}

export async function setPinned(a: Artifact, pinned: boolean) {
  try {
    await api().call("artifact.pin", { id: a.id, pinned });
  } catch (e) {
    toast.error((e as Error).message || "Couldn't change the pin.");
  }
}

export function PinButton({ a, className }: { a: Artifact; className?: string }) {
  const pinned = !!a.pinnedAt;
  const Icon = pinned ? PinOff : Pin;
  return (
    <Tip label={pinned ? "Unpin" : "Pin to the top"}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void setPinned(a, !pinned);
        }}
        aria-label={pinned ? `Unpin ${a.title}` : `Pin ${a.title}`}
        aria-pressed={pinned}
        data-testid="pin-button"
        className={cn(
          "grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg",
          pinned && "text-brand hover:text-brand",
          className,
        )}
      >
        <Icon className="size-4" />
      </button>
    </Tip>
  );
}

/** The chat's card for a Page the agent just made: a live preview and Open. */
export function PageCard({ artifactId, title: asked }: { artifactId: string; title?: string }) {
  const loaded = useApp((s) => !!s.artifacts);
  const art = useApp((s) => s.artifacts?.find((a) => a.id === artifactId));
  const title = art?.title ?? asked ?? "Page";
  const kind = art ? makeKindOf(art) : "page";
  // Make's list may not be loaded yet (a fresh chat): load them so Pin and the title follow the file.
  useEffect(() => {
    if (!loaded) load.artifacts().catch(() => {});
  }, [loaded]);
  return (
    <div
      data-testid="page-card"
      className="group w-full max-w-[520px] overflow-hidden rounded-2xl border border-border bg-card shadow-card animate-rise"
    >
      <button
        type="button"
        onClick={() => openPage(artifactId)}
        aria-label={`Open the page ${title}`}
        className="relative block h-56 w-full cursor-zoom-in overflow-hidden border-border border-b text-left"
      >
        <PageThumb a={{ id: artifactId, title }} className="h-full w-full" />
        <span className="absolute right-3 bottom-3 grid size-8 place-items-center rounded-lg border border-border-strong/60 bg-elevated/95 text-muted opacity-0 shadow-soft transition-opacity group-hover:opacity-100">
          <Maximize2 className="size-4" />
        </span>
      </button>
      <div className="flex items-center gap-3 p-3 pr-3.5">
        <div
          className="grid size-9 shrink-0 place-items-center rounded-xl"
          style={{ background: kindTint(kind), color: KIND_COLOUR[kind] }}
        >
          <KindIcon kind={kind} className="size-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium leading-snug" title={title}>
            {title}
          </div>
          <div className="truncate text-muted text-xs">{KIND_LABEL[kind]} · kept in Make</div>
        </div>
        {art && <PinButton a={art} />}
        <Button variant="secondary" size="sm" onClick={() => openPage(artifactId)}>
          Open
        </Button>
      </div>
    </div>
  );
}

/** The page viewer: a Page full size, with Pin, Download and Close. */
export function PageViewer() {
  const id = useUI((s) => s.pageViewerId);
  const art = useApp((s) => (id ? s.artifacts?.find((a) => a.id === id) : undefined));
  const close = () => useUI.setState({ pageViewerId: null });
  const title = art?.title ?? "Page";
  return (
    <Modal
      open={!!id}
      onOpenChange={(o) => !o && close()}
      bare
      testId="page-viewer"
      className="flex h-[calc(100vh-48px)] w-[min(1120px,calc(100vw-32px))] flex-col"
    >
      <div className="flex items-center gap-3 border-border border-b px-4 py-2.5">
        <LayoutTemplate className="size-4 shrink-0 text-brand" />
        <div className="min-w-0 flex-1 truncate font-semibold" title={title}>
          {title}
        </div>
        {art && <PinButton a={art} />}
        {id && (
          <Tip label="Download">
            <a
              href={api().artifactUrl(id)}
              download={`${title.replace(/[^\w\- ]/g, "_")}.html`}
              aria-label="Download the page"
              className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <Download className="size-4" />
            </a>
          </Tip>
        )}
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <X className="size-4" />
        </button>
      </div>
      {id && <PageFrame artifactId={id} title={title} className="min-h-0 w-full flex-1" />}
    </Modal>
  );
}
