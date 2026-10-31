/**
 * API side of the "Connect your model" walkthrough: what core can see on the machine it runs on. Never reads or
 * returns a sign-in. Nothing is imported from here: Claude, ChatGPT and Grok all sign in on Yo's computer
 * (`account.login.start`).
 */
import type { ConnectDetection } from "@yo/contracts";
import { logger } from "../log";
import { detectHost, type HostEnv, type HostFs, nodeHostEnv, nodeHostFs } from "./hostConnect";

const log = logger("connect");

export class ConnectService {
  constructor(
    private env: () => HostEnv = nodeHostEnv,
    private fs: HostFs = nodeHostFs,
  ) {}

  async detect(): Promise<ConnectDetection> {
    try {
      return await detectHost(this.env(), this.fs);
    } catch (err) {
      log.warn("host detection failed", err);
      const env = this.env();
      return {
        host: { platform: env.platform, name: env.hostname },
        claude: { installed: false, signedIn: null },
        codex: { installed: false, signedIn: null },
      };
    }
  }
}
