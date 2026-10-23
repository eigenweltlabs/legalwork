import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { mkdtempSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import { DictationHud } from "../electron/audio/dictation-hud.mjs";
import { DOCKS, dockBounds, nearestDock } from "../electron/audio/dictation-dock.mjs";

const output = process.env.LEGALWORK_HUD_SCREENSHOTS;
const userData = mkdtempSync(path.join(os.tmpdir(), "lw-hud-regression-"));
app.setPath("userData", userData);
app.commandLine.appendSwitch("mute-audio");
// Finish cleanup and report assertion failures before Electron exits.
app.on("window-all-closed", () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function streamLevel(hud, level, duration = 100) {
  const until = Date.now() + duration;
  do {
    hud.feedLevel(level);
    await delay(16);
  } while (Date.now() < until);
}
const status = {
  miniBarEnabled: true,
  appearance: "app", enabled: true, registered: true, shortcutCaptureActive: false, accelerator: "Control",
  defaultAccelerator: "Control", customAccelerator: false, mode: "hold", supportsHold: true,
  platform: "darwin", accessibility: "granted", error: null,
};

app.whenReady().then(async () => {
  const actions = [];
  const nativeCursor = screen.getCursorScreenPoint;
  let cursor = nativeCursor();
  // Simulate the OS pointer as well as Chromium input without moving the user's mouse.
  screen.getCursorScreenPoint = () => cursor;
  const hud = new DictationHud({ onStart: () => actions.push("start"), onStop: () => actions.push("stop"), onCancel: () => actions.push("cancel"), onMicrophoneMenu: () => actions.push("microphone-menu"), onMeetingStart: () => actions.push("meeting-start"), onMeetingStop: () => actions.push("meeting-stop"), onMeetingDismiss: () => actions.push("meeting-dismiss"), onMeetingOpen: () => actions.push("meeting-open") });
  try {
    if (output) await mkdir(output, { recursive: true });
    await writeFile(hud.positionPath, JSON.stringify({ dock: "top" }));
    await hud.setStatus({ ...status, miniBarEnabled: false });
    assert.equal(hud.window, null, "a saved disabled preference never creates a visible bar at startup");
    const showing = hud.setStatus(status);
    await hud.setStatus({ ...status, miniBarEnabled: false });
    await showing;
    assert.equal(hud.window?.isVisible() ?? false, false, "disabling during window creation wins over the pending show");
    await hud.setStatus(status);
    assert.equal(hud.dock, "bottom", "previously saved top positions move to bottom");
    const window = hud.window;
    assert.ok(window);
    const idleMeeting = { detectionEnabled: true, detectionSupported: true, detected: null, state: "idle", recordingId: null, startedAt: null, error: null };
    await hud.setStatus({ ...status, miniBarEnabled: false });
    for (const phase of ["idle", "starting", "listening", "transcribing", "success", "error"]) {
      await hud.setState(phase);
      assert.equal(window.isVisible(), false, `${phase} cannot reshow a disabled mini bar`);
    }
    await hud.setMeeting({ ...idleMeeting, detected: { app: "Test meeting" } });
    assert.equal(window.isVisible(), false, "meeting detection cannot reshow a disabled mini bar");
    await hud.setMeeting({ ...idleMeeting, state: "recording", recordingId: "active", startedAt: Date.now() });
    await hud.setStatus(status);
    assert.equal(window.isVisible(), true, "re-enabling restores the active recording controls");
    await hud.setStatus({ ...status, miniBarEnabled: false });
    assert.equal(window.isVisible(), false, "the bar can be hidden during recording");
    assert.equal(hud.meeting.state, "recording");
    assert.deepEqual(actions, [], "visibility changes never start, stop, or cancel capture");
    await hud.setMeeting(idleMeeting);
    await hud.setState("idle");
    await hud.setStatus({ ...status, enabled: false, registered: false });
    await hud.setMeeting({ ...idleMeeting, detectionEnabled: false });
    assert.equal(window.isVisible(), true, "manual recording stays available without dictation or meeting detection");
    await hud.setStatus(status);
    ipcMain.emit("legalwork:dictation-hud:drag", { sender: window.webContents }, "start");
    assert.ok(hud.drag);
    await hud.setStatus({ ...status, miniBarEnabled: false });
    assert.equal(hud.drag, null, "disabling cancels an in-progress drag");
    assert.equal(hud.dockPreview, null);
    assert.equal(window.isVisible(), false);
    await hud.setStatus(status);
    console.log("PASS: mini bar startup, show/hide race, dictation and meeting updates, recording independence, reactivation and drag cleanup");
    const input = event => {
      const bounds = window.getBounds();
      cursor = { x: bounds.x + event.x, y: bounds.y + event.y };
      window.webContents.sendInputEvent({ ...event, globalX: cursor.x, globalY: cursor.y });
    };
    const center = id => window.webContents.executeJavaScript(`(() => {const r=document.getElementById('${id}').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    const rendererErrors = [];
    window.webContents.on("console-message", (_event, level, message) => {
      if (level === 3) rendererErrors.push(message);
    });
    assert.equal(window.isFocusable(), false);
    assert.equal(window.isFocused(), false);
    const prefs = window.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.nodeIntegration, false);
    if (process.platform === "darwin" && screen.getAllDisplays().length > 1) {
      const focusWindows = [];
      try {
        for (const display of screen.getAllDisplays()) {
          const area = display.workArea;
          const target = new BrowserWindow({ x: area.x + 100, y: area.y + 100, width: 300, height: 200, show: false });
          focusWindows.push(target);
          target.show();
          target.focus();
          await delay(500);
          const deadline = Date.now() + 3_000;
          while (hud.displayId !== display.id && Date.now() < deadline) await delay(50);
          assert.equal(hud.displayId, display.id, "the HUD follows keyboard focus to another screen while the cursor stays put");
          assert.deepEqual(window.getBounds(), dockBounds(area, "bottom"));
          assert.equal(window.isFocused(), false, "following another screen never steals the target's focus");
        }
        console.log("PASS: native keyboard focus followed across two displays without moving the cursor");
      } finally {
        focusWindows.forEach(target => target.destroy());
      }
    }
    // The remaining cases control the OS pointer deterministically.
    hud.stopWatchingDisplay?.();
    hud.stopWatchingDisplay = null;
    hud.focusedDisplayId = null;
    await window.webContents.executeJavaScript(`(() => {
      window.dictationAudioContexts = 0;
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor(options) { super(options); window.dictationAudioContexts += 1; }
      };
    })()`);
    const state = () => window.webContents.executeJavaScript(`({state:document.body.dataset.state, label:document.getElementById('label').textContent, notice:document.getElementById('notice').textContent, slow:document.body.dataset.slow, heights:[...document.querySelectorAll('#waveform i')].map(b=>b.getBoundingClientRect().height)})`);
    for (const dock of DOCKS) {
      hud.dock = dock;
      hud.positionWindow();
      await hud.setState("starting");
      assert.deepEqual(window.getBounds(), dockBounds(hud.display().workArea, dock), "starting dictation preserves the chosen dock");
      await hud.setState("idle");
      await delay(350);
      const bar = await window.webContents.executeJavaScript(`(() => { const r = document.getElementById('bar').getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:innerWidth, height:innerHeight }; })()`);
      assert.ok(bar.left >= 0 && bar.right <= bar.width && bar.top >= 0 && bar.bottom <= bar.height, `${dock} stays inside its window`);
      const bounds = window.getBounds(), area = hud.display().workArea;
      if (dock === "bottom") assert.equal(area.y + area.height - bounds.y - bar.bottom, 4);
      if (dock === "left") assert.equal(bounds.x + bar.left - area.x, 4);
      if (dock === "right") assert.equal(area.x + area.width - bounds.x - bar.right, 4);
      if (output) await writeFile(path.join(output, `dock-${dock}.png`), (await window.webContents.capturePage()).toPNG());
    }
    hud.dock = "bottom";
    hud.positionWindow();
    for (const locale of ["en", "de"]) {
      cursor = { x: 0, y: 0 };
      await hud.setState("idle", "", locale);
      await delay(400);
      const point = await center("start");
      input({ type: "mouseMove", ...point });
      await delay(350);
      const icon = await window.webContents.executeJavaScript(`(() => {const r=document.querySelector('#start svg').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,hit:document.elementFromPoint(${point.x},${point.y})?.closest('button')?.id};})()`);
      assert.ok(Math.abs(icon.x - point.x) < 1 && Math.abs(icon.y - point.y) < 1, `${locale}: bottom microphone stays under the pointer on hover`);
      assert.equal(icon.hit, "start");
      const compact = await window.webContents.executeJavaScript(`(() => {
        const start=document.getElementById('start'),meeting=document.getElementById('meeting-start'),label=document.getElementById('start-label'),r=label.getBoundingClientRect();
        return {startWidth:start.getBoundingClientRect().width,meetingWidth:meeting.getBoundingClientRect().width,labelOpacity:getComputedStyle(label).opacity,labelAbove:r.bottom<start.getBoundingClientRect().top};
      })()`);
      assert.equal(compact.startWidth, 28, "hovering does not widen the microphone button");
      assert.equal(compact.meetingWidth, 28, "the meeting button stays an icon in both languages");
      assert.equal(compact.labelOpacity, "1");
      assert.equal(compact.labelAbove, true, "the label appears above the bottom button");
      const rect = await window.webContents.executeJavaScript(`(() => {const r=document.getElementById('bar').getBoundingClientRect();return {left:r.left,right:r.right};})()`);
      assert.ok(rect.left >= 0 && rect.right <= 440, "expanded controls fit inside their native window");
    }
    for (const dock of ["left", "right"]) {
      hud.dock = dock;
      hud.positionWindow();
      for (const locale of ["en", "de"]) {
        await hud.setState("idle", "", locale);
        input({ type: "mouseMove", x: 220, y: 10 });
        await delay(350);
        const point = await window.webContents.executeJavaScript(`(() => {const r=document.getElementById('start').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        input({ type: "mouseMove", x: Math.round(point.x), y: Math.round(point.y) });
        await delay(350);
        const stack = await window.webContents.executeJavaScript(`(() => {
          const start=document.getElementById('start').getBoundingClientRect();
          const meeting=document.getElementById('meeting-start').getBoundingClientRect();
          return {start:{x:start.x,y:start.y,bottom:start.bottom},meeting:{x:meeting.x,y:meeting.y,width:meeting.width,height:meeting.height},width:document.getElementById('bar').getBoundingClientRect().width};
        })()`);
        assert.equal(stack.width, 30, `${dock}/${locale} stays a narrow icon column`);
        assert.equal(stack.start.x, stack.meeting.x);
        assert.ok(stack.meeting.y >= stack.start.bottom, "record meeting sits below dictate");
        assert.ok(Math.abs(stack.start.y + 13 - point.y) < 1, "hover expansion keeps the microphone in place");
        input({ type: "mouseMove", x: Math.round(stack.meeting.x + stack.meeting.width / 2), y: Math.round(stack.meeting.y + stack.meeting.height / 2) });
        await delay(350);
        const label = await window.webContents.executeJavaScript(`(() => {const e=document.getElementById('meeting-start-label'),r=e.getBoundingClientRect(),button=document.getElementById('meeting-start'),b=button.getBoundingClientRect();return {left:r.left,right:r.right,opacity:getComputedStyle(e).opacity,hover:button.matches(':hover'),hit:document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.id};})()`);
        if (output) await writeFile(path.join(output, `side-${dock}-${locale}.png`), (await window.webContents.capturePage()).toPNG());
        assert.equal(label.opacity, "1", `${dock}/${locale}: ${JSON.stringify(label)}`);
        assert.ok(label.left >= 0 && label.right <= 440, `${dock}/${locale} label stays on screen`);
        assert.ok(dock === "left" ? label.left > stack.meeting.x + stack.meeting.width : label.right < stack.meeting.x, "side label opens toward the screen");
      }
    }
    input({ type: "mouseMove", x: 220, y: 10 });
    hud.dock = "bottom";
    hud.positionWindow();
    ipcMain.emit("legalwork:dictation-hud:drag", { sender: {} }, "start");
    assert.equal(hud.drag, null, "other renderers cannot move the HUD");
    ipcMain.emit("legalwork:dictation-hud:drag", { sender: window.webContents }, "start");
    assert.ok(hud.drag);
    await delay(150);
    assert.equal(hud.dockPreview.isFocusable(), false);
    assert.equal(await hud.dockPreview.webContents.executeJavaScript("document.querySelectorAll('#dock-targets i').length"), 3);
    assert.equal(await hud.dockPreview.webContents.executeJavaScript("document.querySelector('#dock-targets [data-dock=top]')"), null);
    if (output) await writeFile(path.join(output, "dock-targets.png"), (await hud.dockPreview.webContents.capturePage()).toPNG());
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    ipcMain.emit("legalwork:dictation-hud:drag", { sender: window.webContents }, "end");
    await hud.positionWrites;
    assert.equal(hud.dock, nearestDock(display.workArea, point));
    assert.equal(hud.displayId, display.id);
    assert.equal(hud.dockPreview, null);
    assert.deepEqual(actions, [], "dragging never starts dictation or recording");
    hud.dock = "bottom";
    hud.positionWindow();
    for (const dark of [false, true]) {
      nativeTheme.themeSource = dark ? "dark" : "light";
      for (const locale of ["en", "de"]) {
        for (const phase of ["idle", "starting", "listening", "transcribing", "inserting", "success", "cancelled", "error"]) {
          await hud.setState(phase, phase === "error" ? "Text copied to the clipboard. Paste it with ⌘ V." : "", locale);
          await delay(350);
          assert.equal((await state()).state, phase);
          const fits = await window.webContents.executeJavaScript(`(() => { const bar=document.getElementById('bar').getBoundingClientRect(); return [...document.getElementById('bar').children].filter(e=>getComputedStyle(e).display!=='none').every(e=>{const r=e.getBoundingClientRect();return r.left>=bar.left && r.right<=bar.right}); })()`);
          assert.equal(fits, true, `${phase} / ${locale} fits inside the bar`);
          if (output && locale === "en") {
            if (phase === "listening") {
              await streamLevel(hud, 0.9);
            }
            await mkdir(output, { recursive: true });
            await writeFile(path.join(output, `${dark ? "dark" : "light"}-${phase}.png`), (await window.webContents.capturePage()).toPNG());
            if (["listening", "transcribing", "inserting"].includes(phase)) {
              const rect = await window.webContents.executeJavaScript(`(() => {const r=document.getElementById('bar').getBoundingClientRect();return {x:Math.floor(r.x)-10,y:Math.floor(r.y)-10,width:Math.ceil(r.width)+20,height:Math.ceil(r.height)+20};})()`);
              await writeFile(path.join(output, `${dark ? "dark" : "light"}-${phase === "listening" ? "meter" : phase + "-detail"}.png`), (await window.webContents.capturePage(rect)).toPNG());
            }
          }
        }
      }
    }
    for (const dock of DOCKS) {
      hud.dock = dock;
      hud.positionWindow();
      await hud.setState("idle", "", "en");
      input({ type: "mouseMove", ...await center("start") });
      await delay(350);
      await window.webContents.executeJavaScript("document.getElementById('start').focus()");
      // Leave without a Chromium event, reproducing a native window move.
      cursor = { x: 0, y: 0 };
      await delay(450);
      assert.equal(await window.webContents.executeJavaScript("document.getElementById('bar').getBoundingClientRect().width"), 30, `${dock}: focus and a missing mouseleave cannot hold the overlay open`);
      for (const finish of ["release", "pointercancel", "lostpointercapture"]) {
        input({ type: "mouseMove", ...await center("start") });
        await delay(350);
        const point = await center("start");
        input({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        input({ type: "mouseMove", modifiers: ["leftButtonDown"], x: point.x + 12, y: point.y - 12 });
        await delay(100);
        assert.ok(hud.drag, `${dock}/${finish}: pressing and moving the microphone begins dragging`);
        const offset = { x: hud.drag.offsetX, y: hud.drag.offsetY };
        cursor = { x: cursor.x + 90, y: cursor.y - 70 };
        await delay(80);
        assert.equal(window.getBounds().x, Math.round(cursor.x - offset.x), `${dock}/${finish}: the native window follows even if Chromium stops sending movement`);
        assert.equal(window.getBounds().y, Math.round(cursor.y - offset.y));
        const bounds = window.getBounds();
        if (finish !== "release") {
          await window.webContents.executeJavaScript(`document.getElementById('bar').dispatchEvent(new PointerEvent('${finish}', {pointerId:1,bubbles:true}))`);
        }
        input({ type: "mouseUp", button: "left", clickCount: 1, x: Math.round(cursor.x - bounds.x), y: Math.round(cursor.y - bounds.y) });
        await delay(100);
        assert.equal(hud.drag, null, `${finish} clears drag state`);
        assert.equal(hud.dockPreview, null);
        assert.equal(hud.dragTimer, null);
        cursor = { x: 0, y: 0 };
        await delay(450);
        assert.equal(await window.webContents.executeJavaScript("document.getElementById('bar').dataset.hovered"), "false");
        assert.equal(await window.webContents.executeJavaScript("document.getElementById('bar').getBoundingClientRect().width"), 30);
        assert.deepEqual(actions, [], "ending or cancelling a drag never starts a recording");
        hud.dock = dock;
        hud.positionWindow();
      }
      // Either control must accept a fresh press after a cancelled drag.
      input({ type: "mouseMove", ...await center("start") });
      await delay(350);
      const meetingPoint = await center("meeting-start");
      input({ type: "mouseMove", ...meetingPoint });
      input({ type: "mouseDown", button: "left", clickCount: 1, ...meetingPoint });
      input({ type: "mouseUp", button: "left", clickCount: 1, ...meetingPoint });
      await delay(100);
      assert.deepEqual(actions, ["meeting-start"]);
      actions.length = 0;
      // A fresh microphone click still works too.
      input({ type: "mouseMove", ...await center("start") });
      await delay(350);
      const point = await center("start");
      input({ type: "mouseDown", button: "left", clickCount: 1, ...point });
      input({ type: "mouseUp", button: "left", clickCount: 1, ...point });
      await delay(100);
      assert.deepEqual(actions, ["start"]);
      actions.length = 0;
      cursor = { x: 0, y: 0 };
    }
    hud.dock = "bottom";
    hud.positionWindow();
    for (const appearance of ["app", "white", "black"]) {
      for (const theme of ["dark", "light"]) {
        nativeTheme.themeSource = theme;
        await hud.setStatus({ ...status, appearance });
        await delay(100);
        assert.equal(await window.webContents.executeJavaScript("document.documentElement.dataset.theme"), appearance === "app" ? theme : appearance === "black" ? "dark" : "light");
        if (appearance === "black") assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--surface').trim()"), "rgba(0,0,0,.96)");
        if (output && theme === "light") await writeFile(path.join(output, `color-${appearance}.png`), (await window.webContents.capturePage()).toPNG());
      }
    }
    await hud.setStatus(status);
    // Only this HUD's renderer can invoke its controls.
    ipcMain.emit("legalwork:dictation-hud:action", { sender: {} }, "start");
    assert.deepEqual(actions, []);
    for (const [locale, message] of [["en", "Hold ⌃ and speak"], ["de", "Halten Sie ⌃ und sprechen Sie"]]) {
      await hud.setState("idle", message, locale);
      await delay(220);
      const hint = await window.webContents.executeJavaScript(`({
        state:document.body.dataset.state,
        notice:document.getElementById('notice').textContent,
        visible:getComputedStyle(document.getElementById('notice')).opacity,
        hidden:document.getElementById('notice').getAttribute('aria-hidden'),
        label:getComputedStyle(document.getElementById('label')).display,
        width:document.getElementById('bar').getBoundingClientRect().width
      })`);
      assert.equal(hint.state, "idle");
      assert.equal(hint.notice, message);
      assert.equal(hint.visible, "1");
      assert.equal(hint.hidden, "false");
      assert.equal(hint.label, "none", "short presses never show an attention label");
      assert.ok(hint.width <= 94, "guidance keeps the compact microphone tile");
      await delay(2_050);
      assert.equal((await state()).state, "idle");
      assert.notEqual((await state()).notice, message, "guidance automatically clears");
    }
    await hud.setState("idle");
    ipcMain.emit("legalwork:dictation-hud:action", { sender: {} }, "microphone-menu");
    assert.deepEqual(actions, []);
    await window.webContents.executeJavaScript("document.getElementById('start').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true}))");
    await delay(50);
    assert.deepEqual(actions, ["microphone-menu"], "the idle tile's context menu reaches the native bridge");
    const microphoneState = {
      selection: "auto", selectedName: null, activeName: null, resolvedDeviceId: "mac",
      devices: [{ id: "mac", name: "Mac microphone", available: true, builtIn: true, bluetooth: false },
        { id: "airpods", name: "AirPods", available: true, builtIn: false, bluetooth: true }],
    };
    const selections = [];
    for (const locale of ["en", "de"]) {
      hud.locale = locale;
      const menu = hud.microphoneMenu(microphoneState, selection => selections.push(selection));
      const radios = menu.items.filter(item => item.type === "radio");
      assert.equal(radios.length, 4);
      assert.equal(radios[0].checked, true);
      radios[3].click();
      const missing = hud.microphoneMenu({ ...microphoneState, selection: "gone", selectedName: "Missing microphone" }, () => {});
      assert.ok(missing.items.some(item => item.checked && !item.enabled && item.label.includes("Missing microphone")));
    }
    assert.deepEqual(selections, ["airpods", "airpods"]);
    const nativeMenu = hud.microphoneMenu(microphoneState, () => {});
    let menuShown = false;
    nativeMenu.once("menu-will-show", () => { menuShown = true; });
    nativeMenu.popup({ window });
    await delay(50);
    assert.equal(menuShown, true, "the microphone menu opens on a non-activating panel");
    nativeMenu.closePopup(window);
    assert.equal(window.isFocusable(), false);
    ipcMain.emit("legalwork:dictation-hud:action", { sender: window.webContents }, "start");
    await hud.setState("starting");
    const startupLabelHidden = await window.webContents.executeJavaScript(`getComputedStyle(document.getElementById('label')).display === 'none'`);
    assert.equal(startupLabelHidden, true, "startup shows the level meter without a separate preparing label");
    await streamLevel(hud, 0.9);
    assert.ok((await state()).heights.every((height) => height > 2), "input can appear as soon as capture starts");
    ipcMain.emit("legalwork:dictation-hud:action", { sender: window.webContents }, "stop");
    await hud.setState("listening");
    hud.setMicrophone("Mac microphone");
    await delay(50);
    assert.ok((await state()).notice.includes("Mac microphone"), "the listening hint names the actual microphone");
    await hud.setState("listening", "", "en");
    await hud.setStatus({ ...status, mode: "hold" });
    await delay(220);
    assert.ok((await state()).notice.includes("Release"), "holding shows a release-to-insert hint");
    assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.getElementById('notice')).opacity"), "0", "holding never automatically shows microphone details");
    await hud.setStatus({ ...status, mode: "tap" });
    await delay(220);
    assert.ok((await state()).notice.includes("to finish"), "double-tap switches the hint without restarting capture");
    assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.getElementById('notice')).opacity"), "0", "hands-free dictation never automatically shows microphone details");
    assert.ok(!(await state()).notice.includes("Release"));
    await hud.setStatus(status);
    ipcMain.emit("legalwork:dictation-hud:action", { sender: window.webContents }, "microphone-menu");
    ipcMain.emit("legalwork:dictation-hud:action", { sender: window.webContents }, "stop");
    ipcMain.emit("legalwork:dictation-hud:action", { sender: window.webContents }, "cancel");
    assert.deepEqual(actions, ["microphone-menu", "start", "cancel", "stop", "cancel"]);
    await streamLevel(hud, 1);
    const loudHeights = (await state()).heights;
    assert.ok(loudHeights.every((height) => height > 2), "the whole meter responds to current input");
    assert.equal(loudHeights.length, 10, "the reference has ten strokes");
    assert.ok(Math.max(...loudHeights) > 22, "strong input can still use the full meter height");
    await streamLevel(hud, 1, 300);
    const flowingHeights = (await state()).heights;
    assert.ok(flowingHeights.some((height, index) => Math.abs(height - loudHeights[index]) > 1), "the contour flows while the current input level is steady");
    await streamLevel(hud, 0.05, 350);
    const quietHeights = (await state()).heights;
    assert.ok(quietHeights.every((height, index) => height < loudHeights[index]), "quieter input reduces every segment");
    await streamLevel(hud, 0, 500);
    assert.ok((await state()).heights.every((height) => Math.abs(height - 2) < 0.1), "silence leaves no past waveform behind");
    await streamLevel(hud, 0.9);
    await delay(650);
    assert.ok((await state()).heights.every((height) => Math.abs(height - 2) < 0.1), "a disconnected input settles smoothly");
    await hud.setState("transcribing");
    const dotMotion = await window.webContents.executeJavaScript(`new Promise((resolve) => {
      const row = document.getElementById('waveform');
      const dots = [...row.children].filter(dot => getComputedStyle(dot).display !== 'none');
      const seen = new Set();
      let maxRaised = 0;
      const startedAt = performance.now();
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      function sample(now) {
        const bounds = row.getBoundingClientRect();
        const baseline = bounds.top + bounds.height / 2;
        let raised = 0;
        dots.forEach((dot, index) => {
          const rect = dot.getBoundingClientRect();
          if (baseline - rect.top - rect.height / 2 > 0.5) { raised++; seen.add(index); }
        });
        maxRaised = Math.max(maxRaised, raised);
        if (now - startedAt >= 1100) resolve({ count:dots.length, maxRaised, movingDots:seen.size, reduced });
        else requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`);
    assert.equal(dotMotion.count, 3, "processing shows three dots");
    assert.equal(dotMotion.maxRaised, dotMotion.reduced ? 0 : 1, "only one dot jumps at a time");
    assert.equal(dotMotion.movingDots, dotMotion.reduced ? 0 : 3, "each dot takes a turn across the loop");
    await delay(6_200);
    assert.equal((await state()).slow, "true");
    await hud.setState("success");
    await delay(1_300);
    assert.equal((await state()).state, "idle");
    await hud.setStatus({ ...status, enabled: false });
    assert.equal(window.isVisible(), true, "turning dictation off leaves the enabled mini bar available for meetings");
    const meeting = { detectionEnabled: true, detectionSupported: true, detected: null, state: "idle", recordingId: null, startedAt: null, error: null };
    await hud.setMeeting(meeting);
    assert.equal(window.isVisible(), true, "meeting controls are available independently of dictation");
    const idleBounds = await window.webContents.executeJavaScript(`(() => {const r=document.getElementById('bar').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    input({ type: "mouseMove", x: Math.round(idleBounds.x), y: Math.round(idleBounds.y) });
    await delay(400);
    const hover = await window.webContents.executeJavaScript(`({width:document.getElementById('bar').getBoundingClientRect().width,buttonWidth:document.getElementById('meeting-start').getBoundingClientRect().width,opacity:getComputedStyle(document.getElementById('meeting-start')).opacity})`);
    assert.equal(hover.width, 62); assert.equal(hover.buttonWidth, 28); assert.equal(hover.opacity, "1");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('meeting-start-label').textContent"), "Record meeting");
    assert.equal(await window.webContents.executeJavaScript(`(() => {const bar=document.getElementById('bar').getBoundingClientRect();const button=document.getElementById('meeting-start').getBoundingClientRect();return button.left>=bar.left && button.right<=bar.right;})()`), true, "the revealed meeting button stays inside the expanded tile");
    assert.equal(await window.webContents.executeJavaScript(`(() => {const button=document.getElementById('meeting-start').getBoundingClientRect();return document.elementFromPoint(button.x+button.width/2,button.y+button.height/2)?.closest('button')?.id;})()`), "meeting-start", "the hover hit area never intercepts the meeting button");
    if (output) await writeFile(path.join(output, "meeting-hover.png"), (await window.webContents.capturePage()).toPNG());
    await hud.setStatus(status);
    await hud.setMeeting({ ...meeting, detectionEnabled: false });
    assert.equal(window.isVisible(), true);
    assert.equal(await window.webContents.executeJavaScript("document.body.dataset.meetingAvailable"), "true", "manual meeting recording is available with detection turned off");
    await hud.setState("idle", "", "de");
    await delay(350);
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('meeting-start-label').textContent"), "Besprechung aufnehmen");
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('bar').getBoundingClientRect().width"), 62);
    await hud.setStatus({ ...status, enabled: false });
    await hud.setState("idle", "", "en");
    actions.length = 0;
    await hud.setMeeting({ ...meeting, detected: { id: "zoom", app: "Zoom", title: "Zoom" } });
    assert.equal(await window.webContents.executeJavaScript("document.getElementById('meeting-prompt').hidden"), false);
    assert.deepEqual(actions, [], "meeting detection never records without a click");
    ipcMain.emit("legalwork:dictation-hud:action", { sender: {} }, "meeting-start");
    assert.deepEqual(actions, [], "other renderers cannot start a meeting");
    await window.webContents.executeJavaScript("document.getElementById('meeting-record').click()");
    await delay(30); assert.deepEqual(actions, ["meeting-start"]);
    for (const dark of [false, true]) {
      nativeTheme.themeSource = dark ? "dark" : "light";
      for (const locale of ["en", "de"]) {
        hud.locale = locale;
        for (const phase of ["starting", "recording", "saving", "error"]) {
          await hud.setMeeting({ ...meeting, state: phase, recordingId: "retained", startedAt: Date.now() - 64000, error: phase === "error" ? "Allow microphone and system audio access to record a meeting." : null });
          await delay(400);
          assert.equal((await state()).state, `meeting-${phase}`);
          const fits = await window.webContents.executeJavaScript(`(() => {const bar=document.getElementById('bar').getBoundingClientRect();return [...document.getElementById('bar').children].filter(e=>getComputedStyle(e).display!=='none').every(e=>{const r=e.getBoundingClientRect();return r.left>=bar.left && r.right<=bar.right});})()`);
          assert.equal(fits, true, `meeting ${phase} / ${locale} fits inside the bar`);
          assert.equal(await window.webContents.executeJavaScript("document.getElementById('meeting-prompt').hidden"), true);
          if (phase === "recording") {
            await streamLevel(hud, 0.6);
            assert.ok((await state()).heights.every(height => height > 2), "the meeting meter uses current microphone input");
            assert.equal(await window.webContents.executeJavaScript("document.querySelector('#meeting-open svg') !== null"), true, "recording has a notepad control separate from Stop");
            assert.match(await window.webContents.executeJavaScript("document.getElementById('meeting-time').textContent"), /^1:0[45]$/);
          }
          if (phase === "saving") {
            const dots = await window.webContents.executeJavaScript("[...document.querySelectorAll('#waveform i')].filter(e=>getComputedStyle(e).display!=='none').map(e=>getComputedStyle(e).animationDelay)");
            assert.deepEqual(dots, ["0s", "0.3s", "0.6s"]);
          }
          if (output && locale === "en") await writeFile(path.join(output, `${dark ? "dark" : "light"}-meeting-${phase}.png`), (await window.webContents.capturePage()).toPNG());
        }
      }
    }
    actions.length = 0;
    await hud.setMeeting({ ...meeting, state: "recording", recordingId: "retained", startedAt: Date.now() });
    await window.webContents.executeJavaScript("document.getElementById('meeting-stop').click(); document.getElementById('meeting-open').click()");
    await delay(30); assert.deepEqual(actions, ["meeting-stop", "meeting-open"]);
    assert.equal(window.isFocused(), false, "meeting buttons preserve the current app's focus");
    await hud.setMeeting({ ...meeting, state: "saving", recordingId: "retained" });
    assert.equal((await state()).state, "meeting-saving", "Stop immediately replaces the recording state with saving");
    await hud.setMeeting(meeting);
    assert.equal((await state()).state, "idle", "completion clears the recording controls");
    await hud.setMeeting({ ...meeting, detectionEnabled: false });
    assert.equal(window.isVisible(), true, "turning detection off leaves manual recording available");
    await hud.setStatus(status);
    cursor = { x: 0, y: 0 };
    for (const dock of ["left", "right"]) {
      hud.dock = dock;
      hud.positionWindow();
      for (const locale of ["en", "de"]) {
        nativeTheme.themeSource = locale === "de" ? "dark" : "light";
        for (const phase of ["starting", "listening", "transcribing", "inserting", "success", "cancelled", "error", "meeting-starting", "meeting-recording", "meeting-saving", "meeting-error"]) {
          await hud.setMeeting({ ...meeting, detectionEnabled: false });
          await hud.setState(phase.startsWith("meeting-") ? "idle" : phase, phase === "error" ? "Paste access is needed." : "", locale);
          if (phase.startsWith("meeting-")) await hud.setMeeting({ ...meeting, state: phase.slice(8), startedAt: Date.now() - 64000, error: phase === "meeting-error" ? "Allow microphone and system audio access to record a meeting." : null });
          await delay(350);
          if (["starting", "listening", "meeting-starting", "meeting-recording"].includes(phase)) await streamLevel(hud, 0.8);
          const geometry = await window.webContents.executeJavaScript(`(() => {
            const bar=document.getElementById('bar'),r=bar.getBoundingClientRect();
            const children=[...bar.children].filter(e=>e.id!=='label'&&getComputedStyle(e).display!=='none');
            const label=document.getElementById('label'),l=label.getBoundingClientRect();
            const meter=document.getElementById('waveform').getBoundingClientRect();
            return {width:r.width,height:r.height,inside:r.top>=0&&r.bottom<=innerHeight,
              fits:children.every(e=>{const c=e.getBoundingClientRect();return c.left>=r.left&&c.right<=r.right&&c.top>=r.top&&c.bottom<=r.bottom}),
              labelFits:getComputedStyle(label).display==='none'||(l.left>=0&&l.right<=innerWidth&&l.top>=0&&l.bottom<=innerHeight),
              meterVertical:meter.height>meter.width};
          })()`);
          assert.ok(geometry.height > geometry.width && geometry.width === 30, `${dock}/${locale}/${phase}: the whole pill is vertical and stays as slim as the microphone`);
          assert.ok(geometry.inside && geometry.fits && geometry.labelFits, `${dock}/${locale}/${phase}: controls and labels fit: ${JSON.stringify(geometry)}`);
          if (["starting", "listening", "meeting-starting", "meeting-recording"].includes(phase)) assert.ok(geometry.meterVertical, "the live waveform follows the vertical pill");
          if (output) await writeFile(path.join(output, `vertical-${dock}-${locale}-${phase}.png`), (await window.webContents.capturePage()).toPNG());
        }
      }
    }
    // Permission errors collapse on leave and expire without a click, even with updates.
    await hud.setMeeting(meeting);
    for (const dock of DOCKS) {
      hud.dock = dock;
      hud.positionWindow();
      await hud.setState("idle");
      const error = { ...meeting, state: "error", error: "Allow microphone and system audio access to record a meeting." };
      await hud.setMeeting(error);
      input({ type: "mouseMove", ...await center("bar") });
      await delay(350);
      const hintVisible = () => window.webContents.executeJavaScript(`(() => {const e=document.getElementById('label'),s=getComputedStyle(e);return s.display!=='none'&&s.opacity==='1';})()`);
      assert.equal(await hintVisible(), true, `${dock}: permission guidance is available on hover`);
      cursor = { x: 0, y: 0 };
      await delay(400);
      assert.equal(await hintVisible(), false, `${dock}: permission guidance disappears when the pointer leaves`);
      assert.equal(await window.webContents.executeJavaScript("document.getElementById('bar').getBoundingClientRect().width"), 30);
    }
    const dismiss = hud.actions.onMeetingDismiss;
    hud.actions.onMeetingDismiss = () => { actions.push("auto-dismiss"); void hud.setMeeting(meeting); };
    actions.length = 0;
    await hud.setMeeting(meeting);
    await hud.setMeeting({ ...meeting, state: "error", error: "Allow microphone access." });
    await delay(2_100);
    await hud.setMeeting({ ...meeting, state: "error", error: "Allow microphone access." });
    await delay(2_100);
    assert.equal((await state()).state, "idle", "meeting permission errors expire despite repeated status updates");
    assert.deepEqual(actions, ["auto-dismiss"]);
    hud.actions.onMeetingDismiss = dismiss;
    await hud.setState("error", "Allow microphone access.");
    await delay(2_100);
    await hud.setState("error", "Allow microphone access.");
    await delay(2_100);
    assert.equal((await state()).state, "idle", "dictation permission errors expire despite repeated status updates");
    await hud.setMeeting({ ...meeting, state: "error", error: "Allow microphone access." });
    await delay(2_100);
    await hud.setMeeting({ ...meeting, state: "recording", recordingId: "retained", startedAt: Date.now() });
    await delay(2_100);
    assert.equal((await state()).state, "meeting-recording", "an expired permission notice cannot dismiss a later recording");
    assert.deepEqual(actions, ["auto-dismiss"]);
    assert.deepEqual(rendererErrors, [], "every visual state runs without renderer errors");
    assert.equal(await window.webContents.executeJavaScript("window.dictationAudioContexts"), 0, "HUD readiness never opens the playback device");
    console.log("PASS: dictation and meeting states in both themes and languages, hover controls, manual detection prompt, current input meter, notepad and stop controls, saving dots, focus preservation, and completion");
  } finally {
    hud.destroy();
    screen.getCursorScreenPoint = nativeCursor;
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  app.exit(0);
}).catch((error) => {
  writeSync(2, `${error.stack || error}\n`);
  app.exit(1);
});
