// Open the local /docx-performance.html?pages=30&run=unique harness, then run:
// playwright-cli run-code --filename=apps/app/scripts/docx-performance-check.js
// Repeat with pages=100. Compare builds using the same browser/CPU settings, with
// no concurrent benchmark or build. No latency gate is imposed across hardware.
// The 93-character sample uses real keyboard events at 70ms intervals after warmup.
// Double-rAF latency is a rendering-opportunity proxy, not exact display latency;
// Event Timing includes only >=16ms events, and long tasks are >=50ms.
async (page) => {
  const address = new URL(page.url());
  if (!/^https?:$/.test(address.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
    || !address.pathname.endsWith("/docx-performance.html")) {
    throw new Error("Open the local DOCX performance harness before running this check.");
  }
  const requestedPages = address.searchParams.get("pages") === "100" ? 100 : 30;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await page.waitForFunction(() => document.querySelector(".layout-page")
    || document.body.textContent.includes("Recover your unsaved draft?"), null, { timeout: 60000 });
  const discard = page.getByRole("button", { name: "Discard draft and open file", exact: true });
  if (await discard.isVisible()) await discard.click();
  await page.locator(".layout-page").first().waitFor({ timeout: 60000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForTimeout(1500);

  const pages = page.locator(".paged-editor__pages");
  // The paginated editor's actual input DOM is offscreen. Use it to focus and
  // inspect the complete document; all changes enter through real keyboard events.
  const input = page.locator(".paged-editor__hidden-pm .ProseMirror");
  const readText = () => input.textContent();
  const expectText = async (expected) => {
    await page.waitForFunction((text) => document.querySelector(".paged-editor__hidden-pm .ProseMirror")
      ?.textContent === text, expected);
  };
  const hasText = async (expected) => {
    await page.waitForFunction((text) => document.querySelector(".paged-editor__hidden-pm .ProseMirror")
      ?.textContent.includes(text), expected);
  };
  const saveAndReopen = async (requiredText) => {
    // Save immediately after editing to exercise pending document synchronization.
    await page.getByRole("button", { name: "Save to workspace", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Document status"]')
      ?.textContent.includes("No unsaved changes · Saved to workspace"), null, { timeout: 60000 });
    const saved = await page.locator('[aria-label="Saved DOCX text"]').textContent();
    for (const text of requiredText) {
      if (!saved.includes(text)) throw new Error(`Saved DOCX lost text: ${text}`);
    }
    if ([...saved.matchAll(/Section \d+:/g)].length !== requestedPages) {
      throw new Error("Saving lost or duplicated contract sections");
    }
    await page.getByRole("button", { name: "Reopen saved copy", exact: true }).click();
    await page.locator(".layout-page").first().waitFor({ timeout: 60000 });
    for (const text of requiredText) await hasText(text);
  };

  await pages.getByText("Section 1: Services and obligations", { exact: true }).click();
  await page.keyboard.press("Home");
  await page.keyboard.type("Warm up. ", { delay: 60 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__docxPerf.reset());
  const sample = "Typing should feel immediate, even in a long agreement. Every character must survive saving. ";
  await page.keyboard.type(sample, { delay: 70 });
  await page.waitForTimeout(300);
  await page.waitForFunction((count) => window.__docxPerf.report().keydownToSecondFrameMs.count === count, sample.length);
  const metrics = await page.evaluate(() => window.__docxPerf.report());
  const renderedPages = await page.locator(".layout-page").count();
  console.log("DOCX_TYPING_METRICS", JSON.stringify({ requestedPages, renderedPages, sampleCharacters: sample.length, keyDelayMs: 70, ...metrics }));
  await page.screenshot({ path: `output/playwright/docx-performance-${requestedPages}.png` });

  // Keep undo in a separate history group from the measured typing sample.
  await page.waitForTimeout(600);
  const beforeUndo = await readText();
  const undoMarker = "UNDO_REDO_CHECK ";
  await page.keyboard.type(undoMarker, { delay: 35 });
  const afterRedo = await readText();
  if (!afterRedo.includes(undoMarker)) throw new Error("Undo/redo marker was not inserted");
  await page.keyboard.press("ControlOrMeta+z");
  await expectText(beforeUndo);
  await page.keyboard.press("ControlOrMeta+y");
  await expectText(afterRedo);

  const paragraphs = await input.locator(":scope > p").count();
  await page.keyboard.press("Enter");
  await page.waitForFunction((count) => document.querySelectorAll(".paged-editor__hidden-pm .ProseMirror > p").length === count + 1, paragraphs);
  await page.keyboard.press("Backspace");
  await page.waitForFunction((count) => document.querySelectorAll(".paged-editor__hidden-pm .ProseMirror > p").length === count, paragraphs);
  await expectText(afterRedo);

  // Distant pages are virtualized. Navigate through the editor instead of trying
  // to click a final-page heading which is not mounted in the rendered DOM yet.
  await page.keyboard.press("ControlOrMeta+End");
  const lastPageMarker = "FINAL_PAGE_CHECK ";
  await page.keyboard.type(lastPageMarker, { delay: 70 });
  if (!(await readText()).endsWith(lastPageMarker)) throw new Error("Final-page marker was not inserted at the end of the document");
  const directEdits = [sample.trim(), undoMarker.trim(), lastPageMarker.trim()];
  await saveAndReopen(directEdits);

  await page.getByTitle("Editing (Ctrl+Shift+E)", { exact: true }).click();
  await page.getByText("Suggesting", { exact: true }).click();
  await page.getByTitle("Suggesting (Ctrl+Shift+E)", { exact: true }).waitFor();
  await input.focus();
  await page.keyboard.press("ControlOrMeta+Home");
  const suggestedMarker = "SUGGESTED_CHECK ";
  await page.keyboard.type(suggestedMarker, { delay: 70 });
  await saveAndReopen([...directEdits, suggestedMarker.trim()]);
  const revisions = pages.locator("[data-revision-id]");
  if (await revisions.count() === 0) throw new Error("Suggested insertion lost its tracked-change mark after save/reopen");
  const revisionText = (await revisions.allTextContents()).join("");
  if (!revisionText.includes(suggestedMarker.trim())) {
    throw new Error("Suggested insertion was saved as an ordinary edit");
  }
  await revisions.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `output/playwright/docx-performance-${requestedPages}-saved-suggestion.png` });
  console.log("DOCX_TYPING_CORRECTNESS", JSON.stringify({ requestedPages, undoRedo: true, enterBackspace: true, lastPageTyping: true, directEditSaveReopen: true, suggestedEditSaveReopen: true }));
}
