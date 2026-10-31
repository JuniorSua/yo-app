import { type AgentView, localDateOf } from "@yo/contracts";
import { useEffect } from "react";
import { useApp } from "../stores/app";
import { useActiveAgent } from "../stores/space";
import { api } from "./api";

/** The local date this browser last asked core for the morning brief. */
const CLAIM_KEY = "yo.briefClaim";

/**
 * Ask core for today's morning brief, at most once per local day from this browser. Core decides (it's on, not
 * claimed by another tab or device, not the user's first day) and posts it in the chat when it says yes.
 */
export function claimBriefToday(now = new Date()) {
  const today = localDateOf(now);
  try {
    if (localStorage.getItem(CLAIM_KEY) === today) return;
    localStorage.setItem(CLAIM_KEY, today);
  } catch {
    /* no storage: core's own claim still keeps it to one a day */
  }
  api()
    .call("brief.claim", { localDate: today })
    .catch(() => {
      // Not reached (offline, an older core): a later open tries again.
      try {
        if (localStorage.getItem(CLAIM_KEY) === today) localStorage.removeItem(CLAIM_KEY);
      } catch {
        /* ignore */
      }
    });
}

/**
 * The chat of the active space's main agent opened (never a helper's or another agent's): claim the day's brief.
 * `ready`: its conversation has loaded and the first-run setup chat isn't showing.
 */
export function useMorningBriefClaim(agent: AgentView | undefined, ready: boolean) {
  const lead = useActiveAgent();
  const on = useApp((s) => s.settings.morningBrief !== false && s.settings.onboarded !== false);
  const mine = !!agent && agent.id === lead?.id && agent.kind !== "helper";
  useEffect(() => {
    if (ready && on && mine) claimBriefToday();
  }, [ready, on, mine]);
}
