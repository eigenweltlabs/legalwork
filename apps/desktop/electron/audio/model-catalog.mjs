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
 * languages including German. All Whisper entries here are the multilingual
 * variants, so English and German both work on every model.
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

/** @type {import("@legalwork/types/audio").AudioModelCatalogEntry[]} */
export const AUDIO_MODEL_CATALOG = [
  {
    id: "whisper-tiny",
    label: "Whisper Tiny",
    description: "Smallest and lightest. Good for quick notes on low-power machines.",
    kind: "whisper",
    tier: "fastest",
    languages: "multilingual",
    approxSizeBytes: 105 * 1024 * 1024,
    files: whisperFiles("tiny"),
  },
  {
    id: "whisper-base",
    label: "Whisper Base",
    description: "Light and quick with noticeably better accuracy than Tiny.",
    kind: "whisper",
    tier: "fastest",
    languages: "multilingual",
    approxSizeBytes: 165 * 1024 * 1024,
    files: whisperFiles("base"),
  },
  {
    id: "whisper-small",
    label: "Whisper Small",
    description: "Solid everyday accuracy for English and German at moderate size.",
    kind: "whisper",
    tier: "balanced",
    languages: "multilingual",
    approxSizeBytes: 440 * 1024 * 1024,
    files: whisperFiles("small"),
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "Parakeet v3 (0.6B)",
    description:
      "NVIDIA Parakeet TDT — very fast with near large-model accuracy. 25 languages including English and German.",
    kind: "nemo-transducer",
    tier: "accurate",
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
    id: "whisper-turbo",
    label: "Whisper Large v3 Turbo",
    description: "Best transcription quality. Large download and heavier on CPU/RAM.",
    kind: "whisper",
    tier: "best",
    languages: "multilingual",
    approxSizeBytes: 870 * 1024 * 1024,
    files: whisperFiles("turbo"),
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

export function findAudioModel(modelId) {
  return AUDIO_MODEL_CATALOG.find((entry) => entry.id === modelId) ?? null;
}
