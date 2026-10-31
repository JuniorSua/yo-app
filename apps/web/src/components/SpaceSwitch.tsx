/**
 * Work · Personal. The sidebar's title is the current space ("Work ▾", with "Auto · until 7 PM" under it), and it
 * opens the menu: Auto / Work / Personal, then the work hours. Personal time keeps the same calm look; only the
 * title and the main agent (Pip) change. Renders nothing unless spaces are on and the Personal agent exists (an
 * older core, or spaces turned off).
 */
import { type AgentView, describeActive, describeWorkHours, SPACE_LABELS, type Space } from "@yo/contracts";
import { Briefcase, CalendarClock, Check, ChevronDown, Clock3, House } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { cn, modKey } from "../lib/utils";
import { useApp } from "../stores/app";
import { agentOf, setAutoSwitch, switchSpace, useSpace } from "../stores/space";
import { ui } from "../stores/ui";
import { AgentAvatar } from "./brand";
import { Button } from "./ui/button";
import { Popover } from "./ui/overlay";

export const SPACE_ICON = { work: Briefcase, personal: House } as const;

/** "Mon–Fri 11:00 AM–7:00 PM" → "Mon–Fri 11 AM–7 PM". */
export const shortHours = (text: string) => text.replace(/:00/g, "");

/** The caption under/next to the switch, kept fresh once a minute ("until 7 PM" becomes "until Mon 11 AM"). */
export function useSpaceCaption(): string {
  const view = useSpace();
  const tz = useApp((s) => s.settings.timezone);
  return shortHours(describeActive(view, view.at, tz));
}

function useLeads(): Record<Space, AgentView | undefined> {
  const work = useApp((s) => agentOf(s.agents, "work", true));
  const personal = useApp((s) => agentOf(s.agents, "personal", true));
  return { work, personal };
}

const timeOf = (t: number, tz: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz })
      .format(t)
      .replace(":00", "");
  } catch {
    return "";
  }
};

/** Auto / Work / Personal, then the work hours. Shared by the header caption and the rail badge. */
export function SpaceMenu({
  trigger,
  side = "bottom",
  align = "start",
}: {
  trigger: ReactElement;
  side?: "top" | "bottom" | "right";
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const view = useSpace();
  const tz = useApp((s) => s.settings.timezone);
  const hours = useApp((s) => s.settings.workHours);
  const leads = useLeads();
  const auto = view.source === "schedule";
  const pick = (id: Space | "auto") => {
    setOpen(false);
    if (id === "auto") void setAutoSwitch(true);
    else void switchSpace(id);
  };
  const held = (s: Space) => {
    if (auto || view.space !== s) return null;
    if (view.source === "pinned" || view.until === null) return "Stays on until you switch";
    return `Until ${timeOf(view.until, tz)}, then back to Auto`;
  };
  const rows = [
    {
      id: "auto" as const,
      icon: (
        <span className="space-menu-icon is-glyph">
          <CalendarClock />
        </span>
      ),
      label: "Auto",
      sub:
        auto && view.until
          ? `${SPACE_LABELS[view.space]} now · switches at ${timeOf(view.until, tz)}`
          : "Follow your work hours",
      on: auto,
    },
    ...(["work", "personal"] as const).map((s) => ({
      id: s,
      icon: (
        <span className="space-menu-icon">
          {leads[s] ? <AgentAvatar agent={leads[s]} size={28} quiet /> : null}
        </span>
      ),
      label: SPACE_LABELS[s],
      sub: held(s) ?? `${leads[s]?.name ?? ""} · ${s === "work" ? "work" : "personal"} memory`,
      on: !auto && view.space === s,
    })),
  ];
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={trigger}
      side={side}
      align={align}
      sideOffset={side === "right" ? 12 : 8}
      className="space-menu"
    >
      <div data-testid="space-menu">
        <div className="space-menu-head">
          <span>Space</span>
          <kbd>{modKey}⇧M</kbd>
        </div>
        {rows.map((r, i) => (
          <div key={r.id}>
            {i === 1 && <div className="space-menu-sep" />}
            <button
              className={cn("space-menu-row", r.on && "is-on")}
              onClick={() => pick(r.id)}
              aria-pressed={r.on}
              data-testid={`space-menu-${r.id}`}
            >
              {r.icon}
              <span className="min-w-0 flex-1">
                <b>{r.label}</b>
                <small>{r.sub}</small>
              </span>
              {r.on && <Check />}
            </button>
          </div>
        ))}
        <div className="space-menu-foot">
          <span>
            Work hours: <span className="text-fg-2">{shortHours(describeWorkHours(hours))}</span>
          </span>
          <button
            data-testid="space-menu-hours"
            onClick={() => {
              setOpen(false);
              ui.openSettings("spaces");
            }}
          >
            Edit
          </button>
        </div>
      </div>
    </Popover>
  );
}

/** The sidebar's title: the current space, which opens the space menu, and the one-time intro under it. */
export function SpaceTitle() {
  const available = useSpace((s) => s.available);
  const space = useSpace((s) => s.space);
  const manual = useSpace((s) => s.source === "manual" || s.source === "pinned");
  const caption = useSpaceCaption();
  if (!available) return null;
  return (
    <span className="space-title-wrap" data-testid="space-switch">
      <SpaceMenu
        trigger={
          <button
            type="button"
            className="space-title"
            data-testid="space-rail"
            data-space={space}
            aria-label={`Space: ${SPACE_LABELS[space]}. ${caption}. Space options`}
          >
            <span className="space-title-name">
              {SPACE_LABELS[space]}
              <ChevronDown aria-hidden />
            </span>
            <span className={cn("space-title-caption", manual && "is-manual")} data-testid="space-status">
              {caption}
            </span>
          </button>
        }
      />
      <SpaceIntro />
    </span>
  );
}

/* --------------------------------------------- Intro --------------------------------------------- */

export const SPACES_INTRO_KEY = "yo.spacesIntro";

function introSeen(): boolean {
  try {
    return localStorage.getItem(SPACES_INTRO_KEY) === "1";
  } catch {
    return true;
  }
}

function markIntroSeen() {
  try {
    localStorage.setItem(SPACES_INTRO_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** Once: who the Personal agent is and when Work hours are, with a way to change them. */
function SpaceIntro() {
  const [show, setShow] = useState(() => !introSeen());
  const leads = useLeads();
  const hours = useApp((s) => s.settings.workHours);
  const space = useSpace((s) => s.space);
  // Switching by hand means they've found it.
  const [first] = useState(space);
  useEffect(() => {
    if (show && space !== first) close();
  });
  const close = () => {
    markIntroSeen();
    setShow(false);
  };
  const pip = leads.personal;
  if (!show || !pip) return null;
  return (
    <div
      className="space-intro"
      role="dialog"
      aria-label={`Meet ${pip.name}`}
      data-space-intro
      data-testid="space-intro"
    >
      <div className="flex items-start gap-3">
        <AgentAvatar agent={pip} size={40} quiet />
        <div className="min-w-0 flex-1">
          <strong>Meet {pip.name}, your personal-time agent</strong>
          {leads.work?.name ?? "Yo"} keeps Work. Outside your work hours, {pip.name} takes over for plans,
          errands, family and fun, with its own memory.
        </div>
      </div>
      <div className="space-intro-hours">
        <Clock3 />
        Work hours · {shortHours(describeWorkHours(hours))}
      </div>
      <div className="space-intro-actions">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            close();
            ui.openSettings("spaces");
          }}
          data-testid="space-intro-hours"
        >
          Change hours
        </Button>
        <Button size="sm" variant="primary" onClick={close} data-testid="space-intro-ok">
          Got it
        </Button>
      </div>
    </div>
  );
}
