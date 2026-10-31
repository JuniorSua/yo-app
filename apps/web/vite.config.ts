import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { buildId } from "../../scripts/build-info.mjs";

const CORE = process.env.YO_CORE_URL ?? "http://127.0.0.1:7777";

/** Writes dist/build.json so core can tell open UIs which build it now serves (see core http/updates.ts). */
function buildInfo(id: string | null): Plugin {
  return {
    name: "yo-build-info",
    apply: "build",
    generateBundle() {
      if (id) this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify({ build: id }) });
    },
  };
}

export default defineConfig(({ command }) => {
  // Only real builds get an id; the dev server (and the mock UI) leave the refresh check off.
  const id = command === "build" ? buildId() : null;
  return {
    // Relative base so the build works when served by yo-core, from file:// or under any sub-path.
    base: "./",
    plugins: [react(), tailwindcss(), buildInfo(id)],
    define: { __YO_BUILD__: JSON.stringify(id) },
    server: {
      port: Number(process.env.PORT ?? 5173),
      strictPort: true,
      proxy: {
        "/ws": { target: CORE, ws: true },
        "/api": { target: CORE, ws: true },
        // Browser sign-in (lib/browserAuth.ts).
        "/auth": { target: CORE },
      },
    },
    build: {
      outDir: "dist",
      // noVNC uses top-level await.
      target: "es2022",
      chunkSizeWarningLimit: 1500,
      rolldownOptions: {
        output: {
          // Settings, the workspace pages and the computer window load on demand (see src/lib/lazy.tsx). Keep the
          // icons they share with the chat in one file instead of dozens of tiny ones.
          codeSplitting: { groups: [{ name: "icons", test: /node_modules[\\/]lucide-react/ }] },
        },
      },
    },
  };
});
