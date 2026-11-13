import assert from "node:assert/strict";
import { test } from "node:test";
import { LauncherShortcutRegistry } from "./launcher-shortcuts.mjs";

function fakeGlobalShortcut(refuse = new Set()) {
  const bound = new Map();
  return { bound, register: (accelerator, callback) => { if (refuse.has(accelerator)) return false; bound.set(accelerator, callback); return true; }, unregister: accelerator => { bound.delete(accelerator); }, isRegistered: accelerator => bound.has(accelerator) };
}

test("bindings register once, duplicates and dictation collisions are reported, and refresh re-applies lost chords", () => {
  const shortcut = fakeGlobalShortcut(new Set(["F9"]));
  const registry = new LauncherShortcutRegistry({ globalShortcut: shortcut, reserved: () => ["Control"], platform: "darwin" });
  const bindings = [
    { id: "launcher.open", accelerator: "CommandOrControl+Shift+Space", handler: () => {} },
    { id: "app.ask", accelerator: "Cmd+Shift+Space", handler: () => {} },
    { id: "app.dictate", accelerator: "Control", handler: () => {} },
    { id: "app.files", accelerator: "F9", handler: () => {} },
  ];
  assert.deepEqual(registry.apply(bindings), [
    { id: "app.ask", accelerator: "Command+Shift+Space", reason: "duplicate" },
    { id: "app.dictate", accelerator: "Control", reason: "dictation" },
    { id: "app.files", accelerator: "F9", reason: "registration-failed" },
  ]);
  assert.equal(registry.isRegistered("launcher.open"), true);
  assert.deepEqual([...shortcut.bound.keys()], ["Command+Shift+Space"]);
  shortcut.bound.delete("Command+Shift+Space");
  registry.refresh(bindings);
  assert.equal(shortcut.bound.has("Command+Shift+Space"), true);
  registry.dispose();
  assert.equal(shortcut.bound.size, 0);
});

test("the same accelerator twice inside the registry is a duplicate, not a second registration", () => {
  const shortcut = fakeGlobalShortcut();
  const registry = new LauncherShortcutRegistry({ globalShortcut: shortcut });
  const conflicts = registry.apply([{ id: "a", accelerator: "Alt+Space", handler: () => {} }, { id: "b", accelerator: "Alt+Space", handler: () => {} }]);
  assert.deepEqual(conflicts, [{ id: "b", accelerator: "Alt+Space", reason: "duplicate" }]);
  assert.equal(shortcut.bound.size, 1);
});
