import type { BriefItem, MorningBrief, TimelineEntry } from "@yo/contracts";
import { ArrowRight, Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useApp } from "../../stores/app";
import { composerBus } from "./Composer";

/** Rows a section shows before "Show N more". */
const FOLD_AT = 3;

/** The hour in the owner's time zone (the device's if it's unknown). */
function hourIn(at: number, tz: string): number {
  try {
    return Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(at),
    );
  } catch {
    return new Date(at).getHours();
  }
}

/** "Morning" / "Afternoon" / "Evening", for when the brief was posted. */
export function briefGreeting(at: number, tz: string): string {
  const h = hourIn(at, tz);
  if (h >= 4 && h < 12) return "Morning";
  if (h >= 12 && h < 17) return "Afternoon";
  return "Evening";
}

function dateLine(at: number, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(at);
  }
}

/** The rows of a brief the user started, kept per brief so a reload still says "Started". */
const startedKey = (entryId: string) => `yo.briefStarted.${entryId}`;

function readStarted(entryId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(startedKey(entryId)) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveStarted(entryId: string, titles: string[]) {
  try {
    localStorage.setItem(startedKey(entryId), JSON.stringify(titles));
  } catch {
    /* private mode: it only lasts until a reload */
  }
}

function Section({
  label,
  testId,
  rows,
  render,
}: {
  label: string;
  testId: string;
  rows: number;
  render: (i: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!rows) return null;
  // One row over isn't worth a "Show 1 more".
  const folded = !open && rows > FOLD_AT + 1;
  const shown = folded ? FOLD_AT : rows;
  return (
    <section className="ycard-section" data-testid={testId} aria-label={label}>
      <h3>{label}</h3>
      <ul>
        {Array.from({ length: shown }, (_, i) => (
          <li key={i}>{render(i)}</li>
        ))}
      </ul>
      {folded && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Show ${rows - shown} more in ${label}`}
          className="ycard-link"
          data-testid="brief-more"
        >
          Show {rows - shown} more
        </button>
      )}
    </section>
  );
}

function NeedsRow({ item, started, onStart }: { item: BriefItem; started: boolean; onStart: () => void }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="ycard-row-title">{item.title}</span>
      {item.detail && <span className="ycard-row-detail">{item.detail}</span>}
      <div className="flex">
        {started ? (
          <span className="ycard-link is-done animate-fade-in" data-testid="brief-started">
            <Check className="size-3.5" strokeWidth={2.4} />
            Started
          </span>
        ) : (
          <button
            type="button"
            onClick={onStart}
            aria-label={`Start: ${item.title}`}
            className="ycard-link"
            data-testid="brief-start"
          >
            Start
            <ArrowRight className="size-3.5" strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}

function PlainRow({ item }: { item: BriefItem }) {
  return (
    <div className="flex min-w-0 gap-3">
      {item.time && <span className="ycard-row-time">{item.time}</span>}
      <div className="flex min-w-0 flex-col">
        <span className="ycard-row-title is-plain">{item.title}</span>
        {item.detail && <span className="ycard-row-detail">{item.detail}</span>}
      </div>
    </div>
  );
}

/**
 * The morning brief (post_brief): the date, a greeting, what needs the user (each with Start, which sends Yo
 * "Take care of: {title}" as the user's message), what can wait, today's calendar, and what Yo couldn't check.
 */
export function BriefCard({ entry, brief }: { entry: TimelineEntry; brief: MorningBrief }) {
  const userName = useApp((s) => s.settings.userName?.trim());
  const tz = useApp((s) => s.settings.timezone);
  const [started, setStarted] = useState(() => readStarted(entry.id));
  const at = entry.createdAt || Date.now();
  const start = (item: BriefItem) => {
    if (!composerBus.sendPlain) return;
    // Exactly what the row shows: Yo's own `start` note stays in its post_brief call, never in the user's voice.
    composerBus.sendPlain(`Take care of: ${item.title}`);
    const next = [...started, item.title];
    setStarted(next);
    saveStarted(entry.id, next);
  };
  const empty = !brief.needsYou.length && !brief.canWait.length && !brief.today.length;
  return (
    <div
      role="region"
      aria-label="Morning brief"
      data-testid="brief-card"
      className="ycard ycard-max ycard-brief animate-rise"
    >
      <p className="ycard-eyebrow is-plain">{dateLine(at, tz)}</p>
      <p className="ycard-brief-title">
        {briefGreeting(at, tz)}
        {userName ? `, ${userName}` : ""}.
      </p>
      {empty && <p className="ycard-row-detail">Nothing new needs you, and your calendar is clear today.</p>}
      <Section
        label="Needs you"
        testId="brief-section-needs"
        rows={brief.needsYou.length}
        render={(i) => {
          const item = brief.needsYou[i]!;
          return <NeedsRow item={item} started={started.includes(item.title)} onStart={() => start(item)} />;
        }}
      />
      <Section
        label="Can wait"
        testId="brief-section-wait"
        rows={brief.canWait.length}
        render={(i) => <PlainRow item={brief.canWait[i]!} />}
      />
      <Section
        label="Today"
        testId="brief-section-today"
        rows={brief.today.length}
        render={(i) => <PlainRow item={brief.today[i]!} />}
      />
      {brief.couldNotCheck.length > 0 && (
        <ul className="ycard-brief-foot" data-testid="brief-could-not-check">
          {brief.couldNotCheck.map((n) => (
            <li key={n.source}>
              Couldn't check {n.source}: {n.why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
