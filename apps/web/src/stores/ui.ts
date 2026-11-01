import { create } from "zustand";

export type Page = "agent" | "tasks" | "activity" | "approvals" | "routines" | "memory" | "artifacts";
export type SettingsSection =
  | "accounts"
  | "profile"
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
  /**
   * The workspace beside the chat (Yo 2.1, Dots): the agent's computer, its helpers' screens and opened pages as
   * browser-like tabs. ⌘\ or the chat's panel button toggles it. Below 1100px it opens as a sheet instead
   * (`workspaceSheet`), so a narrow window starts on the chat.
   */
  workPaneOpen: boolean;
  workspaceSheet: boolean;
  /** The chat column's width beside the workspace, dragged by its edge (px); null = the default. Remembered. */
  chatWidth: number | null;
  /** The workspace's open tab: "computer", `helper:<agentId>` or `page:<artifactId>`. */
  workspaceTab: string;
  /** Pages and artifacts opened as workspace tabs, in the order they were opened. */
  pageTabs: string[];
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
  /** A one-click action that can't be undone, waiting for "Archive Pico?" to be confirmed (ConfirmHost). */
  confirm: ConfirmRequest | null;
}

export type SignInAfterSetup = "claude" | "codex";

export interface ConfirmRequest {
  title: string;
  body: string;
  /** The button, named for what it does: "Archive Pico". */
  action: string;
  run: () => unknown;
}

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
  // Yo is home: every window opens on Yo's chat (a specialist's view is a side trip, never reopened).
  agentId: null,
  workPaneOpen: saved.workPaneOpen ?? true,
  workspaceSheet: false,
  chatWidth: typeof saved.chatWidth === "number" && saved.chatWidth > 0 ? saved.chatWidth : null,
  workspaceTab: "computer",
  pageTabs: [],
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
  confirm: null,
}));

// Only the remembered fields are written (not every keystroke in the agent search).
useUI.subscribe((s, prev) => {
  if (
    s.workPaneOpen === prev.workPaneOpen &&
    s.chatWidth === prev.chatWidth &&
    s.signInAfterSetup === prev.signInAfterSetup
  )
    return;
  try {
    localStorage.setItem(
      "yo.ui",
      JSON.stringify({
        workPaneOpen: s.workPaneOpen,
        chatWidth: s.chatWidth,
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
      // A narrow window's workspace sheet never reopens on its own over the next chat.
      workspaceSheet: false,
    });
  },
  goto(page: Page) {
    useUI.setState({ page, focusRecordId: null, workspaceSheet: false });
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
  /** Ask before a one-click action that can't be undone (from a menu or popover that closes as the dialog opens). */
  confirm(request: ConfirmRequest) {
    useUI.setState({ confirm: request });
  },
  openSettings(section: SettingsSection = "accounts") {
    useUI.setState({ settingsOpen: true, settingsSection: section });
  },
  openComputer(agentId: string | null) {
    useUI.setState({ computerAgentId: agentId });
  },
  /** Show or hide the workspace (⌘\ or the chat's panel button); on a narrow window, its sheet. */
  toggleInspector() {
    if (!wideWindow()) useUI.setState((s) => ({ workspaceSheet: !s.workspaceSheet }));
    else useUI.setState((s) => ({ workPaneOpen: !s.workPaneOpen }));
  },
  /** Show a workspace tab ("computer", `helper:<id>`, `page:<id>`), opening the workspace (or its sheet). */
  showTab(tab: string) {
    useUI.setState((s) => ({
      workspaceTab: tab,
      ...(wideWindow() ? { workPaneOpen: true } : { workspaceSheet: true }),
      pageTabs:
        tab.startsWith("page:") && !s.pageTabs.includes(tab.slice(5))
          ? [...s.pageTabs, tab.slice(5)]
          : s.pageTabs,
    }));
  },
  /** Close a page's tab; the computer takes over when it was the open one. */
  closePageTab(id: string) {
    useUI.setState((s) => ({
      pageTabs: s.pageTabs.filter((p) => p !== id),
      workspaceTab: s.workspaceTab === `page:${id}` ? "computer" : s.workspaceTab,
    }));
  },
};

/** Wide enough for the workspace beside the chat (the Mac app's smallest window is 1100 wide). */
export const WORKSPACE_QUERY = "(min-width: 1100px)";

function wideWindow() {
  return typeof matchMedia !== "function" || matchMedia(WORKSPACE_QUERY).matches;
}
