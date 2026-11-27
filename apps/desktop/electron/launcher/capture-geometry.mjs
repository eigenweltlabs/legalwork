/** A thumbnail without an ID is safe only when there is one possible display. */
export function displayCaptureSource(sources, displayId, displayCount) {
  const matches = sources.filter(source => source.display_id === String(displayId));
  if (matches.length === 1) return matches[0];
  if (displayCount === 1 && sources.length === 1 && !sources[0].display_id) return sources[0];
  return null;
}

export function capturePixelRect(rect, display, image) {
  const scaleX = image.width / display.width;
  const scaleY = image.height / display.height;
  const left = Math.max(0, Math.floor(rect.x * scaleX));
  const top = Math.max(0, Math.floor(rect.y * scaleY));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width) * scaleX));
  const bottom = Math.min(image.height, Math.ceil((rect.y + rect.height) * scaleY));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
