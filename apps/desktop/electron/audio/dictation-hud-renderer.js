import { dictationMotionProfile } from "./dictation-motion.js";

const bridge = window.dictationHud;
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
    success: "Text inserted", cancelled: "Cancelled", error: "Dictation needs attention",
    start: "Start dictation", dictate: "Dictate", stop: "Finish and insert text", cancel: "Cancel dictation", dismiss: "Dismiss",
    click: "Click to dictate", release: "Release {shortcut} to insert", finish: "{shortcut} to finish",
    slow: "Taking longer than usual…",
    "meeting-starting": "Starting recording…", "meeting-recording": "Recording meeting", "meeting-saving": "Saving meeting…", "meeting-error": "Recording needs attention",
    meetingStart: "Record meeting", meetingStop: "Stop and save meeting", meetingOpen: "Open recording in LegalWork", meetingDetected: "Meeting detected", meetingDescription: "Record microphone and meeting audio", meetingDismiss: "Not now", meetingRecord: "Record",
  },
  de: {
    starting: "Diktat starten", listening: "Hört zu", transcribing: "Wird transkribiert…", inserting: "Wird eingefügt…",
    success: "Text eingefügt", cancelled: "Abgebrochen", error: "Diktat braucht Aufmerksamkeit",
    start: "Diktat starten", dictate: "Diktieren", stop: "Beenden und Text einfügen", cancel: "Diktat abbrechen", dismiss: "Schließen",
    click: "Klicken zum Diktieren", release: "{shortcut} loslassen zum Einfügen", finish: "{shortcut} zum Beenden",
    slow: "Dauert länger als üblich…",
    "meeting-starting": "Aufnahme wird gestartet…", "meeting-recording": "Besprechung wird aufgenommen", "meeting-saving": "Besprechung wird gespeichert…", "meeting-error": "Aufnahme braucht Aufmerksamkeit",
    meetingStart: "Besprechung aufnehmen", meetingStop: "Aufnahme beenden und speichern", meetingOpen: "Aufnahme in LegalWork öffnen", meetingDetected: "Besprechung erkannt", meetingDescription: "Mikrofon und Besprechungston aufnehmen", meetingDismiss: "Nicht jetzt", meetingRecord: "Aufnehmen",
  },
};

function shortcutLabel(accelerator, platform) {
  return accelerator.split("+").map((key) => ({
    CommandOrControl: platform === "darwin" ? "⌘" : "Ctrl", Command: "⌘", Control: "Ctrl",
    Alt: platform === "darwin" ? "⌥" : "Alt", Shift: "⇧", Super: "Win", Space: "Space", Fn: "fn",
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
  document.body.dataset.meetingAvailable = String(Boolean(value.meeting));
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
  document.documentElement.lang = value.locale;
  for (const action of ["start", "stop", "cancel", "dismiss"]) {
    const button = document.getElementById(action);
    const actionLabel = action === "stop" && value.state === "starting" ? labels.cancel : labels[action];
    button.setAttribute("aria-label", actionLabel);
    button.title = action === "start" ? "" : actionLabel + (action === "cancel" ? " · Esc" : "");
  }
  startLabel.textContent = labels.dictate;
  label.textContent = value.state.startsWith("meeting-") ? value.meeting?.error || labels[value.state] : value.state === "error" ? labels.error : value.message || labels[value.state] || "";
  bar.setAttribute("aria-label", labels[value.state] || labels.start);
  const instruction = (value.mode === "hold" ? labels.release : labels.finish).replace("{shortcut}", shortcut);
  notice.textContent = value.state.startsWith("meeting-") ? value.meeting?.error || labels[value.state] : value.state === "error" ? value.message : value.state === "idle"
    ? value.message || labels.click + (shortcut ? " · " + shortcut : "") : value.state === "listening"
    ? [labels.listening, value.microphoneName, instruction].filter(Boolean).join(" · ") : labels.slow;
  if (value.state === "idle") {
    idleNotice = notice.textContent;
    if (document.getElementById("meeting-start").matches(":hover")) notice.textContent = meetingStartNotice;
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
document.getElementById("meeting-record").addEventListener("click", () => bridge.action("meeting-start"));
document.getElementById("meeting-close").addEventListener("click", () => bridge.action("meeting-dismiss"));
document.getElementById("meeting-start").addEventListener("mouseenter", () => { if (currentState === "idle") notice.textContent = meetingStartNotice; });
document.getElementById("meeting-start").addEventListener("mouseleave", () => { if (currentState === "idle") notice.textContent = idleNotice; });
setInterval(() => {
  const seconds = meetingStartedAt ? Math.max(0, Math.floor((Date.now() - meetingStartedAt) / 1000)) : 0;
  document.getElementById("meeting-time").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}, 250);
bar.addEventListener("click", (event) => {
  if (currentState === "idle" && !event.target.closest("button")) bridge.action("start");
});
let interactive = false;
document.addEventListener("mousemove", (event) => {
  const next = Boolean(event.target.closest("#bar, #meeting-prompt"));
  if (interactive !== next) { interactive = next; bridge.pointer(next); }
});
document.addEventListener("mouseleave", () => { interactive = false; bridge.pointer(false); });
document.getElementById("start").addEventListener("contextmenu", event => {
  event.preventDefault();
  if (currentState === "idle") bridge.action("microphone-menu");
});
bridge.action("ready");
