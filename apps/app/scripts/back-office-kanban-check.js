// Run with playwright-cli run-code on a populated, editable Back Office Kanban.
// Cancel before release so the check never writes a record.
async page => {
  const board = page.locator(".bo-kanban:visible").first();
  return board.evaluate(async board => {
    const columns = [...board.querySelectorAll("[data-bo-drop]")];
    const visibleAt = element => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + Math.min(12, rect.width / 2);
      const y = rect.top + Math.min(12, rect.height / 2);
      return element.contains(document.elementFromPoint(x, y)) ? { x, y } : undefined;
    };
    const title = [...board.querySelectorAll("[data-draggable=true] .bo-record-title")].find(visibleAt);
    const origin = title?.closest("[data-bo-drop]");
    const destination = columns.find(column => column !== origin && visibleAt(column));
    if (!title || !origin || !destination || board.getAttribute("aria-busy") === "true") {
      throw new Error("Open an idle Kanban with a visible card and two visible columns.");
    }
    const start = visibleAt(title), end = visibleAt(destination);
    const send = (type, target, point) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, isPrimary: true, pointerId: 927, pointerType: "mouse",
      button: type === "pointerdown" ? 0 : -1, buttons: type === "pointercancel" ? 0 : 1,
      clientX: point.x, clientY: point.y,
    }));
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const previousDescriptor = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
    const elementFromPoint = document.elementFromPoint;
    let hitTests = 0;
    try {
      document.elementFromPoint = function (x, y) {
        hitTests++;
        return elementFromPoint.call(this, x, y);
      };
      send("pointerdown", title, start);
      const frames = 8, samples = 16;
      for (let step = 0; step < frames; step++) {
        for (let sample = 1; sample <= samples; sample++) {
          const t = (step * samples + sample) / (frames * samples);
          send("pointermove", window, { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
        }
        await frame();
      }
      if (!document.querySelector(".bo-pointer-drag-preview") || !destination.hasAttribute("data-bo-drag-over")) {
        throw new Error("The preview or the destination column did not follow the pointer.");
      }
      if (hitTests > frames) throw new Error(`${hitTests} hit tests for ${frames} frames`);
      return { cards: board.querySelectorAll(".bo-record-card").length, pointerMoves: frames * samples, frames, hitTests };
    } finally {
      if (previousDescriptor) Object.defineProperty(document, "elementFromPoint", previousDescriptor);
      else delete document.elementFromPoint;
      send("pointercancel", window, end);
      if (document.querySelector(".bo-pointer-drag-preview") || board.querySelector("[data-bo-drag-over]")) {
        throw new Error("Cancelling left a drag preview or highlighted column.");
      }
    }
  });
}
