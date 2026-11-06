const rect = () => document.getElementById("rect");
const size = () => document.getElementById("size");
let start = null;
function draw(x, y) {
  const box = { x: Math.min(start.x, x), y: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
  Object.assign(rect().style, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
  Object.assign(size().style, { display: "block", left: `${box.x}px`, top: `${box.y + box.height + 6}px` });
  size().textContent = `${box.width} × ${box.height}`;
  return box;
}
window.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("keydown", event => { if (event.key === "Escape") window.regionOverlay.cancel(); });
  document.addEventListener("mousedown", event => { if (event.button === 0) start = { x: event.clientX, y: event.clientY }; });
  document.addEventListener("mousemove", event => { if (start) draw(event.clientX, event.clientY); });
  document.addEventListener("mouseup", event => {
    if (!start) return;
    const box = draw(event.clientX, event.clientY);
    start = null;
    if (box.width < 4 || box.height < 4) { rect().style.display = "none"; size().style.display = "none"; return; }
    window.regionOverlay.select(box);
  });
  document.addEventListener("contextmenu", event => { event.preventDefault(); window.regionOverlay.cancel(); });
});
