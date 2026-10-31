import type { Avatar } from "@yo/contracts";
import { SOFTIES } from "./softies/characters";
import { softieAvatar } from "./softies/helper";

export interface AgentTemplate {
  id: string;
  name: string;
  role: string;
  /** One line on what it's good at. */
  blurb: string;
  /** A first job line (the agent's brief). */
  instructions: string;
  avatar: Avatar;
  primary?: boolean;
}

/** One starting point per Softie: its name, job and look (the site's art export uses these too). */
export const AGENT_TEMPLATES: AgentTemplate[] = SOFTIES.map((s) => ({
  id: s.kind,
  name: s.name,
  role: s.role,
  blurb: s.hint,
  instructions: s.job,
  avatar: softieAvatar(s.kind),
  ...(s.kind === "yo" ? { primary: true } : {}),
}));
