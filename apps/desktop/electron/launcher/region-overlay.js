const rect = () => document.getElementById("rect");
const size = () => document.getElementById("size");
let start = null;
function draw(x, y) {
  const right = Math.max(0, Math.min(window.innerWidth, x));
  const bottom = Math.max(0, Math.min(window.innerHeight, y));
  const box = { x: Math.min(start.x, right), y: Math.min(start.y, bottom), width: Math.abs(right - start.x), height: Math.abs(bottom - start.y) };
  Object.assign(rect().style, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
  Object.assign(size().style, { left: `${Math.min(box.x, Math.max(0, window.innerWidth - size().offsetWidth - 8))}px`,
    top: `${Math.min(box.y + box.height + 6, window.innerHeight - 26)}px` });
  window.regionOverlay.measure(box);
  return box;
}
window.addEventListener("DOMContentLoaded", () => {
  if (navigator.language.toLowerCase().startsWith("de")) {
    document.documentElement.lang = "de";
    document.title = "Bildschirmbereich aufnehmen";
    document.getElementById("hint").textContent = "Bereich mit der Maus auswählen · Esc zum Abbrechen";
  }
  window.regionOverlay.onSize(({ width, height }) => {
    if (!start) return;
    size().style.display = "block";
    size().textContent = `${width} × ${height} px`;
  });
  document.addEventListener("keydown", event => { if (event.key === "Escape") window.regionOverlay.cancel(); });
  document.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    start = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    document.body.setPointerCapture(event.pointerId);
  });
  document.addEventListener("pointermove", event => { if (start?.pointerId === event.pointerId) draw(event.clientX, event.clientY); });
  document.addEventListener("pointerup", event => {
    if (start?.pointerId !== event.pointerId) return;
    const box = draw(event.clientX, event.clientY);
    start = null;
    if (box.width < 4 || box.height < 4) { rect().style.display = "none"; size().style.display = "none"; return; }
    window.regionOverlay.select(box);
  });
  document.addEventListener("pointercancel", () => window.regionOverlay.cancel());
  document.addEventListener("contextmenu", event => { event.preventDefault(); window.regionOverlay.cancel(); });
});
