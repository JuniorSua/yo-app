import type { AgentView } from "@yo/contracts";
import { Monitor, PanelRight } from "lucide-react";
import { cn, modKey } from "../../lib/utils";
import { ui, useUI } from "../../stores/ui";
import { PANE_QUERY, useMedia } from "../agent/Presence";
import { Tip } from "../ui/overlay";

/**
 * The right end of the chat's top bar: the agent's computer (full screen) and the inspector toggle (⌘\). The
 * inspector needs a wide window; narrower ones only get the computer button.
 */
export function TopBarButtons({ agent }: { agent: AgentView }) {
  const open = useUI((s) => s.workPaneOpen);
  const wide = useMedia(PANE_QUERY);
  return (
    <div className="shell-bar-buttons">
      <Tip label={`${agent.name}’s computer`} shortcut={`${modKey}.`} side="bottom">
        <button
          type="button"
          className="shell-icon-button"
          aria-label={`Open ${agent.name}’s computer`}
          data-testid="topbar-computer"
          onClick={() => ui.openComputer(agent.id)}
        >
          <Monitor aria-hidden />
        </button>
      </Tip>
      {wide && (
        <Tip label={open ? "Hide inspector" : "Show inspector"} shortcut={`${modKey}\\`} side="bottom">
          <button
            type="button"
            className={cn("shell-icon-button", open && "is-on")}
            aria-label={open ? "Hide inspector" : "Show inspector"}
            aria-expanded={open}
            data-testid="toggle-workspace"
            onClick={ui.toggleInspector}
          >
            <PanelRight aria-hidden />
          </button>
        </Tip>
      )}
    </div>
  );
}
