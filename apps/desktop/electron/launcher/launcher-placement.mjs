/** Keep a remembered position inside the display it was saved for, or fall back to the centre of the active display. */
export function placePanel(workArea, size, remembered) {
  const width = Math.min(size.width, workArea.width);
  const height = Math.min(size.height, workArea.height);
  const inside = remembered && remembered.x >= workArea.x - 8 && remembered.y >= workArea.y - 8 && remembered.x + width <= workArea.x + workArea.width + 8 && remembered.y + height <= workArea.y + workArea.height + 8;
  const x = inside ? remembered.x : workArea.x + Math.round((workArea.width - width) / 2);
  const y = inside ? remembered.y : workArea.y + Math.round(workArea.height * 0.18);
  return { x: Math.round(Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - width))), y: Math.round(Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - height))), width, height };
}

/** Compare with the current display's default, so saved default positions never show a reset control. */
export function panelWasMoved(workArea, bounds) {
  const origin = placePanel(workArea, bounds, null);
  return Math.abs(bounds.x - origin.x) > 2 || Math.abs(bounds.y - origin.y) > 2;
}
