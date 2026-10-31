/**
 * The real backend: 1Password's official JavaScript SDK with a service account token. The SDK (and its ~14 MB
 * WebAssembly core, which build.mjs embeds compressed) is only loaded the first time 1Password is used, so a Yo
 * without 1Password never pays for it.
 */
import type { LoginSite, SiteMatchMode } from "@yo/contracts";
import { CORE_VERSION } from "../config";
import {
  type BackendFactory,
  classifyError,
  type LoginOverview,
  type LoginSecrets,
  OnePasswordError,
} from "./backend";

type Sdk = typeof import("@1password/sdk");
type Website = { url: string; autofillBehavior: string };

const MODE: Record<string, SiteMatchMode> = {
  AnywhereOnWebsite: "anywhere",
  ExactDomain: "exact",
  Never: "never",
};

const sites = (websites: Website[] | undefined): LoginSite[] =>
  (websites ?? []).map((w) => ({ url: w.url, mode: MODE[w.autofillBehavior] ?? "anywhere" }));

export const sdkBackend: BackendFactory = async (token) => {
  const sdk: Sdk = await import("@1password/sdk").catch((err) => {
    // Bundled core reads the SDK's WebAssembly from onepassword-core.wasm.br next to core.mjs (build.mjs).
    throw new OnePasswordError(
      `This copy of Yo is missing its 1Password part, so 1Password can't be used. Update Yo. (${String(err?.message ?? err).slice(0, 120)})`,
      "other",
    );
  });
  const LOGIN_KINDS = new Set<string>([sdk.ItemCategory.Login, sdk.ItemCategory.Password]);
  const client = await sdk
    .createClient({ auth: token, integrationName: "Yo", integrationVersion: CORE_VERSION })
    .catch((err) => {
      throw classifyError(err);
    });
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw classifyError(err);
    }
  };
  return {
    vaults: () =>
      call(async () =>
        (await client.vaults.list()).map((v) => ({ id: v.id, title: v.title, items: v.activeItemCount })),
      ),
    logins: (vaultId) =>
      call(async () =>
        (await client.items.list(vaultId))
          .filter((i) => LOGIN_KINDS.has(i.category))
          .map(
            (i): LoginOverview => ({
              vaultId: i.vaultId,
              itemId: i.id,
              title: i.title,
              sites: sites(i.websites),
              hasCode: null,
            }),
          ),
      ),
    login: (vaultId, itemId) =>
      call(async () => {
        const item = await client.items.get(vaultId, itemId);
        const f = item.fields;
        // Built-in Login fields have the ids "username" and "password"; other items get the closest match.
        const username =
          f.find((x) => x.id === "username") ??
          f.find(
            (x) =>
              (x.fieldType === sdk.ItemFieldType.Text || x.fieldType === sdk.ItemFieldType.Email) &&
              /user|e-?mail|login/i.test(x.title),
          );
        const password =
          f.find((x) => x.id === "password") ??
          f.find((x) => x.fieldType === sdk.ItemFieldType.Concealed && /pass/i.test(x.title));
        const totp = f.find((x) => x.fieldType === sdk.ItemFieldType.Totp);
        const code = totp?.details?.type === "Otp" ? totp.details.content.code : undefined;
        const out: LoginSecrets = { title: item.title, sites: sites(item.websites) };
        if (username?.value) out.username = username.value;
        if (password?.value) out.password = password.value;
        if (code) out.oneTimeCode = code;
        return out;
      }),
  };
};
