/**
 * The home-server path of the first agent's setup chat: Yo's core and the agent's computer both run on an
 * always-on machine at home, and this Mac's Yo opens it through an SSH tunnel (the desktop app's
 * `remote.json` mode). Generic on purpose: `<you>@<your-server>` is filled in by the user, never by us.
 *
 * Every command here must match the repo: computer/compose.server.yaml (attached to every release),
 * apps/core/Dockerfile (published as <CORE_IMAGE>:<version> by the release workflow, .github/workflows/release.yml),
 * apps/desktop/src/main.ts (remote.json, the waiting screen) and the controller enrollment
 * (apps/core/src/auth/ControllerAuth.ts: a one-time token in both data folders, valid 10 minutes).
 */
import { REQUIREMENTS } from "@yo/contracts";

/** Where releases are published. Yo's source is private; the release has everything a server needs. */
export const RELEASES = "https://github.com/JuniorSua/yo-app/releases/download";
/** Yo's core and the agent's computer, published with every release as <image>:<version> (release.yml). */
export const CORE_IMAGE = "ghcr.io/juniorsua/yo-core";
export const COMPUTER_IMAGE = "ghcr.io/juniorsua/yo-computer";

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
  "Docker Engine with the Compose plugin, and curl, on that PC.",
  "SSH from this Mac to the PC: on your home network, or anywhere through a private network such as Tailscale (free for personal use).",
  "The PC must never sleep (Windows: Settings → System → Power → Sleep: Never when plugged in).",
  "Windows: WSL 2 with systemd turned on, Docker Engine inside Ubuntu (not Docker Desktop), and WSL started at boot (Task Scheduler, “At startup”).",
  "Never forward Yo's ports (7777, 7801) on your router. The SSH tunnel is the only way in.",
];

export const HOME_SERVER_STEPS: GuideStep[] = [
  {
    title: "Get Yo's server files",
    where: "server",
    body: "Download the server setup for the same version of Yo as this app. Yo menu → About Yo shows the version (like 0.1.300): put it in place of <version>.",
    commands: [
      `mkdir -p ~/yo/computer && cd ~/yo/computer && curl -fsSLo compose.server.yaml ${RELEASES}/v<version>/compose.server.yaml`,
    ],
  },
  {
    title: "Get the two images",
    where: "server",
    body: "Download Yo's core and my computer (Chromium, a desktop and tools, about 1 GB) for the same version.",
    commands: [`docker pull ${CORE_IMAGE}:<version>`, `docker pull ${COMPUTER_IMAGE}:<version>`],
  },
  {
    title: "Start Yo on the server",
    where: "server",
    body: "Create a private settings file with a fresh secret, then start both. They restart on their own after a reboot, as long as Docker starts.",
    commands: [
      "cd ~/yo/computer && mkdir -p core-data",
      `printf 'YO_AGENTD_TOKEN=%s\\nYO_UID=%s\\nYO_GID=%s\\nYO_CORE_IMAGE=%s\\nYO_COMPUTER_IMAGE=%s\\n' "$(openssl rand -hex 32)" "$(id -u)" "$(id -g)" "${CORE_IMAGE}:<version>" "${COMPUTER_IMAGE}:<version>" > .env && chmod 600 .env`,
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
    body: "Yo can stay open for this one. It tells the app to open the server from now on, and makes a one-time sign-in token that works for 10 minutes, so go straight on to the last step.",
    commands: [
      `echo '{"label":"Home server"}' > ${MAC_DATA}/remote.json`,
      `T=$(openssl rand -hex 32); ssh <you>@<your-server> "umask 077; echo $T > ~/yo/computer/core-data/enroll-token" && (umask 077; echo $T > ${MAC_DATA}/enroll-token)`,
    ],
  },
  {
    title: "Open the tunnel and reopen Yo",
    where: "mac",
    body: "Copy the command first: this guide closes when you quit Yo. Quit Yo (Yo menu → Quit Yo), paste the command in Terminal and leave that window open, then open Yo again. It shows “Connecting to Yo on your Home server…” until the tunnel is up, then the server's Yo, where you connect your model once more.",
    commands: ["ssh -N -L 7777:127.0.0.1:7777 <you>@<your-server>"],
    note: "To keep the tunnel up without a Terminal window: brew install autossh, then autossh -M 0 -f -N -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 7777:127.0.0.1:7777 <you>@<your-server> (run it again after restarting your Mac).",
  },
];

/** After Yo on this Mac updates: bring the server to the same version (the new <version> from About Yo). */
export const HOME_SERVER_UPDATE: string[] = [
  `cd ~/yo/computer && curl -fsSLo compose.server.yaml ${RELEASES}/v<version>/compose.server.yaml`,
  `docker pull ${CORE_IMAGE}:<version> && docker pull ${COMPUTER_IMAGE}:<version>`,
  `sed -i 's#^YO_CORE_IMAGE=.*#YO_CORE_IMAGE=${CORE_IMAGE}:<version>#; s#^YO_COMPUTER_IMAGE=.*#YO_COMPUTER_IMAGE=${COMPUTER_IMAGE}:<version>#' .env && docker compose -f compose.server.yaml up -d`,
];

/** Back to running everything on this Mac. */
export const HOME_SERVER_UNDO = `Quit Yo, stop the tunnel, run rm ${MAC_DATA}/remote.json, and open Yo again.`;
