import { useEffect } from "react";
import { useApp } from "../stores/app";
import { useUI } from "../stores/ui";

/**
 * Global shortcuts:  ⌘K palette · ⌘N new agent · ⌘, settings · ⌘\ sidebar · ⌘. work pane · Esc closes overlays.
 * (Dialogs close themselves on Esc; this handles the computer overlay and palette fallbacks.)
 */
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!useApp.getState().settings.onboarded) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === "k") {
        e.preventDefault();
        useUI.setState((s) => ({ paletteOpen: !s.paletteOpen }));
      } else if (mod && k === "n") {
        e.preventDefault();
        useUI.setState({ newAgentOpen: true, paletteOpen: false });
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useUI.setState({ settingsOpen: true, paletteOpen: false });
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        useUI.setState((s) => ({ sidebarCollapsed: !s.sidebarCollapsed }));
      } else if (mod && e.key === ".") {
        e.preventDefault();
        useUI.setState((s) => ({ workPaneOpen: !s.workPaneOpen }));
      } else if (e.key === "Escape") {
        if ((e.target as HTMLElement | null)?.closest?.(".xterm")) return;
        const s = useUI.getState();
        const dialogOpen = s.settingsOpen || s.newAgentOpen || s.paletteOpen || s.agentSettingsId;
        if (!dialogOpen && s.computerAgentId) {
          useUI.setState({ computerAgentId: null });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
