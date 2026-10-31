#!/usr/bin/env node
/**
 * The PC edition from A to Z, no mocks: build yo-core from this checkout, install it with the real installer
 * (pc/install.sh) into a throwaway folder on a spare port and compose project, drive it in Chromium with
 * Playwright (e2e/pc/pc.spec.ts), then uninstall and check nothing is left. See e2e/pc/README.md.
 *
 *   node e2e/pc/run.mjs [--keep] [--skip-build] [--grep <pattern>]
 *
 * Env:
 *   YO_E2E_PC_PORT       port to install on (default 7798)
 *   YO_E2E_PC_PROJECT    compose project (default yo-app-e2e). Never the name of a real install.
 *   YO_E2E_COMPUTER_IMAGE the agent's computer image (default ghcr.io/juniorsua/yo-computer:latest)
 *   YO_E2E_ANTHROPIC_API_KEY an Anthropic API key: enables the live model test (one short message, billed to the
 *                        key). Without it that test is skipped. (A Claude plan sign-in can't be scripted: the person
 *                        signs in on Claude's own page.)
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const skipBuild = args.includes("--skip-build");
const grepAt = args.indexOf("--grep");
const grep = grepAt >= 0 ? args[grepAt + 1] : null;

const port = Number(process.env.YO_E2E_PC_PORT ?? 7798);
const project = process.env.YO_E2E_PC_PROJECT ?? "yo-app-e2e";
if (project === "yo-app") throw new Error("Use a test project name, not the real install's (yo-app).");
const computerImage = process.env.YO_E2E_COMPUTER_IMAGE ?? "ghcr.io/juniorsua/yo-computer:latest";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "yo-e2e-pc-"));
const home = path.join(work, "home");
const bin = path.join(work, "bin");
const rev = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const coreImage = `yo-core:e2e-${rev}`;

const step = (s) => console.log(`\n▶ ${s}`);
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} exited ${r.status}`);
};
const installerEnv = {
  ...process.env,
  YO_APP_SOURCE: path.join(root, "pc"),
  YO_APP_HOME: home,
  YO_APP_BIN_DIR: bin,
  YO_APP_PROJECT: project,
  YO_APP_PORT: String(port),
  YO_CORE_IMAGE: coreImage,
  YO_COMPUTER_IMAGE: computerImage,
  YO_APP_SKIP_PULL: "1",
  YO_APP_NO_BROWSER: "1",
  YO_APP_YES: "1",
};

let installed = false;
let failed = false;
try {
  if (!skipBuild) {
    step("Build core and the web UI");
    run("pnpm", ["--filter", "@yo/core", "build"]);
    run("pnpm", ["--filter", "@yo/web", "build"]);
    step(`Build the core image ${coreImage}`);
    const ctx = path.join(work, "core-image");
    fs.mkdirSync(ctx);
    fs.copyFileSync(path.join(root, "apps/core/Dockerfile"), path.join(ctx, "Dockerfile"));
    // Everything core's build makes (core.mjs, its map, the 1Password wasm), like the release's image context.
    for (const f of fs.readdirSync(path.join(root, "apps/core/dist")))
      fs.copyFileSync(path.join(root, "apps/core/dist", f), path.join(ctx, f));
    fs.cpSync(path.join(root, "apps/web/dist"), path.join(ctx, "web"), { recursive: true });
    run("docker", ["build", "-q", "-t", coreImage, ctx]);
  }
  if (spawnSync("docker", ["image", "inspect", computerImage], { stdio: "ignore" }).status !== 0) {
    step(`Pull ${computerImage}`);
    run("docker", ["pull", computerImage]);
  }

  step(`Install with pc/install.sh (project ${project}, port ${port})`);
  const out = execFileSync("bash", [path.join(root, "pc/install.sh")], {
    cwd: work,
    env: installerEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  process.stdout.write(out);
  installed = true;
  const link = out.match(/http:\/\/127\.0\.0\.1:\d+\/#signin=[0-9a-f]{64}/)?.[0];
  if (!link) throw new Error("The installer didn't print a sign-in link");

  // Firefox too when Playwright's Firefox is installed (`pnpm exec playwright install firefox`).
  const pwDir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), ".cache/ms-playwright");
  const hasFirefox = fs.existsSync(pwDir) && fs.readdirSync(pwDir).some((d) => d.startsWith("firefox-"));
  const projects = hasFirefox ? ["chromium", "firefox"] : ["chromium"];
  step(`Drive it in ${projects.join(" and ")} (e2e/pc/pc.spec.ts)`);
  run(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "-c",
      "e2e/pc/playwright.config.ts",
      ...projects.flatMap((p) => ["--project", p]),
      ...(grep ? ["--grep", grep] : []),
    ],
    {
      env: {
        ...process.env,
        YO_PC_URL: `http://127.0.0.1:${port}`,
        YO_PC_SIGNIN: link,
        YO_PC_HELPER: path.join(bin, "yo-app"),
        YO_PC_HELPER_ENV: JSON.stringify({ YO_APP_HOME: home, YO_APP_NO_BROWSER: "1", YO_APP_YES: "1" }),
        YO_PC_PROJECT: project,
      },
    },
  );
} catch (err) {
  failed = true;
  console.error(`\n✖ ${err.message}`);
} finally {
  if (installed && !keep) {
    step("Uninstall (yo-app uninstall, deleting the test data)");
    const r = spawnSync(path.join(bin, "yo-app"), ["uninstall"], { stdio: "inherit", env: installerEnv });
    if (r.status !== 0) failed = true;
    const left = execFileSync(
      "docker",
      ["ps", "-a", "-q", "--filter", `label=com.docker.compose.project=${project}`],
      { encoding: "utf8" },
    ).trim();
    const vols = execFileSync(
      "docker",
      ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`],
      { encoding: "utf8" },
    ).trim();
    if (left || vols) {
      console.error(`✖ Left behind: containers [${left}] volumes [${vols}]`);
      failed = true;
    } else console.log("✔ Nothing left behind");
  } else if (installed) {
    console.log(`\nKept the install: ${home} (project ${project}, http://127.0.0.1:${port}).`);
    console.log(`Remove it with: YO_APP_HOME=${home} YO_APP_YES=1 ${path.join(bin, "yo-app")} uninstall`);
  }
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
