# System-wide dictation

LegalWork can record the microphone, transcribe locally, and paste the result
at the active cursor in another application. The setting is under **Settings >
Recorder > Dictate anywhere**. It is off by default.

System dictations are ephemeral. LegalWork deletes their temporary audio and
transcript files after insertion, so they do not appear in Recorder history.
If the paste fails, the dictation is retained in Recorder history instead so
the spoken text stays recoverable. Call and meeting recordings continue to
use the normal retained history.

## Background operation

Dictation is used with LegalWork in the background, so the app is built to
keep the shortcut working without a visible window:

- While **Dictate anywhere** is on, a tray icon (Windows) or menu bar icon
  (macOS) shows the shortcut and offers Open and Quit. Closing the window
  hides it instead of quitting; Quit from the tray menu or app menu exits for
  real. The same applies while a recording is still running behind a closed
  window, so it can finalize.
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
   **Privacy & Security > Accessibility**. For Hold mode, also enable LegalWork
   under **Privacy & Security > Input Monitoring**, then restart LegalWork.
   Remove and add the app again if a grant left over from an older build does
   not work.
5. Turn on **Dictate anywhere**. Press the displayed shortcut once to start,
   again to transcribe and paste, or Escape to cancel.

The shortcut field records a key or combination directly after every key is
released. Regular shortcuts and modifier-only shortcuts such as Fn, Control,
or Fn+Control are supported. **Tap** starts and stops on separate presses;
**Hold** records while the shortcut is down and transcribes on release.
LegalWork keeps the previous working shortcut when a new chord cannot be
registered.

Development builds inherit microphone and Accessibility identity from the app
that launches Electron. Grant the terminal or IDE instead, then restart it.
Always validate release permissions with the packaged `.app`, because that is
the identity users install.

### Windows

1. Run the signed NSIS installer and launch LegalWork from the Start menu.
2. In **Settings > Recorder**, download and select a local transcription model.
3. Under **Settings > Privacy & security > Microphone**, enable microphone
   access and **Let desktop apps access your microphone**.
4. Turn on **Dictate anywhere** and use the shortcut shown in LegalWork.

Windows supports modifier-only shortcuts and Hold mode through its low-level
keyboard hook. The Fn key is handled in keyboard firmware on many Windows
laptops and is not exposed to applications on those devices; Control, Alt,
Shift, and Windows remain available as standalone shortcuts.

Windows blocks synthetic input into applications running as Administrator when
LegalWork is not elevated. In that case the transcript remains on the clipboard
and can be pasted manually. Password and secure-desktop fields may also reject
insertion by design.

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
10. Select Hold, keep the shortcut down while speaking, and verify release
    stops capture, transcribes, and pastes exactly once.
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
    the shortcut works again. In Hold mode verify no key is latched.
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
    dictation appears in Recorder history instead of being deleted.
