/**
 * A saved sign-in the provider turned down (expired, revoked, signed out elsewhere). The CLIs say so in their own
 * words ("Invalid API key · Please run /login"), which tell the user to run a command they can't run: adapters
 * report it as one plain message with `auth: true` instead, and core asks the user to sign in again.
 */

export const SIGN_IN_EXPIRED: Record<"claude" | "codex", string> = {
  claude:
    "Claude's sign-in has expired or was signed out, so I couldn't do this. Open Settings → Accounts and press Sign in again, then send it again.",
  codex:
    "ChatGPT's sign-in has expired or was signed out, so I couldn't do this. Open Settings → Accounts and press Sign in again, then send it again.",
};

/**
 * Text the Claude and Codex CLIs use when the saved sign-in is rejected. Only matched against a turn's or a
 * session's own error (never tool output, where a website's "401 Unauthorized" means something else).
 */
const AUTH_FAILURE =
  /please run \/login|invalid api key|oauth token has expired|authentication_error|invalid bearer token|token (?:has been |was )?revoked|could not be refreshed|refresh token (?:has expired|was already used|was rejected|is invalid)|invalid_refresh_token|log out and sign in again|please (?:try )?sign(?:ing)? in again|\b401\b[^\n]*unauthori[sz]ed|unauthori[sz]ed[^\n]*\b401\b/i;

export function looksLikeAuthFailure(text: string | undefined | null): boolean {
  return !!text && AUTH_FAILURE.test(text);
}
