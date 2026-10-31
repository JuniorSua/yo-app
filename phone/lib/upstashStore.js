// Upstash Redis over its REST API: one POST to `${url}/pipeline` per batch. No dependencies.

/**
 * @param {{ url: string, token: string, fetch?: typeof fetch }} opts
 */
export function createUpstashStore({ url, token, fetch: fetchImpl = globalThis.fetch }) {
  const endpoint = `${url.replace(/\/+$/, "")}/pipeline`;
  return {
    kind: "upstash",
    /** @param {Array<Array<string|number>>} cmds */
    async pipeline(cmds) {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(cmds.map((c) => c.map(String))),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
      const body = await res.json();
      if (!Array.isArray(body) || body.length !== cmds.length)
        throw new Error("Upstash: unexpected response");
      return body.map((r) => {
        if (r && typeof r === "object" && "error" in r) throw new Error(`Upstash: ${r.error}`);
        return r?.result ?? null;
      });
    },
  };
}

/**
 * Picks the store from the environment: Vercel KV names first, then Upstash's own.
 * @param {Record<string, string | undefined>} env
 */
export function upstashFromEnv(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return createUpstashStore({ url, token });
}
