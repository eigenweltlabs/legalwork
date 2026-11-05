# Recording, dictation and Voice Mode

Open in LegalWork: [Recorder](legalwork://app/recorder), [Recorder settings](legalwork://app/settings/recorder).

Recorder captures audio and produces a transcript. Dictation inserts recognized speech at a cursor. Voice Mode is a realtime conversation with the assistant. Local transcription uses a downloaded model on this device; cloud transcription is also available subject to account access. Check the selected source before assuming audio stays on the device. Voice Mode uses a separate provider connection.

## Recorder

Open **Recorder** or its panel and complete setup. Use **Settings > Recorder** to select a transcription source and language. For the controls, download states, dictation setup and meeting settings, read [Recorder settings](recorder-settings.md). A local model must be installed; a cloud option must be available to your account and connected.

Choose microphone, system audio or app audio from the sources available on your platform. Grant microphone permission and any audio/screen-capture permission the OS requests. App-specific capture requires a supported macOS version; on Windows, system audio is the route for call audio across applications. Missing or disabled sources cannot be fixed by changing the chat model.

Choose **Record**, speak briefly and check that the expected audio appears in the live transcript. Use the stop control to finish and wait for finalization. Playback's Pause control is separate from capture. Open the completed recording to play it or inspect the transcript.

Use **Import file** or the supported drop area to transcribe an existing audio/video recording. Import requires a ready local transcription model; switch to local transcription if a cloud source is selected. **Save to workspace** or the project-linking action makes the recording/transcript available in the selected project. Check the destination rather than assuming every global recording belongs to the current matter. Rename recordings to make them findable. Deleting a recording is distinct from deleting a downloaded model.

In the transcript panel, select a transcript segment to inspect it alongside playback and use **Copy transcript** when needed. Local speaker labels can be provisional. After recording, use **Speaker settings** to rename people or assign segments correctly; reassigning all of a speaker's segments affects every segment with that label. A detected speaker number is not proof of a person's identity.

## Dictate anywhere

Open **Settings > Recorder > Dictate anywhere**, select a ready transcription source, configure the shortcut and enable dictation. Put the cursor in the target application. In **Tap** mode, press once to start and again to transcribe and insert. In **Hold** mode, hold the shortcut while speaking and release to transcribe. Escape cancels. Use the shortcut shown by the app rather than assuming a universal default.

On macOS, allow Microphone and Accessibility; Hold mode also needs Input Monitoring and may require restarting the app after the permission change. On Windows, allow microphone access for desktop apps. Some laptop Fn keys are handled by firmware and cannot be used by applications, so choose another exposed key combination if needed.

Successful system dictations are ephemeral and do not become normal recording history. If insertion fails, the dictation is retained in Recorder history so the text can be recovered. Inspect the active cursor before inserting into another application.

With dictation enabled, closing the window can leave LegalWork running in the menu bar/tray. **Start at login** enables background startup; **Quit** actually exits. Sleeping finalizes a call recording and cancels an in-flight dictation to prevent unexpected insertion after waking.

## Voice Mode

Connect a compatible OpenAI account/key and use the available Voice Mode control. The voice integration is provider-dependent and may be hidden until its prerequisites are met. It supports realtime interaction and available app actions. Start and end the call explicitly. Its microphone/network behavior differs from local dictation and recording; installing a local transcription model does not make Voice Mode offline.

Related: [Recorder settings](recorder-settings.md), [Settings and privacy](settings-privacy.md), [Feature availability](feature-availability.md), [Troubleshooting](troubleshooting.md).
