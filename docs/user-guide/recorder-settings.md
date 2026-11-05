# Recorder settings

Open in LegalWork: [Recorder settings](legalwork://app/settings/recorder).

Open **Settings > Recorder** in the desktop app. **Models** configures transcription; **Dictate anywhere** configures insertion into other apps. **Meetings** controls meeting detection and recording visibility. These settings are separate from the chat model and from Voice Mode.

## Models and language

1. Open **Models** and choose the transcription language: **Auto**, **English** or **Deutsch**. This changes speech recognition, not the app's display language.
2. For local transcription, choose a model tier and select **Download**. Wait for installation, then select **Use** if it is not already selected. The selection badge and installed state are separate: a selected download is not ready until it completes.
3. Return to Recorder and make a short recording. Play it back and inspect the transcript before recording a longer meeting.

| Control or state | Meaning |
| --- | --- |
| Basic / Standard / Premium / Maximum | Local model choices with different resource requirements. Use the app's size and hardware guidance; premium choices can require entitlement. |
| Download / Cancel / error | Download installs model files. Cancel stops that download; retry a failed download after checking disk space and the displayed error. |
| Use / selected badge | Chooses the installed model for subsequent transcription. |
| Detect existing models / Import, where offered | Reuse compatible model files already on disk. A random audio file is not a transcription model. |
| Delete model | Removes downloaded model files, not recording history. Select another available model before transcribing again. |
| Engine unavailable | The local transcription runtime has a problem. A different chat provider does not repair it. |

### Cloud transcription, when offered

The app lists **Cloud · Europe** and/or **Cloud · US** alongside local models when the firm's subscription and model permissions allow them. Select **Use** on the desired available option. Cloud transcription sends audio to Google in the selected region and uses subscription allowance; the recording is still saved on this device. It needs network access. The selected region and actual account availability matter.

Do not tell someone recording is always offline merely because the audio file is saved locally. Check the selected transcription source. Speaker identification is available with local transcription in the inspected implementation.

## Dictate anywhere

1. Configure a ready transcription source in **Models**, then open **Dictate anywhere**.
2. Select **Configure**, set a shortcut the OS can register, and choose **Tap** or **Hold** if offered. Tap starts and stops on successive presses; Hold records while the shortcut is held.
3. Complete the permission/readiness prompts and use the test text field in the setup dialog. On macOS, Microphone and Accessibility are needed; Hold can also require Input Monitoring. Restart when the app says the new grant needs it.
4. Enable dictation, place the cursor in the destination app, and use your configured shortcut. Escape cancels a dictation.

Use the microphone selector to choose the desired input, refresh devices after changing a headset and check the input level. **Overlay color** changes the floating control's appearance, not the recording source. **Start at login** keeps dictation available after sign-in; approve the OS login item when prompted.

If the shortcut is unavailable, choose another registered key combination. Some Fn keys never reach applications. If insertion fails, recover the retained transcript from Recorder history. Successful system dictations are ephemeral rather than ordinary meeting recordings.

## Meetings

**Record meeting** captures your microphone and meeting audio; **Stop and save** finishes it. Allow the required microphone and system-audio permissions first, and check the recording source. Finished audio and transcripts appear in Recordings.

**Detect meetings** offers a Record button when a supported call is detected. It does not start recording automatically. Detection depends on OS support and the call application; browser detection needs a visible meeting tab and can require Accessibility on macOS. Start a recording manually if a call is not detected. Stop when the meeting ends.

**Hide app** offers **Never**, **During recording** and **Always** where supported. It controls app visibility during screen sharing, not audio capture, model-provider access or whether a recording is being made.

Related: [Recording and transcripts](audio.md), [Privacy](settings-privacy.md), [Troubleshooting](troubleshooting.md).
