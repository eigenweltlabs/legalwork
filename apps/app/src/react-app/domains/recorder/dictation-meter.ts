export function dictationMeterLevel(samples: Float32Array): number {
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  const rms = samples.length ? Math.sqrt(squares / samples.length) : 0;
  // Subtract the noise floor so very quiet input approaches zero continuously.
  if (rms <= 0.0015) return 0;
  return 1 - Math.exp(-(rms - 0.0015) * 45);
}
