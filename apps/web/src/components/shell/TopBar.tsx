import type { AgentView } from "@yo/contracts";
import { Monitor, PanelRight } from "lucide-react";
import { cn, modKey } from "../../lib/utils";
import { ui, useUI, WORKSPACE_QUERY } from "../../stores/ui";
import { useMedia } from "../agent/Presence";
import { Tip } from "../ui/overlay";

/**
 * The chat's top-right buttons, round as in Dots: the agent's computer (its workspace tab) and the workspace
 * toggle (⌘\). There's no call button: Yo has no calls.
 */
export function TopBarButtons({ agent }: { agent: AgentView }) {
  const wide = useMedia(WORKSPACE_QUERY);
  const open = useUI((s) => (wide ? s.workPaneOpen : s.workspaceSheet));
  const onComputer = useUI((s) => s.workspaceTab === "computer");
  return (
    <div className="shell-bar-buttons">
      <Tip label={`${agent.name}’s computer`} side="bottom">
        <button
          type="button"
          className={cn("shell-icon-button", open && onComputer && "is-on")}
          aria-label={`Show ${agent.name}’s computer`}
          data-testid="topbar-computer"
          onClick={() => ui.showTab("computer")}
        >
          <Monitor aria-hidden />
        </button>
      </Tip>
      <Tip label={open ? "Hide workspace" : "Show workspace"} shortcut={`${modKey}\\`} side="bottom">
        <button
          type="button"
          className={cn("shell-icon-button", open && "is-on")}
          aria-label={open ? "Hide workspace" : "Show workspace"}
          aria-expanded={open}
          data-testid="toggle-workspace"
          onClick={ui.toggleInspector}
        >
          <PanelRight aria-hidden />
        </button>
      </Tip>
    </div>
  );
}
