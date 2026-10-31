import { YoWordmark } from "@yo/avatar";
import {
  type Account,
  type ConnectProvider,
  ENABLED_PROVIDERS as PROVIDERS,
  type RuntimeMode,
  type Settings,
  type VmHomeStatus,
} from "@yo/contracts";
import {
  Bell,
  Bug,
  Cpu,
  Globe,
  HeartHandshake,
  Info,
  KeyRound,
  Laptop,
  LaptopMinimal,
  Monitor,
  Moon,
  MoreHorizontal,
  Palette,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Star,
  Sun,
  SunMoon,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { accountDetail, accountIdentity, isUsable, signInNotice } from "../../lib/accounts";
import { api } from "../../lib/api";
import { setGlassPref, useGlassPref } from "../../lib/glassPref";
import { cn } from "../../lib/utils";
import { primaryAgent, useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { type SettingsSection, ui, useUI } from "../../stores/ui";
import { useUpdates } from "../../stores/updates";
import { accountTone, PROVIDER_NAME, PROVIDER_VENDOR, ProviderIcon, StatusDot } from "../brand";
import { ConnectModel } from "../connect/ConnectModel";
import { setComputerSetup } from "../setup/SetupChat";
import { Button } from "../ui/button";
import { Badge, Input, Select, Switch } from "../ui/controls";
import { DialogClose, DialogTitle, Menu, MenuItem, MenuSeparator, Modal } from "../ui/overlay";
import { BrowsersSettings } from "./BrowsersSettings";
import { BugReportSettings } from "./BugReportSettings";
import { DevicesAccessSettings } from "./DevicesAccessSettings";
import { LoginPanel } from "./LoginPanel";
import { OnePasswordCard } from "./OnePasswordCard";
import { PhoneSettings } from "./PhoneSettings";
import { Group, H, Row } from "./parts";
import { SpacesSettings } from "./SpacesSettings";
import { SupportSettings } from "./SupportSettings";
import { UpdatesSettings } from "./UpdatesSettings";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Users }[] = [
  { id: "accounts", label: "Accounts", icon: Users },
  { id: "spaces", label: "Work & Personal", icon: SunMoon },
  { id: "computer", label: "Computer", icon: Cpu },
  { id: "devices", label: "Devices & access", icon: LaptopMinimal },
  { id: "browsers", label: "Browsers & apps", icon: Globe },
  { id: "rules", label: "Rules", icon: ShieldCheck },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "phone", label: "Phone", icon: Smartphone },
  { id: "bugs", label: "Bug reports", icon: Bug },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "support", label: "Support Yo", icon: HeartHandshake },
  { id: "about", label: "About", icon: Info },
];

const update = (patch: Partial<Settings>) => run(api().call("settings.update", patch));

export function AccountCard({
  account,
  compact,
  onConnect,
}: {
  account: Account;
  compact?: boolean;
  /** Open the "Connect your model" walkthrough for this account (instead of signing in on Yo's computer). */
  onConnect?: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState("");
  const tone = accountTone(account);
  const signingIn = account.status === "signing_in";
  const authed = isUsable(account);
  const identity = accountIdentity(account);
  // Expired, or a Claude account still on an old saved token: one plain line and a sign-in button.
  const notice = signInNotice(account);
  const connect = () =>
    onConnect ? onConnect() : run(api().call("account.login.start", { id: account.id }));
  return (
    <div
      data-testid={`account-${account.provider}`}
      className="rounded-[14px] border border-border bg-card shadow-card px-4 py-3.5"
    >
      <div className="flex items-center gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-elevated">
          <ProviderIcon provider={account.provider} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 font-semibold">{PROVIDER_NAME[account.provider]}</span>
            {identity && !compact && <span className="truncate text-muted text-sm">{identity}</span>}
          </div>
          <div className="flex items-center gap-1.5 truncate text-muted text-sm">
            <StatusDot tone={tone} />
            {(account.status === "error" || account.status === "not_installed") && account.message
              ? account.message
              : accountDetail(account)}
          </div>
        </div>
        {account.isDefault && !compact && <Badge>Default</Badge>}
        {!authed && !signingIn && !notice && (
          <Button
            variant={account.provider === "claude" ? "brand" : "secondary"}
            size="sm"
            data-testid={`connect-${account.provider}`}
            onClick={connect}
          >
            {account.status === "not_installed" ? "Set up" : "Connect"}
          </Button>
        )}
        {!compact && (
          <Menu
            trigger={
              <button
                aria-label="Account options"
                className="grid size-8 place-items-center rounded-lg text-muted hover:bg-hover hover:text-fg"
              >
                <MoreHorizontal className="size-4" />
              </button>
            }
          >
            {!account.isDefault && (
              <MenuItem
                icon={<Star />}
                onClick={() => run(api().call("account.setDefault", { id: account.id }))}
              >
                Make default
              </MenuItem>
            )}
            <MenuItem
              icon={<RefreshCw />}
              onClick={() => run(api().call("account.refresh", { id: account.id }))}
            >
              Refresh status
            </MenuItem>
            <MenuItem icon={<KeyRound />} onClick={() => setShowKey((s) => !s)}>
              Use an API key instead
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              icon={<Trash2 />}
              onClick={() => run(api().call("account.remove", { id: account.id }))}
            >
              Sign out & remove
            </MenuItem>
          </Menu>
        )}
      </div>
      {notice && (
        <div
          data-testid={`signin-notice-${account.provider}`}
          className={cn(
            "mt-3 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm",
            notice.kind === "expired" ? "bg-warning/10" : "bg-elevated",
          )}
        >
          <span className="min-w-0 flex-1 text-fg-2">{notice.text}</span>
          <Button
            variant={notice.kind === "expired" ? "brand" : "secondary"}
            size="sm"
            className="shrink-0"
            data-testid={`signin-again-${account.provider}`}
            onClick={connect}
          >
            {notice.action}
          </Button>
        </div>
      )}
      {authed && account.rateLimit?.utilization !== undefined && !compact && (
        <div className="mt-3.5">
          <div className="mb-1 flex justify-between text-muted text-xs">
            <span>Usage this window</span>
            <span className="tabular-nums">{Math.round(account.rateLimit.utilization * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-active">
            <div
              className={cn(
                "h-full rounded-full",
                account.rateLimit.status === "ok"
                  ? "bg-success"
                  : account.rateLimit.status === "warning"
                    ? "bg-warning"
                    : "bg-danger",
              )}
              style={{ width: `${Math.max(3, account.rateLimit.utilization * 100)}%` }}
            />
          </div>
        </div>
      )}
      <LoginPanel account={account} />
      {showKey && (
        <>
          <p className="mt-3 text-muted text-sm">
            Yo keeps this key in its secret storage (the Keychain on a Mac).
          </p>
          <form
            className="mt-2 flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!key.trim()) return;
              await run(api().call("account.setApiKey", { id: account.id, key: key.trim() }));
              setKey("");
              setShowKey(false);
            }}
          >
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              type="password"
              placeholder={`${PROVIDER_VENDOR[account.provider]} API key`}
            />
            <Button type="submit" variant="secondary" disabled={!key.trim()}>
              Save key
            </Button>
          </form>
        </>
      )}
    </div>
  );
}

function Accounts() {
  const accounts = useApp((s) => s.accounts);
  // "Connect your model" walkthrough, shown in place of the list.
  const [connect, setConnect] = useState<{ provider?: ConnectProvider; accountId?: string } | null>(null);
  if (connect)
    return (
      <ConnectModel
        variant="settings"
        initialProvider={connect.provider}
        accountId={connect.accountId}
        onDone={() => setConnect(null)}
      />
    );
  const sorted = [...accounts].sort(
    (a, b) => PROVIDERS.indexOf(a.provider) - PROVIDERS.indexOf(b.provider) || a.createdAt - b.createdAt,
  );
  return (
    <div>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <H desc="Yo runs on your own Claude, ChatGPT or Grok plan. Your own sign-ins on this Mac are never copied.">
            Accounts
          </H>
        </div>
        <Button
          variant="secondary"
          size="sm"
          // Clear of the dialog's close button.
          className="mt-7"
          onClick={() => setConnect({})}
          data-testid="open-connect"
        >
          <Plug className="size-3.5" /> Connect your model
        </Button>
      </div>
      <div className="space-y-2.5">
        {sorted.map((a) => (
          <AccountCard
            key={a.id}
            account={a}
            onConnect={
              a.provider === "claude" || a.provider === "codex" || a.provider === "grok"
                ? () => setConnect({ provider: a.provider as ConnectProvider, accountId: a.id })
                : undefined
            }
          />
        ))}
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-2 border-border border-t pt-5 text-muted text-sm">
        <span className="mr-auto">
          The default account is used when an assistant has no account selected.
        </span>
        {/* One group, so the label and its buttons wrap together. */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs">Add another:</span>
          {PROVIDERS.map((p) => (
            <button
              key={p}
              aria-label={`Add ${PROVIDER_NAME[p]} account`}
              data-testid={`add-account-${p}`}
              onClick={() => run(api().call("account.add", { provider: p }))}
              className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-fg-2 text-xs transition-colors hover:bg-hover hover:text-fg"
              title={`Add another ${PROVIDER_NAME[p]} account (${PROVIDER_VENDOR[p]})`}
            >
              <Plus className="size-3" />
              {PROVIDER_NAME[p]}
            </button>
          ))}
        </div>
      </div>
      <Group title="Passwords" testId="settings-passwords">
        <p className="mb-2.5 px-1 text-muted text-sm">
          Let Yo sign in to sites with logins from your password manager. Yo never sees the passwords.
        </p>
        <OnePasswordCard />
      </Group>
    </div>
  );
}

const MOVE_WARNING =
  "This stops the computer and any work an agent is doing. Yo starts it again when the move finishes. Nothing is deleted.";

/** An updating user was kept on ~/.colima. Move stays optional here, and in the setup chat. */
function LegacyComputer() {
  const [vm, setVm] = useState<VmHomeStatus | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const agentWorking = useApp((s) => Object.values(s.agents).some((a) => a.activity === "working"));
  useEffect(() => {
    let alive = true;
    void api()
      .call("setup.requirements", {})
      .then((report) => {
        if (alive) setVm(report.vmHome);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (moved)
    return (
      <Row title="Existing computer" desc={moved}>
        {null}
      </Row>
    );
  const offer = !!vm && vm.legacyKept && (vm.state === "choose" || vm.choice === "reuse");
  if (!offer || !vm) return null;
  const move = () => {
    setBusy(true);
    void run(api().call("setup.vmHome.choose", { choice: "move" }), "Couldn't move the computer").then(
      async (next) => {
        setBusy(false);
        setConfirming(false);
        if (next?.choice === "move") {
          setMoved(next.detail);
          return;
        }
        const report = await api()
          .call("setup.requirements", {})
          .catch(() => null);
        if (report) setVm(report.vmHome);
      },
    );
  };
  return (
    <Row
      title="Existing computer"
      desc={
        agentWorking
          ? "An agent is working. Wait until they finish before moving the computer."
          : confirming
            ? MOVE_WARNING
            : vm.detail ||
              "Yo is using the computer already in ~/.colima. Nothing was moved or deleted. You can move it into Yo's folder."
      }
    >
      {confirming ? (
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            data-testid="vm-home-move-cancel"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
          <Button
            variant="brand"
            size="sm"
            disabled={busy || agentWorking}
            data-testid="vm-home-move-confirm"
            onClick={move}
          >
            Move into Yo
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || agentWorking}
          title={agentWorking ? "An agent is working. Wait until they finish." : undefined}
          data-testid="vm-home-move-settings"
          onClick={() => setConfirming(true)}
        >
          Move into Yo
        </Button>
      )}
    </Row>
  );
}

function Computer() {
  const computer = useApp((s) => s.computer);
  const settings = useApp((s) => s.settings);
  // A model, or Claude or ChatGPT chosen to sign in on the computer this sets up (they sign in there).
  const modelConnected = useApp((s) => s.accounts.some(isUsable));
  const signInNext = useUI((s) => !!s.signInAfterSetup);
  const hasModel = modelConnected || signInNext;
  const primary = useApp((s) => primaryAgent(s.agents));
  if (!computer) return null;
  const pct = computer.memMB && computer.memLimitMB ? computer.memMB / computer.memLimitMB : 0;
  const running = computer.runtime === "running";
  const notSetUp = computer.host.kind === "local" && (settings.computerSetup ?? "done") !== "done";
  return (
    <div>
      <H desc="Where Yo’s computer runs.">Computer</H>
      <div className="mb-3 flex items-start gap-3 rounded-[14px] border border-border bg-card shadow-card p-4">
        {computer.host.kind === "local" ? (
          <Laptop className="mt-0.5 size-5 text-muted" />
        ) : (
          <Monitor className="mt-0.5 size-5 text-muted" />
        )}
        <div>
          <div className="font-medium">{computer.host.label}</div>
          <div className="text-muted text-sm">
            {computer.host.kind === "local"
              ? "Agents' computers run in a lightweight VM on this machine."
              : `Agents' computers run on ${computer.host.label}.`}
          </div>
        </div>
      </div>

      <div className="rounded-[14px] border border-border bg-card shadow-card p-4">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 font-medium">
              Status
              <Badge
                tone={
                  running
                    ? "success"
                    : computer.runtime === "starting"
                      ? "warning"
                      : computer.runtime === "error"
                        ? "danger"
                        : "neutral"
                }
              >
                {computer.runtime === "running"
                  ? "Running"
                  : computer.runtime === "starting"
                    ? "Starting"
                    : computer.runtime === "missing"
                      ? "Not installed"
                      : computer.runtime === "error"
                        ? "Error"
                        : "Stopped"}
              </Badge>
            </div>
            <div className="text-muted text-sm">
              {computer.message ??
                `${computer.host.label} · ${computer.connected ? "connected" : "not connected"}`}
            </div>
          </div>
          {running ? (
            <Button variant="secondary" size="sm" onClick={() => run(api().call("computer.stop", {}))}>
              Stop
            </Button>
          ) : notSetUp ? (
            // Never set up on this Mac: go through the setup chat (it checks the Mac and the tools first),
            // not straight to a VM this Mac may not have room for.
            <Button
              variant="primary"
              size="sm"
              data-testid="computer-setup"
              onClick={() => {
                if (!hasModel) return ui.openSettings("accounts");
                void setComputerSetup("pending");
                if (primary) ui.openAgent(primary.id);
                useUI.setState({ settingsOpen: false });
              }}
            >
              {hasModel ? "Set it up" : "Connect a model first"}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              disabled={computer.runtime === "starting"}
              onClick={() => run(api().call("computer.start", {}))}
            >
              Start
            </Button>
          )}
        </div>
        <div className="mt-4">
          <div className="mb-1.5 flex justify-between text-sm">
            <span className="text-muted">Memory</span>
            <span className="tabular-nums">
              {computer.memMB ? `${(computer.memMB / 1024).toFixed(1)} GB` : "—"}{" "}
              <span className="text-muted">
                / {computer.memLimitMB ? `${(computer.memLimitMB / 1024).toFixed(0)} GB` : "—"}
              </span>
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-active">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                pct > 0.85 ? "bg-danger" : pct > 0.65 ? "bg-warning" : "bg-success",
              )}
              style={{ width: `${pct * 100}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-2 divide-y divide-border">
        {computer.host.kind === "local" && <LegacyComputer />}
        <Row
          title="Awake computers"
          desc="How many agents can keep their computer awake at once. Others hibernate."
        >
          <div className="w-28">
            <Select
              value={String(settings.maxAwakeComputers)}
              onChange={(v) => update({ maxAwakeComputers: Number(v) })}
              options={["1", "2", "3", "4"].map((n) => ({
                value: n,
                label: `${n} ${n === "1" ? "agent" : "agents"}`,
              }))}
            />
          </div>
        </Row>
        <Row title="Auto-sleep" desc="Hibernate an idle agent's computer after this long.">
          <div className="w-32">
            <Select
              value={String(settings.autoSleepMinutes)}
              onChange={(v) => update({ autoSleepMinutes: Number(v) })}
              options={[
                { value: "10", label: "10 minutes" },
                { value: "15", label: "15 minutes" },
                { value: "30", label: "30 minutes" },
                { value: "60", label: "1 hour" },
                { value: "0", label: "Never" },
              ]}
            />
          </div>
        </Row>
      </div>
      <Button variant="ghost" className="mt-4" onClick={() => useUI.setState({ settingsSection: "devices" })}>
        <LaptopMinimal className="size-4" /> What Yo can use on your Mac
      </Button>
    </div>
  );
}

const MODES: { value: RuntimeMode; title: string; desc: string }[] = [
  {
    value: "approval-required",
    title: "Ask first",
    desc: "Agents ask before running any tool outside their own sandbox.",
  },
  { value: "auto", title: "Auto", desc: "Routine actions run automatically; anything consequential asks." },
  {
    value: "full-access",
    title: "Full access",
    desc: "Full control of their private workspace. Purchases, messages and posts still need your OK.",
  },
];

function Rules() {
  const mode = useApp((s) => s.settings.defaultRuntimeMode);
  return (
    <div>
      <H desc="Choose when your agents check with you first.">Rules & approvals</H>
      <div className="space-y-2" role="radiogroup">
        {MODES.map((m) => (
          <button
            key={m.value}
            role="radio"
            aria-checked={mode === m.value}
            onClick={() => update({ defaultRuntimeMode: m.value })}
            className={cn(
              "flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-colors",
              mode === m.value ? "border-fg/60 bg-active/40" : "border-border hover:bg-hover",
            )}
          >
            <span
              className={cn(
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]",
                mode === m.value ? "border-fg" : "border-border-strong",
              )}
            >
              {mode === m.value && <span className="size-2 rounded-full bg-fg" />}
            </span>
            <div>
              <div className="font-medium">{m.title}</div>
              <div className="text-muted text-sm">{m.desc}</div>
            </div>
          </button>
        ))}
      </div>
      <Button
        variant="ghost"
        className="mt-4"
        onClick={() => {
          useUI.setState({ settingsOpen: false });
          ui.goto("approvals");
        }}
      >
        <ShieldCheck className="size-4" /> Manage saved rules
      </Button>
    </div>
  );
}

function Notifications() {
  const on = useApp((s) => s.settings.notifications);
  const brief = useApp((s) => s.settings.morningBrief !== false);
  return (
    <div>
      <H desc="Get notified when work is ready or Yo needs you.">Notifications</H>
      <div className="divide-y divide-border">
        <Row title="Desktop notifications" desc="Show a system notification when you're not looking at Yo.">
          <Switch
            checked={on}
            label="Desktop notifications"
            onCheckedChange={(v) => {
              void update({ notifications: v });
              if (
                v &&
                typeof Notification !== "undefined" &&
                Notification.permission === "default" &&
                !window.yoDesktop
              )
                void Notification.requestPermission();
            }}
          />
        </Row>
        <Row title="Morning brief" desc="Post a short brief the first time you open Yo each day.">
          <Switch
            checked={brief}
            label="Morning brief"
            testId="setting-morning-brief"
            onCheckedChange={(v) => void update({ morningBrief: v })}
          />
        </Row>
      </div>
    </div>
  );
}

function Appearance() {
  const settings = useApp((s) => s.settings);
  const [name, setName] = useState(settings.userName);
  const glass = useGlassPref((s) => s.on);
  // Little pictures of the window in each theme: the grey roster beside the white (or dark) canvas.
  const themes = [
    { value: "dark" as const, label: "Dark", icon: Moon, bg: "#171717", side: "#1B1B1B", fg: "#ECECEC" },
    { value: "light" as const, label: "Light", icon: Sun, bg: "#FFFFFF", side: "#F3F3F3", fg: "#0D0D0D" },
    {
      value: "system" as const,
      label: "System",
      icon: Monitor,
      bg: "linear-gradient(90deg,#171717 50%,#FFFFFF 50%)",
      side: "transparent",
      fg: "#888",
    },
  ];
  return (
    <div>
      <H>Appearance</H>
      <div className="grid grid-cols-3 gap-3">
        {themes.map((t) => (
          <button
            key={t.value}
            data-testid={`theme-${t.value}`}
            aria-pressed={settings.theme === t.value}
            onClick={() => update({ theme: t.value })}
            className={cn(
              "rounded-2xl border p-1.5 text-left transition-colors",
              settings.theme === t.value ? "border-fg/70" : "border-border hover:border-border-strong",
            )}
          >
            <div
              className="flex h-20 overflow-hidden rounded-xl border border-black/10"
              style={{ background: t.bg }}
            >
              <div className="w-1/3 border-black/10 border-r" style={{ background: t.side }} />
              <div className="flex flex-1 flex-col justify-end gap-1 p-2">
                <div className="ml-auto h-2 w-1/2 rounded-full" style={{ background: t.fg, opacity: 0.25 }} />
                <div className="h-2 w-3/4 rounded-full" style={{ background: t.fg, opacity: 0.15 }} />
                <div className="h-2 w-2/3 rounded-full" style={{ background: t.fg, opacity: 0.08 }} />
              </div>
            </div>
            <div className="flex items-center gap-2 px-1.5 pt-2 pb-1 font-medium text-sm">
              <t.icon className="size-3.5 text-muted" /> {t.label}
            </div>
          </button>
        ))}
      </div>
      <div className="mt-6 divide-y divide-border">
        <Row
          title="Air Glass"
          desc="In the Mac app, the side columns let a little of your desktop show through. Off keeps them solid."
        >
          <Switch checked={glass} label="Air Glass" testId="air-glass" onCheckedChange={setGlassPref} />
        </Row>
        <Row title="Your name" desc="What Yo calls you.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== settings.userName && update({ userName: name })}
            className="w-48"
          />
        </Row>
      </div>
    </div>
  );
}

function About() {
  // The Yo app's own version when there is one (core's package version never changes).
  const appVersion = useUpdates((s) => s.desktop?.currentVersion);
  const version = useApp((s) => s.version);
  return (
    <div>
      <div className="mb-6 flex items-center gap-4">
        <YoWordmark size={40} animated />
      </div>
      <div className="text-muted text-sm">
        Version <span className="text-fg tabular-nums">{appVersion ?? version}</span> · Your AI, your
        subscription, a private workspace on your Mac or PC.
      </div>
      <div className="mt-1 text-muted text-sm" data-testid="about-license">
        Free and open source · Apache-2.0
      </div>
      <UpdatesSettings />
    </div>
  );
}

export function SettingsDialog() {
  const open = useUI((s) => s.settingsOpen);
  const section = useUI((s) => s.settingsSection);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => useUI.setState({ settingsOpen: o })}
      bare
      className="h-[min(640px,calc(100vh-48px))] w-[min(900px,calc(100vw-32px))]"
      testId="settings-dialog"
    >
      {/* On a phone the sections become a strip of tabs above the content. */}
      <div className="relative flex h-full max-sm:flex-col">
        <nav className="w-[208px] shrink-0 bg-sidebar p-2 max-sm:flex max-sm:w-full max-sm:items-center max-sm:gap-1 max-sm:overflow-x-auto max-sm:border-border max-sm:border-b max-sm:py-2 max-sm:pr-12">
          <DialogTitle className="px-2.5 pt-3 pb-3 font-semibold text-[15px] tracking-[-0.01em] max-sm:sr-only">
            Settings
          </DialogTitle>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              data-testid={`settings-${s.id}`}
              onClick={() => useUI.setState({ settingsSection: s.id })}
              className={cn(
                "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition-colors max-sm:w-auto max-sm:shrink-0 max-sm:whitespace-nowrap",
                section === s.id ? "bg-active font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
              )}
            >
              <s.icon className="size-4 text-muted" strokeWidth={1.8} />
              {s.label}
            </button>
          ))}
        </nav>
        <DialogClose
          aria-label="Close settings"
          className="absolute top-3.5 right-3.5 z-10 grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg max-sm:top-2 max-sm:right-2 max-sm:bg-elevated"
        >
          <X className="size-4" />
        </DialogClose>
        <div className="scroll-fade min-w-0 flex-1 overflow-y-auto bg-elevated px-9 py-8 max-sm:px-4 max-sm:py-5">
          {section === "accounts" && <Accounts />}
          {section === "spaces" && <SpacesSettings />}
          {section === "computer" && <Computer />}
          {section === "devices" && <DevicesAccessSettings />}
          {section === "browsers" && <BrowsersSettings />}
          {section === "rules" && <Rules />}
          {section === "notifications" && <Notifications />}
          {section === "phone" && <PhoneSettings />}
          {section === "bugs" && <BugReportSettings />}
          {section === "appearance" && <Appearance />}
          {section === "support" && <SupportSettings />}
          {section === "about" && <About />}
        </div>
      </div>
    </Modal>
  );
}
