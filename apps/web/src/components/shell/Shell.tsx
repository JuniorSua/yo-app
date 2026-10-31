import type { ReactNode } from "react";
import { useApp } from "../../stores/app";
import { useUI } from "../../stores/ui";
import { PANE_QUERY, useMedia } from "../agent/Presence";
import { Sidebar } from "../Sidebar";
import { Inspector } from "./Inspector";
import { Rail } from "./Rail";

/**
 * The window (Dots-style): a thin icon rail, the team roster, the page, and on a chat the inspector on the right.
 * Phones keep the rail as a floating tab bar and drop the roster and inspector.
 */
export function Shell({ children }: { children: ReactNode }) {
  const chatId = useUI((s) => (s.page === "agent" ? s.agentId : null));
  const agent = useApp((s) => (chatId ? s.agents[chatId] : undefined));
  const open = useUI((s) => s.workPaneOpen);
  const wide = useMedia(PANE_QUERY);
  const phone = useMedia("(max-width: 600px)");
  const inspector = !!agent && open && wide;
  return (
    <div className="shell workspace-app" data-inspector={inspector || undefined}>
      <Rail />
      {!phone && <Sidebar />}
      <main className="shell-main">{children}</main>
      {inspector && (
        <div className="shell-inspector-slot">
          <Inspector agent={agent} />
        </div>
      )}
    </div>
  );
}
