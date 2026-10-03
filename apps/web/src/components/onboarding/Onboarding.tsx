import { YoLogo, YoWordmark } from "@yo/avatar";
import { type Avatar as AvatarData, localTimeZone } from "@yo/contracts";
import {
  ArrowLeft,
  ArrowRight,
  FileText,
  Folder,
  FolderOpen,
  KeyRound,
  Monitor,
  Send,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { deviceBridge, hasTrafficLights } from "../../lib/desktop";
import { cn } from "../../lib/utils";
import { primaryAgent, useApp } from "../../stores/app";
import { applyDeviceStatus, errorText, useDevice } from "../../stores/device";
import { run } from "../../stores/sync";
import { AvatarStudio } from "../AvatarStudio";
import { ConnectModel } from "../connect/ConnectModel";
import { macBlocker } from "../settings/DevicesAccessSettings";
import { Button } from "../ui/button";
import { Field, Input, Spinner } from "../ui/controls";

// The agent's computer isn't set up here: the first agent does that in its chat (components/setup).
type Step = "welcome" | "subs" | "access" | "meet";
const STEPS: Step[] = ["welcome", "subs", "access", "meet"];

function Welcome({ next }: { next: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative mb-8">
        <div className="-inset-16 absolute rounded-full bg-[radial-gradient(closest-side,rgba(255,212,59,0.22),transparent)] blur-2xl" />
        <YoLogo size={148} animated className="relative" />
      </div>
      <h1 className="font-semibold text-4xl tracking-[-0.035em]">Say hi to Yo.</h1>
      <p className="mt-3 text-lg text-muted">Your AI, your subscription, its own computer.</p>
      <div className="mt-10 grid w-full max-w-[640px] grid-cols-3 gap-3 text-left">
        {[
          {
            icon: Monitor,
            t: "Its own computer",
            d: "A separate desktop and browser. Your Mac's files stay private unless you share them.",
          },
          { icon: KeyRound, t: "Your subscriptions", d: "Runs on Claude or ChatGPT — switch anytime." },
          {
            icon: ShieldCheck,
            t: "You stay in charge",
            d: "It asks before buying, sending or posting anything.",
          },
        ].map((f) => (
          <div key={f.t} className="rounded-2xl border border-border bg-card shadow-card/70 p-4">
            <f.icon className="mb-3 size-[18px] text-fg-2" />
            <div className="font-medium">{f.t}</div>
            <div className="mt-1 text-muted text-sm leading-snug">{f.d}</div>
          </div>
        ))}
      </div>
      <Button variant="brand" size="lg" className="mt-10 px-6" onClick={next} data-testid="onboarding-start">
        Get started <ArrowRight className="size-4" />
      </Button>
    </div>
  );
}

/** "Connect your model" walkthrough (components/connect). */
function Subscriptions({ next }: { next: () => void }) {
  return <ConnectModel variant="onboarding" onDone={next} />;
}

/** Optional: pair this Mac and share a first folder. Skipping is a complete setup (no access at all). */
function AccessStep({ next }: { next: () => void }) {
  const bridge = deviceBridge();
  const status = useDevice((s) => s.status);
  const [busy, setBusy] = useState<null | "pair" | "pick">(null);
  const [error, setError] = useState<string | null>(null);
  const blocker = status ? macBlocker(status) : null;
  const grants = status?.paired ? status.grants.filter((g) => !g.revokedAt && g.kind !== "app") : [];

  const share = async () => {
    if (!bridge) return;
    setError(null);
    try {
      let s = status ?? (await bridge.status());
      if (!s.paired) {
        setBusy("pair");
        // A native dialog on the Mac asks to confirm pairing.
        s = await bridge.pair();
        applyDeviceStatus(s);
        if (!s.paired) {
          setError("This Mac wasn't paired. You can pair it later in Settings → Devices & access.");
          return;
        }
      }
      await api().call("settings.update", { macAccess: true });
      setBusy("pick");
      applyDeviceStatus(await bridge.chooseFolder("read"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const points = [
    { icon: FolderOpen, t: "Only what you choose", d: "Yo's agents can't see anything else on your Mac." },
    {
      icon: ShieldCheck,
      t: "Read only to start",
      d: "Changes stay off until you allow them, and each one waits for your OK.",
    },
    {
      icon: Send,
      t: "Read by your AI",
      d: "Shared content can be sent to your AI provider when an agent reads it.",
    },
  ];

  return (
    <div className="w-full max-w-[560px]" data-testid="onboarding-access">
      <h1 className="font-semibold text-3xl tracking-[-0.03em]">Let Yo help on this Mac</h1>
      <p className="mt-2 text-muted">
        Choose files and folders Yo can use. Yo asks before changing anything.
      </p>
      <div className="mt-7 rounded-2xl border border-border bg-card shadow-card px-5 py-1.5">
        {points.map((p, i) => (
          <div key={p.t} className={cn("flex items-start gap-3.5 py-3", i > 0 && "border-border border-t")}>
            <p.icon className="mt-0.5 size-[18px] shrink-0 text-fg-2" strokeWidth={1.8} />
            <div>
              <div className="font-medium">{p.t}</div>
              <div className="text-muted text-sm">{p.d}</div>
            </div>
          </div>
        ))}
      </div>

      {bridge && grants.length > 0 && (
        <div
          className="mt-3 rounded-2xl border border-border bg-card shadow-card px-5 py-1.5"
          data-testid="access-shared"
        >
          {grants.map((g, i) => (
            <div
              key={g.id}
              className={cn("flex items-center gap-3 py-2.5", i > 0 && "border-border border-t")}
            >
              {g.kind === "dir" ? (
                <Folder className="size-4 shrink-0 text-muted" />
              ) : (
                <FileText className="size-4 shrink-0 text-muted" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{g.name}</div>
                <div className="truncate text-muted text-sm">{g.displayPath}</div>
              </div>
              <span className="text-muted text-sm">
                {g.mode === "read" ? "Read only" : "Read and change"}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 min-h-5 text-sm" aria-live="polite">
        {!bridge && (
          <span className="text-muted" data-testid="access-browser-note">
            Sharing files from your Mac is available in the Yo app for macOS. You can set it up later in
            Settings → Devices & access.
          </span>
        )}
        {bridge && blocker && <span className="text-muted">{blocker.text}</span>}
        {busy === "pair" && <span className="text-muted">Confirm pairing in the dialog on your Mac…</span>}
        {busy === "pick" && (
          <span className="text-muted">Choose a folder or file in the window on your Mac…</span>
        )}
        {error && (
          <span role="alert" className="text-danger">
            {error}
          </span>
        )}
      </div>

      <div className="mt-6 flex items-center justify-between gap-3">
        {bridge && !blocker && grants.length > 0 ? (
          <>
            <Button variant="ghost" onClick={share} disabled={!!busy} data-testid="access-share">
              {busy ? <Spinner /> : null} Share another
            </Button>
            <Button variant="primary" onClick={next} disabled={!!busy} data-testid="onboarding-next">
              Continue <ArrowRight className="size-4" />
            </Button>
          </>
        ) : bridge && !blocker ? (
          <>
            <Button variant="ghost" onClick={next} disabled={!!busy} data-testid="access-skip">
              Use agent computer only
            </Button>
            <Button variant="brand" onClick={share} disabled={!!busy || !status} data-testid="access-share">
              {busy ? <Spinner /> : null} Share a folder
            </Button>
          </>
        ) : (
          <>
            <span />
            <Button variant="primary" onClick={next} data-testid="access-skip">
              Continue <ArrowRight className="size-4" />
            </Button>
          </>
        )}
      </div>
      <p className="mt-3 text-right text-muted text-xs" data-testid="access-apps-note">
        You can also share Calendar, Contacts and Reminders later in Settings → Devices & access.
      </p>
    </div>
  );
}

function Meet() {
  const agents = useApp((s) => s.agents);
  const settings = useApp((s) => s.settings);
  const primary = primaryAgent(agents);
  const [name, setName] = useState(primary?.name ?? "Yo");
  const [you, setYou] = useState(settings.userName);
  const [avatar, setAvatar] = useState<AvatarData>(
    primary?.avatar ?? { shape: "bubble", color: "yo", eyes: "capsule", accessory: "headset" },
  );
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    if (primary)
      await run(api().call("agent.update", { id: primary.id, patch: { name: name.trim() || "Yo", avatar } }));
    // The user's own time zone (the default is New York): the agent's clock, routines and calendar use it.
    const timezone = localTimeZone() ?? settings.timezone;
    await run(api().call("settings.update", { userName: you.trim(), timezone, onboarded: true }));
    setBusy(false);
  };

  return (
    <div className="w-full max-w-[680px]">
      <h1 className="font-semibold text-3xl tracking-[-0.03em]">Meet {name.trim() || "Yo"}</h1>
      <p className="mt-2 text-muted">
        Your main agent. Give it a name and a look — you can change both later.
      </p>
      <div className="mt-7 rounded-2xl border border-border bg-card shadow-card p-5">
        <AvatarStudio value={avatar} onChange={setAvatar} />
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Field label="Agent name">
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="primary-name" />
          </Field>
          <Field label="What should it call you?">
            <Input
              value={you}
              onChange={(e) => setYou(e.target.value)}
              placeholder="Your first name"
              data-testid="user-name"
            />
          </Field>
        </div>
      </div>
      <div className="mt-6 flex justify-end">
        <Button variant="brand" size="lg" onClick={finish} disabled={busy} data-testid="onboarding-finish">
          Start chatting <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  const i = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, i + 1)]!);
  const back = () => setStep(STEPS[Math.max(0, i - 1)]!);
  useEffect(() => {
    document.getElementById("onb-scroll")?.scrollTo({ top: 0 });
  }, [step]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-bg" data-testid="onboarding">
      <div className="pointer-events-none absolute inset-x-0 bottom-[-40vh] h-[80vh] bg-[radial-gradient(50%_50%_at_50%_50%,rgba(255,212,59,0.07),transparent)]" />
      <div
        className={cn(
          "app-drag relative flex h-[52px] shrink-0 items-center px-5",
          hasTrafficLights && "pl-[84px]",
        )}
      >
        {step !== "welcome" ? (
          <button
            onClick={back}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-muted text-sm hover:bg-hover hover:text-fg"
          >
            <ArrowLeft className="size-3.5" /> Back
          </button>
        ) : (
          <YoWordmark size={20} />
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          {STEPS.map((s, j) => (
            <span
              key={s}
              className={cn(
                "h-1.5 rounded-full transition-all duration-300",
                j === i ? "w-5 bg-fg" : j < i ? "w-1.5 bg-fg/60" : "w-1.5 bg-border-strong",
              )}
            />
          ))}
        </div>
      </div>
      <div id="onb-scroll" className="scroll-fade relative min-h-0 flex-1 overflow-y-auto">
        <div key={step} className="flex min-h-full items-center justify-center px-6 py-10 animate-rise">
          {step === "welcome" && <Welcome next={next} />}
          {step === "subs" && <Subscriptions next={next} />}
          {step === "access" && <AccessStep next={next} />}
          {step === "meet" && <Meet />}
        </div>
      </div>
    </div>
  );
}
