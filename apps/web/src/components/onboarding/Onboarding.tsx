import { SOFTIES, Softie, TEAMMATE_KINDS, YO_AVATAR, YoWordmark } from "@yo/avatar";
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
import { useEdition } from "../../lib/browserAuth";
import { deviceBridge, hasTrafficLights } from "../../lib/desktop";
import { clientIsMac } from "../../lib/platform";
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

const TEAM = SOFTIES.filter((s) => TEAMMATE_KINDS.includes(s.kind));

function Welcome({ next }: { next: () => void }) {
  return (
    <div className="flex w-full max-w-[680px] flex-col items-center text-center">
      <Softie kind="yo" size={120} className="mb-5" />
      <h1 className="font-semibold text-4xl tracking-[-0.035em]">Say hi to Yo.</h1>
      <p className="mt-3 max-w-[30rem] text-balance text-lg text-muted">
        Your AI agent, on the subscription you already pay for, with its own computer on your{" "}
        {clientIsMac() ? "Mac" : "PC"}.
      </p>
      <div className="mt-9 w-full" data-testid="welcome-team">
        <ul className="flex items-end justify-center gap-6">
          {TEAM.map((s) => (
            <li key={s.kind} className="flex w-[72px] flex-col items-center">
              <Softie kind={s.kind} size={48} animated={false} />
              <span className="mt-1.5 font-medium text-sm">{s.name}</span>
              <span className="text-muted text-xs">{s.role}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-muted text-sm">
          Add teammates when you want them. Each gets its own job, memory and model.
        </p>
      </div>
      <div className="mt-9 grid w-full grid-cols-3 gap-3 text-left">
        {[
          {
            icon: Monitor,
            t: "A private computer",
            d: `Its own desktop and browser. ${clientIsMac() ? "Your Mac's" : "Your"} files stay private unless you share them.`,
          },
          {
            icon: KeyRound,
            t: "Your subscriptions",
            d: "Runs on Claude, ChatGPT or Grok. Switch models, not apps.",
          },
          {
            icon: ShieldCheck,
            t: "You stay in charge",
            d: "It asks before buying, sending or posting anything.",
          },
        ].map((f) => (
          <div key={f.t} className="rounded-2xl border border-border bg-card p-4">
            <f.icon className="mb-3 size-[18px] text-fg-2" strokeWidth={1.8} />
            <div className="font-medium">{f.t}</div>
            <div className="mt-1 text-muted text-sm leading-snug">{f.d}</div>
          </div>
        ))}
      </div>
      <Button variant="primary" size="lg" className="mt-9 px-6" onClick={next} data-testid="onboarding-start">
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
    { icon: FolderOpen, t: "Only what you choose", d: "Only the content you choose is shared with Yo." },
    {
      icon: ShieldCheck,
      t: "Read only to start",
      d: "Changes stay off until you allow them, and each one waits for your OK.",
    },
    {
      icon: Send,
      t: "Read by your AI",
      d: "Shared content can be sent to your AI provider when Yo uses it.",
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
              Use only Yo’s computer
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
  const [avatar, setAvatar] = useState<AvatarData>(primary?.avatar ?? YO_AVATAR);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    if (primary)
      await run(api().call("agent.update", { id: primary.id, patch: { name: name.trim() || "Yo", avatar } }));
    // A new user starts with one assistant: Work & Personal spaces (a second agent, Pip, who takes over outside
    // work hours) stay off until they turn them on in Settings → Spaces. Otherwise someone finishing setup in
    // the evening met Pip instead of the assistant they just named, and never saw the computer setup. Only
    // onboarding sends this, so existing installs keep their spaces. Before `onboarded`, so the shell opens
    // with Pip already put away.
    if (settings.spacesOn) await run(api().call("settings.update", { spacesOn: false }));
    // The user's own time zone (the default is New York): the agent's clock, routines and calendar use it.
    const timezone = localTimeZone() ?? settings.timezone;
    await run(api().call("settings.update", { userName: you.trim(), timezone, onboarded: true }));
    setBusy(false);
  };

  return (
    <div className="w-full max-w-[680px]">
      <h1 className="font-semibold text-3xl tracking-[-0.03em]">Meet {name.trim() || "Yo"}</h1>
      <p className="mt-2 text-muted" data-testid="meet-intro">
        Give your assistant a name and a look. You can change both later.
      </p>
      <div className="mt-7 rounded-2xl border border-border bg-card p-5">
        <AvatarStudio value={avatar} onChange={setAvatar} primary />
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Field label="Name">
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
        <Button variant="primary" size="lg" onClick={finish} disabled={busy} data-testid="onboarding-finish">
          Start chatting <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function Onboarding() {
  const [step, setStep] = useState<Step>("welcome");
  // The PC edition has no Mac to share files or apps from, so it skips that step.
  const edition = useEdition();
  const steps = edition === "pc" ? STEPS.filter((s) => s !== "access") : STEPS;
  const i = steps.indexOf(step);
  const next = () => setStep(steps[Math.min(steps.length - 1, i + 1)]!);
  const back = () => setStep(steps[Math.max(0, i - 1)]!);
  useEffect(() => {
    document.getElementById("onb-scroll")?.scrollTo({ top: 0 });
  }, [step]);

  return (
    <div className="air-page relative flex h-full flex-col overflow-hidden" data-testid="onboarding">
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
          {steps.map((s, j) => (
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
