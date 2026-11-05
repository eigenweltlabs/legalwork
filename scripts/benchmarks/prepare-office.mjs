import { chmod, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateWrite, sha256 } from "./evidence.mjs";
import { makeOfficePresentation, makeOfficeWorkbook } from "./office-fixtures.mjs";

/** Prepare once on the controller. Only the two Office inputs are staged into
 * task directories; suites, hashes, helper code and criteria remain outside. */
export async function prepareOffice(output) {
  const root = resolve(output); await mkdir(root, { mode: 0o700 });
  const inputs = join(root, "inputs"); await mkdir(inputs, { mode: 0o700 });
  const workbook = makeOfficeWorkbook(), presentation = makeOfficePresentation();
  const workbookPath = join(inputs, "settlement.xlsx"), presentationPath = join(inputs, "briefing.pptx");
  // Mode 0600 permits the task's copied file to be saved by its ordinary editor.
  // Controller byte hashes pin the originals; no agent can access this folder.
  await privateWrite(workbookPath, workbook); await privateWrite(presentationPath, presentation);
  const interest = 128000 * 0.06 * 90 / 365;
  const cells = {
    "Settlement!B2": { value: 128000 },
    "Settlement!B5": { formula: "B2*B3*B4/365", value: interest },
    "Settlement!B6": { formula: "SUM(B2,B5)", value: 128000 + interest },
    "Settlement!B8": { formula: "ROUND(B2*B3*B4/365,2)", value: 1893.7 },
    "Settlement!B9": { formula: "SUM(B2,B8)", value: 129893.7 },
    "Settlement!B10": { formula: "B9+Sources!B3", value: 132393.7 },
    "Sources!B5": { formula: "Settlement!B2+B3", value: 130500 },
  };
  const suite = { id: "legalwork-inapp-office-saved-outcomes-v1", model: { providerID: "benchmark", modelID: "Eigenwelt Europe Gemini", backendModel: "gemini-3.8-flash", variant: "medium" },
    interactionPolicy: { mode: "autonomous", expectedPermissions: [], expectedForms: [] },
    coverage: { implemented: ["synthetic two-sheet formula/cache/preservation criteria", "synthetic presentation text/layout/slide-addition and original notes/media preservation criteria", "exact successful in-app tool results required alongside saved files"], pending: ["actual real-model runs in both isolated packaged arms", "physical close/reopen UI observation until afterPrompt hook is wired", "external Microsoft add-in Excel structural edits and PowerPoint notes editing"] },
    tasks: [
      { id: "live-excel", copyFiles: [{ from: workbookPath, to: "settlement.xlsx" }],
        beforePrompt: [{ actionId: "documents.open", args: { sessionId: "{{SESSION_ID}}", path: "{{TASK_PATH}}/settlement.xlsx", show: true } }],
        prompt: "Use the open settlement.xlsx in LegalWork's live spreadsheet editor. Read its two existing sheets, Settlement and Sources. Apply the signed amendment principal from Sources!B2 to Settlement!B2. Within the existing grid, enter these formulas: Settlement!B8 =ROUND(B2*B3*B4/365,2), B9 =SUM(B2,B8), and B10 =B9+Sources!B3. Keep the existing formulas, sheets, unrelated cells and formatting. Save the existing workbook, read back Settlement!B8:B10 through the live spreadsheet tools to verify the calculated results, and report them. Do not substitute constants for formulas or use file/code editing for these supported live operations.",
        artifacts: ["settlement.xlsx"], assertions: [
          { id: "completed-without-owned-error", type: "agent.no_error", scope: "subtree" },
          { id: "actual-live-spreadsheet-read-write-and-calculated-read", type: "capability.office", scope: "subtree", format: "xlsx", path: "settlement.xlsx", operations: [
            { tool: "inapp_xlsx_read", input: { sheet: "Sources" }, result: { success: true } },
            { tool: "inapp_xlsx_write", input: { sheet: "Settlement" }, result: { success: true, saved: true } },
            { tool: "inapp_xlsx_read", afterEdits: true, input: { sheet: "Settlement", range: "B8:B10" }, result: { success: true, data: { values: [[1893.7], [129893.7], [132393.7]] } } },
          ] },
          { id: "saved-formulas-calculated-caches-and-original-workbook-preserved", type: "artifact.office_xlsx", path: "settlement.xlsx", sourcePath: workbookPath, sourceSha256: sha256(workbook), cells, preserveParts: ["xl/styles.xml", "xl/theme/theme1.xml"] },
          { id: "same-workbook-open", type: "ui.document_open", path: "settlement.xlsx" },
        ] },
      { id: "live-ppt", copyFiles: [{ from: presentationPath, to: "briefing.pptx" }],
        beforePrompt: [{ actionId: "documents.open", args: { sessionId: "{{SESSION_ID}}", path: "{{TASK_PATH}}/briefing.pptx", show: true } }],
        prompt: "Edit the open briefing.pptx using LegalWork's live presentation tools. Read the presentation and its existing design first. On the first slide, replace the title 'Renewal risk — draft' with 'Renewal risk — approved' and replace 'Current notice: 30 calendar days.' with 'Current notice: 45 calendar days.' Set only that title's font size to 36 CSS slide pixels while preserving its position and other layout. Append a third slide by copying the second slide's design; use title 'Next steps' and body 'Send renewal notice.\nRetain the signed amendment.' Preserve both original slides' other content, speaker notes, theme, footer and logo. Save the existing file, read the final presentation, and preview the two changed/added slides after finishing their edits. Do not use file/code editing for these supported live operations; do not edit speaker notes in this scenario.",
        artifacts: ["briefing.pptx"], assertions: [
          { id: "completed-without-owned-error", type: "agent.no_error", scope: "subtree" },
          { id: "actual-live-presentation-edit-layout-add-and-read", type: "capability.office", scope: "subtree", format: "pptx", path: "briefing.pptx", operations: [
            { tool: "inapp_pptx_read_presentation", input: {}, result: { success: true } },
            { tool: "inapp_pptx_read_presentation", afterEdits: true, input: {}, result: { success: true } },
            { tool: "inapp_pptx_replace_text", input: { slideIndex: 0, search: "Renewal risk — draft", replaceWith: "Renewal risk — approved" }, result: { success: true, saved: true } },
            { tool: "inapp_pptx_replace_text", input: { slideIndex: 0, search: "Current notice: 30 calendar days.", replaceWith: "Current notice: 45 calendar days." }, result: { success: true, saved: true } },
            { tool: "inapp_pptx_update_layout", input: { slideIndex: 0, fontSize: 36 }, result: { success: true, saved: true } },
            { tool: "inapp_pptx_add_slide", input: { templateSlideIndex: 1, insertIndex: 2 }, result: { success: true, saved: true } },
            { tool: "inapp_pptx_preview", afterEditsForSlide: 0, input: { slideIndex: 0 }, result: { success: true } },
            { tool: "inapp_pptx_preview", afterEditsForSlide: 2, input: { slideIndex: 2 }, result: { success: true } },
          ] },
          { id: "saved-slide-text-layout-addition-and-original-notes-preserved", type: "artifact.office_pptx", path: "briefing.pptx", sourcePath: presentationPath, sourceSha256: sha256(presentation), slideCount: 3,
            slides: [{ includes: ["Renewal risk — approved", "Current notice: 45 calendar days.", "Confidential synthetic client briefing"], title: "Renewal risk — approved", titleFontSizeHundredthsPoint: 2700 }, { includes: ["Action checklist", "Verify signed amendment.", "Preserve source records."] }, { includes: ["Next steps", "Send renewal notice.", "Retain the signed amendment.", "Confidential synthetic client briefing"] }],
            changedShapes: [{ slideIndex: 0, name: "Title", allow: ["text", "fontSizes"] }, { slideIndex: 0, name: "Body", allow: ["text"] }], preserveParts: ["ppt/theme/theme1.xml", "ppt/media/logo.png"] },
          { id: "same-presentation-open", type: "ui.document_open", path: "briefing.pptx" },
        ] },
    ] };
  await privateWrite(join(root, "suite.json"), suite);
  const receipt = { schemaVersion: 1, status: "prepared-not-real-agent-executed", createdAt: new Date().toISOString(), paidModelCalls: 0,
    inputs: [{ path: workbookPath, bytes: workbook.length, sha256: sha256(workbook) }, { path: presentationPath, bytes: presentation.length, sha256: sha256(presentation) }],
    controllerCode: await Promise.all(["prepare-office.mjs", "office-fixtures.mjs", "office-evidence.mjs"].map(async name => ({ path: `scripts/benchmarks/${name}`, sha256: sha256(await readFile(new URL(name, import.meta.url))) }))),
    guestInputs: ["settlement.xlsx", "briefing.pptx", "ordinary task prompts"], controllerOnly: ["suite/assertions", "source hashes", "generators", "saved-file readers", "actual tool-result evidence helpers"],
    inheritedLimits: ["In-app Excel edits existing grid and sheet structure; this scenario uses two existing sheets.", "In-app PowerPoint has no speaker-notes editing tool; this scenario preserves notes. External Microsoft add-in notes editing remains a separate criterion."],
    unproved: ["Actual in-app model completion, native calculations and visual review in each arm.", "Physical close/reopen until the ordinary UI afterPrompt hook is integrated.", "Native Code Mode child service outcomes without the full public tool observer result capture."], newCapabilities: false, newProductLimits: false, sourceSkillSelectionsModified: false };
  await privateWrite(join(root, "fixture-receipt.json"), receipt); await chmod(join(root, "suite.json"), 0o400); await chmod(join(root, "fixture-receipt.json"), 0o400);
  return { root, suite, suitePath: join(root, "suite.json"), receiptSha256: sha256(await readFile(join(root, "fixture-receipt.json"))) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--output"); if (index < 0 || !process.argv[index + 1]) throw new Error("--output <NEW-controller-only-directory> is required");
  const result = await prepareOffice(process.argv[index + 1]); console.log(JSON.stringify({ root: result.root, suite: result.suitePath, receiptSha256: result.receiptSha256, modelCalls: 0 }));
}
