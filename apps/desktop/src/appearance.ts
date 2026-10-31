import { type BrowserWindow, type BrowserWindowConstructorOptions, ipcMain, nativeTheme } from "electron";

/** Use the OS compositor for the desktop backdrop; keep normal, resizable window semantics. */
export function windowMaterialOptions() {
  const glass =
    process.platform === "darwin" &&
    !nativeTheme.prefersReducedTransparency &&
    !nativeTheme.shouldUseHighContrastColors;
  return {
    backgroundColor: glass ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1C1D20" : "#FAF9F6",
    // Without `transparent`, Electron ignores the alpha and paints the page on an opaque layer above the
    // frost, so nothing behind the window ever showed. It's fixed at window creation (can't be toggled).
    ...(glass ? { transparent: true, vibrancy: "under-window", visualEffectState: "active" } : {}),
  } satisfies BrowserWindowConstructorOptions;
}

/** Follow appearance/accessibility changes without rebuilding the window or disturbing its session. */
export function installWindowAppearance(window: BrowserWindow, uiUrl: string) {
  const update = () => {
    const options = windowMaterialOptions();
    if (process.platform === "darwin") window.setVibrancy(options.vibrancy ?? null);
    window.setBackgroundColor(options.backgroundColor!);
  };
  const setTheme = (event: Electron.IpcMainEvent, theme: unknown) => {
    // Only the app's main frame may change native appearance; previews/remote content cannot.
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    try {
      if (new URL(event.senderFrame.url).origin !== new URL(uiUrl).origin) return;
    } catch {
      return;
    }
    if (theme !== "light" && theme !== "dark" && theme !== "system") return;
    if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
  };
  nativeTheme.on("updated", update);
  ipcMain.on("yo:appearance:theme", setTheme);
  window.once("closed", () => {
    nativeTheme.off("updated", update);
    ipcMain.off("yo:appearance:theme", setTheme);
  });
}
