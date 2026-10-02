import { PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
import { hasTrafficLights } from "../lib/desktop";
import { cn, modKey } from "../lib/utils";
import { useUI } from "../stores/ui";
import { Tip } from "./ui/overlay";

/** 52px draggable title bar used by every main-area page. */
export function PageHeader({ children, className }: { children: ReactNode; className?: string }) {
  const collapsed = useUI((s) => s.sidebarCollapsed);
  return (
    <header
      className={cn(
        "app-drag flex h-[52px] shrink-0 items-center gap-3 border-border border-b px-4",
        collapsed && hasTrafficLights && "pl-[84px]",
        className,
      )}
    >
      {collapsed && (
        <Tip label="Show sidebar" shortcut={`${modKey}\\`} side="bottom">
          <button
            aria-label="Show sidebar"
            onClick={() => useUI.setState({ sidebarCollapsed: false })}
            className="-ml-1 grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <PanelLeftOpen className="size-[17px]" />
          </button>
        </Tip>
      )}
      {children}
    </header>
  );
}

/** Standard layout for secondary pages (Activity, Routines, ...). */
export function PageShell({
  title,
  subtitle,
  icon,
  actions,
  children,
  wide,
}: {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader>
        <div className="flex items-center gap-2 font-medium">
          {icon}
          {title}
        </div>
      </PageHeader>
      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full px-8 pt-9 pb-16", wide ? "max-w-[1080px]" : "max-w-[820px]")}>
          <div className="mb-7 flex items-end gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="font-semibold text-2xl tracking-[-0.02em]">{title}</h1>
              {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
            </div>
            {actions}
          </div>
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
    <div className="flex flex-col items-center rounded-2xl border border-border border-dashed px-6 py-14 text-center">
      <div className="mb-3 grid size-11 place-items-center rounded-2xl bg-active text-muted [&_svg]:size-5">
        {icon}
      </div>
      <div className="font-medium">{title}</div>
      {body && <div className="mt-1 max-w-sm text-muted text-sm">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
