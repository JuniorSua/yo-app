// Runs yo-core (watch mode) + the web UI (Vite) together for development.
// UI: http://127.0.0.1:5173   Core API: http://127.0.0.1:7777
import { spawn } from "node:child_process";

const procs = [
  ["core", "pnpm", ["--filter", "@yo/core", "dev"], { YO_DEV: "1" }],
  ["web", "pnpm", ["--filter", "@yo/web", "dev"], {}],
];

const children = procs.map(([name, cmd, args, env]) => {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}]`.padEnd(7);
  const out = (d) => process.stdout.write(d.toString().replace(/^(?=.)/gm, `${tag} `));
  child.stdout.on("data", out);
  child.stderr.on("data", out);
  child.on("exit", (code) => console.log(`${tag} exited (${code})`));
  return child;
});

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
