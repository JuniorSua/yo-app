/**
 * The first agent's "let's set up my computer" chat. Scripted, because no model can run until the computer
 * exists: choice cards, a requirement check against the real Mac (core's `setup.requirements`), copy-paste
 * install steps with live re-checks, then the usual `computer.start`. Once the computer is live, "Start
 * chatting" marks the setup done and the real model takes over the chat. "Do this later" is always there.
 */
import {
  type AgentView,
  LOCAL_COMPUTER,
  type RequirementId,
  type RequirementsReport,
  SETUP_COMMANDS,
  type ToolId,
} from "@yo/contracts";
import { ArrowRight, Cloud, House, Laptop, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isUsable } from "../../lib/accounts";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { errorText } from "../../stores/device";
import { run } from "../../stores/sync";
import { ui } from "../../stores/ui";
import { Button } from "../ui/button";
import { Badge, Spinner } from "../ui/controls";
import { HOME_SERVER_NEEDS, HOME_SERVER_STEPS, HOME_SERVER_UNDO } from "./homeServer";
import { AgentLine, ComputerProgress, CopyBox, RequirementsCard, Step, UserLine } from "./parts";

type Path = "local" | "home";

/** How often the chat re-checks the Mac while the user installs tools. */
export const RECHECK_MS = 4000;

/** True when `agent` should show the setup chat instead of its normal one. */
export function useSetupChat(agent: AgentView | undefined): boolean {
  // An older core without the setting counts as set up.
  const setup = useApp((s) => s.settings.computerSetup ?? "done");
  // "unverified": connected by the walkthrough, checked once the computer is live (it doesn't exist yet).
  const model = useApp((s) => s.accounts.some(isUsable));
  const remote = useApp((s) => s.computer?.host.kind === "remote");
  return !!agent?.isPrimary && setup === "pending" && model && !remote;
}

export function setComputerSetup(value: "pending" | "later" | "done") {
  return run(api().call("settings.update", { computerSetup: value }), "Couldn't save that");
}

/** "Set up my computer" for anyone who picked "Do this later" (any agent's chat, until it's set up). */
export function SetupBanner() {
  const setup = useApp((s) => s.settings.computerSetup ?? "done");
  const remote = useApp((s) => s.computer?.host.kind === "remote");
  const live = useApp((s) => s.computer?.runtime === "running");
  const primary = useApp((s) => Object.values(s.agents).find((a) => a.isPrimary));
  if (setup !== "later" || remote || live) return null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-[720px] px-7" data-testid="setup-banner">
      <div className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-2 text-sm shadow-card">
        <Laptop className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 text-fg-2">
          {primary?.name ?? "Yo"}'s computer isn't set up yet, so agents can't work on tasks.
        </span>
        <Button
          variant="secondary"
          size="sm"
          data-testid="setup-resume"
          onClick={() => {
            void setComputerSetup("pending");
            if (primary) ui.openAgent(primary.id);
          }}
        >
          Set it up
        </Button>
      </div>
    </div>
  );
}

function ChoiceCard({
  icon: Icon,
  title,
  text,
  badge,
  selected,
  disabled,
  onClick,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  badge?: React.ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-1.5 rounded-2xl border bg-card p-4 text-left shadow-card transition-all duration-200",
        disabled
          ? "cursor-not-allowed border-border opacity-60"
          : "border-border hover:-translate-y-px hover:border-border-strong hover:bg-elevated hover:shadow-soft",
        selected && "border-fg/40 bg-elevated ring-1 ring-fg/15",
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <Icon className="size-[18px] text-fg-2" strokeWidth={1.8} />
        {badge}
      </div>
      <div className="mt-1 font-medium">{title}</div>
      <div className="text-muted text-sm leading-snug">{text}</div>
    </button>
  );
}

const TOOL_STEPS: { id: ToolId | "tools"; tools: ToolId[] }[] = [
  { id: "homebrew", tools: ["homebrew"] },
  { id: "tools", tools: ["colima", "docker"] },
  { id: "compose", tools: ["compose"] },
];

function InstallSteps({ report, needed }: { report: RequirementsReport; needed: Set<ToolId> }) {
  const installed = (ids: ToolId[]) => ids.every((id) => report.tools.find((t) => t.id === id)?.installed);
  const appleSilicon = report.facts.cpu.appleSilicon !== false;
  const steps = TOOL_STEPS.filter((s) => s.tools.some((t) => needed.has(t)));
  return (
    <div
      className="rounded-2xl border border-border bg-card px-5 py-1.5 shadow-card"
      data-testid="setup-install"
    >
      {steps.map((s, i) => (
        <div key={s.id} className={cn(i > 0 && "border-border border-t")}>
          {s.id === "homebrew" ? (
            <Step n={i + 1} title="Install Homebrew" done={installed(s.tools)} testId="install-homebrew">
              <p className="text-muted text-sm">
                The free package manager for Mac. It asks for your Mac password and may install Apple's
                command line tools.
              </p>
              <CopyBox command={SETUP_COMMANDS.homebrew} />
              {appleSilicon && (
                <>
                  <p className="text-muted text-sm">Then, if Terminal says “brew: command not found”, run:</p>
                  <CopyBox command={SETUP_COMMANDS.homebrewPath} />
                </>
              )}
            </Step>
          ) : s.id === "tools" ? (
            <Step
              n={i + 1}
              title="Install Colima and Docker"
              done={installed(s.tools)}
              testId="install-tools"
            >
              <p className="text-muted text-sm">
                Colima runs my computer in a small virtual machine; Docker starts it. Both are free.
                {report.facts.cpu.appleSilicon === false && " On an Intel Mac this can take a while."}
              </p>
              <CopyBox command={SETUP_COMMANDS.tools} />
            </Step>
          ) : (
            <Step n={i + 1} title="Turn on Docker Compose" done={installed(s.tools)} testId="install-compose">
              <p className="text-muted text-sm">Lets Docker find the Compose plugin Homebrew installed.</p>
              <CopyBox command={SETUP_COMMANDS.composePlugin} />
            </Step>
          )}
        </div>
      ))}
    </div>
  );
}

function HomeServerGuide() {
  return (
    <div
      className="rounded-2xl border border-border bg-card px-5 py-3 shadow-card"
      data-testid="setup-home-guide"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">What you need</span>
        <Badge tone="warning">Advanced</Badge>
      </div>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-fg-2 text-sm">
        {HOME_SERVER_NEEDS.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <div className="mt-2">
        {HOME_SERVER_STEPS.map((s, i) => (
          <div key={s.title} className="border-border border-t">
            <Step
              n={i + 1}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {s.title}
                  <Badge tone={s.where === "server" ? "link" : "neutral"}>
                    {s.where === "server" ? "On the server" : "On this Mac"}
                  </Badge>
                </span>
              }
              testId={`home-step-${i + 1}`}
            >
              <p className="text-muted text-sm">{s.body}</p>
              {s.commands.map((c) => (
                <CopyBox key={c} command={c} />
              ))}
              {s.note && <p className="text-faint text-xs leading-relaxed">{s.note}</p>}
            </Step>
          </div>
        ))}
      </div>
      <p className="border-border border-t pt-3 text-muted text-xs">
        To go back to this Mac: {HOME_SERVER_UNDO}
      </p>
    </div>
  );
}

function list(l: string[]) {
  return l.length < 2 ? (l[0] ?? "") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}

/** "It needs …" for a blocked item. */
const NEEDS: Record<RequirementId, string> = {
  ram: "more memory",
  computerMemory: "more memory to spare",
  cpu: "more processor cores",
  disk: "more free disk space",
  macos: "a newer macOS",
};
/** "… could be better" for a warning. */
const COULD_BE_BETTER: Record<RequirementId, string> = {
  ram: "memory",
  computerMemory: "memory for my computer",
  cpu: "the processor",
  disk: "free disk space",
  macos: "the macOS version",
};

function blockReasons(report: RequirementsReport) {
  const ids = report.items.filter((i) => i.status === "block").map((i) => i.id);
  // Too little memory always means too little to spare: say it once.
  return list(ids.filter((id) => !(id === "computerMemory" && ids.includes("ram"))).map((id) => NEEDS[id]));
}

export function SetupChat({ agent }: { agent: AgentView }) {
  const computer = useApp((s) => s.computer);
  const [path, setPath] = useState<Path | null>(null);
  const [report, setReport] = useState<RequirementsReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Tools that were missing at some point: their steps stay listed (ticked off) once installed. */
  const [needed, setNeeded] = useState<Set<ToolId>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const r = await api().call("setup.requirements", {});
      if (!alive.current) return;
      setReport(r);
      setCheckError(null);
      if (r.missingTools.length)
        setNeeded((n) => (r.missingTools.every((t) => n.has(t)) ? n : new Set([...n, ...r.missingTools])));
    } catch (e) {
      if (alive.current) setCheckError(errorText(e));
    } finally {
      if (alive.current) setChecking(false);
    }
  }, []);

  const choose = (p: Path) => {
    setPath(p);
    if (p === "local" && !report) void check();
  };

  const blocked = report?.verdict === "block";
  const missing = !!report && !blocked && report.missingTools.length > 0;
  // Live re-checks while the user installs the tools.
  useEffect(() => {
    if (path !== "local" || !missing) return;
    const t = setInterval(() => void check(), RECHECK_MS);
    return () => clearInterval(t);
  }, [path, missing, check]);

  const ready = !!report && !blocked && !missing;
  const live = computer?.runtime === "running" && computer.connected;
  const starting = computer?.runtime === "starting";
  const failed = started && computer?.runtime === "error";
  const showProgress = ready && (started || starting || live);

  // Follow the conversation as it grows.
  const steps = `${path}:${!!report}:${missing}:${ready}:${showProgress}:${live}:${failed}`;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && steps) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [steps]);

  const start = async () => {
    setStarted(true);
    await run(api().call("computer.start", {}), "Couldn't start my computer");
  };

  const finish = async () => {
    setBusy(true);
    await setComputerSetup("done");
    if (alive.current) setBusy(false);
  };

  const later = () => void setComputerSetup("later");

  const warnings = report?.items.filter((i) => i.status === "warn" || i.status === "unknown") ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="setup-chat">
      <div ref={scroller} className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6 px-7 pt-8 pb-10">
          <AgentLine agent={agent} testId="setup-greeting">
            <p className="font-medium text-[17px]">
              Looks like we have a model connected. Let's set up my computer.
            </p>
            <p className="text-fg-2">
              I work on a computer of my own, with its own desktop and browser, so your files stay private
              unless you share them. Where should it run?
            </p>
            <div className="grid grid-cols-1 gap-2.5 pt-1 sm:grid-cols-3">
              <ChoiceCard
                icon={Laptop}
                title="This Mac"
                text="Runs here in a small virtual machine. I'll check this Mac first."
                badge={<Badge tone="success">Free</Badge>}
                selected={path === "local"}
                onClick={() => choose("local")}
                testId="setup-choice-local"
              />
              <ChoiceCard
                icon={House}
                title="Home server"
                text="Your own always-on PC at home. I keep working while your Mac sleeps."
                badge={<Badge tone="warning">Advanced</Badge>}
                selected={path === "home"}
                onClick={() => choose("home")}
                testId="setup-choice-home"
              />
              <ChoiceCard
                icon={Cloud}
                title="Cloud"
                text="We'll let you know when it's ready."
                badge={<Badge>Coming soon</Badge>}
                disabled
                testId="setup-choice-cloud"
              />
            </div>
          </AgentLine>

          {path === "local" && (
            <>
              <UserLine text="This Mac" />
              <AgentLine agent={agent} testId="setup-local">
                <p>Let me check this Mac against what my computer needs.</p>
                <RequirementsCard report={report} checking={checking} onRecheck={() => void check()} />
                {checkError && (
                  <div className="flex items-center gap-3 text-sm" role="alert">
                    <span className="text-danger">I couldn't check this Mac: {checkError}</span>
                    <Button variant="ghost" size="sm" onClick={() => void check()}>
                      Try again
                    </Button>
                  </div>
                )}
              </AgentLine>

              {report && blocked && (
                <AgentLine agent={agent} testId="setup-blocked">
                  <p>
                    Sorry, this Mac can't run my computer: it needs {blockReasons(report)}. If you can fix
                    that, check again. Otherwise a home server can run my computer instead, or we can do this
                    later.
                  </p>
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => choose("home")} data-testid="setup-use-home">
                      Use a home server
                    </Button>
                  </div>
                </AgentLine>
              )}

              {/* Stays up (ticked off) once everything's installed. */}
              {report && !blocked && needed.size > 0 && (
                <AgentLine agent={agent} testId="setup-missing">
                  <p>
                    {warnings.length
                      ? `This Mac can run my computer (${list(warnings.map((w) => COULD_BE_BETTER[w.id]))} could be better). `
                      : "This Mac is a great fit. "}
                    A few free tools are missing. Open Terminal (Applications → Utilities), paste each step
                    and press Return. I'll notice when they're installed.
                  </p>
                  <InstallSteps report={report} needed={needed} />
                  {missing && (
                    <p className="flex items-center gap-2 text-muted text-sm">
                      <Spinner /> Watching for the tools…
                    </p>
                  )}
                </AgentLine>
              )}

              {ready && (
                <AgentLine agent={agent} testId="setup-ready">
                  <p>
                    {needed.size
                      ? "Everything's installed. "
                      : warnings.length
                        ? `This Mac can run my computer, though ${list(warnings.map((w) => COULD_BE_BETTER[w.id]))} could be better. `
                        : "This Mac is a great fit, and everything I need is installed. "}
                    The first start downloads my computer (about 1 GB) and takes a few minutes. It uses up to{" "}
                    {LOCAL_COMPUTER.vmMemoryGB} GB of memory, only while it's on.
                  </p>
                  {!showProgress && (
                    <Button variant="brand" onClick={() => void start()} data-testid="computer-start">
                      Start my computer
                    </Button>
                  )}
                </AgentLine>
              )}

              {showProgress && computer && (
                <AgentLine agent={agent} testId="setup-starting">
                  <ComputerProgress c={computer} />
                  {failed && (
                    <div className="space-y-2" role="alert">
                      <p className="text-danger text-sm">{computer.message ?? "My computer didn't start."}</p>
                      <Button variant="secondary" size="sm" onClick={() => void start()}>
                        Try again
                      </Button>
                    </div>
                  )}
                </AgentLine>
              )}

              {showProgress && live && (
                <AgentLine agent={agent} testId="setup-live">
                  <p>
                    My computer is live. From here on it's really me answering, on your model. What should we
                    do first?
                  </p>
                  <Button
                    variant="brand"
                    onClick={() => void finish()}
                    disabled={busy}
                    data-testid="setup-finish"
                  >
                    Start chatting <ArrowRight className="size-4" />
                  </Button>
                </AgentLine>
              )}
            </>
          )}

          {path === "home" && (
            <>
              <UserLine text="Home server" />
              <AgentLine agent={agent} testId="setup-home">
                <p>
                  Good choice if you have a PC that's always on. Yo and my computer both move there, so I keep
                  working while your Mac is closed, and this Mac opens Yo on the server through a private SSH
                  tunnel. It takes about half an hour and some Terminal work.
                </p>
                <HomeServerGuide />
              </AgentLine>
            </>
          )}
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[720px] items-center justify-between gap-3 px-7 pt-2 pb-5">
        <span className="text-faint text-xs">
          {path === "home"
            ? "When the last step is done, Yo reopens on your server."
            : "You can come back to this any time."}
        </span>
        {!(showProgress && live) && (
          <Button variant="ghost" onClick={later} data-testid="setup-later">
            Do this later
          </Button>
        )}
      </div>
    </div>
  );
}
