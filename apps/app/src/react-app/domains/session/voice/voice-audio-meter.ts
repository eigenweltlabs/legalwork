export type VoiceAudioFrame = { level: number; bands: number[] };
export const SILENT_VOICE_AUDIO: VoiceAudioFrame = { level: 0, bands: [0, 0, 0, 0, 0, 0] };

/** Read-only taps of the call's existing streams. Nothing is connected to the
 * speakers, recorded, or uploaded; the call retains ownership of its tracks. */
export function createVoiceAudioMeter() {
  let context: AudioContext;
  try { context = new AudioContext(); } catch { return null; }
  let disposed = false;
  const connect = (stream: MediaStream) => {
    if (disposed || !stream.getAudioTracks().length) return null;
    try {
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      void context.resume().catch(() => undefined);
      return { source, analyser, waveform: new Float32Array(1024), spectrum: new Uint8Array(512) };
    } catch { return null; }
  };
  type Channel = ReturnType<typeof connect>;
  let input: Channel = null, output: Channel = null;
  const frame: VoiceAudioFrame = { level: 0, bands: [0, 0, 0, 0, 0, 0] };
  const frequencies = [60, 180, 400, 800, 1600, 3200, 7000];
  const disconnect = (channel: Channel) => { channel?.source.disconnect(); channel?.analyser.disconnect(); };
  const read = (channel: Channel) => {
    if (!channel) return;
    channel.analyser.getFloatTimeDomainData(channel.waveform);
    let sum = 0;
    for (const value of channel.waveform) sum += value * value;
    const rms = Math.sqrt(sum / channel.waveform.length);
    // Gate room noise, then compress the range so quiet speech still reads well.
    const level = Math.min(1, Math.sqrt(Math.max(0, rms - 0.006) * 5.5));
    frame.level = Math.max(frame.level, level);
    if (!level) return;
    channel.analyser.getByteFrequencyData(channel.spectrum);
    const hzPerBin = context.sampleRate / channel.analyser.fftSize;
    for (let band = 0; band < 6; band++) {
      const from = Math.floor(frequencies[band] / hzPerBin);
      const to = Math.min(channel.spectrum.length, Math.max(from + 1, Math.ceil(frequencies[band + 1] / hzPerBin)));
      let energy = 0;
      for (let bin = from; bin < to; bin++) energy += channel.spectrum[bin];
      frame.bands[band] = Math.max(frame.bands[band], energy / ((to - from) * 255));
    }
  };
  return {
    setInputStream(stream: MediaStream) { disconnect(input); input = connect(stream); },
    setOutputStream(stream: MediaStream) { disconnect(output); output = connect(stream); },
    sample(inputEnabled = true, outputEnabled = true) {
      frame.level = 0;
      frame.bands.fill(0);
      if (!disposed && context.state === "running") {
        if (inputEnabled) read(input);
        if (outputEnabled) read(output);
      }
      return frame;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disconnect(input);
      disconnect(output);
      void context.close().catch(() => undefined);
    },
  };
}
