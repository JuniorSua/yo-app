import {
  Avatar,
  defaultColor,
  SOFTIE_ACCENTS,
  SOFTIE_STATE_LABEL,
  SOFTIES,
  Softie,
  type SoftieState,
  softieAvatar,
  softieOf,
} from "@yo/avatar";
import type { Avatar as AvatarData, SoftieKind } from "@yo/contracts";
import { ImageUp, X } from "lucide-react";
import { type CSSProperties, useRef, useState } from "react";
import { cn, readFileDataUrl } from "../lib/utils";
import { Button } from "./ui/button";
import { Tip } from "./ui/overlay";

const PREVIEW_STATES: SoftieState[] = ["idle", "thinking", "working", "needs", "done"];

/** The Softie's colour as a CSS variable, for its tinted stage. */
const tint = (hex: string) => ({ "--softie": hex }) as CSSProperties;

/** The ten colours, as round swatches. The Softie's own colour is first-class: picking it clears the override. */
export function SoftieColors({
  kind,
  value,
  onPick,
}: {
  kind: SoftieKind;
  value: string;
  onPick: (hex: string | undefined) => void;
}) {
  const own = defaultColor(kind).toLowerCase();
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Colour">
      {SOFTIE_ACCENTS.map((c) => {
        const on = value.toLowerCase() === c.hex.toLowerCase();
        return (
          <Tip key={c.id} label={c.hex.toLowerCase() === own ? `${c.name} (its own)` : c.name}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={c.name}
              data-testid={`softie-color-${c.id}`}
              onClick={() => onPick(c.hex.toLowerCase() === own ? undefined : c.hex)}
              className={cn(
                "size-6 rounded-full ring-offset-2 ring-offset-elevated transition-[transform,box-shadow] duration-150 hover:scale-110 active:scale-95",
                on ? "ring-2 ring-fg" : "shadow-[inset_0_0_0_1px_rgb(0_0_0/0.08)]",
              )}
              style={{ background: c.hex }}
            />
          </Tip>
        );
      })}
    </div>
  );
}

/** The six Softies as tiles (small) or cards with their job (large). */
export function SoftieGrid({
  value,
  color,
  onPick,
  size = "tile",
  testPrefix = "softie",
}: {
  value: SoftieKind | null;
  /** The colour the chosen one wears (the others show their own). */
  color?: string;
  onPick: (kind: SoftieKind) => void;
  size?: "tile" | "card";
  testPrefix?: string;
}) {
  const card = size === "card";
  return (
    <div
      className={cn("grid grid-cols-3", card ? "gap-2.5" : "gap-1.5")}
      role="radiogroup"
      aria-label="Character"
    >
      {SOFTIES.map((s) => {
        const on = value === s.kind;
        const hex = on && color ? color : defaultColor(s.kind);
        return (
          <button
            key={s.kind}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${s.name}, ${s.role}`}
            data-testid={`${testPrefix}-${s.kind}`}
            onClick={() => onPick(s.kind)}
            style={tint(hex)}
            className={cn(
              "group flex flex-col items-center rounded-2xl border text-center transition-[border-color,background-color,box-shadow] duration-150",
              card ? "px-3 pt-3 pb-3.5" : "px-1 pt-1.5 pb-2",
              on
                ? "border-fg/60 bg-[color-mix(in_oklab,var(--softie)_7%,var(--elevated))] shadow-soft"
                : "border-border bg-bg/40 hover:border-border-strong hover:bg-[color-mix(in_oklab,var(--softie)_6%,var(--elevated))]",
            )}
          >
            <span
              className={cn(
                "grid place-items-center transition-transform duration-200 ease-out group-hover:-translate-y-0.5",
                card ? "size-[76px]" : "size-[52px]",
              )}
            >
              <Softie
                kind={s.kind}
                color={hex}
                size={card ? 68 : 44}
                state={on && card ? "done" : "idle"}
                animated={on}
              />
            </span>
            <span className={cn("font-semibold", card ? "mt-1.5 text-base" : "text-xs")}>{s.name}</span>
            {card && (
              <>
                <span className="font-medium text-muted text-xs">{s.role}</span>
                <span className="mt-1.5 text-balance text-fg-2 text-xs leading-snug">{s.hint}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-2 font-medium text-2xs text-muted uppercase tracking-[0.08em]">{title}</div>
      {children}
    </div>
  );
}

/**
 * An agent's look: one of the six Softies, in its own colour or one of the ten, or an uploaded photo (which wins).
 * Older avatars show as the Softie they map to, so editing starts from what's on screen.
 */
export function AvatarStudio({
  value,
  onChange,
  primary,
}: {
  value: AvatarData;
  onChange: (a: AvatarData) => void;
  /** The main agent: an older avatar shows as Yo. */
  primary?: boolean;
}) {
  const [preview, setPreview] = useState<SoftieState>("idle");
  const [replay, setReplay] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const look = softieOf(value, { primary });
  const custom = value.softie?.color;
  const pick = (kind: SoftieKind) => onChange(softieAvatar(kind, custom));
  const recolor = (hex: string | undefined) => onChange(softieAvatar(look.kind, hex));

  return (
    <div className="flex gap-6" data-testid="avatar-studio">
      <div className="flex w-[188px] shrink-0 flex-col items-center">
        <div
          className="relative grid aspect-square w-full place-items-center rounded-2xl border border-border bg-[radial-gradient(circle_at_50%_42%,color-mix(in_oklab,var(--softie)_10%,var(--elevated)),var(--bg)_78%)]"
          style={tint(look.color)}
        >
          {value.image ? (
            <Avatar avatar={value} size={120} state="idle" />
          ) : (
            <Softie
              key={`${preview}-${replay}`}
              kind={look.kind}
              color={look.color}
              size={120}
              state={preview}
            />
          )}
          {value.image && (
            <button
              type="button"
              aria-label="Remove photo"
              data-testid="avatar-remove-photo"
              onClick={() => onChange({ ...value, image: undefined })}
              className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-elevated text-muted shadow-soft hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {!value.image && (
          <div className="mt-2.5 flex flex-wrap justify-center gap-1" data-testid="avatar-states">
            {PREVIEW_STATES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={preview === s}
                data-testid={`preview-${s}`}
                onClick={() => {
                  setPreview(s);
                  setReplay((n) => n + 1);
                }}
                className={cn(
                  "rounded-full px-2 py-0.5 text-2xs transition-colors",
                  preview === s ? "bg-fg text-bg" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                {SOFTIE_STATE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
        <Button
          variant="secondary"
          size="sm"
          className="mt-3 w-full"
          onClick={() => file.current?.click()}
          data-testid="avatar-upload"
        >
          <ImageUp className="size-3.5" /> {value.image ? "Change photo" : "Use a photo"}
        </Button>
        <input
          ref={file}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) onChange({ ...softieAvatar(look.kind, custom), image: await readFileDataUrl(f) });
            e.target.value = "";
          }}
        />
      </div>

      <div className="min-w-0 flex-1 space-y-5">
        <Group title="Character">
          <SoftieGrid value={value.image ? null : look.kind} color={look.color} onPick={pick} />
        </Group>
        <Group title="Colour">
          <SoftieColors kind={look.kind} value={value.image ? "" : look.color} onPick={recolor} />
        </Group>
      </div>
    </div>
  );
}
