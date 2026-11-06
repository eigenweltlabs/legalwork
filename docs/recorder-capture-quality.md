# Recorder: app audio, speaker identification, and transcription quality

This covers Recorder capture, speaker labels, transcription timing and meeting
notes. Local transcription stays on the device. The cloud path described below
uses the organisation's enabled regional providers.

## Finding recordings from chat

`legalwork_recordings_list` searches the retained recordings in the current
desktop profile, including global recordings and every project's recordings.
It supports optional project, title, and inclusive local-date filters, plus
`scope: "global"` for unassigned recordings only. Discovery returns metadata,
not transcript excerpts or speaker names.
Use `period: "yesterday"` or `"today"` to resolve relative dates with the host's
clock and time zone. Follow `nextCursor` to exhaust a list; later pages retain
the initial date filters and exclude newly created recordings.

`legalwork_recording_read` reads the current transcript by recording ID, with
timestamps and saved speaker names. It includes finalized live speech and
supports `nextOffset` pagination for long transcripts. Refresh from offset zero
after edits. Temporary dictation captures and internal storage paths are excluded.

The library routes require owner access, inherited from the authenticated chat.
Collaborators, viewers, unknown sessions, and revoked sessions cannot inspect
the owner's private library. Interactive chats can read global and current-project
transcripts directly. Another project's transcript requires an existing project
or folder grant, or explicit read-only recording approval in that chat. Approval
does not grant access to other files and expires on restart. Permission, session
scope, and project-root changes invalidate stale approvals.

Scheduled tasks use the server-recorded project scope from their saved settings:
`project` includes that project plus unassigned global recordings; `all` includes
every project plus global recordings. Both discovery and content reads enforce
this scope. A scheduled run cannot expand access through tool arguments or an
interactive approval, and verified descendant chats inherit the same restriction.
Headless servers report that the library is unavailable,
not that it is empty. Other devices and external cloud libraries are not searched.

Verified on 21 October 2026 with the standard development profile: the same chat
that previously found only one project recording returned all 15 library entries
for the previous day, then read a global recording with corrected speaker names.
Automated coverage includes local midnight, daylight saving transitions,
pagination, transcript edits, partial/live speech, cross-project approvals,
existing grants, scheduled project boundaries, and permission downgrades.

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

How it works: each completed VAD speech segment (at most 18 seconds) is
processed locally while the recording continues. Segmentation isolates the
predominant voice; CAM++ produces its embedding. A recording-scoped matcher
compares that embedding with retained speaker centroids. The recording keeps
these identities across VAD boundaries and disk writes. Finalization drains
queued speech and writes exports.

The live matcher uses cosine similarity 0.5. The previous live-only 0.75 cutoff
fragmented natural speech: two manually grouped turns in a local test recording
scored 0.63. The diarizer's separate clustering threshold is a distance setting;
it is not interchangeable with this matching score.

At least one second of voiced audio is needed to recognize an existing speaker,
1.5 seconds to create a speaker, and two seconds to adapt a centroid. If the two
best matches are within 0.08, or no voice covers 65% of the segment's detected
speech, the segment remains unassigned. Only its dominant voice can create an
identity. Brief background voices do not silently seed additional centroids.

Limits: labels remain provisional. Similar voices can merge, and microphone or
channel changes can still split an identity. One label represents each transcript
segment, so balanced overlap remains unassigned. There is no whole-recording
speaker pass or one-hour limit; speaker state is bounded to 64 centroids.

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

## Workspace transcripts and long recordings

Project-home recording actions open transcript tabs in the workspace. An active
recording linked to that project is shared with its visible chat automatically.
The Live call toggle can opt the workspace out for the rest of that recording.
Global recordings remain opt-in; attaching one opens its transcript beside chat.
The agent is notified once per chat and reads `live-call-transcript.md` on demand.
After a recording ends, speaker corrections and title changes also update this
managed workspace copy. The recording metadata retains its destination across
app restarts. A hidden sidecar identifies the file's recording, so editing an
older call cannot overwrite a newer call that has reused the same filename.
The Markdown stays plain and opens in the normal document view.
Copies disconnected before recording ends remain snapshots of what was shared;
later speech is not added to workspaces where sharing was turned off.

Compressed audio is streamed to `audio.webm` in one-second chunks. Each completed
speech segment is appended to `transcript.jsonl` immediately, and the workspace
mirror appends only new text in bounded batches. Stopping preserves the mirror
and appends its end marker. Final JSON, Markdown, text and SRT exports are written
once at completion. After an interruption, the journal recovers completed
segments, tolerating an incomplete final line, and marks the recording as
interrupted instead of presenting it as complete.

Local speaker detection runs on completed VAD segments (at most 18 seconds) while
recording. The installed segmentation and embedding models assign provisional
speaker IDs; up to 64 voice centroids keep IDs stable across segments. Short or
uncertain speech remains unassigned, and a segment containing multiple voices is
assigned to its dominant speaker. Saved transcripts support manual corrections.
There is no whole-recording PCM read or one-hour speaker limit. The worker keeps
its 30-second audio ring and at most one pending partial decode per stream.

Regression coverage feeds six hours of timestamped segments through persistence,
checks interruption recovery, and verifies that stopping keeps all live text.
This is not a six-hour capture soak test: available disk space and a transcription
model that keeps up with the input still determine practical recording length.

## Cloud meetings and automatic notes

Cloud meetings retain known Microphone, System audio and App audio labels for
separate inputs from the start. They identify sources, not verified people.
Speaker detection is automatic, with no additional-voices setting. After Stop,
cloud word boundaries are checked against local CAM++ voice embeddings in an
Electron utility process. Each input and recording has its own voice state.
Several longer utterances contribute to a profile; a new voice needs independent
confirmation, and similar profiles are reconciled at the end. The first voice
reuses the input label and additional voices get their own IDs. Uncertain speech
and unavailable voice models retain input labels. Source labels identify inputs;
voice identities remain probabilistic and can require correction.

After Stop, the independent speaker pass refines word timings.
Unmatched words keep their input label. A failed live socket preserves
captured speaker-pass audio for the saved transcript. Speaker windows are
30 seconds with overlap to reduce per-request latency.
Transient connection setup is retried once before audio is sent. A recoverable
provider failure skips that window and continues with later audio, preserving
input labels for the gap. Three consecutive failures stop the pass. Paid audio
requests are not retried after an uncertain response.

The capture worklet emits silence when an input has no samples so both input
clocks keep advancing together. The gateway uses provider speech activity
offsets instead of response arrival times. Desktop persistence sorts incoming
segments by capture time and rewrites a shared live mirror on late arrivals.
Improved word timings are applied even when text and speaker stay unchanged.
When alignment moves the end of one caption past the next caption's onset, the
original word sequence on that input takes precedence over estimated timing.
The gateway commits long authoritative meeting text incrementally. If Google
returns a long utterance in one final packet, confident word alignment splits it
into paragraphs targeting 600 characters and 30 seconds, using recognized word
times. Unmatched text is retained, so these are not hard limits on every segment.
The viewer also bounds same-speaker grouping by time, silence gap and text length.
The alignment cache retains four minutes of words to cover delayed long packets.

With a cloud transcription model selected, **Settings > Recorder > Meetings**
offers one **Post-process meeting with LLM** switch for the meeting title,
summary and automatic speaker names, plus an enabled chat model in the
transcription region and optional instructions. The switch defaults to on;
upgrading preserves either previous title/summary opt-out. Disabling it sends no
automatic notes request. Local recordings and ephemeral dictation never generate cloud notes.

Saved cloud transcripts without a summary offer **Summarize** in the
header toolbar. The title, summary and transcript share one bounded reading column.
This runs title, summary and speaker naming once using the current notes model
and instructions, even when automatic post-processing is off. It leaves that
setting unchanged. The button waits for speaker processing, shows progress,
allows retry after failure and disappears after success. Concurrent clicks share
one request; deleting the recording cancels a pending request.

Notes wait for every input's speaker pass and the final transcript and workspace
copies to finish saving. Only then does the UI show summary generation in progress.
They use the existing server and paid chat endpoint with a fresh organisation
opt-in check, and count toward normal model
usage. The default is OpenAI Luna in the same region, including when the catalog
marks Luna as a reasoning model. Settings displays the resolved model name.
If Luna is unavailable, the user must enable it or explicitly select another
model. A selected unavailable model fails without silently switching models or
regions. Responses must contain complete JSON with the requested
fields. Failures leave the transcript intact. A manual rename during generation
is preserved. Speaker names require a known speaker ID and an exact quote from
that speaker containing the proposed name. The model is instructed to use only
explicit self-identification; uncertain identities retain their existing labels.
Manual speaker names are preserved. Summary prose uses known personal names,
not internal speaker IDs. Unknown references trigger at most one corrective
request for neutral wording; a second invalid response is not saved. Existing
summary IDs resolve to stored personal names on reopen and in subsequent edits
and workspace exports. Summary text appears above the transcript and is included in JSON,
Markdown and managed workspace copies; TXT and SRT remain verbatim.

OpenWhispr's [capture timeline](https://github.com/OpenWhispr/openwhispr/blob/f2a269646075ab4a82b86f08802aeaf315191520/src/helpers/meetingAudioTimeline.js),
[segment reducer](https://github.com/OpenWhispr/openwhispr/blob/f2a269646075ab4a82b86f08802aeaf315191520/src/stores/meetingSegmentReducer.ts)
and separation of meeting and dictation routing informed this review. No
OpenWhispr implementation code was copied.

Deploy the companion model-api gateway change before the desktop release.
Regression tests cover delayed input ordering, source-label preservation,
speaker failure, notes controls, cancellation, manual names and export updates.
Before release, make a real microphone plus system-audio call, stop it, and
verify turn order, refined speakers and notes. Repeat with local transcription
and with post-processing off. Synthetic tests and component previews do
not replace this live provider check.

## Meeting detection

Google Meet supports both `/<code>` and `/meet/<code>` URLs. Recognized browser
meeting metadata can offer a recording even when joining muted. On macOS the
helper examines browser windows independently of microphone activity, using
window titles when Accessibility metadata is unavailable. Sustained browser
microphone activity can offer a generic Browser call prompt if the provider
cannot be identified. This can also prompt for other browser microphone uses.
Detection always offers a prompt; it never starts recording automatically.

## OSS implementation review, 27 October 2026

Reviewed source and tests rather than treating advertised features as proof:

- [Hyprnote, now Anarlog: batch diarization](https://github.com/fastrepl/anarlog/blob/7165aba8974c2c3ff4cfda34846027b4e0e1d7a9/crates/listener2-core/src/batch/diarize.rs)
  preserves microphone/remote channel context and performs post-recording
  diarization. Its [local pipeline](https://github.com/fastrepl/anarlog/blob/7165aba8974c2c3ff4cfda34846027b4e0e1d7a9/crates/pyannote-local/src/pipeline.rs)
  uses segmentation, clean-speech embeddings and whole-session clustering.
  Its [browser detection tests](https://github.com/fastrepl/anarlog/blob/7165aba8974c2c3ff4cfda34846027b4e0e1d7a9/crates/detect/src/meeting_ax/tests/browser_detection.rs)
  combine window URLs, titles and bounded call-control checks.
- [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit/blob/eb92c115ee7abc1e161b0b2159da31785b0f5566/whisperlivekit/diarization/sortformer_backend.py)
  retains Sortformer state per session. Its speaker-boundary tests preserve
  words despite speaker revisions and retrograde timestamps. The default
  checkpoint has four speaker channels and requires the Python/NeMo stack.
- [WhisperX](https://github.com/m-bain/whisperX/blob/5d3678b8535698a2826a5db9eb3e4105aef85dd9/whisperx/diarize.py)
  assigns aligned words by temporal overlap with whole-recording pyannote
  diarization. It is a quality reference, not an Electron drop-in library.
- [OpenWhispr settings](https://github.com/OpenWhispr/openwhispr/blob/6408cd9a1081dc4935706fcbba6aaeae1d2cd18d/src/components/settings/MeetingSettings.tsx)
  do expose a general diarization switch. Its local CAM++ embeddings and
  post-recording reconciliation are the relevant implementation patterns.
- Meetily's public community code includes capture and summaries, but
  [speaker diarization is a Pro feature](https://meetily.ai/speaker-diarization).
  It was excluded as an open-source diarization implementation.

No upstream implementation code was copied. These projects establish useful
patterns, not measured accuracy on LegalWork recordings. This change uses the
existing local embedding runtime and cloud word alignment; it does not claim to
implement Anarlog's complete clustering pipeline or WhisperX.

Local replay of cached real provider responses and saved PCM on all three test
recordings produced two input labels, zero unassigned segments, unchanged words
in order, and paragraphs within 30 seconds/599 characters. Fresh transcription
coverage of the longest recording remains partial (35 minutes microphone,
21 minutes system audio). A controlled one-input sequence assembled from both
real voices retained two final identities, with an early misassignment in one
sequence. This is not a human-annotated diarization accuracy benchmark.
