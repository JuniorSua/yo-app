import { ImageOff } from "lucide-react";
import { useState } from "react";
import { api } from "../../lib/api";
import { chatImageSource } from "../../lib/images";
import { CopyImageButton } from "../ui/CopyImageButton";
import { ImageViewer } from "./ImageViewer";

/** A picture inside an agent's message, shown right in the chat; click to see it full size. */
export function ChatImage({
  agentId,
  src,
  alt,
  snapshot,
  version,
}: {
  agentId: string;
  src?: string;
  alt?: string;
  /** Stored copy taken when the message finished (preferred: it's the picture this message was written with). */
  snapshot?: string;
  /** Unique per message, so a later message showing a redone file never reuses this one's picture. */
  version?: string;
}) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = chatImageSource(src);
  const url =
    source?.kind === "url"
      ? source.url
      : snapshot
        ? api().chatImageUrl(snapshot)
        : source
          ? api().imageUrl(agentId, source.path, version)
          : null;
  const download = source?.kind === "computer" ? api().fileUrl(agentId, source.path) : url;
  const label = alt?.trim() || src?.split("/").pop() || "Image";

  if (!url || failed)
    return (
      <span
        data-testid="chat-image-missing"
        className="my-1 flex w-fit max-w-full items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-muted text-sm"
      >
        <ImageOff className="size-4 shrink-0" />
        <span className="truncate">Couldn't show “{label}”. It may have been moved or deleted.</span>
      </span>
    );

  return (
    <>
      <span className="group/img relative my-1 block w-fit max-w-full">
        <button
          type="button"
          data-testid="chat-image"
          onClick={() => setOpen(true)}
          aria-label={`View ${label} full size`}
          title="Click to enlarge and zoom"
          className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-xl border border-border bg-card transition-[border-color,box-shadow] hover:border-border-strong hover:shadow-soft"
        >
          <img
            src={url}
            alt={label}
            loading="lazy"
            onError={() => setFailed(true)}
            className="block max-h-[480px] w-auto max-w-full object-contain"
          />
        </button>
        {/* Shows on hover or keyboard focus; always on touch screens (no hover there). */}
        <CopyImageButton
          url={url}
          testId="copy-image"
          className="absolute top-2 right-2 bg-card/90 shadow-soft backdrop-blur-sm opacity-0 group-hover/img:opacity-100 focus-visible:opacity-100 data-[copied]:opacity-100 [@media(hover:none)]:opacity-100"
        />
      </span>
      {alt?.trim() && <span className="mt-1 block text-muted text-xs">{alt}</span>}
      <ImageViewer open={open} onOpenChange={setOpen} url={url} label={label} download={download} />
    </>
  );
}
