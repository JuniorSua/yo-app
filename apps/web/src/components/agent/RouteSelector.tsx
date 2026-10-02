/**
 * Composer choice of where a message may run: Auto (default) or the agent computer only. A preference
 * captured with each message, never a permission: core still checks Mac access, grants and approvals.
 * Kept per agent in memory only (resets to Auto on reload).
 */
import { Menu as BMenu } from "@base-ui/react/menu";
import type { ExecutionStatus, RoutePreference } from "@yo/contracts";
import { Check, ChevronDown, Route, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { activeDevices } from "../../stores/app";
import { Menu } from "../ui/overlay";

const chosen = new Map<string, RoutePreference>();

const OPTIONS: { value: RoutePreference; label: string; desc: string; icon: typeof Route }[] = [
  {
    value: "auto",
    label: "Auto",
    desc: "Agent computer, plus files you shared from your Mac when needed",
    icon: Route,
  },
  {
    value: "agent-computer",
    label: "Agent computer only",
    desc: "Don't use this Mac for this message",
    icon: Server,
  },
];

/** Only worth offering when Mac access is on and some Mac is paired. */
export function routeChoiceAvailable(execution: ExecutionStatus | null) {
  return !!execution?.flags.devices && activeDevices(execution).length > 0;
}

export function useRoute(agentId: string): [RoutePreference, (r: RoutePreference) => void] {
  const [route, setRoute] = useState<RoutePreference>(() => chosen.get(agentId) ?? "auto");
  useEffect(() => setRoute(chosen.get(agentId) ?? "auto"), [agentId]);
  return [
    route,
    (r) => {
      chosen.set(agentId, r);
      setRoute(r);
    },
  ];
}

export function RouteSelector({
  value,
  onChange,
}: {
  value: RoutePreference;
  onChange: (r: RoutePreference) => void;
}) {
  const current = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0]!;
  return (
    <Menu
      side="top"
      align="start"
      testId="route-menu"
      className="w-72"
      trigger={
        <button
          data-testid="route-trigger"
          aria-label={`Where this message can run: ${current.label}`}
          className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-fg-2 text-sm transition-colors hover:bg-hover hover:text-fg data-[popup-open]:bg-active"
        >
          <current.icon className="size-3.5" />
          <span className="font-medium">{current.label}</span>
          <ChevronDown className="size-3 text-muted" />
        </button>
      }
    >
      <BMenu.RadioGroup value={value} onValueChange={(v) => onChange(v as RoutePreference)}>
        {OPTIONS.map((o) => (
          <BMenu.RadioItem
            key={o.value}
            value={o.value}
            closeOnClick
            data-testid={`route-${o.value}`}
            className="flex select-none items-start gap-2.5 rounded-lg px-2.5 py-2 outline-none data-[highlighted]:bg-hover"
          >
            <o.icon className="mt-0.5 size-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-base">{o.label}</div>
              <div className="text-muted text-xs">{o.desc}</div>
            </div>
            <BMenu.RadioItemIndicator className="mt-0.5">
              <Check className="size-3.5 text-fg" />
            </BMenu.RadioItemIndicator>
          </BMenu.RadioItem>
        ))}
      </BMenu.RadioGroup>
    </Menu>
  );
}
