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
  const pixels = Buffer.alloc(80 * 60 * 4, 255);
  for (let index = 0; index < 80 * 60; index++) {
    pixels[index * 4] = index % 80;
    pixels[index * 4 + 1] = Math.floor(index / 80);
  }
  const thumbnail = nativeImage.createFromBitmap(pixels, { width: 80, height: 60 });
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // Both images and titles are synthetic. The fixture never reads the real screen.
  systemPreferences.getMediaAccessStatus = () => "granted";
  desktopCapturer.getSources = async ({ types }) => types.includes("screen")
    ? [{ id: "screen:fixture", display_id: String(display.id), thumbnail }]
    : [{ id: "window:one", name: "Synthetic document", thumbnail }, { id: "window:two", name: "Synthetic document", thumbnail: thumbnail.resize({ width: 40 }) }];
  const capture = new ScreenCapture({ hiddenWhile: work => work() });

  const regional = capture.captureRegion();
  const overlay = await findFixtureWindow("region-overlay.html");
  const { width, height } = display.bounds;
  const from = { x: Math.floor(width / 4), y: Math.floor(height / 4) };
  const to = { x: Math.floor(3 * width / 4), y: Math.floor(3 * height / 4) };
  const x = Math.floor(from.x * 80 / width), y = Math.floor(from.y * 60 / height);
  const cropped = thumbnail.crop({ x, y, width: Math.ceil(to.x * 80 / width) - x, height: Math.ceil(to.y * 60 / height) - y });
  const { width: cropWidth, height: cropHeight } = cropped.getSize();
  const label = `${cropWidth} × ${cropHeight} px`;
  overlay.focus();
  overlay.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...from });
  overlay.webContents.sendInputEvent({ type: "mouseMove", modifiers: ["leftButtonDown"], ...to });
  const measurement = await overlay.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const expected = ${JSON.stringify(label)};
    // macOS can send a hover at the physical cursor during synthetic pointer capture.
    // Ask for the same box explicitly before comparing it to the native release.
    window.regionOverlay.measure(${JSON.stringify({ ...from, width: to.x - from.x, height: to.y - from.y })});
    const timeout = setTimeout(() => reject(new Error("Unexpected crop size: " + document.getElementById("size").textContent)), 1000);
    const poll = () => {
      const value = document.getElementById("size").textContent;
      if (value !== expected) { requestAnimationFrame(poll); return; }
      clearTimeout(timeout); resolve(value);
    };
    poll();
  })`);
  overlay.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...to });
  const region = await regional;
  assert.equal(region.ok, true);
  assert.equal(region.capture.dataUrl, cropped.toDataURL());
  assert.equal(measurement, `${region.capture.width} × ${region.capture.height} px`);
  console.log("PASS native pointer drag returns the selected rectangle with synthetic pixels.");

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
    await fixture.webContents.executeJavaScript('document.querySelector("textarea").value = "x".repeat(200_001); document.querySelector("textarea").select();');
    await new Promise(resolve => setTimeout(resolve, 200));
    const oversized = await promisify(execFile)(helper, ["--selected-text", String(process.pid)], { timeout: 8000 });
    assert.deepEqual(JSON.parse(oversized.stdout), { ok: false, reason: "too-large" });
    console.log("PASS oversized native text is rejected without shortening it.");
  }
}).then(() => finish(0)).catch(error => {
  console.error(error.message);
  finish(1);
});
