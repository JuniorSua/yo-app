/**
 * Work & Personal spaces on the core (the pure rules live in @yo/contracts spaces.ts): each space has its own main
 * agent. The primary agent (Yo) leads Work; Pip, created here, leads Personal. Runs on every boot and whenever the
 * owner turns spaces on, and is safe to run any number of times: a live agent per space at most (the database's
 * unique index backs this up), and Pip comes back from the archive rather than being made twice.
 */
import {
  type ActiveSpace,
  type Agent,
  type Avatar,
  agentForSpace,
  resolveSpace,
  type Space,
  teammateAvatar,
} from "@yo/contracts";
import type { Store } from "../db/store";

/** kv: the id of the Personal agent this core made, so turning spaces off and on brings the same one back. */
const PERSONAL_KV = "personalAgentId";
/** kv: the primary's old default role was renamed once (see below). */
const ROLE_FIX_KV = "spacesRoleFix";

export const PERSONAL_NAME = "Pip";
export const PERSONAL_ROLE = "your personal-time agent";
const OLD_PRIMARY_ROLE = "your personal agent";
const WORK_ROLE = "your work assistant";

/** Pip is Mochi, so new teammates still start at Dew; if someone already wears Mochi, the next free Softie. */
function personalAvatar(store: Store): Avatar {
  const team = store.listAgents();
  const taken = team.some((a) => !a.archivedAt && a.kind !== "helper" && a.avatar.softie?.kind === "mochi");
  if (taken) return teammateAvatar(team);
  return { shape: "bubble", color: "#2DC892", eyes: "capsule", accessory: "none", softie: { kind: "mochi" } };
}

/** Run a write that the unique index may refuse (another live agent already leads that space): false if so. */
function tryWrite(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

/**
 * Make sure each space has its main agent, when spaces are on: the primary leads Work (unless another live agent
 * already does), and a Personal agent exists (Pip: brought back from the archive if this core made one before,
 * else created). Returns the ids of agents it created or changed, for the caller to tell the apps.
 */
export function ensureSpaceAgents(store: Store): string[] {
  if (!store.getSettings().spacesOn) return [];
  const changed: string[] = [];
  const agents = store.listAgents();
  const primary = agents.find((a) => a.isPrimary) ?? null;

  let work = store.getSpaceAgent("work");
  if (!work && primary && !primary.space && tryWrite(() => store.setAgentSpace(primary.id, "work"))) {
    work = store.getAgent(primary.id);
    changed.push(primary.id);
  }

  if (!store.getSpaceAgent("personal")) {
    const saved = store.getKv<string>(PERSONAL_KV);
    const old = saved ? store.getAgent(saved) : null;
    let personal: Agent | null = null;
    if (old && old.kind !== "helper" && !old.isPrimary) {
      // The one this core made before (archived when spaces were turned off): bring it back, chats and all.
      const back = tryWrite(() => {
        store.setAgentSpace(old.id, "personal");
        if (old.archivedAt) store.updateAgent(old.id, { archivedAt: null });
      });
      if (back) personal = store.getAgent(old.id);
    }
    if (!personal && !store.getSpaceAgent("personal")) {
      tryWrite(() => {
        personal = store.createAgent({
          name: PERSONAL_NAME,
          role: PERSONAL_ROLE,
          instructions: "",
          avatar: personalAvatar(store),
          accountId: null,
          model: null,
          effort: null,
          runtimeMode: store.getSettings().defaultRuntimeMode,
          isPrimary: false,
          pinned: true,
          space: "personal",
        });
        store.addActivity({
          agentId: personal.id,
          kind: "system",
          summary: `Created ${personal.name}, your Personal agent`,
          ref: null,
        });
      });
    }
    const made = personal as Agent | null;
    if (made) {
      store.setKv(PERSONAL_KV, made.id);
      changed.push(made.id);
    }
  }

  // Once: the primary's default role said "personal", which is now Pip's job.
  if (!store.getKv<boolean>(ROLE_FIX_KV)) {
    const lead = work ?? primary;
    if (lead?.isPrimary && lead.role === OLD_PRIMARY_ROLE) {
      store.updateAgent(lead.id, { role: WORK_ROLE });
      if (!changed.includes(lead.id)) changed.push(lead.id);
    }
    store.setKv(ROLE_FIX_KV, true);
  }
  return changed;
}

/**
 * Spaces were turned off: put the Personal agent away (archived, chats kept) so the owner is back to one main
 * agent. Turning spaces on again brings it back. Returns its id, or null when there was none.
 */
export function shelvePersonalAgent(store: Store): string | null {
  const personal = store.getSpaceAgent("personal");
  if (!personal || personal.isPrimary) return null;
  store.setKv(PERSONAL_KV, personal.id);
  store.updateAgent(personal.id, { archivedAt: Date.now() });
  return personal.id;
}

/** The space right now, from the owner's settings (Work when spaces are off). */
export function activeSpace(store: Pick<Store, "getSettings">, now = Date.now()): ActiveSpace {
  return resolveSpace(now, store.getSettings());
}

/** The main agent of the space right now (the primary when spaces are off or the space has no agent). */
export function activeSpaceAgent(store: Pick<Store, "getSettings" | "listAgents">, now = Date.now()) {
  const s = store.getSettings();
  return agentForSpace(store.listAgents(), resolveSpace(now, s).space, s.spacesOn === true);
}

/** The space an agent works in for prompts and memory: its own, or its parent's for a helper; none when off. */
export function focusOf(
  store: Pick<Store, "getSettings" | "getAgent">,
  agent: Pick<Agent, "space" | "kind" | "parentId"> | null | undefined,
): Space | undefined {
  if (!agent || !store.getSettings().spacesOn) return undefined;
  const own = agent.kind === "helper" && agent.parentId ? store.getAgent(agent.parentId) : agent;
  return own?.space ?? undefined;
}
