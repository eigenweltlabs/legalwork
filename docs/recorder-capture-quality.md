# Recorder: app audio, speaker identification, and transcription quality

This covers three parts of the local Recorder pipeline: per-application audio
capture on macOS, on-device speaker diarization, and the audio front-end that
feeds the ASR model. All processing stays on the device.

## Capture sources

The Recorder captures the **microphone** and **system audio** (everything the
machine plays). System audio uses Chromium's WASAPI loopback on Windows and a
Core Audio / ScreenCaptureKit path on macOS 13+, gated by the macOS **Screen &
System Audio Recording** permission.

Per-application capture (a picker that taps one chosen app) was removed:
single-app Core Audio process taps were unreliable for the multiprocess apps
users actually wanted (Chrome/Electron emit audio from helper processes, not
the main one). System audio captures the same content without the fragility.
The native tap backend remains in the tree, unused, in case per-app capture is
revisited.

## Speaker identification (diarization)

Speaker labels ("who said what") are **always on** for retained call/meeting
recordings — there is no setting. The two on-device models (pyannote
segmentation 3.0 + a 3D-Speaker CAM++ embedding extractor, ~36 MB total)
download automatically in the background the first time the recorder loads (and
retry on each load until installed). Recordings made before that download
finishes simply aren't labeled; later ones are.

How it works: while a diarize-enabled recording runs, its 16 kHz mono audio is
teed to a temporary file. When the recording stops, a finalize pass runs
`sherpa-onnx` `OfflineSpeakerDiarization` over that audio (a few hundred
milliseconds to tens of seconds depending on length), producing speaker turns.
Each transcript segment is then assigned the speaker whose turns overlap it
most, with a nearest-turn fallback for short utterances in a gap. Speaker ids
are renumbered by first appearance and shown as "Speaker 1", "Speaker 2", … in
the transcript, the exports (txt/srt/md), and the transcript handed to the
chat. Dictation is never diarized.

Limits: one speaker per segment (overlapping crosstalk collapses to the
dominant speaker); recordings longer than 60 minutes skip the speaker pass to
bound memory (transcription still completes). The clustering threshold default
(0.5) suits real speakers; very similar or synthetic voices may merge.

## Transcription quality (front-end)

The dominant quality levers for the local ASR are the audio the model is fed,
not the model config:

- **Microphone front-end.** Chromium's automatic gain control, noise
  suppression, and echo cancellation are tuned for telephony, not ASR, and
  distort the waveform. For microphone-only capture all three are off. When
  system/app audio is also captured, echo cancellation is enabled (the speaker
  output can leak into the mic); gain control and noise suppression stay off.
- **Word-onset padding.** Voice activity detection cuts speech at the exact
  on/offset, clipping the first ~100–300 ms of a word so a transducer drops or
  garbles it. Each segment is decoded with ~300 ms of raw pre-roll and
  hangover from a rolling buffer; the reported timestamps still cover only the
  speech.
- **Mix limiting.** When several sources are summed (a call recording), the mix
  is trimmed and limited so two loud sources can't overshoot and hard-clip into
  distortion the model reads as noise. A single source is left untouched.

The Parakeet model config itself (int8 weights, `nemo_transducer`, greedy
decoding, 80-dim features) is correct and unchanged; int8 and the decoding
method were not the cause of poor quality, and `modified_beam_search` is
deliberately avoided (it hallucinates on Parakeet TDT).

## Model lineup (three tiers)

Lawyers don't read "whisper-small", so the catalog is presented as three
tiers with plain-English benefits (see
`apps/app/.../recorder/model-tiers.ts`):

| Tier | Model | Why |
|---|---|---|
| **Basic** | `whisper-tiny` | Fast rough notes, runs on any/old computer. |
| **Standard** | `whisper-small` | Balanced accuracy for modern computers (free). |
| **Premium** | `parakeet-tdt-0.6b-v3` | Best accuracy *and* real-time fast, with punctuation — entitlement-gated. |

On CPU (sherpa-onnx int8, the runtime here), Parakeet is both the fastest and
the most accurate model for German (~5% WER vs ~20% for whisper-small) and the
only premium model that runs live on ordinary laptops — so Premium leads with
it rather than Whisper Large Turbo (batch-only on CPU). Whisper Base and Turbo
were dropped.

**Device hint.** `RecorderService.deviceProfile()` reads `os.cpus()` /
`os.totalmem()` / `process.arch` and recommends Standard on Apple Silicon or
≥8 GB/≥4-core machines, else Basic. The recommended tier is badged
"Recommended for your device" and adopted as the default when the user hasn't
chosen one.

**Premium gating.** `isPremiumEntitled()` in `model-tiers.ts` is a placeholder
that returns `false` today (auth is built separately). While it is false, the
Premium tier shows a lock/badge and an "unlocks with your plan" dialog instead
of downloading, and the store refuses to select or download a premium model.
Wire that one function to the real entitlement when auth lands.

## Onboarding & first-run

- **First-run modal** (`shell/transcription-intro.tsx`): a one-time hero modal
  explaining on-device transcription, shown the first desktop launch after
  install (deferring if a "What's new" announcement is still pending).
- **Onboarding setup step** (`onboarding/transcription-setup-step.tsx`): the
  final onboarding cover offers two one-tap installs — add the Office add-ins
  and download the recommended transcription model. Both optional; both also
  live in Settings.
- **Settings › Recorder** is split into **Models** and **Dictate anywhere**
  tabs.
