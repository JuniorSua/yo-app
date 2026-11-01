import { useEffect } from "react";
import { primaryAgent, useApp } from "../stores/app";
import { ui, useUI } from "../stores/ui";
import { useBrowserAuth } from "./browserAuth";
import { isDesktop } from "./desktop";
import { isMac, modKey } from "./utils";

/**
 * The New request shortcut as shown. Browsers keep Ctrl+N (and ⌘N) for a new window, so in a browser it's Alt+N
 * (⌃N on a Mac, where Option+N types a tilde). ⌘N/Ctrl+N still work wherever the browser lets them through.
 */
export function newRequestKey(browserMode = useBrowserAuth.getState().browserMode): string {
  if (isDesktop || !browserMode) return `${modKey}N`;
  return isMac ? "⌃N" : "Alt+N";
}

/**
 * Global shortcuts:  ⌘K palette · ⌘N new request (to the primary agent) · ⌘, settings · ⌘\ the inspector · ⌘. the
 * open agent's computer, full screen · ⌘/ the shortcuts sheet · Esc closes overlays. ⌘ is Ctrl off a Mac; in a
 * browser Alt+N is New request too.
 * (Dialogs, the workspace sheet and the full-screen computer close themselves on Esc.)
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
      } else if ((mod && k === "n") || (altOnly(e) && k === "n" && !isDesktop)) {
        e.preventDefault();
        const a = primaryAgent(useApp.getState().agents);
        if (a) ui.focusComposer(a.id);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        useUI.setState({ settingsOpen: true, paletteOpen: false });
      } else if (mod && (e.key === "/" || e.code === "Slash")) {
        e.preventDefault();
        useUI.setState((s) => ({ shortcutsOpen: !s.shortcutsOpen, paletteOpen: false }));
      } else if (mod && (e.key === "\\" || e.code === "Backslash")) {
        e.preventDefault();
        ui.toggleInspector();
      } else if (mod && e.key === ".") {
        e.preventDefault();
        const s = useUI.getState();
        ui.openComputer(
          s.computerAgentId
            ? null
            : s.page === "agent"
              ? s.agentId
              : (primaryAgent(useApp.getState().agents)?.id ?? null),
        );
      }
      // Escape: dialogs, the workspace sheet and the full-screen computer close themselves (Base UI dialogs).
    };
    const altOnly = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
