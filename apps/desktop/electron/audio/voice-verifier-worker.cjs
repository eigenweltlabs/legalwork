"use strict";

const { VoiceVerifier } = require("./voice-verifier.cjs");
const port = process.parentPort ?? {
  postMessage: message => process.send?.(message),
  on: (_event, callback) => process.on("message", data => callback({ data })),
};
let verifier;
port.on("message", ({ data }) => {
  try {
    if (data.type === "finish") { port.postMessage({ result: verifier?.finish() ?? {} }); return; }
    if (!verifier) {
      const { SpeakerEmbeddingExtractor } = require("sherpa-onnx-node");
      verifier = new VoiceVerifier(new SpeakerEmbeddingExtractor({ model: data.model, numThreads: 2, provider: "cpu", debug: 0 }));
    }
    port.postMessage({ result: verifier.verify(data.audio, data.offsetMs, data.turns) });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
