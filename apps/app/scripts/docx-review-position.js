// Run with playwright-cli run-code --filename=apps/app/scripts/docx-review-position.js
// after opening /docx-review.html?fixture=positions on the local preview server.
async (page) => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/docx-review\.html\?fixture=positions$/.test(page.url())) {
    throw new Error("Open the synthetic DOCX positioning fixture first.");
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".layout-page")
    || document.body.textContent.includes("Recover your unsaved draft?"));
  const discard = page.getByRole("button", { name: "Discard draft and open file" });
  if (await discard.isVisible()) await discard.click();
  await page.waitForFunction(() => document.querySelectorAll(".layout-page").length === 3);
  const mark = (id) => page.locator(`.paged-editor__pages [data-revision-id="${id}"]`);
  const card = page.locator("[data-docx-review-anchor] .docx-tracked-change-card");
  const check = async (id) => {
    await page.waitForFunction((revisionId) => {
      const m = document.querySelector(`.paged-editor__pages [data-revision-id="${revisionId}"]`);
      const c = document.querySelector("[data-docx-review-anchor] .docx-tracked-change-card");
      const v = document.querySelector(".docx-editor__scroll-container");
      if (!m || !c || !v || getComputedStyle(c).visibility !== "visible") return false;
      const a = m.getBoundingClientRect(), b = c.getBoundingClientRect(), bounds = v.getBoundingClientRect();
      const gap = Math.max(0, b.top - a.bottom, a.top - b.bottom);
      const overlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      return gap <= 13 && overlap < 1 && b.left >= bounds.left && b.right <= bounds.right
        && b.top >= bounds.top && b.bottom <= bounds.bottom
        && Math.abs(b.width - Math.min(340, v.clientWidth - 24)) < 1;
    }, id, { timeout: 5000 });
    const reviewer = `Reviewer ${Math.floor((id - 100) / 2) + 1}`;
    if (!(await card.getByText(reviewer, { exact: true }).isVisible())) throw new Error("The wrong revision card opened");
  };
  const select = async (id) => {
    await mark(id).click();
    await card.waitFor({ state: "visible" });
    await page.waitForTimeout(650);
    await check(id);
  };
  const center = async (id, nearBottom = false) => {
    await mark(id).evaluate((m, bottom) => {
      const v = m.closest(".docx-editor__scroll-container");
      const offset = bottom ? v.clientHeight - 32 : 200;
      v.scrollTop += m.getBoundingClientRect().top - v.getBoundingClientRect().top - offset;
    }, nearBottom);
    await check(id);
  };
  const screenshot = async (name) => {
    // Let the transient page-number badge fade before recording visual evidence.
    await page.waitForFunction(() => [...document.querySelectorAll('.docx-editor [role="status"][aria-live="polite"]')]
      .every((element) => Number(getComputedStyle(element).opacity) === 0));
    await page.screenshot({ path: `output/playwright/${name}.png` });
  };

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Narrow panel", exact: true }).click();
  await select(104);
  await center(104);
  await screenshot("table-card-620");
  // Following a scrolling page must not leave a floating card for offscreen text.
  const previousScroll = await page.locator(".docx-editor__scroll-container").evaluate((v) => {
    const before = v.scrollTop;
    v.scrollTop += 700;
    return before;
  });
  await card.waitFor({ state: "hidden" });
  await page.locator(".docx-editor__scroll-container").evaluate((v, top) => { v.scrollTop = top; }, previousScroll);
  await check(104);
  await center(104, true);
  await card.getByPlaceholder("Reply or add others with @").click();
  await card.getByPlaceholder("Reply or add others with @").fill("Position check");
  await check(104);
  await card.getByRole("button", { name: "Cancel", exact: true }).click();
  await check(104);
  await card.getByRole("button", { name: "Accept", exact: true }).click();
  await mark(104).waitFor({ state: "detached" });
  await mark(105).waitFor({ state: "detached" });
  await select(120);
  await center(120);

  await page.setViewportSize({ width: 420, height: 900 });
  await select(120);
  await center(120);
  await screenshot("table-card-420");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Expand document", exact: true }).click();
  await select(122);
  await center(122);
  await screenshot("table-card-expanded");
  await page.getByRole("button", { name: "Zoom out", exact: true }).click();
  await select(123);
  await center(123);
  await check(123);
}
