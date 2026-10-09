export function windowsTitleBarOverlay(dark, blackout = false) {
  return {
    color: dark ? (blackout ? "#111111" : "#242424") : "#edf4fa",
    symbolColor: dark ? "#f5f5f5" : "#0d0d0f",
    height: 44,
  };
}

/** @returns {import("electron").BrowserWindowConstructorOptions} */
export function windowAppearanceOptions(platform, dark, blackout = false) {
  if (platform === "darwin") {
    return {
      backgroundColor: "#00000001",
      titleBarStyle: "hiddenInset",
      vibrancy: dark ? "under-window" : "sidebar",
      visualEffectState: "active",
    };
  }
  if (platform === "win32") {
    return { titleBarStyle: "hidden", titleBarOverlay: windowsTitleBarOverlay(dark, blackout) };
  }
  return {};
}
