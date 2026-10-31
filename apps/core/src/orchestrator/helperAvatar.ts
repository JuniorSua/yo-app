import { helperAvatar as softieHelper } from "@yo/avatar/tint";
import type { Avatar } from "@yo/contracts";

/**
 * A helper's little avatar: a teammate Softie (never Yo, never its parent's) in one of the helper accents, random
 * but stable for its id. The pick lives with the renderer (packages/avatar/src/softies/helper.ts), so the app and
 * core agree on it.
 */
export function helperAvatar(helperId: string, parent?: Pick<Avatar, "color" | "softie">): Avatar {
  return softieHelper(helperId, parent);
}
