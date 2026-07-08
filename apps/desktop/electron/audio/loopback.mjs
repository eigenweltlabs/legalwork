/**
 * System-audio loopback for the Recorder.
 *
 * Chromium can hand `getDisplayMedia` a loopback audio track on every desktop
 * platform, but each needs a nudge:
 *  - Windows: WASAPI loopback, built in — `audio: "loopback"` just works.
 *  - macOS 13+: ScreenCaptureKit loopback behind `MacLoopbackAudioForScreenShare`
 *    (+ `MacSckSystemAudioLoopbackOverride`); macOS 15+ prefers the CoreAudio
 *    process-tap path behind `MacCatapSystemAudioLoopbackCapture`.
 *  - Linux: PipeWire/PulseAudio behind `PulseaudioLoopbackForScreenShare`.
 *
 * `appendLoopbackFeatureFlags` must run before `app.ready`. The display-media
 * handler is installed only while the recorder is actually capturing so the
 * rest of the app keeps default screen-share behavior.
 */

import { macOsAtLeast } from "./mac-version.mjs";

const FEATURE_SWITCH = "enable-features";

// True between enableLoopbackAudio() and the handler answering (or explicit
// disable). The media permission handler consults this so the recorder's
// getDisplayMedia — whose permission request includes "video" — is allowed
// without opening screen/camera access to ordinary content.
let loopbackArmed = false;

export function isLoopbackCaptureArmed() {
  return loopbackArmed;
}

export function appendLoopbackFeatureFlags(app) {
  const flags = [];
  if (process.platform === "darwin") {
    flags.push("MacLoopbackAudioForScreenShare");
    flags.push(macOsAtLeast(15) ? "MacCatapSystemAudioLoopbackCapture" : "MacSckSystemAudioLoopbackOverride");
  } else if (process.platform === "linux") {
    flags.push("PulseaudioLoopbackForScreenShare");
  }
  if (flags.length === 0) return;

  const existing = app.commandLine.getSwitchValue(FEATURE_SWITCH);
  if (app.commandLine.hasSwitch(FEATURE_SWITCH)) {
    app.commandLine.removeSwitch(FEATURE_SWITCH);
  }
  const merged = [existing, ...flags].filter(Boolean).join(",");
  app.commandLine.appendSwitch(FEATURE_SWITCH, merged);
}

/**
 * Route the NEXT getDisplayMedia call to a screen source with loopback
 * audio — no source picker, since the recorder only wants the audio track.
 *
 * The handler is one-shot: it uninstalls itself after answering (or on
 * explicit disable), so a renderer crash between enable and disable can leak
 * at most a single already-user-initiated capture, and the app's default
 * screen-share behavior is restored immediately.
 */
export function enableLoopbackAudio(session, desktopCapturer) {
  loopbackArmed = true;
  // Safety net if the renderer dies before its finally-disable runs.
  setTimeout(() => {
    loopbackArmed = false;
  }, 30_000);
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    session.defaultSession.setDisplayMediaRequestHandler(null);
    desktopCapturer
      .getSources({ types: ["screen"] })
      .then((sources) => {
        if (!sources.length) throw new Error("No screen sources for system audio capture.");
        callback({ video: sources[0], audio: "loopback" });
      })
      .catch(() => {
        // Deny the request; the renderer surfaces a friendly error.
        callback({});
      });
  });
}

export function disableLoopbackAudio(session) {
  loopbackArmed = false;
  session.defaultSession.setDisplayMediaRequestHandler(null);
}
