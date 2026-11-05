# System-wide dictation

LegalWork can record the microphone, transcribe locally, and paste the result
at the active cursor in another application. The setting is under **Settings >
Recorder > Dictate anywhere**. It is off by default.

System dictations are ephemeral. LegalWork deletes their temporary audio and
transcript files after insertion, so they do not appear in Recorder history.
If the paste command fails, the transcript stays on the clipboard for manual
paste and the bar shows the recovery message. Call and meeting recordings
continue to use the normal retained history.

## Recorder onboarding

Recorder remains one main onboarding step. Its **Permissions** substep guides
microphone and supported system-audio access, macOS keyboard monitoring,
Accessibility and Automation, and a local speech model. Dictation permissions
can be deferred, and a model download may continue in the background.

Continue opens **Dictation & meetings** within the same step. Users explicitly
enable Dictate Anywhere, record their shortcut inline, and try it in a test
field or use **Try dictation** for the local microphone test. Finishing inserts
only into that field; it never sends a chat message. Meeting detection has its
own toggle and still only offers recording, rather than starting it. Existing
settings are preserved; entering or leaving onboarding does not enable features.
Missing permissions link back to the first substep. The final Continue moves
to the existing AI setup step, leaving the main onboarding step count unchanged.

For development, append `onboarding=recorder` to the session route's query to
reopen the real flow. This affordance is disabled in production builds and
does not reset workspaces, OS permissions, or other preferences.

## Dictating a chat message

The microphone beside Send in Home and chat composers dictates into the current
draft. Click it to start, then finish to transcribe and insert the text without
sending the message. The composer shows a live waveform while listening and
three individually jumping dots during transcription. Cancel or Escape leaves
the existing draft unchanged. Leaving a chat or switching its active tab cancels
its dictation, including pending startup and transcription.

This uses the same local model, language and microphone selection as Dictate
anywhere, but works without enabling its shortcut or granting Accessibility
permission. Feedback stays inside the composer and insertion does not use the
clipboard. Microphone permission and an installed Recorder model are required;
setup errors link to Recorder settings. Capture is exclusive with meetings,
imports and other dictation. Temporary audio and transcripts are discarded and
never enter recording history. The microphone control is unavailable in the web
client, where the native local transcription service is absent.

The square stop button transcribes into the draft for review. The adjacent
arrow button transcribes and sends the completed draft, including any existing
text and attachments. Silence, cancellation, a departed chat, or failed
transcription does not send a message. Repeated clicks cannot send twice.

The floating microphone can be dragged to the bottom, left, or right
edge of a display. Three drop targets appear during the drag. Its position
and display are saved across restarts; starting dictation keeps that position.
Hovering reveals Dictate and Record meeting actions, horizontally at the bottom
and vertically at either side, with side labels opening toward the screen.
At either side, the full recording pill and live waveform are vertical too;
cancel, stop, and meeting controls remain upright in a column.

For a branded macOS development app, the app bundle must include
`NSAppleEventsUsageDescription` and the
`com.apple.security.automation.apple-events` signing entitlement.
Without the usage description, macOS rejects the request without showing a
prompt or adding the app to Automation settings. Keep the same bundle ID and
signing identity when repairing the bundle, then launch it through macOS
LaunchServices so permissions belong to LegalWork Dev. Continue using
`http://localhost:5173`, the existing `com.eigenweltlabs.legalwork.dev` profile,
and the `~/.legalwork/legalwork-orchestrator-dev` runtime data.

## Meeting recording and detection

Hover over the floating microphone to reveal **Record meeting**. This also
works without an active call, for an in-person meeting. Recording captures
the system-default microphone and system audio, transcribes locally, and
retains the audio and transcript in **Recordings**. The floating bar shows a
blinking red recording light, elapsed time, the current microphone level, and
**Stop and save**. Click the recording light to open the recorder. Saving
shows three dots that jump individually while the final transcript and
speaker pass finish. Dictation remains a separate, ephemeral recording.

Recordings follow the current view. In a full-page project overview, selecting
a recording opens its transcript in place; a newly started project recording
also fills this view live. The existing **Open as a tab** action hands that
transcript to the project's workspace. In the tabbed workspace, recordings use
the same preview, keep-open, drag, split, and expand/restore controls as other
documents. A new capture opens a retained transcript tab with finalized speech
and the current partial appearing as they arrive.

Global recordings do not open workspace tabs or change the current view.
In the global Recorder, selecting a saved recording or **Open transcript**
shows the transcript in place, with a back button to the recordings list.
Entering a workspace during a global recording does not automatically open
its transcript there. Closing
a transcript tab leaves capture running, and reopening it resumes the live
view. Completed tabs keep the saved transcript when later recordings or
dictation begin. Transcript tabs follow the viewer's existing split, window,
and layout persistence behavior.

Completed transcripts include a People panel. Edit a name there to rename
that speaker throughout the recording, or add another person. A speaker menu
can assign a turn to a different person or reassign all of that speaker's
segments. For a turn containing several segments, each segment also has its
own assignment menu. Corrections preserve the transcript text and timestamps,
persist across restarts, and update the JSON, text, SRT, and Markdown exports.
Speaker editing becomes available once recording and diarization finish.
Each People row shows its segment count and explicit rename and remove controls.
Removing a speaker reassigns their segments to another person or leaves them
unassigned, without deleting text or audio. Unused speakers can also be removed.

**Settings > Recorder > Meetings > Detect meetings** is enabled by default.
Automatic detection is available on Windows 10/11 and macOS 14.2+. Zoom,
Teams, Slack, and Webex can trigger a prompt when using the microphone;
browsers also need a meeting URL or call window title for Google Meet,
Teams, or Zoom, with the meeting tab visible in a browser window.

On Windows, a hidden PowerShell/.NET helper enumerates active **capture**
sessions through Core Audio and resolves audio helper processes back to
supported call applications. Chrome, Edge, and Firefox are supported: UI
Automation reads address controls in browser toolbars, skipping web documents,
page contents, tab lists, password fields, and browsing history. Window titles
provide a Google Meet fallback when an address is unavailable. URL credentials,
queries, and fragments are discarded. Playing audio alone never triggers a
prompt, and LegalWork's own capture is excluded. No audio stream is opened by
detection, and audio routing is unchanged.

The Windows helper is compiled once and reused between polls. It stops when
detection is disabled, the computer suspends, or LegalWork quits. A hung probe
is terminated; unavailable or policy-blocked PowerShell uses a retry backoff
and leaves manual recording available. No administrator access, additional
runtime download, or execution-policy bypass is required. The Windows CI job
compiles and runs the exact shipped helper without recording audio.

On macOS, the native helper reads Core Audio's process microphone activity;
browser detection additionally needs Accessibility permission. Other platforms
still support manual recording through the existing capture capabilities.

API references: [capture endpoint enumeration](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-immdeviceenumerator-enumaudioendpoints),
[audio session state](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol-getstate),
[session process identity](https://learn.microsoft.com/en-us/windows/win32/api/audiopolicy/nf-audiopolicy-iaudiosessioncontrol2-getprocessid),
and [UI Automation threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading).

Detection checks every three seconds and requires a stable signal before
offering **Record**. It never opens the microphone or starts a recording on
its own. Dismissing a prompt suppresses it for that call; a 15-second grace
period tolerates brief microphone interruptions. The user stops recording
when the meeting ends; detection does not auto-stop a muted call. Native
microphone activity can also occur in a call app's audio settings or lobby,
so the prompt is a suggestion, not proof that a call has started.

This follows Wispr Flow's documented call-detection and manual-prompt
behavior ([recording guide](https://docs.wisprflow.ai/articles/9238501024-recording-a-meeting-with-notetaker-beta),
[settings](https://docs.wisprflow.ai/articles/9319084321-notetaker-settings-explained-beta)).
Wispr Flow does not publish its detector implementation. LegalWork's
implementation uses read-only OS activity and window metadata rather than
claiming identical proprietary internals.

## Background operation

Dictation is used with LegalWork in the background, so the app is built to
keep the shortcut working without a visible window:

- While **Dictate anywhere** is on, a tray icon (Windows) or menu bar icon
  (macOS) shows the shortcut and offers Open and Quit. Closing the window
  hides it instead of quitting; Quit from the tray menu or app menu exits for
  real. The same applies while a recording is still running behind a closed
  window, so it can finalize, and while supported meeting detection is on.
- **Start at login** (Settings > Recorder, next to the dictation setting)
  registers LegalWork as a login item. It starts in the background: the
  window stays hidden and the shortcut is armed. On macOS 13+ the entry
  appears under **System Settings > General > Login Items** and macOS shows a
  one-time notification; on Windows it appears under **Settings > Apps >
  Startup** and in Task Manager.
- Sleep, wake, and the lock screen are handled: going to sleep finalizes an
  active call recording and cancels an in-flight dictation (nothing is pasted
  into whatever happens to be focused after wake). After wake and after
  unlocking, LegalWork restarts the native keyboard listener and re-warms the
  transcription engine, the two components that commonly die across sleep.
- While recording, importing, or pasting, LegalWork holds an OS power
  assertion so idle sleep (and Windows Modern Standby) cannot freeze a
  recording mid-write. The assertion is released when the work finishes; an
  idle armed shortcut holds nothing. Lid-close sleep cannot be prevented on
  macOS by design; the suspend handling above covers it.
- A crashed window process reloads automatically so the capture pipeline
  behind the hotkey comes back without a manual restart.

## User installation

### macOS

1. Install LegalWork from the DMG by dragging it to Applications, then launch
   the installed copy. Do not run it from the DMG.
2. In **Settings > Recorder**, download and select a local transcription model.
3. Allow LegalWork under **System Settings > Privacy & Security > Microphone**.
4. Use **Open Privacy Settings** in Recorder settings and enable LegalWork under
   **Privacy & Security > Accessibility**. For shortcut gestures, also enable LegalWork
   under **Privacy & Security > Input Monitoring**, then restart LegalWork.
   Remove and add the app again if a grant left over from an older build does
   not work.
5. Turn on **Dictate anywhere**. Hold the displayed shortcut while speaking,
   then release to transcribe and paste. Double-tap for hands-free dictation;
   one press finishes it. Escape cancels.

The shortcut field records a key or combination directly after every key is
released. Regular shortcuts and modifier-only shortcuts such as Fn, Control,
or Fn+Control are supported. Both gestures work automatically, with no mode
setting. The first press starts microphone capture immediately. A release
within 200 ms waits up to 300 ms for a second press: that press keeps the same
capture running hands-free; without it, the isolated tap returns to the
microphone tile with a brief **Hold [shortcut] and speak** hint.
Holds shorter than 500 ms return to the microphone tile with the same hint;
holds between 200 ms and 500 ms do so immediately. Holding for at least
500 ms transcribes on release. One subsequent press
finishes hands-free capture. While the native keyboard monitor is unavailable,
Electron's fallback chord supports a single press to start or finish; hold and
double-tap require the monitor.
LegalWork keeps the previous working shortcut when a new chord cannot be
registered.

The keyboard monitor observes shortcuts without consuming their events or
changing the system's key behavior.

### Dictation bar

When enabled and registered, a 30 × 28 px microphone tile appears at the bottom
of the screen. Hover to reveal **Dictate** and the shortcut, or click to start
hands-free dictation. The tile expands into the recording bar in place and
never takes focus from the destination application:

- **Start**: the level meter appears immediately, resting at zero until audio
  arrives. Its shape stays the same when the microphone and local model are
  ready; the listening hint appears only after audio capture is ready.
- **Listening**: microphone volume scales ten strokes whose contour flows
  through a one-second cycle measured from the supplied Wispr Flow recording.
  The center moves and smaller peaks appear across the band. A quick response
  and smooth release follow current input without scrolling audio history.
  Feedback updates independently of transcription's audio batches and settles
  to dots in silence. Microphone details and the shortcut hint appear only on
  hover, both while holding and during hands-free dictation. Use the
  stop button to finish and insert, or X / Escape to cancel.
- **Transcribing**: three horizontal dots bounce in sequence immediately on
  release or finish, while capture flushes and the local model completes.
  X / Escape still cancels; it prevents
  insertion without deleting files out from under the pending flush.
- **Inserting**: the transcript is being pasted. Finish/cancel controls are
  removed during this short operation to avoid racing the paste.
- **Text inserted** or **Cancelled**: a brief confirmation returns to the
  microphone tile. Errors display the actual recovery message with a dismiss button.

Preparation and transcription show a longer-than-usual notice after six
seconds. A valid hold release or hands-free finish during microphone startup
queues completion until capture is ready. An isolated quick tap shows the
shortcut hint and Escape cancels without pasting. If no speech was recognized,
dictation returns quietly to idle without pasting or modifying the clipboard.
The explicit finish button always inserts even a
short phrase. Transparent areas pass mouse clicks to the underlying app.
The bar follows LegalWork's theme, supports English and German, and respects
the operating system's reduced motion preference. Meeting/call overlays are
unaffected.

Microphone opening and PCM processor setup run concurrently; resolving the
microphone's display name happens after capture begins. Speech spoken before
the input opens cannot be recorded. Finishing waits for the final partial PCM
batch and the speech detector's remaining samples before finalizing the
transcript. A missing flush acknowledgement reports an error and releases the
microphone and temporary dictation session.

The interaction reference is Wispr Flow's [desktop dictation flow](https://docs.wisprflow.ai/articles/6409258247-starting-your-first-dictation),
[hands-free controls](https://docs.wisprflow.ai/articles/6391241694-use-flow-hands-free),
and [Flow Bar reference](https://wispr.notion.site/What-s-the-bar-at-the-bottom-of-my-screen-1992ebdc73348143a4a6d2cdac57be71).
The local transcription engine continues to determine the actual processing duration.

Run `pnpm --filter @legalwork/app test:dictation` for startup, cancellation,
single insertion, and error recovery regressions. Run
`pnpm --filter @legalwork/desktop test:dictation-hud` for all visual states in
both themes/languages, focus preservation, controls, input level and delayed
feedback. Set `LEGALWORK_HUD_SCREENSHOTS` to a directory to save state previews.
Run `pnpm --filter @legalwork/desktop test:dictation-capture` to verify real
PCM/WebM capture, final-sample preservation, startup during microphone-name
lookup, and microphone cleanup with a silent output sink, using a
synthetic microphone without opening physical audio input or output.

Development builds inherit microphone and Accessibility identity from the app
that launches Electron. Grant the terminal or IDE instead, then restart it.
Always validate release permissions with the packaged `.app`, because that is
the identity users install.

### Microphone choice

Choose a microphone in **Settings > Recorder > Dictate anywhere**, or right-click
its idle microphone tile. The choice is saved across restarts and applies to the
next dictation; an active recording keeps its input. The listening hover hint
names the microphone actually in use.

- **Automatic (recommended)** follows the system input unless it is Bluetooth.
  On macOS it then prefers an available built-in microphone, followed by another
  non-Bluetooth input. A built-in Mac microphone is unavailable with the lid closed.
- **System default** follows the operating system's input choice.
- A **specific microphone**, including AirPods, is used as selected. If it is
  disconnected, dictation asks you to choose another input instead of opening
  a different microphone. Reconnecting it restores the saved choice.

When Bluetooth is selected, Settings explains that its microphone can affect
music and offers **Use Mac microphone** when one is available. Dictation uses a
silent Web Audio sink and visual readiness feedback, so capture does not open
an audio playback device. macOS sound settings and meeting/call recording retain
their existing input behavior.

### Windows

1. Run the signed NSIS installer and launch LegalWork from the Start menu.
2. In **Settings > Recorder**, download and select a local transcription model.
3. Under **Settings > Privacy & security > Microphone**, enable microphone
   access and **Let desktop apps access your microphone**.
4. Turn on **Dictate anywhere** and use the shortcut shown in LegalWork.

Windows supports modifier-only shortcuts and both gestures through its low-level
keyboard hook. The Fn key is handled in keyboard firmware on many Windows
laptops and is not exposed to applications on those devices; Control, Alt,
Shift, and Windows remain available as standalone shortcuts.

Windows blocks synthetic input into applications running as Administrator when
LegalWork is not elevated. In that case the transcript remains on the clipboard
and can be pasted manually. Password and secure-desktop fields may also reject
insertion by design.

### Paste delivery and clipboard recovery

On macOS, the bundled helper posts Command+V with CGEvent, resolving V from the
active keyboard layout. The System Events keystroke is a fallback when the helper
cannot run. Neither path inspects the focused field to decide whether to paste.
The native path requires Accessibility but does not require Automation consent.
Windows uses SendInput and checks how many keyboard events the OS accepted.

After an accepted command, the previous clipboard contents (text, HTML, RTF, images, or an empty
clipboard) are restored after 500 ms, provided the user has
not copied something else. On macOS, delivery is observed after both key events: a readable field containing
the transcript confirms insertion; a field that stays unchanged, a non-text
control, or a ready accessibility tree with no focused field triggers clipboard
recovery. A focused web document without an editing field also triggers recovery.
Cold Chromium trees and editors with unreadable contents remain unknown: the
accepted paste keeps its normal clipboard restoration instead of producing a
false clipboard-only result. The recording-start event prepares accessibility in
the background; neither capture nor paste waits for preparation.

Command errors also retain the transcript and show the amber recovery message.
The native result for observed failure is distinct from command errors, so it
never retries a delivered shortcut. This follows [Flow's documented recovery behavior](https://docs.wisprflow.ai/articles/1621472516-flow-fails-to-detect-text-fields-or-inserts-incorrectly-on-non-qwerty-keyboard-layouts),
including assuming success in editors that do not report their contents. Windows
continues to use the SendInput result; the post-paste readback is macOS-specific.
No text from the receiving field is logged or retained.

The native regression command waits for **Run verification** in its own test
window before sending real keys. It must only be run when desktop interaction is
explicitly wanted; normal checks use mocked clipboard/shortcut services and a
standalone Swift classifier test.

This follows [OpenWhispr's clipboard lifecycle](https://github.com/OpenWhispr/openwhispr/blob/main/src/helpers/clipboard.js)
and [native macOS paste helper](https://github.com/OpenWhispr/openwhispr/blob/main/resources/macos-fast-paste.swift).
The helper's MIT notice is retained in the source and bundled licenses.

## Build prerequisites

- Node.js matching CI and Corepack with `pnpm@11.4.0`.
- Run `pnpm install --frozen-lockfile` at the repository root.
- Build each installer on its target OS. The desktop package contains native
  Electron and `sherpa-onnx-node` binaries and is not treated as a portable
  cross-build.
- Models are downloaded after installation and are intentionally not bundled
  in the installer.

### Build on macOS

Install Xcode Command Line Tools, then run:

```bash
pnpm --filter @legalwork/desktop test
pnpm --filter @legalwork/desktop typecheck:electron
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/desktop package:electron
```

Artifacts are written to `apps/desktop/dist-electron/` as DMG and ZIP files.
Release distribution requires the normal Developer ID signing and notarization
environment. A locally unsigned build can exercise transcription, but its TCC
permissions do not prove that the signed release identity works.

### Build on Windows

Use a Windows x64 or arm64 build host with Node.js and Corepack, then run in
PowerShell:

```powershell
pnpm --filter @legalwork/desktop test
pnpm --filter @legalwork/desktop typecheck:electron
pnpm --filter @legalwork/app typecheck
pnpm --filter @legalwork/desktop package:electron
```

The NSIS installer is written to `apps/desktop/dist-electron/`. Validate both a
fresh install and an in-place upgrade because microphone privacy settings and
shortcut registration are profile-level state.

## Release verification

On each target OS:

1. Install the packaged artifact and download a model.
2. Enable the setting and confirm the displayed shortcut is registered.
3. Dictate into Word, Outlook, a Chromium text field, and a plain-text editor.
4. Confirm the target application never loses focus while the HUD appears.
5. Copy rich content before dictation and verify the prior clipboard is restored.
6. Change the clipboard during insertion and verify LegalWork does not overwrite
   the newer clipboard value.
7. Deny the required permission and verify the transcript is retained on the
   clipboard with an explicit error.
8. Press Escape while listening and verify no transcript is pasted.
9. Restart LegalWork and verify the enabled setting and shortcut persist.
10. Hold the shortcut while speaking and verify release stops capture,
    transcribes, and pastes exactly once. Double-tap the same shortcut, release
    both taps, then verify capture continues and one press finishes it.
11. Save a modifier-only shortcut (Control on both platforms and Fn on macOS)
    and verify it remains active after restart.

### Background matrix

12. Close the window with dictation enabled: the app stays in the tray or
    menu bar and the shortcut still dictates into another app. Reopen from
    the tray (Windows: single click; macOS: menu item or Dock icon).
13. Sleep and wake, then dictate within 5 seconds and again after 5 minutes.
    The shortcut must work without restarting LegalWork (hooks and event taps
    are reinstalled on wake).
14. Lock (Win+L / Ctrl+Cmd+Q) while dictation is listening: the dictation is
    canceled, nothing is pasted into the password field, and after unlocking
    the shortcut works again. After holding, verify no key is latched.
15. Start a long call recording, close the lid or force sleep, and wake:
    everything captured before sleep is finalized and playable, and the
    recording is not left in a broken "recording" state.
16. Leave the machine idle for 30+ minutes, then dictate: the first spoken
    words must appear (post-idle microphone tracks and cold engines are
    reacquired automatically).
17. Enable Start at login, reboot, and dictate without opening the window.
    macOS: approve the Login Items notification if shown.
18. Repeat sleep/wake ten times in a row; the shortcut must survive every
    cycle.
19. Deny automatic paste (remove Accessibility on macOS) and dictate: the
    transcript stays on the clipboard, the HUD reports the failure, and the
    temporary dictation is deleted from Recorder history.

The overlay expands only while the pointer is over it. Pressing and dragging the microphone collapses the controls, follows the native pointer, and snaps to the left, right, or bottom when released. Cancelling a drag clears the hover and capture state. Native pointer checks also clear hover when a window moves without a Chromium mouse-leave event.

Settings → Recorder → Dictate anywhere → Overlay color offers White, Black, and Follow app mode (the default). This choice is stored with the dictation settings, applies immediately to the floating controls and dock preview, and survives app restarts.

Recording a meeting also requires Screen & System Audio Recording access on macOS, separately from dictation permissions. Enable the actual development bundle (LegalWork Dev), not just the installed LegalWork app. If the development bundle is absent from that pane, add it with + and restart it using the standard dev profile.

The overlay sits four points from the work area edge. Side pills stay 30 points wide during both dictation and meeting recording. Attention messages appear on hover and clear after four seconds, even when the recording status refreshes.
