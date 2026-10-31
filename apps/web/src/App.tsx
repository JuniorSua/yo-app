import { Softie } from "@yo/avatar";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { AgentPage } from "./components/agent/AgentPage";
import { PageViewer } from "./components/agent/Pages";
import { PANE_QUERY, useMedia } from "./components/agent/Presence";
import { SignIn } from "./components/auth/SignIn";
import { CommandPalette } from "./components/CommandPalette";
import { RestartConfirm } from "./components/RestartConfirm";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { Shell } from "./components/shell/Shell";
import { UpdateNotice } from "./components/UpdateNotice";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/overlay";
import { WindowSessionBanner } from "./components/WindowSessionBanner";
import { useBrowserAuth } from "./lib/browserAuth";
import { type ConnectionClient, connectionHelp } from "./lib/connection";
import { desktop } from "./lib/desktop";
import { lazyComponent, preloadWhenIdle } from "./lib/lazy";
import { clientIsWindows } from "./lib/platform";
import { useNow } from "./lib/useNow";
import { useShortcuts } from "./lib/useShortcuts";
import { useApp } from "./stores/app";
import { startSpaceClock } from "./stores/space";
import { retryConnection } from "./stores/sync";
import { type UIState, ui, useUI } from "./stores/ui";

// Not needed to show the chat, so they load after it (see lib/lazy).
const Onboarding = lazyComponent(() =>
  import("./components/onboarding/Onboarding").then((m) => m.Onboarding),
);
const TasksPage = lazyComponent(() => import("./components/pages/TasksPage").then((m) => m.TasksPage));
const ActivityPage = lazyComponent(() =>
  import("./components/pages/ActivityPage").then((m) => m.ActivityPage),
);
const ApprovalsPage = lazyComponent(() =>
  import("./components/pages/ApprovalsPage").then((m) => m.ApprovalsPage),
);
const RoutinesPage = lazyComponent(() =>
  import("./components/pages/RoutinesPage").then((m) => m.RoutinesPage),
);
const MemoryPage = lazyComponent(() => import("./components/pages/MemoryPage").then((m) => m.MemoryPage));
const ArtifactsPage = lazyComponent(() =>
  import("./components/pages/ArtifactsPage").then((m) => m.ArtifactsPage),
);
const SettingsDialog = lazyComponent(() =>
  import("./components/settings/SettingsDialog").then((m) => m.SettingsDialog),
);
const NewAgentDialog = lazyComponent(() =>
  import("./components/NewAgentDialog").then((m) => m.NewAgentDialog),
);
const AgentSettingsDialog = lazyComponent(() =>
  import("./components/NewAgentDialog").then((m) => m.AgentSettingsDialog),
);
const ComputerOverlay = lazyComponent(() =>
  import("./components/computer/ComputerOverlay").then((m) => m.ComputerOverlay),
);

/**
 * Mounts a dialog the first time it opens (its code may still be loading then), and keeps it mounted after, so
 * closing still animates.
 */
function OnceOpened({ when, children }: { when: (s: UIState) => boolean; children: ReactNode }) {
  const open = useUI(when);
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open ? <Suspense fallback={null}>{children}</Suspense> : null;
}

/** Light or dark (or the system's), on <html> and the window chrome. Work and Personal share one calm look. */
function useTheme() {
  const theme = useApp((s) => s.settings.theme);
  const booted = useApp((s) => s.booted);
  useEffect(() => {
    if (!booted) return;
    desktop?.appearance?.setTheme(theme);
    const mq = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const t = theme === "system" ? (mq.matches ? "light" : "dark") : theme;
      const root = document.documentElement;
      root.classList.remove("light", "dark");
      root.classList.add(t);
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", t === "dark" ? "#171717" : "#FFFFFF");
    };
    apply();
    try {
      localStorage.setItem("yo.theme", theme);
    } catch {
      /* ignore */
    }
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme, booted]);
}

/** The Mac app, or a browser (and which edition of Yo it talks to), for the connecting screens' advice. */
function useConnectionClient(): ConnectionClient {
  const browser = useBrowserAuth((s) => s.browserMode);
  const edition = useBrowserAuth((s) => s.info?.edition ?? null);
  const helper = useBrowserAuth((s) => s.info?.helperCommand ?? null);
  return { browser, edition, helper, windows: browser && clientIsWindows() };
}

function Splash() {
  const [started] = useState(Date.now);
  // Known after a reconnect that needs a fresh load (a server update); unknown on the very first start.
  const placement = useApp((s) => s.execution?.corePlacement);
  const help = connectionHelp(useNow() - started, true, placement, useConnectionClient());
  return (
    <div className="air-page grid h-full place-items-center">
      <div className="flex max-w-md flex-col items-center gap-4 px-6 text-center animate-fade-in">
        <Softie kind="yo" size={64} state="working" />
        <div className="shimmer-text text-sm">{help.title}</div>
        {help.slow && (
          <>
            <p className="text-muted text-sm">{help.body}</p>
            <Button onClick={retryConnection} data-testid="splash-retry">
              Try again
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Reconnecting() {
  const [started] = useState(Date.now);
  const placement = useApp((s) => s.execution?.corePlacement);
  const help = connectionHelp(useNow() - started, false, placement, useConnectionClient());
  return (
    <div
      role="status"
      className="-translate-x-1/2 fixed top-3 left-1/2 z-[80] max-w-md rounded-2xl border border-border-strong bg-elevated px-4 py-2 text-sm shadow-pop animate-rise"
    >
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-warning pulse-dot" />
        {help.title}
      </div>
      {help.slow && (
        <div className="mt-1 flex items-end gap-3">
          <p className="flex-1 text-muted text-xs">{help.body}</p>
          <Button size="sm" onClick={retryConnection} data-testid="reconnect-now">
            Try now
          </Button>
        </div>
      )}
    </div>
  );
}

function ConnectionBanner() {
  const connection = useApp((s) => s.connection);
  const booted = useApp((s) => s.booted);
  const signedOut = useBrowserAuth((s) => s.status === "signed-out" || s.status === "unsupported");
  return booted && connection !== "open" && !signedOut ? <Reconnecting /> : null;
}

function Main() {
  const page = useUI((s) => s.page);
  switch (page) {
    case "tasks":
      return <TasksPage />;
    case "activity":
      return <ActivityPage />;
    case "approvals":
      return <ApprovalsPage />;
    case "routines":
      return <RoutinesPage />;
    case "memory":
      return <MemoryPage />;
    case "artifacts":
      return <ArtifactsPage />;
    default:
      return <AgentPage />;
  }
}

export function App() {
  useTheme();
  useShortcuts();
  const booted = useApp((s) => s.booted);
  const onboarded = useApp((s) => s.settings.onboarded);
  const theme = useApp((s) => s.settings.theme);
  const chat = useUI((s) => s.page === "agent");
  // The inspector (300px card + 8px gutter) sits on the right of a chat: toasts float just left of it.
  const paneOpen = useUI((s) => s.workPaneOpen);
  const wide = useMedia(PANE_QUERY);
  const inspector = chat && paneOpen && wide;
  // A browser that isn't signed in (lib/browserAuth.ts): the sign-in screen comes before everything else.
  const signedOut = useBrowserAuth((s) => s.status === "signed-out" || s.status === "unsupported");

  useEffect(() => {
    if (booted) preloadWhenIdle();
  }, [booted]);
  useEffect(() => startSpaceClock(), []);

  useEffect(() => {
    if (!desktop) return;
    return desktop.onNavigate((t) => {
      if (t.agentId) ui.openAgent(t.agentId);
      else if (t.page) ui.goto(t.page as never);
    });
  }, []);

  return (
    <TooltipProvider delay={350}>
      {signedOut ? (
        <SignIn />
      ) : !booted ? (
        <Splash />
      ) : !onboarded ? (
        <Suspense fallback={<Splash />}>
          <Onboarding />
        </Suspense>
      ) : (
        <div className="h-full min-h-0">
          <Shell>
            <WindowSessionBanner />
            <Suspense fallback={null}>
              <Main />
            </Suspense>
          </Shell>
          <OnceOpened when={(s) => !!s.computerAgentId}>
            <ComputerOverlay />
          </OnceOpened>
          <OnceOpened when={(s) => s.settingsOpen}>
            <SettingsDialog />
          </OnceOpened>
          <OnceOpened when={(s) => s.newAgentOpen}>
            <NewAgentDialog />
          </OnceOpened>
          <OnceOpened when={(s) => !!s.agentSettingsId}>
            <AgentSettingsDialog />
          </OnceOpened>
          <CommandPalette />
          <OnceOpened when={(s) => !!s.pageViewerId}>
            <PageViewer />
          </OnceOpened>
          <OnceOpened when={(s) => s.shortcutsOpen}>
            <ShortcutsDialog />
          </OnceOpened>
        </div>
      )}
      <ConnectionBanner />
      {/* Floats bottom-left, over the foot of the sidebar. */}
      {booted && !signedOut && <UpdateNotice floating />}
      {booted && !signedOut && <RestartConfirm />}
      <Toaster
        theme={theme === "system" ? "system" : theme}
        // In a chat: top-right, below the chat header (at the bottom it covered the Send button). Other pages have
        // their main buttons top-right and no message box: bottom-right there.
        position={chat ? "top-right" : "bottom-right"}
        offset={chat ? { top: 104, right: inspector ? 328 : 20 } : { bottom: 20, right: 20 }}
        // Phones: under the compact chat header, or above the floating tab bar.
        mobileOffset={chat ? { top: 76 } : { bottom: "calc(96px + env(safe-area-inset-bottom))" }}
        gap={10}
        toastOptions={{
          classNames: {
            toast:
              "!rounded-2xl !border !border-border-strong/60 !bg-elevated !text-fg !shadow-pop !font-sans !text-base !gap-2.5",
            description: "!text-muted !text-sm",
            actionButton: "!bg-fg !text-bg !rounded-lg !font-medium",
            cancelButton: "!bg-active !text-fg !rounded-lg !font-medium",
          },
        }}
      />
    </TooltipProvider>
  );
}
