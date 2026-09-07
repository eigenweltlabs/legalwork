// Run with playwright-cli run-code --filename=apps/app/scripts/docx-review-cards.js
// against /docx-review.html. Only the synthetic, in-memory fixture is modified.
async (page) => {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1):\d+\/docx-review\.html$/.test(page.url())) {
    throw new Error("Open the local DOCX review harness before running this check.");
  }
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".layout-page")
    || document.body.textContent.includes("Recover your unsaved draft?"));
  const discard = page.getByRole("button", { name: "Discard draft and open file" });
  if (await discard.isVisible()) await discard.click();
  const pages = page.locator(".paged-editor__pages");
  const card = page.locator(".docx-tracked-change-card");
  const accept = card.getByRole("button", { name: "Accept", exact: true });
  const revision = (id) => pages.locator(`[data-revision-id="${id}"]`);
  const dismiss = async () => {
    await pages.getByText("1. Definitions", { exact: true }).click();
    await accept.waitFor({ state: "hidden" });
  };
  const open = async (id) => {
    await revision(id).click();
    await accept.waitFor({ state: "visible" });
    // Exercise the deferred caret update that originally collapsed this card.
    await page.waitForTimeout(650);
    if (!(await accept.isVisible())) throw new Error(`Revision ${id} card collapsed after clicking`);
    const contained = await card.evaluate((element) => {
      const host = element.closest(".docx-host").getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.left >= host.left && rect.right <= host.right;
    });
    if (!contained) throw new Error("The selected review card is clipped by the editor panel");
  };

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Narrow panel", exact: true }).click();
  await open(1);
  await page.screenshot({ path: "output/playwright/tracked-card-620.png" });
  await dismiss();
  await open(2);
  await dismiss();
  await page.setViewportSize({ width: 420, height: 900 });
  await open(1);
  await page.screenshot({ path: "output/playwright/tracked-card-420.png" });
  await dismiss();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Expand document", exact: true }).click();
  await open(2);
  await page.screenshot({ path: "output/playwright/tracked-card-expanded.png" });
  await card.getByPlaceholder("Reply or add others with @").click();
  await card.getByPlaceholder("Reply or add others with @").fill("Checked both parts of this replacement.");
  await card.getByRole("button", { name: "Reply", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Document status"]')
    ?.textContent.includes("No unsaved changes · Saved to workspace"));
  await page.getByRole("button", { name: "Restore document panel", exact: true }).click();
  await page.getByRole("button", { name: "Reopen saved copy", exact: true }).click();
  await open(1);
  // The DOCX adapter persists revision replies as independent paragraph comments,
  // so accepting/rejecting the revision cannot delete the discussion.
  const reply = page.locator(".docx-comment-card").filter({ hasText: "Checked both parts of this replacement." });
  if (await reply.count() !== 1) {
    throw new Error("The tracked-change reply did not survive save/reopen");
  }

  await accept.click();
  await revision(1).waitFor({ state: "detached" });
  await revision(2).waitFor({ state: "detached" });
  await pages.getByText("Payment is due within 60 days of invoice.", { exact: true }).waitFor();
  // Reopen the saved review checkpoint to exercise Reject independently of Accept.
  await page.getByRole("button", { name: "Reopen saved copy", exact: true }).click();
  await open(2);
  await card.getByRole("button", { name: "Reject", exact: true }).click();
  await revision(1).waitFor({ state: "detached" });
  await revision(2).waitFor({ state: "detached" });
  await pages.getByText("Payment is due within 30 days of invoice.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Save to workspace", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Document status"]')
    ?.textContent.includes("No unsaved changes · Saved to workspace"));
  await page.getByRole("button", { name: "Reopen saved copy", exact: true }).click();
  await pages.getByText("Payment is due within 30 days of invoice.", { exact: true }).waitFor();
  if (await card.count()) throw new Error("The rejected revision reappeared after saving");
  if (await reply.count() !== 1) throw new Error("Rejecting the revision removed its discussion");
}
