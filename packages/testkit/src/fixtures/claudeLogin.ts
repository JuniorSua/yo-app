/**
 * `claude auth login --claudeai` PTY transcripts (headless: BROWSER=true, no display). The prompt part is a real
 * capture from Claude Code 2.1.304 on macOS (cols=1000; OAuth state/challenge values replaced): the sign-in
 * link is an OSC 8 hyperlink whose visible text is the link again, and the paste prompt has no newline after it.
 * Claude Code 2.1.285 (the yo-computer image) prints the same, but ends the OSC 8 sequences with ESC \ instead
 * of BEL. The failure tail is a real capture too (a made-up code); the success tail is a placeholder (the flow
 * only relies on the exit code and `claude auth status --json`).
 *
 * The pasted code is never echoed by the CLI, so it never appears in these transcripts.
 */
const E = "\u001b";
const BEL = "\u0007";
const ST = `${E}\\`;

export const CLAUDE_LOGIN_STATE = "FAKESTATE_abcdefghijklmnopqrstuvwxyz012345";

export const CLAUDE_LOGIN_URL = `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins&code_challenge=FAKECHALLENGE_abcdefghijklmnopqrstuvwxyz0123&code_challenge_method=S256&state=${CLAUDE_LOGIN_STATE}`;

/** A code shaped like the one Claude's page shows ("<code>#<state>"), for this transcript's link. */
export const FAKE_CLAUDE_LOGIN_CODE = `FAKEcode_abcdefghijklmnopqrstuvwxyz0123456789#${CLAUDE_LOGIN_STATE}`;

/** Up to and including the paste prompt. `terminator`: how the OSC 8 hyperlink ends (BEL or ESC \). */
export function claudeLoginPrompt(opts: { terminator?: "bel" | "st"; url?: string } = {}): string[] {
  const t = opts.terminator === "st" ? ST : BEL;
  const url = opts.url ?? CLAUDE_LOGIN_URL;
  return [
    "Opening browser to sign in…\r\n",
    `If the browser didn't open, visit: ${E}]8;;${url}${t}${E}[94m${url}${E}[39m${E}]8;;${t}\r\n`,
    "Paste code here if prompted > ",
  ];
}

/** What follows a code Claude turned down (real capture); the CLI then exits 1. */
export const CLAUDE_LOGIN_FAILED_TAIL = `Login failed: Request failed with status code 400\r\n${E}[?25h`;

/** What follows an accepted code (placeholder wording); the CLI then exits 0. */
export const CLAUDE_LOGIN_SUCCESS_TAIL = `Login successful.\r\n${E}[?25h`;
