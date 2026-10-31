/**
 * The agents' 1Password tools. onepassword_search returns names, websites and item refs; onepassword_fill has
 * core read the login and agentd type it into the agent's browser. Neither result ever carries a username,
 * password or code, so none reaches the model, the chat, the timeline, logs or bug reports.
 *
 * Reading a secret into the chat isn't offered at all, not even with approval: once in the model's context it
 * would be in the provider's transcript and Yo's history for good. Signing in covers what Yo needs; for anything
 * else the user opens 1Password themselves.
 */
import {
  type FillLoginResult,
  fieldList,
  itemRef,
  type LoginSite,
  ONE_PASSWORD_FIELDS,
  type OnePasswordFieldKind,
  OnePasswordFillInput,
  OnePasswordSearchInput,
  parseItemRef,
  siteHost,
} from "@yo/contracts";
import type { Store } from "../db/store";
import { logger } from "../log";
import type { LoginSecrets } from "./backend";
import type { OnePassword } from "./OnePassword";

const log = logger("1password");

export const ONE_PASSWORD_TOOLS = ["onepassword_search", "onepassword_fill"];
/** The approval card's tool name; an "Always allow" saves the rule `yo:1password:<host>`. */
export const ONE_PASSWORD_APPROVAL = "yo:1password";
export const ruleFor = (host: string) => `${ONE_PASSWORD_APPROVAL}:${host}`;
/** After the user allows a login once, more steps of the same sign-in (the code page) don't ask again. */
const GRANT_MS = 10 * 60_000;

export interface FillApproval {
  host: string;
  item: string;
  fields: OnePasswordFieldKind[];
}

export interface OnePasswordToolDeps {
  onePassword: OnePassword;
  store: Store;
  /** agentd's browser.fillLogin. */
  fill: (
    agentId: string,
    req: {
      sites: LoginSite[];
      fields: { kind: OnePasswordFieldKind; value?: string }[];
      dryRun: boolean;
    },
  ) => Promise<FillLoginResult>;
  /** Whose rules and grants apply (a helper's are its parent's). */
  ruleOwner: (agentId: string) => string;
  /** The approval card. Resolves "allow" | "deny" | "expired". */
  ask: (agentId: string, callId: string, a: FillApproval) => Promise<"allow" | "deny" | "expired">;
  now?: () => number;
}

const VALUE: Record<OnePasswordFieldKind, keyof LoginSecrets> = {
  username: "username",
  password: "password",
  one_time_code: "oneTimeCode",
};

/** agentd's refusal in words the model can act on (an older computer doesn't know the request yet). */
function fillError(err: unknown): Error {
  const code = (err as { code?: string })?.code;
  if (code === "invalid_request" || /invalid request: type/i.test(String((err as Error)?.message)))
    return new Error(
      "Yo's computer needs an update before it can fill 1Password logins. Ask the user to update Yo and restart its computer; use request_takeover meanwhile.",
    );
  if (/agentd not connected|timed out/i.test(String((err as Error)?.message)))
    return new Error("Yo's computer isn't answering right now. Try again in a moment.");
  return err instanceof Error ? err : new Error(String(err));
}

export function createOnePasswordTools(d: OnePasswordToolDeps) {
  const now = d.now ?? Date.now;
  const grants = new Map<string, number>();
  const grantKey = (agentId: string, ref: string, host: string) => `${d.ruleOwner(agentId)}|${ref}|${host}`;

  const search = async (args: Record<string, unknown>): Promise<string> => {
    const p = OnePasswordSearchInput.parse(args);
    const found = await d.onePassword.search(p.query, p.limit ?? 10);
    const vaults = d.onePassword.promptInfo()?.vaults.join(", ") || "the shared vault";
    if (!found.length)
      return `No login for "${p.query}" in 1Password (vaults Yo can see: ${vaults}). The user can add one to that vault in 1Password; otherwise use request_takeover.`;
    return [
      `Logins in 1Password (use the item_ref with onepassword_fill; you never see the values):`,
      ...found.map((l) => {
        const hosts = [...new Set(l.sites.map((s) => siteHost(s.url)).filter(Boolean))];
        return `- "${l.title}" — ${hosts.length ? hosts.join(", ") : "no website saved"} — vault ${l.vault} — item_ref ${itemRef(l.vaultId, l.itemId)}`;
      }),
    ].join("\n");
  };

  const fill = async (agentId: string, callId: string, args: Record<string, unknown>): Promise<string> => {
    const p = OnePasswordFillInput.parse(args);
    const ref = parseItemRef(p.item_ref);
    if (!ref) throw new Error(`"${p.item_ref}" isn't an item_ref from onepassword_search.`);
    let login = await d.onePassword.login(ref.vaultId, ref.itemId);
    const wanted = (p.fields ?? [...ONE_PASSWORD_FIELDS]).filter((k) => login[VALUE[k]]);
    if (!wanted.length)
      throw new Error(
        `The 1Password login "${login.title}" has no ${fieldList(p.fields ?? [...ONE_PASSWORD_FIELDS]).replace(" and ", " or ")} saved.`,
      );
    if (!login.sites.some((s) => s.mode !== "never"))
      throw new Error(
        `The 1Password login "${login.title}" has no website saved, so Yo can't tell where it belongs. The user can add the website to it in 1Password.`,
      );

    // Find the tab first (no values sent), so the card names the real page.
    const probe = await d
      .fill(agentId, { sites: login.sites, fields: wanted.map((kind) => ({ kind })), dryRun: true })
      .catch((err) => {
        throw fillError(err);
      });
    if (!probe.found.length)
      throw new Error(
        `The page on ${probe.host} doesn't show a ${fieldList(wanted).replace(" and ", " or ")} field Yo can recognize (fields inside embedded frames aren't supported yet). Use request_takeover for this one.`,
      );

    const key = grantKey(agentId, p.item_ref, probe.host);
    const ruled = d.store.findRule(d.ruleOwner(agentId), ruleFor(probe.host))?.decision;
    if (ruled === "deny") return `DENIED (standing rule): don't sign in to ${probe.host} with 1Password.`;
    if (ruled !== "allow" && (grants.get(key) ?? 0) < now()) {
      const answer = await d.ask(agentId, callId, {
        host: probe.host,
        item: login.title,
        fields: probe.found,
      });
      if (answer === "deny")
        return `DENIED by the user: don't sign in to ${probe.host} with the 1Password login "${login.title}".`;
      if (answer === "expired")
        return "The user didn't answer in time, so nothing was filled. Don't retry on your own: tell the user, or ask again later.";
      // A code read before the wait may have run out by now.
      if (probe.found.includes("one_time_code")) login = await d.onePassword.login(ref.vaultId, ref.itemId);
    }
    grants.set(key, now() + GRANT_MS);

    const fields = probe.found.map((kind) => ({ kind, value: login[VALUE[kind]] as string }));
    const r = await d.fill(agentId, { sites: login.sites, fields, dryRun: false }).catch((err) => {
      throw fillError(err);
    });

    // Audit: which login, where, what. Never a value.
    const agentName = d.store.getAgent(agentId)?.name ?? "Yo";
    const what = fieldList(r.filled);
    d.store.addActivity({
      agentId,
      kind: "system",
      summary: `Used 1Password login "${login.title}" on ${r.host} (${what})`,
      ref: null,
    });
    d.onePassword.recordUse({ at: now(), item: login.title, site: r.host, fields: r.filled, agentName });
    log.info(`${agentName} used login "${login.title}" on ${r.host} (${what})`);

    return [
      `Filled the ${what} from the 1Password login "${login.title}" on ${r.host}${r.submitted ? " and submitted the form" : ""}.`,
      r.stillOnForm
        ? "The sign-in form is still showing (wrong password, or one more step): Yo cleared the password from it. Take a snapshot to see what the page says."
        : "Take a snapshot to see the result. If the page now asks for a one-time code, call onepassword_fill again.",
    ].join(" ");
  };

  return async (agentId: string, callId: string, tool: string, args: Record<string, unknown>) => {
    if (tool === "onepassword_search") return search(args);
    if (tool === "onepassword_fill") return fill(agentId, callId, args);
    throw new Error(`Unknown tool ${tool}`);
  };
}
