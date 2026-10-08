export type AppearanceMode = "light" | "dark" | "blackout";
export type ThemeMode = AppearanceMode | "system";
export type ResolvedThemeMode = "light" | "dark";

const THEME_PREF_KEY = "legalwork.react.settings.theme-mode";
const LEGACY_THEME_PREF_KEYS = ["legalwork.themePref"];

const mediaQuery = "(prefers-color-scheme: dark)";
const listeners = new Set<() => void>();
let currentMode: ThemeMode | null = null;
let systemThemeCleanup: (() => void) | null = null;
let storageSubscribed = false;

const getMediaQueryList = () =>
  typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? null
    : window.matchMedia(mediaQuery);

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === "light" || value === "dark" || value === "blackout" || value === "system";

const readStoredMode = (): ThemeMode => {
  // Light remains the default until the user chooses a theme in Customization.
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(THEME_PREF_KEY);
    if (isThemeMode(stored)) {
      return stored;
    }

    for (const key of LEGACY_THEME_PREF_KEYS) {
      const legacyStored = window.localStorage.getItem(key);
      if (isThemeMode(legacyStored)) {
        window.localStorage.setItem(THEME_PREF_KEY, legacyStored);
        return legacyStored;
      }
    }
  } catch {
    // ignore
  }
  return "light";
};

const resolveMode = (mode: ThemeMode): ResolvedThemeMode => {
  if (mode === "blackout") return "dark";
  if (mode !== "system") return mode;
  return getMediaQueryList()?.matches ? "dark" : "light";
};

const applyTheme = (mode: ThemeMode) => {
  if (typeof document === "undefined") return;
  const resolved = resolveMode(mode);
  document.documentElement.dataset.theme = resolved;
  // Blackout is a dark palette, so existing editor and component dark styles still apply.
  document.documentElement.dataset.appearance = mode === "blackout" ? "blackout" : resolved;
  document.documentElement.style.colorScheme = resolved;
};

const emitThemeChange = () => {
  for (const listener of listeners) {
    listener();
  }
};

const syncNativeTheme = (mode: ThemeMode) => {
  if (typeof window === "undefined") return;
  void window.__LEGALWORK_ELECTRON__?.invokeDesktop?.("__setNativeTheme", mode === "blackout" ? "dark" : mode, mode);
};

const getCurrentMode = () => {
  if (currentMode === null) {
    currentMode = readStoredMode();
  }
  return currentMode;
};

const handleSystemThemeChange = () => {
  if (getCurrentMode() !== "system") return;
  applyTheme("system");
  syncNativeTheme("system");
  emitThemeChange();
};

const ensureSystemThemeSubscription = () => {
  if (systemThemeCleanup || typeof window === "undefined") return;

  const list = getMediaQueryList();
  if (!list) return;

  list.addEventListener("change", handleSystemThemeChange);
  systemThemeCleanup = () => list.removeEventListener("change", handleSystemThemeChange);
};

const ensureStorageSubscription = () => {
  if (storageSubscribed || typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== THEME_PREF_KEY && !LEGACY_THEME_PREF_KEYS.includes(event.key)) return;
    const mode = readStoredMode();
    if (mode === getCurrentMode()) return;
    currentMode = mode;
    applyTheme(mode);
    syncNativeTheme(mode);
    emitThemeChange();
  });
  storageSubscribed = true;
};

export const bootstrapTheme = () => {
  const mode = getCurrentMode();
  applyTheme(mode);
  syncNativeTheme(mode);
  ensureSystemThemeSubscription();
  ensureStorageSubscription();
};

export const getInitialThemeMode = () => getCurrentMode();

export const getResolvedThemeMode = () => resolveMode(getCurrentMode());

export const getResolvedAppearance = (): AppearanceMode =>
  getCurrentMode() === "blackout" ? "blackout" : getResolvedThemeMode();

const persistThemeMode = (mode: ThemeMode) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_PREF_KEY, mode);
  } catch {
    // ignore
  }
};

export const subscribeToTheme = (onChange: () => void) => {
  ensureSystemThemeSubscription();
  ensureStorageSubscription();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
};

export const setThemeMode = (mode: ThemeMode) => {
  currentMode = mode;
  persistThemeMode(mode);
  applyTheme(mode);
  syncNativeTheme(mode);
  ensureSystemThemeSubscription();
  emitThemeChange();
};
