/**
 * An update being applied, as steps with real states (lib/updates.ts applySteps): done, the current one with a
 * spinner and a line on what it's doing, and the ones still to come. Shown in the update window.
 */
import { Check } from "lucide-react";
import type { ApplyStep } from "../lib/updates";
import { cn } from "../lib/utils";
import { Spinner } from "./ui/controls";

export function ApplySteps({ steps, className }: { steps: ApplyStep[]; className?: string }) {
  return (
    <ol data-testid="update-steps" className={cn("space-y-2.5", className)}>
      {steps.map((s) => (
        <li key={s.id} data-testid={`update-step-${s.id}`} data-state={s.state} className="flex gap-3">
          <StepMark state={s.state} />
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                "text-base transition-colors duration-200 motion-reduce:transition-none",
                s.state === "active"
                  ? "font-medium text-fg"
                  : s.state === "done"
                    ? "text-fg-2"
                    : "text-faint",
              )}
            >
              {s.label}
            </div>
            {s.detail && <div className="text-muted text-sm">{s.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepMark({ state }: { state: ApplyStep["state"] }) {
  if (state === "done")
    return (
      <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-success/15 text-success animate-pop">
        <Check className="size-3" strokeWidth={2.6} aria-hidden />
        <span className="sr-only">Done:</span>
      </span>
    );
  if (state === "active")
    return (
      <span className="mt-px grid size-5 shrink-0 place-items-center text-brand-ink">
        <Spinner className="size-4" />
        <span className="sr-only">Now:</span>
      </span>
    );
  return (
    <span className="mt-px grid size-5 shrink-0 place-items-center" aria-hidden>
      <span className="size-2 rounded-full border-[1.5px] border-faint/70" />
    </span>
  );
}
