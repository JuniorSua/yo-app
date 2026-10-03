import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initApi } from "./lib/api";
import { startSync } from "./stores/sync";
import { startUpdates } from "./stores/updates";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

if (new URLSearchParams(location.search).has("creature-lab")) {
  // Isolated character exploration: /?creature-lab=1. No API or agent data mutations.
  document.title = "Yo — Character workshop";
  import("./components/creature-lab/CreatureLab").then(({ CreatureLab }) => root.render(<CreatureLab />));
} else if (new URLSearchParams(location.search).has("gallery")) {
  // Visual QA page for the avatar system: /?gallery=1
  import("./components/AvatarGallery").then(({ AvatarGallery }) => root.render(<AvatarGallery />));
} else
  initApi().then(() => {
    void startSync();
    startUpdates();
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
