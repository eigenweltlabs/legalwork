import assert from "node:assert/strict";
import test from "node:test";
import { windowAppearanceOptions, windowsTitleBarOverlay } from "./window-chrome.mjs";

test("Windows puts native caption controls in the 44px app bar", () => {
  assert.deepEqual(windowAppearanceOptions("win32", false), {
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#edf4fa", symbolColor: "#0d0d0f", height: 44 },
  });
  assert.deepEqual(windowAppearanceOptions("win32", true).titleBarOverlay, windowsTitleBarOverlay(true));
  assert.equal(windowsTitleBarOverlay(true).color, "#242424");
  assert.equal(windowsTitleBarOverlay(true).symbolColor, "#f5f5f5");
  assert.deepEqual(windowAppearanceOptions("win32", true, true).titleBarOverlay, windowsTitleBarOverlay(true, true));
  assert.equal(windowsTitleBarOverlay(true, true).color, "#111111");
});

test("macOS keeps its inset controls and vibrancy; Linux keeps its native frame", () => {
  for (const dark of [false, true]) {
    assert.deepEqual(windowAppearanceOptions("darwin", dark), {
      backgroundColor: "#00000001", titleBarStyle: "hiddenInset",
      vibrancy: dark ? "under-window" : "sidebar", visualEffectState: "active",
    });
    assert.deepEqual(windowAppearanceOptions("linux", dark), {});
  }
});
