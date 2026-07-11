# System-wide dictation

LegalWork can record the microphone, transcribe locally, and paste the result
at the active cursor in another application. The setting is under **Settings >
Recorder > Dictate anywhere**. It is off by default.

System dictations are ephemeral. LegalWork deletes their temporary audio and
transcript files after insertion, so they do not appear in Recorder history.
Call and meeting recordings continue to use the normal retained history.

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
