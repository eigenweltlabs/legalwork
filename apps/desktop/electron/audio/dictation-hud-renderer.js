import { dictationMotionProfile } from "./dictation-motion.js";

const bridge = window.dictationHud;
if (new URLSearchParams(location.search).has("preview")) document.body.dataset.preview = "true";
const bar = document.getElementById("bar");
const notice = document.getElementById("notice");
const label = document.getElementById("label");
const startLabel = document.getElementById("start-label");
const bars = [...document.querySelectorAll("#waveform i")];
let targetLevel = 0;
let displayedLevel = 0;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let currentState = "idle";
let slowTimer;
let lastLevelAt = 0;
let animationFrame = 0;
let previousFrameAt = 0;
let meterStartedAt = 0;
let meetingStartedAt = null;
let idleNotice = "";
let meetingStartNotice = "";
const meteringStates = ["starting", "listening", "meeting-starting", "meeting-recording"];
const translations = {
  en: {
    starting: "Starting dictation", listening: "Listening", transcribing: "Transcribing…", inserting: "Inserting…",
    copied: "Couldn’t insert text", copyInstructions: "Copied to clipboard. Select a text field and press {paste} to paste.",
    success: "Text inserted", cancelled: "Cancelled", error: "Dictation needs attention",
    start: "Start dictation", dictate: "Dictate", stop: "Finish and insert text", cancel: "Cancel dictation", dismiss: "Dismiss",
    click: "Click to dictate", release: "Release {shortcut} to insert", finish: "{shortcut} to finish",
    slow: "Taking longer than usual…",
    "meeting-starting": "Starting recording…", "meeting-recording": "Recording meeting", "meeting-saving": "Saving meeting…", "meeting-error": "Recording needs attention",
    meetingStart: "Record meeting", meetingStop: "Stop and save meeting", meetingOpen: "Open recording in LegalWork", meetingDetected: "Meeting detected", meetingDescription: "Record microphone and meeting audio", meetingDismiss: "Not now", meetingRecord: "Record",
    assistant: "Start Assistant",
  },
  de: {
    starting: "Diktat starten", listening: "Hört zu", transcribing: "Wird transkribiert…", inserting: "Wird eingefügt…",
    copied: "Text konnte nicht eingefügt werden", copyInstructions: "In die Zwischenablage kopiert. Wähle ein Textfeld und drücke {paste}, um den Text einzufügen.",
    success: "Text eingefügt", cancelled: "Abgebrochen", error: "Diktat braucht Aufmerksamkeit",
    start: "Diktat starten", dictate: "Diktieren", stop: "Beenden und Text einfügen", cancel: "Diktat abbrechen", dismiss: "Schließen",
    click: "Klicken zum Diktieren", release: "{shortcut} loslassen zum Einfügen", finish: "{shortcut} zum Beenden",
    slow: "Dauert länger als üblich…",
    "meeting-starting": "Aufnahme wird gestartet…", "meeting-recording": "Besprechung wird aufgenommen", "meeting-saving": "Besprechung wird gespeichert…", "meeting-error": "Aufnahme braucht Aufmerksamkeit",
    meetingStart: "Besprechung aufnehmen", meetingStop: "Aufnahme beenden und speichern", meetingOpen: "Aufnahme in LegalWork öffnen", meetingDetected: "Besprechung erkannt", meetingDescription: "Mikrofon und Besprechungston aufnehmen", meetingDismiss: "Nicht jetzt", meetingRecord: "Aufnehmen",
    assistant: "Assistenten starten",
  },
};

function shortcutLabel(accelerator, platform) {
  return accelerator.split("+").map((key) => ({
    CommandOrControl: platform === "darwin" ? "⌘" : "Ctrl", Command: "⌘", Control: "Ctrl",
    Alt: platform === "darwin" ? "⌥" : "Alt", Shift: "⇧", Super: "Win", Space: "Space", Fn: "fn", Plus: "+",
  })[key] || key).join(" ");
}

function resetMeter() {
  targetLevel = 0;
  displayedLevel = 0;
  for (const item of bars) item.style.transform = meteringStates.includes(currentState) ? `scaleY(${2 / 26})` : "";
}

function animateMeter(now) {
  animationFrame = 0;
  if (!meteringStates.includes(currentState)) return;
  const elapsed = previousFrameAt ? Math.min(now - previousFrameAt, 48) : 16;
  previousFrameAt = now;
  if (!meterStartedAt) meterStartedAt = now;
  if (now - lastLevelAt > 160) targetLevel = 0;
  const blend = reducedMotion.matches ? 1 : 1 - Math.exp(-elapsed / (targetLevel > displayedLevel ? 16 : 70));
  displayedLevel += (targetLevel - displayedLevel) * blend;
  if (Math.abs(targetLevel - displayedLevel) < 0.0005) displayedLevel = targetLevel;
  const profile = dictationMotionProfile(reducedMotion.matches ? 0 : now - meterStartedAt);
  bars.forEach((item, index) => {
    item.style.transform = `scaleY(${(2 + displayedLevel * profile[index] * 24) / 26})`;
  });
  animationFrame = requestAnimationFrame(animateMeter);
}

bridge.onState((value) => {
  document.documentElement.dataset.theme = value.dark ? "dark" : "light";
  document.documentElement.dataset.appearance = value.appearance || "app";
  if (value.preview) {
    document.body.dataset.preview = "true";
    document.body.dataset.dock = value.dock;
    return;
  }
  document.body.dataset.dock = value.dock || "bottom";
  const changed = currentState !== value.state;
  currentState = value.state;
  document.body.dataset.state = value.state;
  const hint = value.state === "idle" && Boolean(value.message);
  document.body.dataset.hint = String(hint);
  document.documentElement.dataset.theme = value.dark ? "dark" : "light";
  const shortcut = shortcutLabel(value.accelerator, value.platform);
  const labels = translations[value.locale] || translations.en;
  meetingStartNotice = labels.meetingStart;
  meetingStartedAt = value.meeting?.startedAt;
  document.body.dataset.meetingAvailable = "true";
  const companion = value.companion ?? { enabled: false, badge: true, attention: 0, recording: false };
  document.body.dataset.companion = String(Boolean(companion.enabled));
  document.body.dataset.companionRecording = String(Boolean(companion.recording));
  const assistantButton = document.getElementById("assistant");
  const badge = document.getElementById("assistant-badge");
  const assistantLabel = (labels.assistant || "Open Assistant") + (companion.attention ? ` · ${companion.attention}` : "");
  assistantButton.setAttribute("aria-label", assistantLabel);
  assistantButton.title = "";
  document.getElementById("assistant-label").textContent = labels.assistant;
  badge.hidden = !(companion.badge && companion.attention > 0);
  badge.textContent = companion.attention > 9 ? "9+" : String(companion.attention);
  document.getElementById("start").disabled = !value.enabled || !value.registered;
  const detected = value.state === "idle" ? value.meeting?.detected : null;
  document.getElementById("meeting-prompt").hidden = !detected;
  document.getElementById("meeting-title").textContent = detected ? `${labels.meetingDetected} · ${detected.app}` : "";
  document.getElementById("meeting-description").textContent = labels.meetingDescription;
  for (const [id, text] of [["meeting-start", labels.meetingStart], ["meeting-stop", labels.meetingStop], ["meeting-open", labels.meetingOpen], ["meeting-dismiss", labels.meetingDismiss], ["meeting-close", labels.dismiss]]) {
    document.getElementById(id).setAttribute("aria-label", text);
    document.getElementById(id).title = text;
  }
  document.getElementById("meeting-record").textContent = labels.meetingRecord;
  document.getElementById("meeting-start-label").textContent = labels.meetingStart;
  document.documentElement.lang = value.locale;
  for (const action of ["start", "stop", "cancel", "dismiss"]) {
    const button = document.getElementById(action);
    const actionLabel = action === "stop" && value.state === "starting" ? labels.cancel : labels[action];
    button.setAttribute("aria-label", actionLabel);
    button.title = action === "start" ? "" : actionLabel + (action === "cancel" ? " · Esc" : "");
  }
  startLabel.textContent = labels.dictate;
  label.textContent = value.state.startsWith("meeting-") ? value.meeting?.error || labels[value.state] : value.state === "error" ? (value.dock !== "bottom" && value.message) || labels.error : value.message || labels[value.state] || "";
  const copyInstructions = labels.copyInstructions.replace("{paste}", value.platform === "darwin" ? "⌘V" : "Ctrl+V");
  document.getElementById("copy-instructions").textContent = copyInstructions;
  bar.setAttribute("aria-label", value.state === "copied" ? `${labels.copied}. ${copyInstructions}` : value.message || labels[value.state] || labels.start);
  const instruction = (value.mode === "hold" ? labels.release : labels.finish).replace("{shortcut}", shortcut);
  notice.textContent = value.state.startsWith("meeting-") ? value.meeting?.error || labels[value.state] : value.state === "error" ? value.message : value.state === "idle"
    ? value.message || labels.click + (shortcut ? " · " + shortcut : "") : value.state === "listening"
    ? [labels.listening, value.microphoneName, instruction].filter(Boolean).join(" · ") : labels.slow;
  if (value.state === "idle") {
    idleNotice = notice.textContent;
    if (document.getElementById("meeting-start").dataset.hovered === "true") notice.textContent = meetingStartNotice;
  }
  notice.setAttribute("aria-hidden", !hint && !["listening", "error", "meeting-starting", "meeting-recording", "meeting-error"].includes(value.state));
  if (changed) {
    clearTimeout(slowTimer);
    document.body.dataset.slow = "false";
    // Keep live input through startup; stop rendering as soon as dictation finishes.
    if (!["listening", "meeting-recording"].includes(value.state) || performance.now() - lastLevelAt > 160) resetMeter();
    if (meteringStates.includes(value.state)) {
      if (!animationFrame) {
        previousFrameAt = 0;
        meterStartedAt = 0;
        animationFrame = requestAnimationFrame(animateMeter);
      }
    } else {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    }
    if (["starting", "transcribing"].includes(value.state)) slowTimer = setTimeout(() => {
      document.body.dataset.slow = "true";
      notice.setAttribute("aria-hidden", "false");
    }, 6_000);
  }
});
bridge.onLevel((level) => {
  if (!meteringStates.includes(currentState)) return;
  lastLevelAt = performance.now();
  targetLevel = level;
});
for (const action of ["start", "stop", "cancel", "dismiss"]) document.getElementById(action).addEventListener("click", () => bridge.action(action));
for (const action of ["meeting-start", "meeting-stop", "meeting-open", "meeting-dismiss"]) document.getElementById(action).addEventListener("click", () => bridge.action(action));
document.getElementById("assistant").addEventListener("click", event => { event.stopPropagation(); bridge.action("assistant-open"); });
document.getElementById("meeting-record").addEventListener("click", () => bridge.action("meeting-start"));
document.getElementById("meeting-close").addEventListener("click", () => bridge.action("meeting-dismiss"));
setInterval(() => {
  const seconds = meetingStartedAt ? Math.max(0, Math.floor((Date.now() - meetingStartedAt) / 1000)) : 0;
  document.getElementById("meeting-time").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}, 250);
bar.addEventListener("click", (event) => {
  if (currentState !== "idle" || event.target.closest("button")) return;
  if (document.getElementById("start").disabled && document.body.dataset.companion === "true") bridge.action("assistant-open");
  else bridge.action("start");
});
let interactive = false;
let pointerDrag = null;
let suppressClick = false;
function setHover(target) {
  bar.dataset.hovered = String(Boolean(target?.closest("#bar")) && !pointerDrag?.moving);
  for (const id of ["start", "meeting-start", "assistant"]) {
    document.getElementById(id).dataset.hovered = String(target?.closest("button")?.id === id && !pointerDrag?.moving);
  }
  if (currentState === "idle") notice.textContent = target?.closest("#meeting-start") ? meetingStartNotice : idleNotice;
  const next = Boolean(pointerDrag || target?.closest("#bar, #meeting-prompt"));
  if (interactive !== next) { interactive = next; bridge.pointer(next); }
}
function updatePointer(x, y) {
  if (pointerDrag) return;
  setHover(document.elementFromPoint(x, y));
}
function clearDrag() {
  const previous = pointerDrag;
  pointerDrag = null;
  document.body.dataset.dragging = "false";
  if (previous && bar.hasPointerCapture(previous.id)) bar.releasePointerCapture(previous.id);
  setHover(null);
}
bridge.onCursor(({ x, y, reset }) => {
  if (reset) clearDrag();
  else updatePointer(x, y);
});
bar.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  suppressClick = false;
  if (event.target.closest("button") && !event.target.closest("#start")) return;
  pointerDrag = { id: event.pointerId, x: event.screenX, y: event.screenY, moving: false };
  // Do not leave focus behind on a mouse-only, non-activating overlay.
  event.preventDefault();
  bar.setPointerCapture(event.pointerId);
});
bar.addEventListener("pointermove", event => {
  if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
  if (!pointerDrag.moving && Math.hypot(event.screenX - pointerDrag.x, event.screenY - pointerDrag.y) >= 5) {
    pointerDrag.moving = true;
    suppressClick = true;
    document.body.dataset.dragging = "true";
    setHover(null);
    // Collapse before measuring so the microphone follows the pointer itself.
    const rect = bar.getBoundingClientRect();
    bridge.drag("start", { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  }
  if (pointerDrag.moving) bridge.drag("move");
});
function finishDrag(event, save) {
  if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
  const moving = pointerDrag.moving;
  clearDrag();
  if (moving) bridge.drag(save ? "end" : "cancel");
}
bar.addEventListener("pointerup", event => finishDrag(event, true));
bar.addEventListener("pointercancel", event => finishDrag(event, false));
bar.addEventListener("lostpointercapture", event => finishDrag(event, false));
bar.addEventListener("click", event => {
  // Keep this guard until the next press, including clicks delivered after IPC.
  if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener("mousemove", event => updatePointer(event.clientX, event.clientY));
document.addEventListener("mouseleave", () => { if (!pointerDrag) setHover(null); });
window.addEventListener("blur", () => {
  if (pointerDrag?.moving) bridge.drag("cancel");
  clearDrag();
});
document.getElementById("start").addEventListener("contextmenu", event => {
  event.preventDefault();
  if (currentState === "idle") bridge.action("microphone-menu");
});
bridge.action("ready");
