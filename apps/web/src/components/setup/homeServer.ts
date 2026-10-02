/**
 * The home-server path of the first agent's setup chat: Yo's core and the agent's computer both run on an
 * always-on machine at home, and this Mac's Yo opens it through an SSH tunnel (the desktop app's
 * `remote.json` mode). Generic on purpose: `<you>@<your-server>` is filled in by the user, never by us.
 *
 * Every command here must match the repo: computer/compose.server.yaml, apps/core/Dockerfile,
 * apps/desktop/src/main.ts (remote.json, the waiting screen) and the controller enrollment
 * (apps/core/src/auth/ControllerAuth.ts: a one-time token in both data folders, valid 10 minutes).
 */
import { REQUIREMENTS } from "@yo/contracts";

export const PUBLIC_REPO = "https://github.com/JuniorSua/yo-app.git";

export interface GuideStep {
  title: string;
  /** Where to run the commands. */
  where: "server" | "mac";
  body: string;
  commands: string[];
  note?: string;
}

const MAC_DATA = "~/Library/Application\\ Support/Yo";

export const HOME_SERVER_NEEDS: string[] = [
  `An always-on PC running Linux, or Windows with WSL 2 (Ubuntu). ${REQUIREMENTS.ram.minimumGB} GB of memory or more (${REQUIREMENTS.ram.recommendedGB} GB recommended), ${REQUIREMENTS.cpu.minimumCores}+ CPU cores and about ${REQUIREMENTS.disk.recommendedFreeGB} GB free.`,
  "Docker Engine with the Compose plugin, git, and Node 22 on that PC.",
  "SSH from this Mac to the PC: on your home network, or anywhere through a private network such as Tailscale (free for personal use).",
  "Never forward Yo's ports (7777, 7801) on your router. The SSH tunnel is the only way in.",
];

export const HOME_SERVER_STEPS: GuideStep[] = [
  {
    title: "Get Yo and build it",
    where: "server",
    body: "Download Yo's source and build its core and web app. pnpm comes with Node through Corepack.",
    commands: [
      `git clone ${PUBLIC_REPO} ~/yo && cd ~/yo`,
      "corepack enable && pnpm install && pnpm --filter @yo/core --filter @yo/web build",
    ],
    note: "If corepack says permission denied, run it with sudo.",
  },
  {
    title: "Build the two images",
    where: "server",
    body: "One for Yo's core, one for my computer (Chromium, a desktop and tools). The second takes 10–20 minutes the first time.",
    commands: [
      "cd ~/yo && mkdir -p ~/yo-core-build && cp apps/core/Dockerfile apps/core/dist/core.mjs ~/yo-core-build/ && cp -r apps/web/dist ~/yo-core-build/web",
      "docker build -t yo-core:local ~/yo-core-build",
      "docker build -t yo-computer:local -f computer/Dockerfile .",
    ],
  },
  {
    title: "Start Yo on the server",
    where: "server",
    body: "Create a private settings file with a fresh secret, then start both. They restart on their own after a reboot, as long as Docker starts.",
    commands: [
      "cd ~/yo/computer && mkdir -p core-data",
      `printf 'YO_AGENTD_TOKEN=%s\\nYO_UID=%s\\nYO_GID=%s\\n' "$(openssl rand -hex 32)" "$(id -u)" "$(id -g)" > .env && chmod 600 .env`,
      "docker compose -f compose.server.yaml up -d",
      "curl -s http://127.0.0.1:7777/healthz",
    ],
    note: "The last command prints ok when Yo is up. On Windows, WSL only runs while it's started: have it start when you sign in, and keep the PC from sleeping.",
  },
  {
    title: "Check this Mac can reach the server",
    where: "mac",
    body: "Replace <you> with your user name on the server and <your-server> with its name or address.",
    commands: ["ssh <you>@<your-server> echo ok"],
    note: "Set up an SSH key (ssh-keygen, then ssh-copy-id <you>@<your-server>) so the tunnel doesn't ask for a password.",
  },
  {
    title: "Point Yo on this Mac at the server",
    where: "mac",
    body: "Quit Yo first (Yo menu → Quit Yo). Then tell the app to open the server, and give it a one-time sign-in token that works for 10 minutes.",
    commands: [
      `echo '{"label":"Home server"}' > ${MAC_DATA}/remote.json`,
      `T=$(openssl rand -hex 32); ssh <you>@<your-server> "umask 077; echo $T > ~/yo/computer/core-data/enroll-token" && (umask 077; echo $T > ${MAC_DATA}/enroll-token)`,
    ],
  },
  {
    title: "Open the tunnel and reopen Yo",
    where: "mac",
    body: "Keep this running (leave the Terminal window open), then open Yo. It shows “Connecting to Yo on your Home server…” until the tunnel is up, then the server's Yo, where you connect your model once more.",
    commands: ["ssh -N -L 7777:127.0.0.1:7777 <you>@<your-server>"],
    note: "To keep the tunnel up without a Terminal window: brew install autossh, then autossh -M 0 -f -N -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 7777:127.0.0.1:7777 <you>@<your-server> (run it again after restarting your Mac).",
  },
];

/** Back to running everything on this Mac. */
export const HOME_SERVER_UNDO = `Quit Yo, stop the tunnel, run rm ${MAC_DATA}/remote.json, and open Yo again.`;
