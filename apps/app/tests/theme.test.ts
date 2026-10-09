import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const key = "legalwork.react.settings.theme-mode";
const legacyKey = "legalwork.themePref";
const source = readFileSync(new URL("../src/app/theme.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } }).outputText;
const prepaints = ["index", "overlay", "live-overlay", "taskpane"].map((entry) => {
  const html = readFileSync(new URL(`../${entry}.html`, import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error(`Missing theme bootstrap script: ${entry}`);
  return { entry, script };
});

function createWindow(values: Record<string, string> = {}, dark = false) {
  const stored = new Map(Object.entries(values));
  const storageListeners: Array<(event: { key: string | null; storageArea: unknown }) => void> = [];
  const systemListeners = new Set<() => void>();
  const nativeModes: string[] = [];
  const nativeAppearances: string[] = [];
  const documentElement = { dataset: { theme: "", appearance: "" }, style: { colorScheme: "" } };
  const localStorage = {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem: (name: string, value: string) => { stored.set(name, value); },
  };
  const media = {
    matches: dark,
    addEventListener: (_name: string, callback: () => void) => { systemListeners.add(callback); },
    removeEventListener: (_name: string, callback: () => void) => { systemListeners.delete(callback); },
  };
  const context = {
    exports: {},
    document: { documentElement },
    localStorage,
    window: {
      localStorage,
      matchMedia: () => media,
      addEventListener: (_name: string, callback: typeof storageListeners[number]) => { storageListeners.push(callback); },
      __LEGALWORK_ELECTRON__: { invokeDesktop: (_command: string, mode: string, appearance: string) => { nativeModes.push(mode); nativeAppearances.push(appearance); } },
    },
  };
  runInNewContext(compiled, context);
  const theme: typeof import("../src/app/theme") = runInNewContext("exports", context);
  return {
    theme, context, documentElement, stored, nativeModes, nativeAppearances,
    storageChange(name: string | null, value: string | null, storageArea: unknown = localStorage) {
      if (name === null) stored.clear();
      else if (value === null) stored.delete(name);
      else stored.set(name, value);
      storageListeners.forEach((callback) => callback({ key: name, storageArea }));
    },
    systemChange(value: boolean) {
      media.matches = value;
      systemListeners.forEach((callback) => callback());
    },
  };
}

for (const { entry, script } of prepaints) {
  test(`${entry}: first paint and runtime agree on defaults, persisted choices and legacy preferences`, () => {
    for (const values of [{}, { [key]: "dark" }, { [key]: "blackout" }, { [key]: "light", [legacyKey]: "dark" }, { [key]: "system" }, { [legacyKey]: "dark" }, { [key]: "invalid", [legacyKey]: "system" }]) {
      for (const systemDark of [false, true]) {
        const win = createWindow(values, systemDark);
        runInNewContext(script, win.context);
        const firstPaint = win.documentElement.dataset.theme;
        const firstAppearance = win.documentElement.dataset.appearance;
        win.theme.bootstrapTheme();
        expect(win.documentElement.dataset.theme).toBe(firstPaint);
        expect(win.documentElement.style.colorScheme).toBe(firstPaint);
        expect(win.documentElement.dataset.appearance).toBe(firstAppearance);
        expect(win.theme.getResolvedAppearance()).toBe(firstAppearance);
      }
    }
  });
}

test("Blackout persists as a palette while native controls and editors receive dark", () => {
  const win = createWindow();
  win.theme.bootstrapTheme();
  win.theme.setThemeMode("blackout");
  expect(win.stored.get(key)).toBe("blackout");
  expect(win.nativeModes.at(-1)).toBe("dark");
  expect(win.nativeAppearances.at(-1)).toBe("blackout");
  expect(win.theme.getResolvedThemeMode()).toBe("dark");
  expect(win.theme.getResolvedAppearance()).toBe("blackout");
  const reopened = createWindow(Object.fromEntries(win.stored));
  reopened.theme.bootstrapTheme();
  expect(reopened.documentElement.dataset).toEqual({ theme: "dark", appearance: "blackout" });
  reopened.systemChange(true);
  reopened.systemChange(false);
  expect(reopened.theme.getResolvedAppearance()).toBe("blackout");
});

test("Blackout changes reach other windows even when the binary dark theme stays the same", () => {
  const win = createWindow({ [key]: "dark" });
  win.theme.bootstrapTheme();
  let notifications = 0;
  win.theme.subscribeToTheme(() => { notifications++; });
  win.storageChange(key, "blackout");
  expect(notifications).toBe(1);
  expect(win.documentElement.dataset.appearance).toBe("blackout");
  win.storageChange(key, "dark");
  expect(notifications).toBe(2);
  expect(win.documentElement.dataset.appearance).toBe("dark");
  win.storageChange(key, "system");
  expect(win.documentElement.dataset).toEqual({ theme: "light", appearance: "light" });
  win.systemChange(true);
  expect(win.documentElement.dataset).toEqual({ theme: "dark", appearance: "dark" });
});

test("dark choice persists and restores in a new renderer", () => {
  const win = createWindow();
  win.theme.bootstrapTheme();
  win.theme.setThemeMode("dark");
  expect(win.stored.get(key)).toBe("dark");
  expect(win.nativeModes.at(-1)).toBe("dark");
  const reopened = createWindow(Object.fromEntries(win.stored));
  reopened.theme.bootstrapTheme();
  expect(reopened.documentElement.dataset.theme).toBe("dark");
});

test("other windows receive theme changes without writing them back", () => {
  const win = createWindow();
  win.theme.bootstrapTheme();
  let notifications = 0;
  const unsubscribe = win.theme.subscribeToTheme(() => { notifications++; });
  win.storageChange(key, "dark");
  expect(win.theme.getInitialThemeMode()).toBe("dark");
  expect(win.documentElement.dataset.theme).toBe("dark");
  expect(win.nativeModes.at(-1)).toBe("dark");
  expect(notifications).toBe(1);
  win.storageChange(key, "dark");
  win.storageChange("unrelated", "light");
  expect(notifications).toBe(1);
  unsubscribe();
  win.storageChange(key, "light");
  expect(notifications).toBe(1);
  expect(win.documentElement.dataset.theme).toBe("light");
});

test("system changes apply only when System is selected", () => {
  const win = createWindow({ [key]: "system" });
  win.theme.bootstrapTheme();
  win.systemChange(true);
  expect(win.documentElement.dataset.theme).toBe("dark");
  win.theme.setThemeMode("light");
  win.systemChange(false);
  win.systemChange(true);
  expect(win.documentElement.dataset.theme).toBe("light");
});

test("clearing preferences restores the light default in open windows", () => {
  const win = createWindow({ [key]: "dark" });
  win.theme.bootstrapTheme();
  win.storageChange(null, null);
  expect(win.documentElement.dataset.theme).toBe("light");
  expect(win.theme.getInitialThemeMode()).toBe("light");
});
