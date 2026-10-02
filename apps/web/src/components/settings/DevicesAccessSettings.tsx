/**
 * Settings → Devices & access: where Yo's computer runs, the Mac kill switches, this Mac's pairing, the
 * folders and files shared from it, the Mac apps (Calendar, Contacts, Reminders, Notes, Mail) Yo may use,
 * window control (approved window sessions), other paired Macs, recent operations on the Mac and memory use.
 *
 * Two sources of truth, shown side by side:
 *  - core's view (`useApp().execution`, operations) — available in the browser and the desktop app;
 *  - this Mac's own view (`useDevice()`, from window.yoDesktop.device) — desktop app only.
 * The UI never decides access: every control asks core or the desktop app, which enforce it.
 */
import type {
  DeviceApp,
  DeviceGrant,
  DeviceOperation,
  DeviceOperationStatus,
  GrantMode,
  PairedDevice,
  Settings,
} from "@yo/contracts";
import {
  AppWindow,
  BookUser,
  CalendarCheck,
  CalendarCog,
  Check,
  CircleAlert,
  CircleX,
  Clock,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  Hourglass,
  House,
  Laptop,
  ListChecks,
  ListTodo,
  type LucideIcon,
  Mail,
  MailPlus,
  MemoryStick,
  MousePointerClick,
  NotebookPen,
  NotebookText,
  Plus,
  Save,
  ScanEye,
  Server,
  TimerOff,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { api } from "../../lib/api";
import { type DeviceMetrics, deviceBridge, type YoDeviceBridge } from "../../lib/desktop";
import { ago, clockTime, cn } from "../../lib/utils";
import { activeDevices, activeGrants, PLACEMENT_LABEL, useApp, usePlacement } from "../../stores/app";
import { applyDeviceStatus, errorText, refreshDevice, useDevice } from "../../stores/device";
import { load, run } from "../../stores/sync";
import { useUI } from "../../stores/ui";
import { StatusDot } from "../brand";
import {
  appOsView,
  isAppGrant,
  MAC_APPS,
  type MacAppInfo,
  macApp,
  macSettingView,
  modeOptions,
  modeText,
  OS_TONE_CLASS,
  type OsView,
  SCREEN_APP,
} from "../macApps";
import { Button } from "../ui/button";
import { Badge, Select, Spinner, Switch } from "../ui/controls";
import { Menu, MenuItem } from "../ui/overlay";
import { WindowSessionBanner } from "../WindowSessionBanner";
import { Group, H, Row } from "./parts";

const update = (patch: Partial<Settings>) => run(api().call("settings.update", patch));

const MODE_OPTIONS: { value: GrantMode; label: string }[] = [
  { value: "read", label: "Read only" },
  { value: "read-write", label: "Read and change" },
];

function Tile({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <div
      className={cn("grid size-9 shrink-0 place-items-center rounded-xl bg-elevated text-muted", className)}
    >
      <Icon className="size-[18px]" strokeWidth={1.8} />
    </div>
  );
}

function InlineError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-2 flex items-start gap-1.5 text-danger text-sm">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** Run a bridge call: keep its fresh status, or surface the failure inline. */
function useBridgeAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const act = async <T,>(key: string, fn: () => Promise<T>, onDone?: (r: T) => void) => {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      onDone?.(r);
      return r;
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, act, setError };
}

/* ------------------------------ Where Yo works ----------------------------- */

function WhereYoWorks() {
  const computer = useApp((s) => s.computer);
  const placement = usePlacement();
  const line =
    placement === "this-mac"
      ? "Yo's computer runs in a Linux VM on this Mac and uses its memory and battery."
      : placement === "home-pc"
        ? "Browsing, code and files run on your Home PC. Your Mac only runs this window and a small helper."
        : placement === "custom-remote"
          ? "Browsing, code and files run on a remote computer. Your Mac only runs this window and a small helper."
          : "Yo couldn't tell where its computer runs.";
  return (
    <div
      className="flex items-start gap-3 rounded-[14px] border border-border bg-card shadow-card p-4"
      data-testid="where-yo-works"
    >
      <Tile icon={placement === "this-mac" ? Laptop : placement === "home-pc" ? House : Server} />
      <div className="min-w-0 flex-1">
        <div className="text-muted text-xs">Where Yo works</div>
        <div className="font-medium">
          {placement ? PLACEMENT_LABEL[placement] : (computer?.host.label ?? "Unknown")}
        </div>
        <div className="mt-0.5 text-muted text-sm">{line}</div>
      </div>
      <Button variant="ghost" size="sm" onClick={() => useUI.setState({ settingsSection: "computer" })}>
        Computer settings
      </Button>
    </div>
  );
}

/* --------------------------------- This Mac -------------------------------- */

/** Why this Mac can't pair or share right now (null = nothing in the way). */
export function macBlocker(s: NonNullable<ReturnType<typeof useDevice.getState>["status"]>): {
  badge: string;
  text: string;
} | null {
  if (!s.supported) return { badge: "Not available", text: "Sharing files with Yo needs macOS." };
  if (!s.helper.available)
    return {
      badge: "Unavailable",
      text: "The Mac helper isn't installed in this build, so folders and files can't be shared from this Mac.",
    };
  if (s.needsEnrollment)
    return {
      badge: "Needs setup",
      text: "This app isn't signed in to Yo yet, so it can't pair. Put a one-time setup token from the computer running Yo into this app's data folder (enroll-token), then restart Yo.",
    };
  if (!s.signedIn)
    return {
      badge: "Unavailable",
      text: "This app couldn't sign in to Yo, so pairing isn't available. Make sure Yo is running and up to date.",
    };
  return null;
}

function ThisMac({ bridge }: { bridge: YoDeviceBridge }) {
  const status = useDevice((s) => s.status);
  const loadError = useDevice((s) => s.error);
  const { busy, error, act } = useBridgeAction();
  const pauseId = useId();

  if (!status) {
    return (
      <div className="rounded-[14px] border border-border bg-card shadow-card p-4" data-testid="this-mac">
        <div className="flex items-center gap-3">
          <Tile icon={Laptop} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">This Mac</div>
            {loadError ? (
              <div className="text-danger text-sm">Couldn't read this Mac's status: {loadError}</div>
            ) : (
              <div className="flex items-center gap-2 text-muted text-sm">
                <Spinner /> Checking this Mac…
              </div>
            )}
          </div>
          {loadError && (
            <Button size="sm" onClick={() => void refreshDevice()}>
              Try again
            </Button>
          )}
        </div>
      </div>
    );
  }

  const blocker = macBlocker(status);
  return (
    <div className="rounded-[14px] border border-border bg-card shadow-card" data-testid="this-mac">
      <div className="flex items-center gap-3 p-4">
        <Tile icon={Laptop} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{status.deviceName}</span>
            <span className="text-faint text-xs">This Mac</span>
          </div>
          {status.paired ? (
            <div className="flex items-center gap-1.5 text-muted text-sm" data-testid="this-mac-state">
              <StatusDot tone={status.paused ? "warning" : status.connected ? "success" : "muted"} />
              {status.paused
                ? "Paired · access paused"
                : status.connected
                  ? "Paired · connected to Yo"
                  : "Paired · offline, reconnecting…"}
            </div>
          ) : (
            <div className="text-muted text-sm" data-testid="this-mac-state">
              {blocker
                ? blocker.text
                : "Not paired. Pairing lets Yo's agents ask for folders you choose here."}
            </div>
          )}
        </div>
        {blocker && !status.paired && (
          <Badge tone={blocker.badge === "Needs setup" ? "warning" : "neutral"}>{blocker.badge}</Badge>
        )}
        {!status.paired && !blocker && (
          <Button
            variant="brand"
            size="sm"
            data-testid="pair-mac"
            disabled={!!busy}
            onClick={() => act("pair", () => bridge.pair(), applyDeviceStatus)}
          >
            {busy === "pair" ? (
              <>
                <Spinner /> Waiting for you to confirm…
              </>
            ) : (
              "Pair this Mac"
            )}
          </Button>
        )}
      </div>
      {status.paired && (
        <div className="border-border border-t px-4">
          {blocker && (
            <div className="flex items-start gap-2 py-3 text-sm text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              {blocker.text}
            </div>
          )}
          <Row
            title="Pause access"
            desc="Takes effect on this Mac immediately, even offline."
            descId={pauseId}
            className={cn(blocker && "border-border border-t")}
          >
            <Switch
              checked={status.paused}
              label="Pause access"
              describedBy={pauseId}
              testId="pause-mac"
              disabled={busy === "pause"}
              onCheckedChange={(v) => void act("pause", () => bridge.setPaused(v), applyDeviceStatus)}
            />
          </Row>
          <div className="flex items-center gap-3 border-border border-t py-2.5">
            <span className="flex-1 text-muted text-sm">
              Unpairing removes every folder, file and app shared from this Mac.
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-danger hover:text-danger"
              disabled={!!busy}
              data-testid="unpair-mac"
              onClick={() => act("unpair", () => bridge.unpair(), applyDeviceStatus)}
            >
              {busy === "unpair" ? <Spinner /> : null} Unpair
            </Button>
          </div>
        </div>
      )}
      {error && (
        <div className="px-4 pb-3">
          <InlineError>{error}</InlineError>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Shared --------------------------------- */

function GrantRow({
  grant,
  bridge,
  deviceName,
  writesOn,
}: {
  grant: DeviceGrant;
  bridge: YoDeviceBridge | undefined;
  deviceName?: string;
  writesOn: boolean;
}) {
  const { busy, error, act } = useBridgeAction();
  const remove = () =>
    act("remove", async () => {
      if (bridge) applyDeviceStatus(await bridge.revoke(grant.id));
      else await api().call("grants.revoke", { grantId: grant.id });
    });
  return (
    <div className="px-4 py-3" data-testid="grant-row">
      <div className="flex items-center gap-3">
        <Tile icon={grant.kind === "dir" ? Folder : FileText} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{grant.name}</div>
          <div className="truncate text-muted text-sm">
            {grant.displayPath}
            {deviceName ? ` · ${deviceName}` : ""}
            {grant.mode === "read-write" && !writesOn ? " · changes are off" : ""}
          </div>
        </div>
        {bridge ? (
          <div className="w-40">
            <Select
              value={grant.mode}
              label={`Access to ${grant.name}`}
              testId="grant-mode"
              disabled={!!busy}
              options={MODE_OPTIONS}
              // Widening to "Read and change" opens a native confirmation on the Mac.
              onChange={(mode) =>
                mode !== grant.mode &&
                void act("mode", () => bridge.setMode(grant.id, mode), applyDeviceStatus)
              }
            />
          </div>
        ) : (
          <Badge>{grant.mode === "read" ? "Read only" : "Read and change"}</Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Remove ${grant.name}`}
          disabled={!!busy}
          onClick={() => void remove()}
        >
          {busy === "remove" ? <Spinner /> : "Remove"}
        </Button>
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}

function SharedList({ bridge }: { bridge: YoDeviceBridge | undefined }) {
  const execution = useApp((s) => s.execution);
  const settings = useApp((s) => s.settings);
  const status = useDevice((s) => s.status);
  const { busy, error, act } = useBridgeAction();
  const local = bridge && status?.paired;
  const devices = activeDevices(execution);
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name;
  // Folders and files only; apps have their own group below.
  const grants: DeviceGrant[] = (
    local ? status.grants.filter((g) => !g.revokedAt) : bridge ? [] : activeGrants(execution)
  ).filter((g) => !isAppGrant(g));
  const showDevice = !bridge && new Set(grants.map((g) => g.deviceId)).size > 1;
  const canShare = !!local && !macBlocker(status);
  const writesOn = settings.macAccess && settings.macWrites;

  return (
    <Group title={bridge ? "Shared from this Mac" : "Shared from your Macs"} testId="shared-list">
      <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-card">
        {grants.length === 0 ? (
          <div className="flex items-center gap-3 px-4 py-4 text-muted text-sm" data-testid="shared-empty">
            <FolderOpen className="size-4 shrink-0" />
            Nothing shared yet. Yo's agents can't see any of your files.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {grants.map((g) => (
              <GrantRow
                key={g.id}
                grant={g}
                bridge={local ? bridge : undefined}
                deviceName={showDevice ? nameOf(g.deviceId) : undefined}
                writesOn={writesOn}
              />
            ))}
          </div>
        )}
        {bridge && (
          <div className="flex items-center gap-3 border-border border-t px-4 py-2.5">
            <Button
              variant="secondary"
              size="sm"
              data-testid="share-folder"
              disabled={!canShare || !!busy}
              onClick={() => act("share", () => bridge.chooseFolder("read"), applyDeviceStatus)}
            >
              {busy === "share" ? <Spinner /> : <Plus className="size-3.5" />}
              Share a folder or file
            </Button>
            {!local && <span className="text-muted text-sm">Pair this Mac to share folders and files.</span>}
            {local && status.paused && <span className="text-muted text-sm">Access is paused.</span>}
          </div>
        )}
      </div>
      {error && <InlineError>{error}</InlineError>}
      <p className="mt-2 px-1 text-muted text-xs">
        Shared content can be sent to your AI provider when an agent reads it.
      </p>
    </Group>
  );
}

/* ----------------------------------- Apps ---------------------------------- */

/** "macOS: allowed" etc. Text + icon, with color only as a hint. */
function OsStatusText({ info, state }: { info: MacAppInfo; state: OsView }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1", OS_TONE_CLASS[state.tone])}
      data-testid={`app-os-${info.app}`}
    >
      <state.icon className="size-3 shrink-0" aria-hidden />
      {state.text}
    </span>
  );
}

/** Where to turn Yo back on when macOS blocks it, with a button to get there (desktop app only). */
function OsBlockedNotice({
  info,
  shared,
  bridge,
  deviceName,
}: {
  info: MacAppInfo;
  shared: boolean;
  bridge: YoDeviceBridge | undefined;
  deviceName?: string;
}) {
  const { busy, error, act } = useBridgeAction();
  const where = `System Settings → Privacy & Security → ${info.pane}`;
  // Notes and Mail are Apple Events: macOS lists them under Automation → Yo.
  const automation = info.permissionKey === null;
  const text = automation
    ? `${shared ? "Shared, but macOS currently blocks" : "macOS blocked"} Yo from controlling ${info.label}. ${
        bridge ? "Open" : "On your Mac, open"
      } ${where} → Yo and turn on ${info.label}.`
    : `${shared ? `Shared, but macOS currently blocks Yo from ${info.label}. ` : `macOS blocked Yo from ${info.label}. `}${
        bridge
          ? `Open ${where} and turn on Yo.`
          : `Turn on Yo in ${where}${deviceName ? ` on ${deviceName}` : " on your Mac"}.`
      }`;
  return (
    <div
      role="status"
      className="mt-2.5 rounded-xl border border-warning/30 bg-warning/[0.06] px-3 py-2.5"
      data-testid={shared ? "app-os-blocked" : "app-blocked"}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-2 text-fg-2 text-sm">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span>{text}</span>
        </div>
        {bridge && (
          <Button
            variant="secondary"
            size="sm"
            data-testid={`app-open-privacy-${info.app}`}
            disabled={!!busy}
            onClick={() => void act("privacy", () => bridge.openPrivacy(info.app))}
          >
            <ExternalLink className="size-3.5" />
            Open System Settings
          </Button>
        )}
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}

/** One Mac app on this Mac (desktop app): macOS status, and sharing it with Yo. */
function LocalAppRow({
  info,
  grant,
  bridge,
  canShare,
  writesOn,
}: {
  info: MacAppInfo;
  grant: DeviceGrant | undefined;
  bridge: YoDeviceBridge;
  canShare: boolean;
  writesOn: boolean;
}) {
  const status = useDevice((s) => s.status);
  const { busy, error, act } = useBridgeAction();
  // What macOS answered the last time the user clicked Allow (it doesn't ask again once you say no).
  const [answered, setAnswered] = useState<string | null>(null);
  const os = appOsView(info, status?.permissions, !!grant, answered);
  const label = info.label;

  const allow = (mode: GrantMode) =>
    act(
      "allow",
      () => bridge.allowApp(info.app, mode),
      ({ osStatus, ...fresh }) => {
        applyDeviceStatus(fresh);
        setAnswered(osStatus);
      },
    );
  const blocked = os.blocked || (!grant && (answered === "denied" || answered === "restricted"));

  let control: ReactNode;
  if (grant) {
    control = (
      <>
        {info.canChange ? (
          <div className="w-40">
            <Select
              value={grant.mode}
              label={`Access to ${label}`}
              testId={`app-mode-${info.app}`}
              disabled={!!busy}
              options={modeOptions(info)}
              // Widening to "Read and change" opens a native confirmation on the Mac.
              onChange={(mode) =>
                mode !== grant.mode &&
                void act("mode", () => bridge.setMode(grant.id, mode), applyDeviceStatus)
              }
            />
          </div>
        ) : (
          <Badge>Read only</Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Stop sharing ${label}`}
          data-testid={`app-stop-${info.app}`}
          disabled={!!busy}
          onClick={() => void act("stop", () => bridge.revoke(grant.id), applyDeviceStatus)}
        >
          {busy === "stop" ? <Spinner /> : "Stop sharing"}
        </Button>
      </>
    );
  } else if (busy === "allow") {
    control = (
      <Button variant="secondary" size="sm" disabled data-testid={`app-allow-${info.app}`}>
        <Spinner /> Waiting for macOS…
      </Button>
    );
  } else if (info.canChange) {
    control = (
      <Menu
        testId={`app-allow-menu-${info.app}`}
        className="w-56"
        trigger={
          <Button
            variant="secondary"
            size="sm"
            data-testid={`app-allow-${info.app}`}
            aria-label={`Allow ${label}…`}
            disabled={!canShare || !!busy}
          >
            Allow…
          </Button>
        }
      >
        <MenuItem testId="app-allow-read" icon={<Eye />} onClick={() => void allow("read")}>
          Read only
        </MenuItem>
        <MenuItem testId="app-allow-read-write" icon={<Save />} onClick={() => void allow("read-write")}>
          {info.changeLabel}
        </MenuItem>
      </Menu>
    );
  } else {
    control = (
      <Button
        variant="secondary"
        size="sm"
        data-testid={`app-allow-${info.app}`}
        aria-label={`Allow ${label} (read only)…`}
        disabled={!canShare || !!busy}
        onClick={() => void allow("read")}
      >
        Allow…
      </Button>
    );
  }

  return (
    <div className="px-4 py-3" data-testid="app-row" data-app={info.app}>
      <div className="flex items-center gap-3">
        <Tile icon={info.icon} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{label}</div>
          <div className="text-muted text-sm">{info.purpose}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
            <OsStatusText info={info} state={os} />
            <span className="text-faint" aria-hidden>
              ·
            </span>
            <span className="text-muted" data-testid={`app-share-${info.app}`}>
              {grant
                ? `Shared${grant.mode === "read-write" && !writesOn ? " · changes are off" : ""}`
                : "Not shared"}
            </span>
          </div>
        </div>
        {control}
      </div>
      {blocked && <OsBlockedNotice info={info} shared={!!grant} bridge={bridge} />}
      <InlineError>{error}</InlineError>
    </div>
  );
}

/** One Mac app as core sees it (browser): what's shared, and stopping it. Sharing needs the Mac app. */
function RemoteAppRow({
  info,
  grants,
  devices,
  writesOn,
}: {
  info: MacAppInfo;
  grants: DeviceGrant[];
  devices: PairedDevice[];
  writesOn: boolean;
}) {
  const { busy, error, act } = useBridgeAction();
  const grant = grants[0];
  const device =
    devices.find((d) => d.id === grant?.deviceId) ?? (devices.length === 1 ? devices[0] : undefined);
  const os = device ? appOsView(info, device.permissions, !!grant) : null;
  return (
    <div className="px-4 py-3" data-testid="app-row" data-app={info.app}>
      <div className="flex items-center gap-3">
        <Tile icon={info.icon} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{info.label}</div>
          <div className="text-muted text-sm">{info.purpose}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
            {os && (
              <>
                <OsStatusText info={info} state={os} />
                <span className="text-faint" aria-hidden>
                  ·
                </span>
              </>
            )}
            <span className="text-muted" data-testid={`app-share-${info.app}`}>
              {grant
                ? `Shared${devices.length > 1 && device ? ` from ${device.name}` : ""}${grant.mode === "read-write" && !writesOn ? " · changes are off" : ""}`
                : "Not shared"}
            </span>
          </div>
        </div>
        {grant && (
          <>
            <Badge>{modeText(info, grant.mode)}</Badge>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Stop sharing ${info.label}`}
              data-testid={`app-stop-${info.app}`}
              disabled={!!busy}
              onClick={() =>
                void act("stop", async () => {
                  for (const g of grants) await api().call("grants.revoke", { grantId: g.id });
                })
              }
            >
              {busy === "stop" ? <Spinner /> : "Stop sharing"}
            </Button>
          </>
        )}
      </div>
      {grant && os?.blocked && (
        <OsBlockedNotice info={info} shared bridge={undefined} deviceName={device?.name} />
      )}
      <InlineError>{error}</InlineError>
    </div>
  );
}

function AppsGroup({ bridge }: { bridge: YoDeviceBridge | undefined }) {
  const execution = useApp((s) => s.execution);
  const settings = useApp((s) => s.settings);
  const status = useDevice((s) => s.status);
  const writesOn = settings.macAccess && settings.macWrites;
  const local = bridge && status?.paired ? status : null;
  const canShare = !!local && !macBlocker(local) && !local.paused;
  const appGrants = (list: DeviceGrant[], app: DeviceApp) =>
    list.filter((g) => isAppGrant(g) && g.app === app && !g.revokedAt);

  return (
    <Group title="Apps" testId="apps-list">
      <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-card">
        <div className="divide-y divide-border">
          {MAC_APPS.map((info) =>
            bridge ? (
              <LocalAppRow
                key={info.app}
                info={info}
                grant={local ? appGrants(local.grants, info.app)[0] : undefined}
                bridge={bridge}
                canShare={canShare}
                writesOn={writesOn}
              />
            ) : (
              <RemoteAppRow
                key={info.app}
                info={info}
                grants={appGrants(activeGrants(execution), info.app)}
                devices={activeDevices(execution)}
                writesOn={writesOn}
              />
            ),
          )}
        </div>
        {(!bridge || !local || local.paused) && (
          <div className="border-border border-t px-4 py-2.5 text-muted text-sm" data-testid="apps-note">
            {!bridge
              ? "Open the Yo app on your Mac to share apps."
              : !local
                ? "Pair this Mac to share apps."
                : "Access is paused."}
          </div>
        )}
      </div>
      <p className="mt-2 px-1 text-muted text-xs">
        macOS asks you first. Yo shows each change to Calendar, Reminders or Notes, and each Mail draft, and
        waits for your OK. Yo never sends mail.
      </p>
    </Group>
  );
}

/* ------------------------------ Window control ----------------------------- */

/** One macOS setting window control needs: "Screen Recording: on", with an icon. */
function MacSettingText({ view, testId }: { view: ReturnType<typeof macSettingView>; testId: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", OS_TONE_CLASS[view.tone])} data-testid={testId}>
      <view.icon className="size-3 shrink-0" aria-hidden />
      {view.text}
    </span>
  );
}

/**
 * What to do when macOS hasn't let Yo see windows yet (Screen Recording, and Accessibility to click and
 * type, are only granted in System Settings — there is no prompt to answer).
 */
function ScreenSettingsGuide({
  bridge,
  blocked,
  shared,
}: {
  bridge: YoDeviceBridge;
  blocked: boolean;
  shared: boolean;
}) {
  const { busy, error, act } = useBridgeAction();
  return (
    <div
      role="status"
      className="mt-2.5 rounded-xl border border-warning/30 bg-warning/[0.06] px-3 py-2.5"
      data-testid="window-control-guidance"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-2 text-fg-2 text-sm">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <div>
            <div className="font-medium text-fg">
              {blocked
                ? "macOS blocked Yo from seeing windows."
                : shared
                  ? "Shared, but macOS isn't letting Yo see or use windows yet."
                  : "macOS needs your OK in System Settings first."}
            </div>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4">
              <li>
                Turn on Yo in System Settings → Privacy & Security → Screen Recording (and Accessibility to
                click/type).
              </li>
              <li>You may need to quit and reopen Yo.</li>
              {!shared && <li>Then click Allow again.</li>}
            </ol>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          data-testid="window-control-open-privacy"
          disabled={!!busy}
          onClick={() => void act("privacy", () => bridge.openPrivacy("screen"))}
        >
          <ExternalLink className="size-3.5" />
          Open System Settings
        </Button>
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}

/** This Mac's side of window control (desktop app): the macOS settings it needs and sharing it with Yo. */
function WindowControlMac({ bridge }: { bridge: YoDeviceBridge }) {
  const status = useDevice((s) => s.status);
  const { busy, error, act } = useBridgeAction();
  // What the last Allow answered: "needs-settings" until Yo is turned on in System Settings.
  const [answered, setAnswered] = useState<string | null>(null);
  const local = status?.paired ? status : null;
  const grant = local?.grants.find((g) => isAppGrant(g) && g.app === "screen" && !g.revokedAt);
  const rec = macSettingView("Screen Recording", status?.permissions.screenRecording);
  const ax = macSettingView("Accessibility", status?.permissions.accessibility);
  const canShare = !!local && !macBlocker(local) && !local.paused;
  const blocked = answered === "denied" || answered === "restricted";
  const needsSettings = grant
    ? !!status && (!rec.on || (grant.mode === "read-write" && !ax.on))
    : (answered === "needs-settings" && (!rec.on || !ax.on)) || blocked;

  const allow = (mode: GrantMode) =>
    act(
      `allow-${mode}`,
      () => bridge.allowApp("screen", mode),
      ({ osStatus, ...fresh }) => {
        applyDeviceStatus(fresh);
        setAnswered(osStatus);
      },
    );

  return (
    <div className="px-4 py-3" data-testid="window-control-mac">
      <div className="flex items-center gap-3">
        <Tile icon={AppWindow} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">Windows on {status?.deviceName ?? "this Mac"}</div>
          <div className="text-muted text-sm">
            Yo asks each time, for one window and a few minutes. Nothing else on your screen is shared.
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
            <MacSettingText view={rec} testId="screen-recording-status" />
            <span className="text-faint" aria-hidden>
              ·
            </span>
            <MacSettingText view={ax} testId="accessibility-status" />
            <span className="text-faint" aria-hidden>
              ·
            </span>
            <span className="text-muted" data-testid="window-control-share">
              {grant ? `Shared · ${modeText(SCREEN_APP, grant.mode)}` : "Not shared"}
            </span>
          </div>
        </div>
        {grant && (
          <>
            <div className="w-40">
              <Select
                value={grant.mode}
                label="What Yo may do in a window you approve"
                testId="window-control-mode"
                disabled={!!busy}
                options={modeOptions(SCREEN_APP)}
                // Widening asks macOS again (Accessibility) and confirms on the Mac; narrowing just applies.
                onChange={(mode) =>
                  mode !== grant.mode &&
                  void (mode === "read-write"
                    ? allow(mode)
                    : act("mode", () => bridge.setMode(grant.id, mode), applyDeviceStatus))
                }
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Stop sharing windows"
              data-testid="window-control-stop-sharing"
              disabled={!!busy}
              onClick={() => void act("stop", () => bridge.revoke(grant.id), applyDeviceStatus)}
            >
              {busy === "stop" ? <Spinner /> : "Stop sharing"}
            </Button>
          </>
        )}
      </div>
      {!grant && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 pl-12">
          <Button
            variant="secondary"
            size="sm"
            data-testid="window-control-allow-read"
            disabled={!canShare || !!busy}
            onClick={() => void allow("read")}
          >
            {busy === "allow-read" ? <Spinner /> : <ScanEye className="size-3.5" />}
            Allow looking
          </Button>
          <Button
            variant="secondary"
            size="sm"
            data-testid="window-control-allow-read-write"
            disabled={!canShare || !!busy}
            onClick={() => void allow("read-write")}
          >
            {busy === "allow-read-write" ? <Spinner /> : <MousePointerClick className="size-3.5" />}
            Allow looking and clicking
          </Button>
          {busy?.startsWith("allow") && <span className="text-muted text-sm">Checking with macOS…</span>}
          {!local && <span className="text-muted text-sm">Pair this Mac first.</span>}
          {local?.paused && <span className="text-muted text-sm">Access is paused.</span>}
        </div>
      )}
      {needsSettings && <ScreenSettingsGuide bridge={bridge} blocked={blocked} shared={!!grant} />}
      {!grant && answered === "cancelled" && (
        <p className="mt-2 pl-12 text-muted text-sm" data-testid="window-control-cancelled">
          Not shared: you chose Cancel in the confirmation on your Mac. Click Allow again and choose “Allow
          changes”.
        </p>
      )}
      <InlineError>{error}</InlineError>
    </div>
  );
}

function WindowControlGroup({ bridge }: { bridge: YoDeviceBridge | undefined }) {
  const settings = useApp((s) => s.settings);
  const descId = useId();
  const title = "Let Yo use a window you approve";
  return (
    <Group title="Window control" testId="window-control">
      <div className="space-y-2.5">
        {bridge && <WindowSessionBanner variant="inline" />}
        <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-card">
          <Row
            title={title}
            desc={`Last resort for tasks no other tool can do. You approve one window for a few minutes; a banner with Stop stays on screen.${settings.macAccess ? "" : " Turn on Mac access first."}`}
            descId={descId}
            className="px-4"
          >
            <Switch
              checked={settings.macAccess && settings.macControl}
              disabled={!settings.macAccess}
              label={title}
              describedBy={descId}
              testId="mac-control"
              onCheckedChange={(v) => void update({ macControl: v })}
            />
          </Row>
          <div className="border-border border-t">
            {bridge ? (
              <WindowControlMac bridge={bridge} />
            ) : (
              <div className="flex items-center gap-3 px-4 py-3 text-sm" data-testid="window-control-note">
                <Tile icon={AppWindow} />
                <span className="text-fg-2">Open the Yo app on your Mac to set up window control.</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Group>
  );
}

/* ------------------------------ Other devices ------------------------------ */

function deviceLine(d: PairedDevice): { tone: "success" | "warning" | "muted"; text: string } {
  if (d.paused) return { tone: "warning", text: "Paused on the Mac" };
  if (d.online) return { tone: "success", text: "Online" };
  return { tone: "muted", text: d.lastSeenAt ? `Offline · last seen ${ago(d.lastSeenAt)}` : "Offline" };
}

function DeviceRow({ device, grantCount }: { device: PairedDevice; grantCount: number }) {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, act } = useBridgeAction();
  const line = deviceLine(device);
  return (
    <div className="px-4 py-3" data-testid="device-row">
      <div className="flex items-center gap-3">
        <Tile icon={Laptop} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{device.name}</div>
          <div className="flex items-center gap-1.5 text-muted text-sm">
            <StatusDot tone={line.tone} />
            {line.text} · {grantCount === 0 ? "nothing shared" : `${grantCount} shared`}
          </div>
        </div>
        {confirming ? (
          <>
            <span className="text-muted text-sm">Unpair {device.name}?</span>
            <Button
              variant="danger"
              size="sm"
              disabled={!!busy}
              onClick={() =>
                act(
                  "unpair",
                  () => api().call("devices.unpair", { deviceId: device.id }),
                  () => setConfirming(false),
                )
              }
            >
              {busy ? <Spinner /> : null} Unpair
            </Button>
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(true)}
            aria-label={`Unpair ${device.name}`}
          >
            Unpair
          </Button>
        )}
      </div>
      <InlineError>{error}</InlineError>
    </div>
  );
}

function OtherDevices({ bridge }: { bridge: YoDeviceBridge | undefined }) {
  const execution = useApp((s) => s.execution);
  const status = useDevice((s) => s.status);
  const grants = activeGrants(execution);
  const devices = activeDevices(execution).filter((d) => !bridge || d.id !== status?.deviceId);
  if (bridge && devices.length === 0) return null;
  return (
    <Group title={bridge ? "Other paired devices" : "Paired Macs"} testId="paired-devices">
      <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-card">
        {devices.length === 0 ? (
          <div className="px-4 py-4 text-muted text-sm">No Macs are paired with Yo.</div>
        ) : (
          <div className="divide-y divide-border">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                device={d}
                grantCount={grants.filter((g) => g.deviceId === d.id).length}
              />
            ))}
          </div>
        )}
      </div>
    </Group>
  );
}

/* ----------------------------- Recent activity ----------------------------- */

const VERB: Record<DeviceOperation["capability"], [past: string, plain: string, icon: LucideIcon]> = {
  "files.list": ["Listed", "List", FolderOpen],
  "files.read": ["Read", "Read", Eye],
  "files.write": ["Saved", "Save", Save],
  "contacts.read": ["Looked up", "Look up", BookUser],
  "calendar.read": ["Checked Calendar", "Check Calendar", CalendarCheck],
  "calendar.write": ["Changed Calendar", "Change Calendar", CalendarCog],
  "reminders.read": ["Checked Reminders", "Check Reminders", ListTodo],
  "reminders.write": ["Changed Reminders", "Change Reminders", ListChecks],
  "notes.read": ["Checked Notes", "Check Notes", NotebookText],
  "notes.write": ["Changed Notes", "Change Notes", NotebookPen],
  "mail.read": ["Checked Mail", "Check Mail", Mail],
  "mail.draft": ["Drafted mail", "Draft mail", MailPlus],
  "window.observe": ["Looked at a window", "Look at a window", ScanEye],
  "window.control": ["Used a window", "Use a window", MousePointerClick],
};

/** The Mac app an operation used ("screen" for window sessions), or null for files. */
function opApp(op: DeviceOperation): DeviceApp | null {
  const prefix = op.capability.split(".")[0];
  if (prefix === "window") return "screen";
  return prefix === "contacts" ||
    prefix === "calendar" ||
    prefix === "reminders" ||
    prefix === "notes" ||
    prefix === "mail"
    ? prefix
    : null;
}

/** Activity line for an operation: "Read ~/Docs/a.csv", "Checked Calendar", "Changed Calendar · Add …". */
function OperationText({ op }: { op: DeviceOperation }) {
  const [past, plain] = VERB[op.capability];
  const verb = op.status === "succeeded" ? past : plain;
  const app = opApp(op);
  if (!app)
    return (
      <>
        <span className="font-medium">{verb}</span> <span className="text-fg-2">{op.displayPath}</span>
      </>
    );
  // App operations carry a self-describing displayPath ("Calendar: Add “Call Alex” to Home").
  const label = macApp(app).label;
  const detail = op.displayPath.startsWith(`${label}: `)
    ? op.displayPath.slice(label.length + 2)
    : op.displayPath === label
      ? ""
      : op.displayPath;
  return (
    <>
      <span className="font-medium">{verb}</span>
      {verb.toLowerCase().includes(label.toLowerCase()) || app === "screen" ? "" : ` in ${label}`}
      {detail && <span className="text-fg-2"> · {detail}</span>}
    </>
  );
}

const OP_STATUS: Record<
  DeviceOperationStatus,
  { label: string; tone: "neutral" | "success" | "warning" | "danger" | "link"; icon: LucideIcon }
> = {
  succeeded: { label: "Done", tone: "success", icon: Check },
  failed: { label: "Failed", tone: "danger", icon: CircleX },
  denied: { label: "Declined", tone: "neutral", icon: CircleX },
  expired: { label: "Expired", tone: "neutral", icon: TimerOff },
  cancelled: { label: "Cancelled", tone: "neutral", icon: CircleX },
  "awaiting-approval": { label: "Waiting for you", tone: "warning", icon: Hourglass },
  authorized: { label: "In progress", tone: "link", icon: Clock },
  dispatching: { label: "In progress", tone: "link", icon: Clock },
  "unknown-outcome": { label: "Outcome unknown — check the file", tone: "warning", icon: TriangleAlert },
};

export function OperationStatusBadge({
  status,
  checkWhat = "the file",
}: {
  status: DeviceOperationStatus;
  /** What to check when the outcome is unknown ("the file", "Calendar"). */
  checkWhat?: string;
}) {
  const s = OP_STATUS[status];
  return (
    <Badge tone={s.tone} className="shrink-0">
      <s.icon className="size-3" />
      {status === "unknown-outcome" ? `Outcome unknown — check ${checkWhat}` : s.label}
    </Badge>
  );
}

function RecentActivity() {
  const operations = useApp((s) => s.operations);
  const agents = useApp((s) => s.agents);
  const list = [...(operations ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8);
  return (
    <Group title="Recent activity on your Mac" testId="device-activity">
      <div className="overflow-hidden rounded-[14px] border border-border bg-card shadow-card">
        {operations === null ? (
          <div className="flex items-center gap-2 px-4 py-4 text-muted text-sm">
            <Spinner /> Loading…
          </div>
        ) : list.length === 0 ? (
          <div className="px-4 py-4 text-muted text-sm">
            Nothing yet. When an agent reads or changes something on your Mac, it shows up here.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {list.map((op) => {
              const Icon = VERB[op.capability][2];
              const app = opApp(op);
              const agent = agents[op.agentId];
              return (
                <div key={op.id} className="flex items-center gap-3 px-4 py-2.5" data-testid="operation-row">
                  <Icon className="size-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      <OperationText op={op} />
                    </div>
                    <div className="truncate text-muted text-xs">
                      {agent?.name ?? "An agent"} · {ago(op.updatedAt)}
                      {op.reason && op.status !== "succeeded" ? ` · ${op.reason}` : ""}
                    </div>
                  </div>
                  <OperationStatusBadge status={op.status} checkWhat={app ? macApp(app).label : undefined} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Group>
  );
}

/* ---------------------------------- Memory --------------------------------- */

const PROC_LABEL: Record<string, string> = {
  Browser: "App",
  Tab: "Window",
  GPU: "Graphics",
  Utility: "Utility",
};

function useMacMetrics(bridge: YoDeviceBridge | undefined) {
  const [metrics, setMetrics] = useState<DeviceMetrics | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const m = await bridge.metrics();
        if (alive) {
          setMetrics(m);
          setFailed(false);
        }
      } catch {
        if (alive) setFailed(true);
      }
    };
    void tick();
    // Only while this section is on screen: the interval stops when it unmounts.
    const t = window.setInterval(tick, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [bridge]);
  return { metrics, failed };
}

function MemoryUse({ bridge }: { bridge: YoDeviceBridge | undefined }) {
  const computer = useApp((s) => s.computer);
  const { metrics, failed } = useMacMetrics(bridge);
  const placement = usePlacement();

  const byType = new Map<string, number>();
  for (const p of metrics?.procs ?? []) {
    const k = PROC_LABEL[p.type] ?? p.type;
    byType.set(k, (byType.get(k) ?? 0) + p.memMB);
  }
  const running = computer?.runtime === "running";
  const mem = running && computer?.memMB != null ? computer.memMB : null;

  return (
    <Group title="Memory use" testId="memory-use">
      <div className="grid grid-cols-2 gap-2.5">
        <div
          className="rounded-[14px] border border-border bg-card shadow-card p-4"
          data-testid="memory-this-mac"
        >
          <div className="flex items-center gap-2 text-muted text-sm">
            <MemoryStick className="size-3.5" /> Yo app on this Mac
          </div>
          <div className="mt-1.5 font-semibold text-xl tabular-nums tracking-[-0.01em]">
            {bridge && metrics && !failed ? `${metrics.totalMB} MB` : "Unavailable"}
          </div>
          {bridge && metrics && !failed ? (
            <>
              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted text-xs tabular-nums">
                {[...byType].map(([k, v]) => (
                  <span key={k}>
                    {k} {v} MB
                  </span>
                ))}
              </div>
              <div className="mt-1 text-faint text-xs">Updated {clockTime(metrics.at)}</div>
            </>
          ) : (
            <div className="mt-1.5 text-muted text-xs">
              {bridge
                ? failed
                  ? "Couldn't read memory use from the app."
                  : "Measuring…"
                : "Only the Yo app for macOS can measure this."}
            </div>
          )}
        </div>
        <div
          className="rounded-[14px] border border-border bg-card shadow-card p-4"
          data-testid="memory-agent-computer"
        >
          <div className="flex items-center gap-2 text-muted text-sm">
            <MemoryStick className="size-3.5" /> Agent computer
          </div>
          <div className="mt-1.5 font-semibold text-xl tabular-nums tracking-[-0.01em]">
            {mem != null ? `${(mem / 1024).toFixed(1)} GB` : "Unavailable"}
            {mem != null && computer?.memLimitMB ? (
              <span className="font-normal text-base text-muted">
                {" "}
                of {(computer.memLimitMB / 1024).toFixed(0)} GB
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 text-muted text-xs">
            {!running
              ? "Yo's computer isn't running."
              : placement === "this-mac"
                ? "Uses this Mac's memory."
                : placement
                  ? `On ${PLACEMENT_LABEL[placement]}, not this Mac.`
                  : ""}
          </div>
        </div>
      </div>
    </Group>
  );
}

/* --------------------------------- Section --------------------------------- */

export function DevicesAccessSettings() {
  const execution = useApp((s) => s.execution);
  const settings = useApp((s) => s.settings);
  const bridge = deviceBridge();
  const accessId = useId();
  const writesId = useId();

  useEffect(() => {
    void load.execution();
    void load.operations(true);
    void refreshDevice();
  }, []);

  return (
    <div data-testid="devices-access">
      <H desc="Choose what Yo may use on your Mac. Everything else happens on Yo's own computer.">
        Devices & access
      </H>
      <WhereYoWorks />

      {!execution ? (
        <div
          className="mt-4 flex items-start gap-3 rounded-[14px] border border-border bg-card shadow-card p-4 text-sm"
          data-testid="devices-unavailable"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted" />
          <div>
            <div className="font-medium">Not available with this version of Yo</div>
            <div className="text-muted">
              Yo's core doesn't support paired Macs yet, so nothing can be shared from your Mac. Update Yo to
              use this.
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-2 divide-y divide-border">
            <Row
              title={bridge ? "Let Yo use this Mac" : "Let Yo use your Mac"}
              desc="Only folders, files and apps you share below. Nothing else on your Mac is visible."
              descId={accessId}
            >
              <Switch
                checked={settings.macAccess}
                label={bridge ? "Let Yo use this Mac" : "Let Yo use your Mac"}
                describedBy={accessId}
                testId="mac-access"
                onCheckedChange={(v) => void update({ macAccess: v })}
              />
            </Row>
            <Row
              title="Allow approved changes"
              desc={
                settings.macAccess
                  ? "Yo shows each change and waits for you before saving it."
                  : "Yo shows each change and waits for you before saving it. Turn on Mac access first."
              }
              descId={writesId}
            >
              <Switch
                checked={settings.macAccess && settings.macWrites}
                disabled={!settings.macAccess}
                label="Allow approved changes"
                describedBy={writesId}
                testId="mac-writes"
                onCheckedChange={(v) => void update({ macWrites: v })}
              />
            </Row>
          </div>

          <Group title={bridge ? "This Mac" : "Pairing"}>
            {bridge ? (
              <ThisMac bridge={bridge} />
            ) : (
              <div
                className="flex items-center gap-3 rounded-[14px] border border-border bg-card shadow-card p-4 text-sm"
                data-testid="pair-in-app"
              >
                <Tile icon={Laptop} />
                <span className="text-fg-2">Open the Yo app on your Mac to pair it and share folders.</span>
              </div>
            )}
          </Group>

          <SharedList bridge={bridge} />
          <AppsGroup bridge={bridge} />
          <WindowControlGroup bridge={bridge} />
          <OtherDevices bridge={bridge} />
          <RecentActivity />
        </>
      )}

      <MemoryUse bridge={bridge} />
    </div>
  );
}
