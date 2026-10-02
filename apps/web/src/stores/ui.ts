import { create } from "zustand";

export type Page = "agent" | "activity" | "approvals" | "routines" | "memory" | "artifacts";
export type SettingsSection =
  | "accounts"
  | "computer"
  | "devices"
  | "rules"
  | "notifications"
  | "bugs"
  | "appearance"
  | "about";

interface UIState {
  page: Page;
  agentId: string | null;
  sidebarCollapsed: boolean;
  workPaneOpen: boolean;
  computerAgentId: string | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  newAgentOpen: boolean;
  paletteOpen: boolean;
  agentSettingsId: string | null;
  search: string;
}

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("yo.ui") ?? "{}") as Partial<UIState>;
  } catch {
    return {};
  }
})();

export const useUI = create<UIState>(() => ({
  page: "agent",
  agentId: saved.agentId ?? null,
  sidebarCollapsed: saved.sidebarCollapsed ?? false,
  workPaneOpen: saved.workPaneOpen ?? true,
  computerAgentId: null,
  settingsOpen: false,
  settingsSection: "accounts",
  newAgentOpen: false,
  paletteOpen: false,
  agentSettingsId: null,
  search: "",
}));

useUI.subscribe((s) => {
  try {
    localStorage.setItem(
      "yo.ui",
      JSON.stringify({
        agentId: s.agentId,
        sidebarCollapsed: s.sidebarCollapsed,
        workPaneOpen: s.workPaneOpen,
      }),
    );
  } catch {
    /* ignore */
  }
});

export const ui = {
  openAgent(agentId: string) {
    useUI.setState({ page: "agent", agentId });
  },
  goto(page: Page) {
    useUI.setState({ page });
  },
  openSettings(section: SettingsSection = "accounts") {
    useUI.setState({ settingsOpen: true, settingsSection: section });
  },
  openComputer(agentId: string | null) {
    useUI.setState({ computerAgentId: agentId });
  },
};
