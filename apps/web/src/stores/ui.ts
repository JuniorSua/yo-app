import { create } from "zustand";

export type Page = "agent" | "tasks" | "activity" | "approvals" | "routines" | "memory" | "artifacts";
export type SettingsSection =
  | "accounts"
  | "spaces"
  | "computer"
  | "devices"
  | "browsers"
  | "rules"
  | "notifications"
  | "phone"
  | "bugs"
  | "appearance"
  | "support"
  | "about";

export interface UIState {
  page: Page;
  agentId: string | null;
  /** The inspector beside the chat (the agent's profile, computer, activity and outputs). Was the work pane. */
  workPaneOpen: boolean;
  computerAgentId: string | null;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  newAgentOpen: boolean;
  paletteOpen: boolean;
  /** The keyboard shortcuts sheet (⌘/). */
  shortcutsOpen: boolean;
  /** The Page (create_page) open in the page viewer. */
  pageViewerId: string | null;
  agentSettingsId: string | null;
  search: string;
  composerFocus: number;
  /** Text for an agent's message box to start with (the Make page's + menu); the box takes it once. */
  composerDraft: { agentId: string; text: string } | null;
  focusEntryId: string | null;
  focusRecordId: string | null;
  /**
   * First run on a Mac whose computer isn't set up yet, and the person chose Claude or ChatGPT: both sign in on
   * Yo's computer, so the setup chat comes first and ends with that sign-in. Remembered across restarts.
   */
  signInAfterSetup: SignInAfterSetup | null;
}

export type SignInAfterSetup = "claude" | "codex";

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("yo.ui") ?? "{}") as Partial<UIState> & {
      /** What a Yo from before ChatGPT signed in on its computer remembered ("Claude after setup"). */
      claudeAfterSetup?: boolean;
    };
  } catch {
    return {};
  }
})();

const savedSignIn: SignInAfterSetup | null =
  saved.signInAfterSetup === "claude" || saved.signInAfterSetup === "codex"
    ? saved.signInAfterSetup
    : saved.claudeAfterSetup
      ? "claude"
      : null;

export const useUI = create<UIState>(() => ({
  page: "agent",
  agentId: saved.agentId ?? null,
  workPaneOpen: saved.workPaneOpen ?? true,
  computerAgentId: null,
  settingsOpen: false,
  settingsSection: "accounts",
  newAgentOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  pageViewerId: null,
  agentSettingsId: null,
  search: "",
  composerFocus: 0,
  composerDraft: null,
  focusEntryId: null,
  focusRecordId: null,
  signInAfterSetup: savedSignIn,
}));

// Only the remembered fields are written (not every keystroke in the agent search).
useUI.subscribe((s, prev) => {
  if (
    s.agentId === prev.agentId &&
    s.workPaneOpen === prev.workPaneOpen &&
    s.signInAfterSetup === prev.signInAfterSetup
  )
    return;
  try {
    localStorage.setItem(
      "yo.ui",
      JSON.stringify({
        agentId: s.agentId,
        workPaneOpen: s.workPaneOpen,
        signInAfterSetup: s.signInAfterSetup,
      }),
    );
  } catch {
    /* ignore */
  }
});

export const ui = {
  openAgent(agentId: string) {
    useUI.setState({
      page: "agent",
      agentId,
      focusRecordId: null,
      focusEntryId: null,
    });
  },
  goto(page: Page) {
    useUI.setState({ page, focusRecordId: null });
  },
  /** An agent's chat with its composer focused. */
  focusComposer(agentId: string) {
    useUI.setState((s) => ({
      page: "agent",
      agentId,
      paletteOpen: false,
      focusEntryId: null,
      composerFocus: s.composerFocus + 1,
    }));
  },
  /** An agent's chat with `text` in its message box, focused, the cursor at the end. */
  prefillComposer(agentId: string, text: string) {
    useUI.setState((s) => ({
      page: "agent",
      agentId,
      paletteOpen: false,
      focusEntryId: null,
      composerDraft: { agentId, text },
      composerFocus: s.composerFocus + 1,
    }));
  },
  openSettings(section: SettingsSection = "accounts") {
    useUI.setState({ settingsOpen: true, settingsSection: section });
  },
  openComputer(agentId: string | null) {
    useUI.setState({ computerAgentId: agentId });
  },
  /** Show or hide the inspector (⌘\ or the chat's inspector button). */
  toggleInspector() {
    useUI.setState((s) => ({ workPaneOpen: !s.workPaneOpen }));
  },
};
