/** A missing or ambiguous source is never permission to capture another app. */
export function windowCaptureSource(sources, origin) {
  if (!origin?.window) return null;
  const matches = sources.filter(source => !/LegalWork/i.test(source.name) && source.name === origin.window);
  return matches.length === 1 ? matches[0] : null;
}
