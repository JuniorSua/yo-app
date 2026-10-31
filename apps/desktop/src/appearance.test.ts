import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ nativeTheme: {} as any, ipcMain: {} as any }));
vi.mock("electron", () => mocks);

import { installWindowAppearance, windowMaterialOptions } from "./appearance";

beforeEach(() => {
  mocks.nativeTheme = Object.assign(new EventEmitter(), {
    themeSource: "system",
    shouldUseDarkColors: false,
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
  });
  mocks.ipcMain = new EventEmitter();
  vi.stubGlobal("process", { ...process, platform: "darwin" });
});
afterEach(() => vi.unstubAllGlobals());

describe("Air Glass native appearance", () => {
  it("uses native vibrancy on macOS, with an opaque fallback elsewhere", () => {
    expect(windowMaterialOptions()).toMatchObject({
      vibrancy: "under-window",
      backgroundColor: "#00000000",
      // The frost only shows through a transparent window; an opaque one hides it completely.
      transparent: true,
      visualEffectState: "active",
    });
    for (const platform of ["win32", "linux"]) {
      vi.stubGlobal("process", { ...process, platform });
      expect(windowMaterialOptions()).toEqual({ backgroundColor: "#FAF9F6" });
    }
  });

  it("disables vibrancy for reduced transparency and high contrast, including live changes", () => {
    const window = Object.assign(new EventEmitter(), {
      webContents: { mainFrame: { url: "http://localhost:7777/" } },
      setVibrancy: vi.fn(),
      setBackgroundColor: vi.fn(),
    });
    installWindowAppearance(window as any, "http://localhost:7777");
    mocks.nativeTheme.prefersReducedTransparency = true;
    mocks.nativeTheme.emit("updated");
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#FAF9F6");
    mocks.nativeTheme.prefersReducedTransparency = false;
    mocks.nativeTheme.shouldUseHighContrastColors = true;
    mocks.nativeTheme.shouldUseDarkColors = true;
    mocks.nativeTheme.emit("updated");
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#1C1D20");
    mocks.nativeTheme.shouldUseHighContrastColors = false;
    mocks.nativeTheme.emit("updated");
    expect(window.setVibrancy).toHaveBeenLastCalledWith("under-window");
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#00000000");
    window.emit("closed");
    expect(mocks.nativeTheme.listenerCount("updated")).toBe(0);
    expect(mocks.ipcMain.listenerCount("yo:appearance:theme")).toBe(0);
  });

  it("accepts only the app's main frame and valid theme values", () => {
    const mainFrame = { url: "http://localhost:7777/" };
    const window = Object.assign(new EventEmitter(), { webContents: { mainFrame } });
    installWindowAppearance(window as any, "http://localhost:7777");
    const emit = (event: any, theme: unknown) => mocks.ipcMain.emit("yo:appearance:theme", event, theme);
    const trusted = { sender: window.webContents, senderFrame: mainFrame };
    emit({ ...trusted, sender: {} }, "light");
    emit({ ...trusted, senderFrame: { url: mainFrame.url } }, "light");
    emit(trusted, "invalid");
    expect(mocks.nativeTheme.themeSource).toBe("system");
    mainFrame.url = "https://example.com";
    emit(trusted, "light");
    expect(mocks.nativeTheme.themeSource).toBe("system");
    mainFrame.url = "http://localhost:7777/";
    for (const theme of ["light", "dark", "system"]) {
      emit(trusted, theme);
      expect(mocks.nativeTheme.themeSource).toBe(theme);
    }
  });
});
