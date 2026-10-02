/** Small layout pieces shared by the Settings sections. */
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Row({
  title,
  desc,
  descId,
  children,
  className,
}: {
  title: string;
  desc?: ReactNode;
  /** id for the description, so the control can point at it with aria-describedby. */
  descId?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-6 py-3.5", className)}>
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        {desc && (
          <div id={descId} className="text-muted text-sm">
            {desc}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function H({ children, desc }: { children: ReactNode; desc?: string }) {
  return (
    <div className="mb-5">
      <h2 className="font-semibold text-xl tracking-[-0.015em]">{children}</h2>
      {desc && <p className="mt-1 text-muted text-sm">{desc}</p>}
    </div>
  );
}

/** A titled group inside a section. */
export function Group({
  title,
  children,
  className,
  testId,
}: {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn("mt-7", className)} data-testid={testId}>
      <h3 className="mb-2.5 px-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]">{title}</h3>
      {children}
    </section>
  );
}
