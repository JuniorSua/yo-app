/**
 * `claude setup-token` PTY transcript. The prefix is a real capture from Claude Code 2.1.285
 * (cols=1000; OAuth state/challenge values replaced); the success tail follows the CLI's
 * documented output. Tokens here are fake.
 */
const E = "\u001b";
const BEL = "\u0007";
const URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=FAKECHALLENGE_abcdefghijklmnopqrstuvwxyz0123&code_challenge_method=S256&state=FAKESTATE_abcdefghijklmnopqrstuvwxyz012345";

export const SETUP_TOKEN_URL = URL;

export const SETUP_TOKEN_TRANSCRIPT_PREFIX = [
  `${E}7${E}[r${E}8${E}[?25h${E}[?25l${E}[?2004h${E}[?2031h${E}[?1004h${E}[31mWelcome${E}[9Gto${E}[12GClaude${E}[19GCode${E}[24G${E}[37mv2.1.285${E}[39m\r\r\n`,
  "..........................................................\r\r\n\r\r\n",
  `${E}[2G${E}[1mThis${E}[7Gwill${E}[12Gguide${E}[18Gyou${E}[22Gthrough${E}[30Glong-lived${E}[41G(1-year)${E}[50Gauth${E}[55Gtoken${E}[61Gsetup${E}[67Gfor${E}[71Gyour${E}[76GClaude${E}[83Gaccount.${E}[22m\r\r\n\r\r\n`,
  `${E}[>0q${E}[?u${E}[c${E}[2G${E}[97m·${E}[4G${E}[39mOpening${E}[12Gbrowser${E}[20Gto${E}[23Gsign${E}[28Gin…\r\r\n`,
  `\r${E}[1C${E}[1A${E}[97m✢${E}[39m\r\r\n`,
  `\r${E}[1C${E}[1A${E}[37mBrowser didn't open? Use the url below to sign in (c to copy)${E}[39m\r\r\n\r\r\n`,
  `${E}]8;id=1x3wur3;${URL}${BEL}${E}[37m${URL}${E}[39m${E}]8;;${BEL}\r\r\n\r\r\n\r\r\n`,
  `${E}[2GPaste${E}[8Gcode${E}[13Ghere${E}[18Gif${E}[21Gprompted${E}[30G>\r\r\n`,
];

export const FAKE_OAUTH_TOKEN =
  "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMn-AAAA";

/** Full transcript; `wrapAt` simulates a narrow terminal wrapping the token. */
export function setupTokenTranscript(opts: { token?: string; wrapAt?: number } = {}): string[] {
  const token = opts.token ?? FAKE_OAUTH_TOKEN;
  const shown = opts.wrapAt ? token.match(new RegExp(`.{1,${opts.wrapAt}}`, "g"))!.join("\r\n") : token;
  return [
    ...SETUP_TOKEN_TRANSCRIPT_PREFIX,
    `${E}[2K${E}[1A${E}[2K${E}[G`,
    `${E}[32m✓${E}[39m${E}[3GLong-lived${E}[14Gauthentication${E}[29Gtoken${E}[35Gcreated${E}[43Gsuccessfully!\r\r\n\r\r\n`,
    `Your${E}[6GOAuth${E}[12Gtoken${E}[18G(valid${E}[25Gfor${E}[29G1${E}[31Gyear):\r\r\n\r\r\n`,
    `${E}[33m${shown}${E}[39m\r\r\n\r\r\n`,
    `Store${E}[7Gthis${E}[12Gtoken${E}[18Gsecurely.${E}[28GYou${E}[32Gwon't${E}[38Gbe${E}[41Gable${E}[46Gto${E}[49Gsee${E}[53Git${E}[56Gagain.\r\r\n\r\r\n`,
    `Use${E}[5Gthis${E}[10Gtoken${E}[16Gby${E}[19Gsetting:${E}[28Gexport${E}[35GCLAUDE_CODE_OAUTH_TOKEN=<token>\r\r\n`,
  ];
}
