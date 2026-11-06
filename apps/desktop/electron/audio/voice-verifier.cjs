"use strict";

const { SpeakerClusters } = require("./live-speakers.cjs");
const normalized = values => {
  const norm = Math.hypot(...values);
  return norm ? Float32Array.from(values, value => value / norm) : null;
};
const similarity = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);

// Compare actual voices, never request-scoped cloud speaker numbers. Each
// instance belongs to one input of one recording and retains no audio.
class VoiceVerifier {
  constructor(extractor) {
    this.extractor = extractor;
    this.clusters = new SpeakerClusters(0.4, 8);
    this.candidates = [];
  }

  verify(audio, offsetMs, turns) {
    const bytes = Buffer.from(audio);
    const labels = new Map();
    for (const turn of turns) {
      if (turn.speaker == null || turn.endMs - turn.startMs < 1500) continue;
      if (!labels.has(turn.speaker)) labels.set(turn.speaker, []);
      labels.get(turn.speaker).push(turn);
    }
    const matched = new Map();
    const corrections = [];
    const endMs = offsetMs + bytes.length / 32;
    this.candidates = this.candidates.filter(candidate => endMs - candidate.endMs <= 60000);
    for (const [label, runs] of labels) {
      // Pool several longer utterances. A single short phrase is too sensitive
      // to phonetics, background noise and the speaker's distance to the mic.
      const embeddings = [];
      let duration = 0;
      for (const turn of runs.sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs)).slice(0, 3)) {
        const start = Math.max(0, Math.round((turn.startMs - offsetMs) * 16));
        const end = Math.min(bytes.length / 2, Math.round((turn.endMs - offsetMs) * 16), start + 128000);
        if (end - start < 24000) continue;
        const samples = new Float32Array(end - start);
        for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE((start + i) * 2) / 32768;
        const stream = this.extractor.createStream();
        stream.acceptWaveform({ samples, sampleRate: 16000 });
        stream.inputFinished();
        if (!this.extractor.isReady(stream)) continue;
        const embedding = normalized(this.extractor.compute(stream, false));
        if (embedding) { embeddings.push(embedding); duration += samples.length / 16; }
      }
      if (!embeddings.length) continue;
      const voice = normalized(embeddings[0].map((_, i) => embeddings.reduce((sum, vector) => sum + vector[i], 0)));
      if (!voice) continue;
      let speaker = this.clusters.identify(voice, { allowNew: this.clusters.voices.length === 0 && duration >= 4000, adapt: duration >= 4000 });
      if (speaker == null && duration >= 6000) {
        const candidate = this.candidates.find(candidate => similarity(candidate.voice, voice) >= .5 && offsetMs >= candidate.endMs - 2000);
        if (candidate) {
          speaker = this.clusters.identify(voice, { allowNew: true });
          if (speaker != null) corrections.push(...candidate.turns.map(turn => ({ ...turn, speaker })));
          this.candidates = this.candidates.filter(item => item !== candidate);
        } else this.candidates.push({ voice, endMs, turns: turns.filter(turn => turn.speaker === label) });
      }
      matched.set(label, speaker);
    }
    return { turns: turns.map(turn => ({ ...turn, speaker: matched.get(turn.speaker) ?? null })), corrections };
  }

  finish() {
    // Longer voice profiles can resolve an early split caused by a short or
    // noisy introduction. Reconcile only acoustically similar identities.
    const aliases = {};
    for (let i = 1; i < this.clusters.voices.length; i++) {
      for (let j = 0; j < i; j++) {
        if (similarity(this.clusters.voices[i], this.clusters.voices[j]) < .5) continue;
        aliases[i] = aliases[j] ?? j;
        break;
      }
    }
    return aliases;
  }
}

module.exports = { VoiceVerifier };
