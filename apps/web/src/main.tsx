import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initApi } from "./lib/api";
import { prepareBrowserAuth } from "./lib/browserAuth";
import { startSync } from "./stores/sync";
import { startUpdates } from "./stores/updates";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);

// In a plain browser this first takes a `#signin=` token out of the address bar (lib/browserAuth.ts).
initApi(prepareBrowserAuth()).then(() => {
  void startSync();
  startUpdates();
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
