export const DEFAULT_UPDATE_REPO: string;
export function resolveUpdateChannel(
  env: Record<string, string | undefined>,
  where: { publicSnapshot: boolean },
): { channel: "github" | "feed"; repo: string; computerImageRepo: string | null };
