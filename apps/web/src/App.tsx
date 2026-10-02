import { YoLogo } from "@yo/avatar";
import { useEffect } from "react";
import { Toaster } from "sonner";
import { AgentPage } from "./components/agent/AgentPage";
import { CommandPalette } from "./components/CommandPalette";
import { ComputerOverlay } from "./components/computer/ComputerOverlay";
import { AgentSettingsDialog, NewAgentDialog } from "./components/NewAgentDialog";
import { Onboarding } from "./components/onboarding/Onboarding";
import { ActivityPage } from "./components/pages/ActivityPage";
import { ApprovalsPage } from "./components/pages/ApprovalsPage";
import { ArtifactsPage } from "./components/pages/ArtifactsPage";
import { MemoryPage } from "./components/pages/MemoryPage";
import { RoutinesPage } from "./components/pages/RoutinesPage";
import { Sidebar } from "./components/Sidebar";
import { SettingsDialog } from "./components/settings/SettingsDialog";
import { UpdateNotice } from "./components/UpdateNotice";
import { TooltipProvider } from "./components/ui/overlay";
import { WindowSessionBanner } from "./components/WindowSessionBanner";
import { desktop } from "./lib/desktop";
import { useShortcuts } from "./lib/useShortcuts";
import { useApp } from "./stores/app";
import { ui, useUI } from "./stores/ui";

function useTheme() {
  const theme = useApp((s) => s.settings.theme);
  const booted = useApp((s) => s.booted);
  useEffect(() => {
    if (!booted) return;
    const mq = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const t = theme === "system" ? (mq.matches ? "light" : "dark") : theme;
      document.documentElement.className = t;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute("content", t === "dark" ? "#1C1D20" : "#FAF9F6");
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

function Splash() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-4 animate-fade-in">
        <YoLogo size={56} animated state="working" />
        <div className="shimmer-text text-sm">Connecting to Yo…</div>
      </div>
    </div>
  );
}

function ConnectionBanner() {
  const connection = useApp((s) => s.connection);
  const booted = useApp((s) => s.booted);
  if (!booted || connection === "open") return null;
  return (
    <div className="-translate-x-1/2 fixed top-3 left-1/2 z-[80] flex items-center gap-2 rounded-full border border-border-strong bg-elevated px-3 py-1.5 text-sm shadow-pop animate-rise">
      <span className="size-1.5 rounded-full bg-warning pulse-dot" />
      Reconnecting to Yo…
    </div>
  );
}

function Main() {
  const page = useUI((s) => s.page);
  switch (page) {
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
  const sidebarCollapsed = useUI((s) => s.sidebarCollapsed);

  useEffect(() => {
    if (!desktop) return;
    return desktop.onNavigate((t) => {
      if (t.agentId) ui.openAgent(t.agentId);
      else if (t.page) ui.goto(t.page as never);
    });
  }, []);

  return (
    <TooltipProvider delay={350}>
      {!booted ? (
        <Splash />
      ) : !onboarded ? (
        <Onboarding />
      ) : (
        <div className="flex h-full min-h-0">
          <Sidebar />
          <main className="relative flex min-w-0 flex-1 flex-col">
            <WindowSessionBanner />
            <Main />
          </main>
          <ComputerOverlay />
          <SettingsDialog />
          <NewAgentDialog />
          <AgentSettingsDialog />
          <CommandPalette />
        </div>
      )}
      <ConnectionBanner />
      {/* The sidebar shows it in its footer; without one it floats bottom-left. */}
      {booted && (!onboarded || sidebarCollapsed) && <UpdateNotice floating />}
      <Toaster
        theme={theme === "system" ? "system" : theme}
        position="bottom-right"
        offset={20}
        gap={10}
        toastOptions={{
          classNames: {
            toast:
              "!rounded-2xl !border !border-border-strong/60 !bg-elevated !text-fg !shadow-pop !font-sans !text-base !gap-2.5",
            description: "!text-muted !text-sm",
            actionButton: "!bg-fg !text-bg !rounded-lg !font-medium",
          },
        }}
      />
    </TooltipProvider>
  );
}
