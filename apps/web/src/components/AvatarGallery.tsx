import { AGENT_TEMPLATES, Avatar, YoLogo, YoWordmark } from "@yo/avatar";
import type { AgentActivity } from "@yo/contracts";
import { AVATAR_ACCESSORIES, AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES } from "@yo/contracts";

const STATES: AgentActivity[] = ["idle", "working", "waiting", "done", "error", "sleeping"];

/** Dev-only visual QA sheet for every avatar shape, eye, accessory and state (/?gallery=1). */
export function AvatarGallery() {
  const colors = AVATAR_COLORS.map((c) => c.id);
  return (
    <div className="scroll-fade h-full overflow-y-auto p-10 text-fg" data-testid="avatar-gallery">
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
