import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, desktopCapturer, nativeImage, screen, systemPreferences } from "electron";
import { ScreenCapture } from "../electron/launcher/screen-capture.mjs";

const profile = mkdtempSync(join(tmpdir(), "legalwork-capture-fixture-"));
app.setPath("userData", profile);
app.on("window-all-closed", () => {});
const helper = process.env.LEGALWORK_CAPTURE_TEST_HELPER;

async function findFixtureWindow(filename) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const window = BrowserWindow.getAllWindows().find(item => item.isVisible() && item.webContents.getURL().endsWith(filename));
    if (window) return window;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Could not open ${filename}.`);
}

const deadline = setTimeout(() => {
  console.error("Capture fixture timed out.");
  finish(1);
}, 20_000);

function finish(code) {
  clearTimeout(deadline);
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  rmSync(profile, { recursive: true, force: true });
  app.exit(code);
}

app.whenReady().then(async () => {
  console.log("Electron capture fixture is ready.");
  const thumbnail = nativeImage.createFromBitmap(Buffer.alloc(80 * 60 * 4, 255), { width: 80, height: 60 });
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // Both images and titles are synthetic. The fixture never reads the real screen.
  systemPreferences.getMediaAccessStatus = () => "granted";
  desktopCapturer.getSources = async ({ types }) => types.includes("screen")
    ? [{ id: "screen:fixture", display_id: String(display.id), thumbnail }]
    : [{ id: "window:one", name: "Synthetic document", thumbnail }, { id: "window:two", name: "Synthetic document", thumbnail: thumbnail.resize({ width: 40 }) }];
  const capture = new ScreenCapture({ hiddenWhile: work => work() });

  const regional = capture.captureRegion();
  const overlay = await findFixtureWindow("region-overlay.html");
  await overlay.webContents.executeJavaScript(`window.regionOverlay.select({ x: 0, y: 0, width: ${display.bounds.width}, height: ${display.bounds.height} })`);
  const region = await regional;
  assert.equal(region.ok, true);
  assert.equal(region.capture.dataUrl, thumbnail.toDataURL());
  assert.equal(region.capture.width, 80);
  assert.equal(region.capture.height, 60);
  console.log("PASS native region completion with synthetic pixels.");

  const cancelled = capture.captureRegion();
  const cancelOverlay = await findFixtureWindow("region-overlay.html");
  await cancelOverlay.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))');
  assert.deepEqual(await cancelled, { ok: false, reason: "cancelled", message: "" });
  console.log("PASS native region Escape cancellation.");

  const windowResult = capture.captureWindow();
  const picker = await findFixtureWindow("window-picker.html");
  await picker.webContents.executeJavaScript('document.querySelectorAll("#sources button")[1].click()');
  const chosen = await windowResult;
  assert.equal(chosen.ok, true);
  assert.equal(chosen.capture.width, 40);
  assert.equal(chosen.capture.sourceWindow, "Synthetic document");
  console.log("PASS native region completion, Escape, and duplicate-title window selection with synthetic pixels.");

  if (helper) {
    // This Electron fixture opts into Chromium accessibility like an accessible browser.
    app.setAccessibilitySupportEnabled(true);
    const fixture = new BrowserWindow({ width: 480, height: 160, show: false, title: "Synthetic AX fixture" });
    await fixture.loadURL("data:text/html," + encodeURIComponent("<title>Synthetic AX fixture</title><textarea>  Synthetic selected clause.  </textarea>"));
    fixture.show();
    app.focus({ steal: true });
    fixture.focus();
    await fixture.webContents.executeJavaScript('const text = document.querySelector("textarea"); text.focus(); text.select();');
    await new Promise(resolve => setTimeout(resolve, 200));
    const { stdout } = await promisify(execFile)(helper, ["--selected-text", String(process.pid)], { timeout: 8000 });
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true, `Synthetic Chromium AX read failed: ${result.reason}`);
    assert.equal(result.text, "  Synthetic selected clause.  ");
    console.log("PASS native Chromium text selection preserves leading and trailing spaces.");
  }
}).then(() => finish(0)).catch(error => {
  console.error(error.message);
  finish(1);
});
