import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, ipcMain, nativeTheme } from "electron";
import { DictationHud } from "../electron/audio/dictation-hud.mjs";

const output = process.env.LEGALWORK_HUD_SCREENSHOTS;
app.commandLine.appendSwitch("mute-audio");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function streamLevel(hud, level, duration = 100) {
  const until = Date.now() + duration;
  do {
    hud.feedLevel(level);
    await delay(16);
  } while (Date.now() < until);
}
const status = {
  enabled: true, registered: true, shortcutCaptureActive: false, accelerator: "CommandOrControl+Shift+D",
  defaultAccelerator: "CommandOrControl+Shift+D", customAccelerator: false, mode: "hold", supportsHold: true,
  platform: "darwin", accessibility: "granted", error: null,
};

app.whenReady().then(async () => {
  const actions = [];
  const hud = new DictationHud({ onStart: () => actions.push("start"), onStop: () => actions.push("stop"), onCancel: () => actions.push("cancel"), onMicrophoneMenu: () => actions.push("microphone-menu"), onMeetingStart: () => actions.push("meeting-start"), onMeetingStop: () => actions.push("meeting-stop"), onMeetingDismiss: () => actions.push("meeting-dismiss"), onMeetingOpen: () => actions.push("meeting-open") });
  try {
    await hud.setStatus(status);
    const window = hud.window;
    assert.ok(window);
    const rendererErrors = [];
    window.webContents.on("console-message", (_event, level, message) => {
      if (level === 3) rendererErrors.push(message);
    });
    assert.equal(window.isFocusable(), false);
    assert.equal(window.isFocused(), false);
    const prefs = window.webContents.getLastWebPreferences();
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.nodeIntegration, false);
    await window.webContents.executeJavaScript(`(() => {
      window.dictationAudioContexts = 0;
      const NativeAudioContext = window.AudioContext;
      window.AudioContext = class extends NativeAudioContext {
        constructor(options) { super(options); window.dictationAudioContexts += 1; }
      };
    })()`);
    const state = () => window.webContents.executeJavaScript(`({state:document.body.dataset.state, label:document.getElementById('label').textContent, notice:document.getElementById('notice').textContent, slow:document.body.dataset.slow, heights:[...document.querySelectorAll('#waveform i')].map(b=>b.getBoundingClientRect().height)})`);
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
    // Only this HUD's renderer can invoke its controls.
    ipcMain.emit("legalwork:dictation-hud:action", { sender: {} }, "start");
    assert.deepEqual(actions, []);
    for (const [locale, message] of [["en", "Hold ⌘ ⇧ D and speak"], ["de", "Halten Sie ⌘ ⇧ D und sprechen Sie"]]) {
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
    assert.equal(window.isVisible(), false);
    const meeting = { detectionEnabled: true, detectionSupported: true, detected: null, state: "idle", recordingId: null, startedAt: null, error: null };
    await hud.setMeeting(meeting);
    assert.equal(window.isVisible(), true, "meeting controls are available independently of dictation");
    const idleBounds = await window.webContents.executeJavaScript(`(() => {const r=document.getElementById('bar').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    window.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(idleBounds.x), y: Math.round(idleBounds.y) });
    await delay(400);
    const hover = await window.webContents.executeJavaScript(`({width:document.getElementById('bar').getBoundingClientRect().width,buttonWidth:document.getElementById('meeting-start').getBoundingClientRect().width,opacity:getComputedStyle(document.getElementById('meeting-start')).opacity})`);
    assert.equal(hover.width, 132); assert.equal(hover.buttonWidth, 28); assert.equal(hover.opacity, "1");
    assert.equal(await window.webContents.executeJavaScript(`(() => {const bar=document.getElementById('bar').getBoundingClientRect();const button=document.getElementById('meeting-start').getBoundingClientRect();return button.left>=bar.left && button.right<=bar.right;})()`), true, "the revealed meeting button stays inside the expanded tile");
    assert.equal(await window.webContents.executeJavaScript(`(() => {const button=document.getElementById('meeting-start').getBoundingClientRect();return document.elementFromPoint(button.x+button.width/2,button.y+button.height/2)?.closest('button')?.id;})()`), "meeting-start", "the hover hit area never intercepts the meeting button");
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
            assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.getElementById('record-light')).animationName"), "recording-light");
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
    await hud.setMeeting({ ...meeting, detectionEnabled: false });
    assert.equal(window.isVisible(), false);
    assert.deepEqual(rendererErrors, [], "every visual state runs without renderer errors");
    assert.equal(await window.webContents.executeJavaScript("window.dictationAudioContexts"), 0, "HUD readiness never opens the playback device");
    console.log("PASS: dictation and meeting states in both themes and languages, hover controls, manual detection prompt, current input meter, recording light, saving dots, focus preservation, and completion");
  } finally {
    hud.destroy();
  }
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
