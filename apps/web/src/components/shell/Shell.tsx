import type { ReactNode } from "react";
import { Rail } from "./Rail";

/**
 * The window (Dots-style): a thin icon rail, then the page. A chat brings its own workspace beside it (AgentPage);
 * the team is a popover on the rail. Phones keep the rail as a floating tab bar.
 */
export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="shell workspace-app">
      <Rail />
      <main className="shell-main">{children}</main>
    </div>
  );
}
