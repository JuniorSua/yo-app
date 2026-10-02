import {
  AVATAR_PRESETS,
  Avatar,
  CUPCAT_VARIANTS,
  type CupCatVariant,
  cupCatVariant,
  EYE_LABELS,
  LIVING_CHARACTERS_INFO,
  LIVING_ORDER,
  type LivingCharacterId,
  livingAvatar,
  RARITY_COLOR,
  RARITY_LABEL,
  randomAvatar,
  rollCupCat,
  SHAPE_LABELS,
} from "@yo/avatar";
import type { AgentActivity, Avatar as AvatarData } from "@yo/contracts";
import { AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES } from "@yo/contracts";
import { Box, ChevronDown, Dices, ImageUp, Lock, Sparkles, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn, readFileDataUrl } from "../lib/utils";
import { Button } from "./ui/button";
import { Tip } from "./ui/overlay";

const STATES: { value: AgentActivity; label: string }[] = [
  { value: "idle", label: "Idle" },
  { value: "working", label: "Working" },
  { value: "waiting", label: "Needs you" },
  { value: "done", label: "Done" },
  { value: "sleeping", label: "Asleep" },
];

/** Copilot-style shapes (CupCats are rolled, not shaped). */
const COPILOT_SHAPES = AVATAR_SHAPES.filter((s) => s !== "cupcat");

const cupcatAvatar = (v: CupCatVariant): AvatarData => ({
  shape: "cupcat",
  color: "yo",
  eyes: "capsule",
  accessory: "headset",
  variant: v.id,
});

function Tile({
  active,
  onClick,
  children,
  label,
  testId,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  label: string;
  testId?: string;
  className?: string;
}) {
  return (
    <Tip label={label}>
      <button
        aria-label={label}
        aria-pressed={active}
        data-testid={testId}
        onClick={onClick}
        className={cn(
          "grid aspect-square place-items-center rounded-xl border transition-all duration-150",
          active
            ? "border-fg/70 bg-active shadow-soft"
            : "border-border bg-bg/40 hover:border-border-strong hover:bg-hover",
          className,
        )}
      >
        {children}
      </button>
    </Tip>
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

function RarityPill({ v }: { v: CupCatVariant }) {
  const c = RARITY_COLOR[v.rarity];
  return (
    <span
      data-testid="cupcat-rarity"
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-semibold text-2xs",
        v.rarity === "legendary" && "yo-legendary",
      )}
      style={{ color: c, background: `${c}1f`, boxShadow: `inset 0 0 0 1px ${c}55` }}
    >
      {v.rarity === "legendary" && <Sparkles className="size-3" />}
      {RARITY_LABEL[v.rarity]} · {v.odds}%
    </span>
  );
}

/** Your one-and-only CupCat: who you got and the odds. You roll once; the cat stays. */
function CupCatCard({ value, rolling }: { value: AvatarData; rolling: boolean }) {
  const v = cupCatVariant(value.variant);
  const [showOdds, setShowOdds] = useState(false);
  return (
    <div className="rounded-2xl border border-border bg-bg/40 p-4" data-testid="cupcat-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-2xs text-muted uppercase tracking-[0.08em]">Your CupCat</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-semibold text-lg tracking-[-0.01em]" data-testid="cupcat-name">
              {rolling ? "Rolling…" : v.name}
            </span>
            {!rolling && <span className="text-muted text-sm">{v.jp}</span>}
          </div>
          <div className="mt-1.5 h-5">{!rolling && <RarityPill v={v} />}</div>
        </div>
        {!rolling && (
          <span
            data-testid="cupcat-locked"
            className="flex shrink-0 items-center gap-1 rounded-full bg-active px-2 py-1 text-2xs text-muted"
          >
            <Lock className="size-3" /> Yours for good
          </span>
        )}
      </div>
      <p className="mt-3 text-muted text-xs leading-relaxed">
        Every CupCat is one of 15. You roll once and the cat you get stays with this agent — rarer cats are
        harder to get.
      </p>
      <button
        onClick={() => setShowOdds((s) => !s)}
        className="mt-2 flex items-center gap-1 text-muted text-xs hover:text-fg"
        data-testid="cupcat-odds-toggle"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", showOdds && "rotate-180")} /> See the odds
      </button>
      {showOdds && (
        <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-1.5" data-testid="cupcat-odds">
          {CUPCAT_VARIANTS.map((c) => (
            <div key={c.id} className="flex items-center gap-2 text-xs">
              <Avatar avatar={cupcatAvatar(c)} size={22} animated={false} />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="font-medium tabular-nums" style={{ color: RARITY_COLOR[c.rarity] }}>
                {c.odds}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Body + headset colours for a living character. */
function LivingEditor({
  value,
  onPick,
}: {
  value: AvatarData;
  onPick: (id: LivingCharacterId, body?: string, headset?: string) => void;
}) {
  const living = value.living!;
  const c = LIVING_CHARACTERS_INFO[living.character];
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-bg/40 p-4" data-testid="living-editor">
      <div>
        <div className="font-semibold">{c.name}</div>
        <div className="text-muted text-xs">
          {c.tagline}. Sleeps when idle, reads and looks around while working, and glows with "?" eyes when it
          needs you.
        </div>
      </div>
      <Group title="Body">
        <div className="flex flex-wrap gap-2">
          {c.bodies.map((b) => (
            <Tip key={b.id} label={b.name}>
              <button
                aria-label={b.name}
                data-testid={`living-body-${b.id}`}
                onClick={() => onPick(c.id, b.id, living.headset)}
                className={cn(
                  "size-7 rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110",
                  living.body === b.id ? "ring-2 ring-fg" : "ring-1 ring-black/10",
                )}
                style={{
                  background: `radial-gradient(circle at 35% 30%, ${b.swatch[2]}, ${b.swatch[1]} 55%, ${b.swatch[0]})`,
                }}
              />
            </Tip>
          ))}
        </div>
      </Group>
      <Group title="Headset">
        <div className="flex flex-wrap gap-2">
          {c.headsets.map((h) => (
            <Tip key={h.id} label={h.name}>
              <button
                aria-label={`${h.name} headset`}
                data-testid={`living-headset-${h.id}`}
                onClick={() => onPick(c.id, living.body, h.id)}
                className={cn(
                  "size-7 rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110",
                  living.headset === h.id ? "ring-2 ring-fg" : "ring-1 ring-black/10",
                )}
                style={{ background: `linear-gradient(135deg, ${h.swatch[1]}, ${h.swatch[0]})` }}
              />
            </Tip>
          ))}
        </div>
      </Group>
    </div>
  );
}

export function AvatarStudio({ value, onChange }: { value: AvatarData; onChange: (a: AvatarData) => void }) {
  const [preview, setPreview] = useState<AgentActivity>("idle");
  const [anim, setAnim] = useState(0);
  const [rolling, setRolling] = useState<AvatarData | null>(null);
  const timer = useRef<number | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const isCat = value.shape === "cupcat" && !value.image;
  const isLiving = !!value.living && !value.image;
  // Every Yo worker wears the headset (they're listening), so edits always keep it on. A rolled CupCat is
  // remembered (variant) so switching away and back brings the same cat — you only roll once per agent.
  const set = (patch: Partial<AvatarData>) =>
    onChange({ ...value, living: undefined, ...patch, accessory: "headset" });
  const mini = (patch: Partial<AvatarData>): AvatarData => ({
    ...value,
    ...(value.shape === "cupcat" ? { shape: "squircle" as const } : {}),
    image: undefined,
    living: undefined,
    accessory: "headset",
    ...patch,
  });
  const pickLiving = (id: LivingCharacterId, body?: string, headset?: string) =>
    onChange({ ...livingAvatar(id, body, headset), variant: value.variant });
  const pickCat = () => {
    const kept = value.variant ? CUPCAT_VARIANTS.find((c) => c.id === value.variant) : undefined;
    if (kept) onChange(cupcatAvatar(kept));
    else roll();
  };

  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  /** Gacha roll: shuffle through cats for a moment, then land on a weighted pick. */
  const roll = () => {
    if (value.variant) return; // one roll per agent
    if (timer.current) window.clearInterval(timer.current);
    const result = rollCupCat();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      onChange(cupcatAvatar(result));
      return;
    }
    let ticks = 0;
    setRolling(cupcatAvatar(CUPCAT_VARIANTS[Math.floor(Math.random() * CUPCAT_VARIANTS.length)]!));
    timer.current = window.setInterval(() => {
      ticks++;
      if (ticks >= 12) {
        if (timer.current) window.clearInterval(timer.current);
        timer.current = null;
        setRolling(null);
        onChange(cupcatAvatar(result));
        setPreview("done");
        setAnim((n) => n + 1);
        return;
      }
      setRolling(cupcatAvatar(CUPCAT_VARIANTS[Math.floor(Math.random() * CUPCAT_VARIANTS.length)]!));
    }, 70);
  };

  const shown = rolling ?? value;
  const copilotActive =
    !value.image &&
    !value.living &&
    value.shape === AVATAR_PRESETS[0]!.avatar.shape &&
    value.color === AVATAR_PRESETS[0]!.avatar.color &&
    value.finish === "dimensional";

  return (
    <div className="flex gap-5" data-testid="avatar-studio">
      <div className="flex w-[196px] shrink-0 flex-col items-center">
        <div className="relative grid aspect-square w-full place-items-center rounded-2xl border border-border bg-[radial-gradient(circle_at_50%_40%,var(--elevated),var(--bg))]">
          <Avatar
            key={`${preview}-${anim}`}
            avatar={shown}
            size={isCat || rolling || isLiving ? 150 : 132}
            state={rolling ? "idle" : preview}
            animated={!rolling}
            ground
          />
          {value.image && (
            <button
              aria-label="Remove image"
              onClick={() => set({ image: undefined })}
              className="absolute top-2 right-2 grid size-6 place-items-center rounded-full bg-elevated text-muted shadow-soft hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap justify-center gap-1">
          {STATES.map((s) => (
            <button
              key={s.value}
              onClick={() => {
                setPreview(s.value);
                setAnim((n) => n + 1);
              }}
              className={cn(
                "rounded-full px-2 py-0.5 text-2xs transition-colors",
                preview === s.value ? "bg-fg text-bg" : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="mt-3 flex w-full gap-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1"
            disabled={isCat}
            onClick={() => {
              if (isLiving) {
                const id = LIVING_ORDER[Math.floor(Math.random() * LIVING_ORDER.length)]!;
                const c = LIVING_CHARACTERS_INFO[id];
                const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
                pickLiving(id, pick(c.bodies).id, pick(c.headsets).id);
              } else
                onChange({
                  ...randomAvatar(),
                  finish: value.finish ?? "dimensional",
                  variant: value.variant,
                });
            }}
            data-testid="avatar-randomize"
          >
            <Dices className="size-3.5" /> Randomize
          </Button>
          <Tip label="Upload an image">
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="Upload image"
              onClick={() => file.current?.click()}
            >
              <ImageUp className="size-3.5" />
            </Button>
          </Tip>
          <input
            ref={file}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) set({ image: await readFileDataUrl(f) });
              e.target.value = "";
            }}
          />
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-start gap-5">
          <Group title="Living characters">
            <div className="grid grid-cols-3 gap-1.5">
              {LIVING_ORDER.map((id) => {
                const c = LIVING_CHARACTERS_INFO[id];
                return (
                  <Tile
                    key={id}
                    label={`${c.name} — ${c.tagline.toLowerCase()}. Moves with what the agent is doing.`}
                    active={isLiving && value.living?.character === id}
                    onClick={() => pickLiving(id)}
                    testId={`living-${id}`}
                    className="w-[64px]"
                  >
                    <Avatar avatar={livingAvatar(id)} size={46} state="done" quiet animated={false} />
                  </Tile>
                );
              })}
            </div>
          </Group>
          <Group title="Classic">
            <div className="grid grid-cols-2 gap-1.5">
              <Tile
                label="Violet Copilot — drawn, fully customizable."
                active={copilotActive}
                onClick={() => onChange({ ...AVATAR_PRESETS[0]!.avatar, variant: value.variant })}
                testId="preset-violet-copilot"
                className="w-[64px]"
              >
                <Avatar avatar={AVATAR_PRESETS[0]!.avatar} size={48} animated={false} />
              </Tile>
              <Tile
                label={
                  value.variant
                    ? "Your CupCat (rolled once, yours for good)"
                    : "CupCat — roll once for one of 15 cats (some are very rare)"
                }
                active={isCat}
                onClick={pickCat}
                testId="preset-cupcat"
                className="relative w-[64px]"
              >
                {isCat || value.variant ? (
                  <Avatar
                    avatar={
                      isCat ? value : cupcatAvatar(CUPCAT_VARIANTS.find((c) => c.id === value.variant)!)
                    }
                    size={48}
                    animated={false}
                  />
                ) : (
                  <span className="relative grid place-items-center">
                    <Avatar
                      avatar={cupcatAvatar(CUPCAT_VARIANTS[0]!)}
                      size={48}
                      animated={false}
                      style={{ filter: "brightness(0) saturate(0)", opacity: 0.28 }}
                    />
                    <span className="absolute font-bold text-lg text-muted">?</span>
                  </span>
                )}
              </Tile>
            </div>
          </Group>
        </div>

        {isLiving ? <LivingEditor value={value} onPick={pickLiving} /> : null}
        {isLiving ? null : isCat || rolling ? (
          <CupCatCard value={value} rolling={!!rolling} />
        ) : (
          <>
            <Group title="Finish">
              <div className="flex w-fit rounded-xl border border-border bg-bg/40 p-0.5" role="radiogroup">
                {(
                  [
                    { id: "dimensional", label: "3D", icon: Box },
                    { id: "flat", label: "Flat", icon: Square },
                  ] as const
                ).map((f) => {
                  const active = (value.finish ?? "flat") === f.id;
                  return (
                    <button
                      key={f.id}
                      role="radio"
                      aria-checked={active}
                      data-testid={`finish-${f.id}`}
                      onClick={() =>
                        set({ finish: f.id === "flat" ? undefined : "dimensional", image: undefined })
                      }
                      className={cn(
                        "flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-xs transition-colors",
                        active ? "bg-fg text-bg" : "text-muted hover:text-fg",
                      )}
                    >
                      <f.icon className="size-3.5" /> {f.label}
                    </button>
                  );
                })}
              </div>
            </Group>
            <Group title="Shape">
              <div className="grid grid-cols-8 gap-1.5">
                {COPILOT_SHAPES.map((s) => (
                  <Tile
                    key={s}
                    label={SHAPE_LABELS[s] ?? s}
                    active={value.shape === s && !value.image}
                    onClick={() => set({ shape: s, image: undefined })}
                    testId={`shape-${s}`}
                  >
                    <Avatar
                      avatar={mini({ shape: s })}
                      size={30}
                      animated={false}
                      style={{ width: "62%", height: "auto" }}
                    />
                  </Tile>
                ))}
              </div>
            </Group>
            <div className="grid grid-cols-[1fr_auto] gap-4">
              <Group title="Color">
                <div className="flex flex-wrap gap-[7px]">
                  {AVATAR_COLORS.map((c) => (
                    <Tip key={c.id} label={c.name}>
                      <button
                        aria-label={c.name}
                        data-testid={`color-${c.id}`}
                        onClick={() => set({ color: c.id })}
                        className={cn(
                          "size-6 rounded-full ring-offset-2 ring-offset-card transition-transform hover:scale-110",
                          value.color === c.id ? "ring-2 ring-fg" : "ring-1 ring-black/10",
                        )}
                        style={{ background: c.hex }}
                      />
                    </Tip>
                  ))}
                </div>
              </Group>
              <Group title="Eyes">
                <div className="grid grid-cols-4 gap-1.5">
                  {AVATAR_EYES.map((e) => (
                    <Tile
                      key={e}
                      label={EYE_LABELS[e] ?? e}
                      active={value.eyes === e}
                      onClick={() => set({ eyes: e })}
                      testId={`eyes-${e}`}
                    >
                      <Avatar
                        avatar={mini({ eyes: e })}
                        size={30}
                        animated={false}
                        style={{ width: "34px", height: "auto" }}
                      />
                    </Tile>
                  ))}
                </div>
              </Group>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
