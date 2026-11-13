import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_LAUNCHER_SETTINGS, LauncherSettingsStore, normalizeLauncherSettings } from "./launcher-settings.mjs";

test("settings validate each field and keep the current value for malformed input", () => {
  const next = normalizeLauncherSettings({ shortcut: "Alt+Space", backgroundPresence: true, aliases: { files: "dok", projects: "TOOLONG", tasks: "" }, actionShortcuts: { "app.ask": "CommandOrControl+Shift+A", "app.bad": "not a key!" }, pinned: "yes" });
  assert.equal(next.shortcut, "Alt+Space");
  assert.equal(next.backgroundPresence, true);
  assert.deepEqual(next.aliases, { ...DEFAULT_LAUNCHER_SETTINGS.aliases, files: "dok" });
  assert.deepEqual(next.actionShortcuts, { "app.ask": "CommandOrControl+Shift+A" });
  assert.equal(next.pinned, false);
  assert.equal(normalizeLauncherSettings(null).shortcut, DEFAULT_LAUNCHER_SETTINGS.shortcut);
  assert.equal(normalizeLauncherSettings({ shortcut: "rm -rf /" }, next).shortcut, "Alt+Space");
});

test("the store persists atomically and reloads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "launcher-settings-"));
  try {
    const store = new LauncherSettingsStore(dir);
    await store.load();
    await store.update({ companion: true, aliases: { chats: "g" } });
    const raw = JSON.parse(await readFile(path.join(dir, "launcher.json"), "utf8"));
    assert.equal(raw.companion, true);
    assert.equal(raw.aliases.chats, "g");
    const reloaded = new LauncherSettingsStore(dir);
    assert.equal((await reloaded.load()).aliases.chats, "g");
    assert.equal(reloaded.get().shortcut, DEFAULT_LAUNCHER_SETTINGS.shortcut);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy window pin preferences cannot leave the launcher stuck open", () => {
  assert.equal(normalizeLauncherSettings({ pinned: true }).pinned, false);
  assert.equal(normalizeLauncherSettings({}, { ...DEFAULT_LAUNCHER_SETTINGS, pinned: true }).pinned, false);
});
