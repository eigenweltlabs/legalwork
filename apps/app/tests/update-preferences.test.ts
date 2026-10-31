import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdaterPreferences, UPDATER_PREFERENCES_FILENAME } from "../../desktop/electron/updater-preferences.mjs";
import { loadUpdatePreferences, saveUpdatePreferences } from "../src/react-app/domains/settings/state/update-preferences";
import { BACKGROUND_UPDATE_CHECK_INTERVAL_MS, checkForUpdatesInBackground } from "../src/react-app/domains/settings/state/electron-updater-state";
import { useUpdateStatusStore } from "../src/react-app/domains/settings/state/update-status-store";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const roots: string[] = [];
let fixtureDay = 0;
afterEach(async () => {
  setSystemTime();
  useUpdateStatusStore.getState().setStatus(null);
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  setSystemTime(new Date(Date.UTC(2030, 0, ++fixtureDay, 23, 30)));
  const root = await mkdtemp(join(tmpdir(), "legalwork-updater-renderer-"));
  roots.push(root);
  await mkdir(join(root, "Local Storage"));
  const app = { getPath: () => root };
  let native = createUpdaterPreferences(app);
  const localStorage = new Map<string, string>();
  let blockedStorage = false;
  let checks = 0;
  let checkFailure = false;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => { if (blockedStorage) throw new Error("Storage unavailable"); return localStorage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blockedStorage) throw new Error("Storage unavailable"); localStorage.set(key, value); },
    },
    __LEGALWORK_ELECTRON__: { updater: {
      getPreferences: (legacy: { autoCheck?: boolean; autoDownload?: boolean }) => native.read(legacy),
      setPreferences: (patch: { autoCheck?: boolean; autoDownload?: boolean }) => native.write(patch),
      check: async () => {
        checks += 1;
        if (checkFailure) throw new Error("Website and GitHub unavailable");
        return { available: false };
      },
    } },
  } });
  return { root, localStorage, restart: () => { native = createUpdaterPreferences(app); }, blockStorage: () => { blockedStorage = true; }, checks: () => checks, failChecks: () => { checkFailure = true; } };
}

test("startup makes no updater request after disabled preferences survive browser storage deletion", async () => {
  const f = await fixture();
  f.localStorage.set("legalwork.react.settings.update-auto-check", "0");
  expect(await loadUpdatePreferences()).toEqual({ autoCheck: false, autoDownload: false });
  f.localStorage.clear();
  f.restart();
  await checkForUpdatesInBackground();
  expect(f.checks()).toBe(0);
  expect(await loadUpdatePreferences()).toEqual({ autoCheck: false, autoDownload: false });
});

test("explicit updater changes persist independently of inaccessible localStorage", async () => {
  const f = await fixture();
  f.blockStorage();
  expect(await loadUpdatePreferences()).toEqual({ autoCheck: false, autoDownload: false });
  expect(await saveUpdatePreferences({ autoCheck: true })).toEqual({ autoCheck: true, autoDownload: false });
  f.restart();
  expect(await loadUpdatePreferences()).toEqual({ autoCheck: true, autoDownload: false });
});

test("corrupt native settings override stale enabled browser flags without overwriting them on load", async () => {
  const f = await fixture();
  f.localStorage.set("legalwork.react.settings.update-auto-check", "1");
  await writeFile(join(f.root, UPDATER_PREFERENCES_FILENAME), "{");
  expect(await loadUpdatePreferences()).toEqual({ autoCheck: false, autoDownload: false });
  expect(f.localStorage.get("legalwork.react.settings.update-auto-check")).toBe("1");
});

test("automatic checks repeat across days without requiring a restart or duplicating concurrent checks", async () => {
  const f = await fixture();
  await saveUpdatePreferences({ autoCheck: true });
  await Promise.all([checkForUpdatesInBackground(), checkForUpdatesInBackground()]);
  expect(f.checks()).toBe(1);
  await checkForUpdatesInBackground();
  expect(f.checks()).toBe(1);
  setSystemTime(new Date(Date.now() + BACKGROUND_UPDATE_CHECK_INTERVAL_MS));
  await checkForUpdatesInBackground();
  expect(f.checks()).toBe(2);
  await saveUpdatePreferences({ autoCheck: false });
  setSystemTime(new Date(Date.now() + BACKGROUND_UPDATE_CHECK_INTERVAL_MS));
  await checkForUpdatesInBackground();
  expect(f.checks()).toBe(2);
});

test("periodic checks leave in-flight checks, downloads and prepared installers alone", async () => {
  const f = await fixture();
  await saveUpdatePreferences({ autoCheck: true });
  const states: ("checking" | "downloading" | "ready")[] = ["checking", "downloading", "ready"];
  for (const state of states) {
    const status = { state, version: "4.0.0" };
    useUpdateStatusStore.getState().setStatus(status);
    await checkForUpdatesInBackground();
    expect(useUpdateStatusStore.getState().status).toEqual(status);
  }
  expect(f.checks()).toBe(0);
});

test("failed periodic checks retain an already available update", async () => {
  const f = await fixture();
  await saveUpdatePreferences({ autoCheck: true });
  const previous = { state: "available", version: "4.0.0" } satisfies NonNullable<ReturnType<typeof useUpdateStatusStore.getState>["status"]>;
  useUpdateStatusStore.getState().setStatus(previous);
  f.failChecks();
  await checkForUpdatesInBackground();
  expect(f.checks()).toBe(1);
  expect(useUpdateStatusStore.getState().status).toEqual(previous);
});
