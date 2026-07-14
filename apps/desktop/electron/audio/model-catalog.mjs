/**
 * Catalog of local speech-to-text models for the Recorder.
 *
 * All models run fully on-device through sherpa-onnx. Files are plain HTTPS
 * downloads from Hugging Face (`resolve/main` links), one file at a time —
 * no archives to unpack. Sizes are display estimates; the downloader trusts
 * Content-Length for progress.
 *
 * Model lineup mirrors what MacWhisper offers, from "tiny and cheap" to
 * "large and accurate", including NVIDIA Parakeet TDT 0.6b v3 (the fast
 * multilingual model MacWhisper Premium ships) which covers 25 European
 * languages including German, and Whisper large-v3 as the top-accuracy option.
 * All Whisper entries here are the multilingual variants, so English and German
 * both work on every model.
 */

const HF = "https://huggingface.co";

function whisperFiles(name) {
  const repo = `${HF}/csukuangfj/sherpa-onnx-whisper-${name}/resolve/main`;
  return [
    { name: "encoder.int8.onnx", url: `${repo}/${name}-encoder.int8.onnx` },
    { name: "decoder.int8.onnx", url: `${repo}/${name}-decoder.int8.onnx` },
    { name: "tokens.txt", url: `${repo}/${name}-tokens.txt` },
  ];
}

/**
 * Four lawyer-facing tiers (see apps/app/.../recorder/model-tiers.ts for the
 * friendly names). The middle "standard" and "premium" models are both far
 * more accurate than Whisper Base/Turbo on CPU for German legal audio, so the
 * old Base/Turbo entries were dropped. `plan: "premium"` marks a gated tier;
 * `requiresFastDevice` additionally holds the heaviest model back to capable
 * machines.
 *
 * @type {import("@legalwork/types/audio").AudioModelCatalogEntry[]}
 */
export const AUDIO_MODEL_CATALOG = [
  {
    id: "whisper-tiny",
    label: "Super small",
    description: "Only use this if your machine is very slow.",
    kind: "whisper",
    tier: "fastest",
    plan: "free",
    languages: "multilingual",
    approxSizeBytes: 105 * 1024 * 1024,
    files: whisperFiles("tiny"),
  },
  {
    id: "whisper-small",
    label: "Basic",
    description: "Balanced accuracy.",
    kind: "whisper",
    tier: "balanced",
    plan: "free",
    languages: "multilingual",
    approxSizeBytes: 440 * 1024 * 1024,
    files: whisperFiles("small"),
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "Premium",
    description:
      "Best accuracy and real-time fast, on device. English and German with automatic punctuation.",
    kind: "nemo-transducer",
    tier: "accurate",
    plan: "premium",
    languages: "multilingual",
    approxSizeBytes: 672 * 1024 * 1024,
    recommended: true,
    files: [
      {
        name: "encoder.int8.onnx",
        url: `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/encoder.int8.onnx`,
      },
      {
        name: "decoder.int8.onnx",
        url: `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/decoder.int8.onnx`,
      },
      {
        name: "joiner.int8.onnx",
        url: `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/joiner.int8.onnx`,
      },
      {
        name: "tokens.txt",
        url: `${HF}/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/main/tokens.txt`,
      },
    ],
  },
  {
    id: "whisper-large-v3",
    label: "Maximum",
    description:
      "Highest accuracy for demanding audio. Slower than Premium and needs a powerful, recent computer.",
    kind: "whisper",
    tier: "best",
    plan: "premium",
    languages: "multilingual",
    // ~1.7 GB across encoder (731 MB) + decoder (961 MB) + tokens.
    approxSizeBytes: 1694 * 1024 * 1024,
    requiresFastDevice: true,
    files: whisperFiles("large-v3"),
  },
];

/**
 * Silero VAD — segments speech before decoding, exactly like MacWhisper's
 * live captions. Small enough to download alongside any model.
 */
export const VAD_MODEL = {
  fileName: "silero_vad.onnx",
  url: `${HF}/csukuangfj/vad/resolve/main/silero_vad.onnx`,
  approxSizeBytes: 1.9 * 1024 * 1024,
};

/**
 * Speaker diarization ("who said what") — fully on-device via sherpa-onnx:
 * pyannote segmentation 3.0 + a 3D-Speaker CAM++ embedding extractor. Runs as
 * a finalize pass over a recording's audio. Downloaded on demand (~36 MB)
 * only when the user turns on "Identify speakers".
 */
export const DIARIZATION_MODELS = {
  approxSizeBytes: 36 * 1024 * 1024,
  segmentation: {
    fileName: "segmentation.onnx",
    url: `${HF}/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx`,
  },
  embedding: {
    fileName: "embedding.onnx",
    url: `${HF}/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx`,
  },
};

export function findAudioModel(modelId) {
  return AUDIO_MODEL_CATALOG.find((entry) => entry.id === modelId) ?? null;
}
