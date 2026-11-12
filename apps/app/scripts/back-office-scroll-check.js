// Run with playwright-cli run-code on an open Back Office table with at least three screens of rows.
async page => {
  const grid = page.locator(".bo-grid-scroll[role=grid]:visible").first();
  return grid.evaluate(async table => {
    const header = table.querySelector(".bo-grid-header");
    const body = table.querySelector(".bo-grid-row")?.parentElement;
    if (!header || !body) throw new Error("Open a populated Back Office table.");
    const viewport = table.clientHeight - header.offsetHeight;
    if (body.offsetHeight < viewport * 3) throw new Error("Use a table with at least three screens of rows.");
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const previous = table.scrollTop;
    let tested = 0;
    let worstGap = 0;
    function uncoveredPixels() {
      const rect = table.getBoundingClientRect();
      const bounds = body.getBoundingClientRect();
      const bottom = Math.min(bounds.bottom, rect.top + table.clientHeight);
      let coveredTo = Math.max(bounds.top, rect.top + header.offsetHeight);
      let missing = 0;
      for (const row of body.children) {
        const { top, bottom: end } = row.getBoundingClientRect();
        if (end <= coveredTo || top >= bottom) continue;
        missing += Math.max(0, top - coveredTo);
        coveredTo = end;
      }
      return missing + Math.max(0, bottom - coveredTo);
    }
    try {
      table.scrollTop = 0;
      await frame();
      await frame();
      for (let pass = 0; pass < 3; pass++) {
        for (const delta of [0.7, 0.9, 1.1, 0.8, -0.9, -1.1, -1.1, 0.7, 0.9, -1.1, -0.8, -0.8]) {
          const from = table.scrollTop;
          table.scrollTop += Math.round(delta * viewport);
          if (table.scrollTop === from) continue;
          // The compositor can expose this area before React handles the scroll event.
          worstGap = Math.max(worstGap, uncoveredPixels());
          await frame();
          worstGap = Math.max(worstGap, uncoveredPixels());
          tested++;
        }
      }
      if (worstGap > 1) throw new Error(`Scrolling exposed ${Math.round(worstGap)} empty pixels.`);
      return { records: Number(table.getAttribute("aria-rowcount")) - 1, tested, worstGap };
    } finally {
      table.scrollTop = previous;
    }
  });
}
