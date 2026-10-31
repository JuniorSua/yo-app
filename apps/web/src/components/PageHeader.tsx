import { type ReactNode, useEffect } from "react";
import { cn } from "../lib/utils";
import { useApp } from "../stores/app";
import { ui, useUI } from "../stores/ui";

/**
 * The slim, draggable band along the top of every page other than a chat (the chat has its own bar): it lines up
 * with the roster's title and leaves the big page title below to do the talking.
 */
export function PageHeader({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <header className={cn("app-drag flex h-12 shrink-0 items-center gap-3 px-6", className)}>
      {children}
    </header>
  );
}

/** Standard layout for secondary pages (Tasks and its tabs, Make, Memory). */
export function PageShell({
  title,
  subtitle,
  actions,
  children,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const page = useUI((s) => s.page);
  // Tasks and its tabs. Make and Memory are rail items of their own, so they have no tabs.
  const sections = ["tasks", "approvals", "routines", "activity"].includes(page)
    ? [
        { page: "tasks" as const, label: "Tasks" },
        { page: "approvals" as const, label: "Needs you" },
        { page: "routines" as const, label: "Routines" },
        { page: "activity" as const, label: "Activity" },
      ]
    : [];
  const approvals = useApp((s) => s.approvals.length);
  const focusRecord = useUI((s) => s.focusRecordId);
  useEffect(() => {
    if (!focusRecord) return;
    const el = document.querySelector(`[data-record-id="${CSS.escape(focusRecord)}"]`);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.classList.add("workspace-highlight");
      return () => el.classList.remove("workspace-highlight");
    }
  });
  return (
    <div className="air-page flex h-full min-h-0 flex-col">
      <PageHeader />
      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "page-body mx-auto w-full px-10 pt-6 pb-16",
            wide ? "max-w-[1080px]" : "max-w-[820px]",
          )}
        >
          <div className="page-heading mb-6 flex flex-wrap items-end gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-bold text-[28px] leading-[34px] tracking-[-0.022em]">{title}</h1>
              {subtitle && <p className="mt-1.5 text-[14px] text-muted leading-5">{subtitle}</p>}
            </div>
            {actions}
          </div>
          {sections.length > 0 && (
            <nav className="workspace-tabs" aria-label="Tasks sections">
              {sections.map((s) => (
                <button
                  key={s.page}
                  aria-current={page === s.page ? "page" : undefined}
                  onClick={() => ui.goto(s.page)}
                  data-testid={`tab-${s.page}`}
                >
                  {s.label}
                  {s.page === "approvals" && approvals > 0 && <b>{approvals}</b>}
                </button>
              ))}
            </nav>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

export function EmptyNote({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-[20px] bg-hover px-6 py-14 text-center">
      <div className="mb-3 grid size-11 place-items-center rounded-full bg-card text-muted shadow-raised [&_svg]:size-5">
        {icon}
      </div>
      <div className="font-medium">{title}</div>
      {body && <div className="mt-1 max-w-sm text-muted text-sm">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
