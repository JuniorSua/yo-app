import {
  AGENT_TEMPLATES,
  Avatar,
  CREATURE_ORDER,
  type CreatureId,
  creatureAvatar,
  creatureInfo,
  type TurnInfo,
  YoLogo,
  YoWordmark,
} from "@yo/avatar";
import type { AgentActivity } from "@yo/contracts";
import { AVATAR_ACCESSORIES, AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES } from "@yo/contracts";

const STATES: AgentActivity[] = ["idle", "working", "waiting", "done", "error", "sleeping"];

/** The creature poses in activity order; "thinking" is a working turn that isn't using a tool. */
const CREATURE_SHEET: { label: string; state: AgentActivity; turn?: TurnInfo }[] = [
  { label: "Idle", state: "idle" },
  { label: "Working", state: "working" },
  { label: "Thinking", state: "working", turn: { toolRunning: false, lastKind: "reasoning" } },
  { label: "Needs you", state: "waiting" },
  { label: "Done", state: "done" },
  { label: "Asleep", state: "sleeping" },
  { label: "Error", state: "error" },
];

/** Every pose of one creature, as the app's still pictures (/?gallery=1&creature=sprout). */
function CreatureSheet({ kind, size = 132 }: { kind: CreatureId; size?: number }) {
  return (
    <div
      data-testid={`creature-sheet-${kind}`}
      className="w-fit rounded-2xl border border-border bg-card p-6"
    >
      <div className="mb-4 font-semibold text-lg">
        {creatureInfo(kind).name}{" "}
        <span className="font-normal text-muted text-sm">· {creatureInfo(kind).species}</span>
      </div>
      <div className="flex gap-5">
        {CREATURE_SHEET.map((s) => (
          <div key={s.label} className="flex flex-col items-center gap-2 text-muted text-sm">
            <div className="grid place-items-center p-3">
              <Avatar avatar={creatureAvatar(kind)} size={size} state={s.state} turn={s.turn} />
            </div>
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Dev-only visual QA sheet for every avatar shape, eye, accessory and state (/?gallery=1). */
export function AvatarGallery() {
  const colors = AVATAR_COLORS.map((c) => c.id);
  const q = new URLSearchParams(location.search);
  const theme = q.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.className = theme;
  const only = q.get("creature");
  if (only && (CREATURE_ORDER as string[]).includes(only))
    return (
      <div className="h-full bg-bg p-8 text-fg">
        <CreatureSheet kind={only as CreatureId} />
      </div>
    );
  return (
    <div className="scroll-fade h-full overflow-y-auto p-10 text-fg" data-testid="avatar-gallery">
      <h2 className="mb-3 font-semibold">Creatures</h2>
      <div className="mb-8 flex flex-col gap-4">
        {CREATURE_ORDER.map((kind) => (
          <CreatureSheet key={kind} kind={kind} size={88} />
        ))}
      </div>
      <div className="mb-8 flex items-center gap-8">
        <YoWordmark size={40} animated />
        <YoLogo size={96} animated />
        <YoLogo size={96} animated state="working" />
        <YoLogo size={96} animated state="waiting" />
      </div>
      <h2 className="mb-3 font-semibold">Shapes × eyes</h2>
      <div className="mb-8 grid grid-cols-8 gap-4">
        {AVATAR_SHAPES.flatMap((shape, i) =>
          AVATAR_EYES.map((eyes) => (
            <Avatar
              key={`${shape}-${eyes}`}
              avatar={{ shape, eyes, color: colors[(i * 3) % 12]!, accessory: "none" }}
              size={88}
              animated={false}
            />
          )),
        )}
      </div>
      <h2 className="mb-3 font-semibold">Accessories</h2>
      <div className="mb-8 flex flex-wrap gap-4">
        {AVATAR_ACCESSORIES.flatMap((accessory, i) =>
          (["squircle", "drop", "cloud"] as const).map((shape) => (
            <Avatar
              key={`${accessory}-${shape}`}
              avatar={{ shape, eyes: "capsule", color: colors[(i + 2) % 12]!, accessory }}
              size={88}
              animated={false}
            />
          )),
        )}
      </div>
      <h2 className="mb-3 font-semibold">States</h2>
      <div className="mb-8 flex gap-6">
        {STATES.map((s) => (
          <div key={s} className="flex flex-col items-center gap-2 text-muted text-sm">
            <Avatar avatar={AGENT_TEMPLATES[0]!.avatar} size={96} state={s} ground />
            {s}
          </div>
        ))}
      </div>
      <h2 className="mb-3 font-semibold">Templates</h2>
      <div className="flex gap-6">
        {AGENT_TEMPLATES.map((t) => (
          <div key={t.id} className="flex flex-col items-center gap-2 text-muted text-sm">
            <Avatar avatar={t.avatar} size={112} ground />
            {t.name}
          </div>
        ))}
      </div>
    </div>
  );
}
