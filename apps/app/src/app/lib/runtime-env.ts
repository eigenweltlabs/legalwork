// Runtime detection primitives. Leaf module by design: keep it import-free so
// low-level clients (opencode, legalwork-server, den) can use it without
// dragging in the utils barrel (which pulls i18n and app constants).
export function isElectronRuntime() {
  return typeof window !== "undefined" && (window as Window).__LEGALWORK_ELECTRON__ != null;
}

export function isDesktopRuntime() {
  return isElectronRuntime();
}

export function isOfficeAddinRuntime() {
  return typeof document !== "undefined" && document.documentElement.classList.contains("lw-word-pane");
}
