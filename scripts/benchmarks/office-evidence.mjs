// Controller-only saved-file and actual-tool evidence; never sent to an agent.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
const appRequire = createRequire(new URL("../../apps/app/package.json", import.meta.url));
const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const XLSX = appRequire("xlsx");
const { DOMParser } = appRequire("@xmldom/xmldom");
const { unzipSync } = serverRequire("fflate");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const formula = value => value?.replace(/^=/, "").replace(/\s/g, "").toUpperCase();
const archive = bytes => unzipSync(bytes);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const parse = bytes => new DOMParser().parseFromString(Buffer.from(bytes).toString(), "application/xml");
const nodes = (doc, name) => Array.from(doc.getElementsByTagNameNS("*", name));
const text = doc => nodes(doc, "t").map(node => node.textContent).join("\n");
const timestamp = value => typeof value === "number" ? value : Date.parse(value);
function inside(root, relative) {
  const resolved = path.resolve(root, relative), difference = path.relative(path.resolve(root), resolved);
  if (path.isAbsolute(relative) || difference === ".." || difference.startsWith(`..${path.sep}`)) throw new Error("Office artifact escapes its task directory.");
  return resolved;
}
function relationships(parts, part) {
  const filename = path.posix.join(path.posix.dirname(part), "_rels", `${path.posix.basename(part)}.rels`);
  if (!parts[filename]) return [];
  return nodes(parse(parts[filename]), "Relationship").filter(node => node.getAttribute("TargetMode") !== "External").map(node => ({
    id: node.getAttribute("Id"), type: node.getAttribute("Type").split("/").at(-1),
    part: path.posix.normalize(path.posix.join(path.posix.dirname(part), node.getAttribute("Target"))),
  }));
}
function shapeInfo(node) {
  const name = nodes(node, "cNvPr")[0]?.getAttribute("name"), transform = nodes(node, "xfrm")[0];
  const offset = transform && nodes(transform, "off")[0], extent = transform && nodes(transform, "ext")[0];
  return { name, text: text(node), x: offset?.getAttribute("x"), y: offset?.getAttribute("y"), width: extent?.getAttribute("cx"), height: extent?.getAttribute("cy"),
    fontSizes: [...new Set(nodes(node, "rPr").map(run => run.getAttribute("sz")).filter(Boolean))].sort() };
}
export function inspectOfficePresentation(bytes) {
  const parts = archive(bytes), presentation = "ppt/presentation.xml";
  const relations = relationships(parts, presentation);
  const slides = nodes(parse(parts[presentation]), "sldId").map(node => {
    const id = node.getAttribute("r:id"), part = relations.find(item => item.id === id && item.type === "slide")?.part;
    if (!part || !parts[part]) throw new Error("Presentation references a missing slide.");
    const doc = parse(parts[part]), notesPart = relationships(parts, part).find(item => item.type === "notesSlide")?.part;
    return { part, text: text(doc), shapes: nodes(doc, "sp").map(shapeInfo), notes: notesPart && parts[notesPart] ? text(parse(parts[notesPart])) : "" };
  });
  return { parts, slides };
}

export async function evaluateSavedOfficeArtifact(assertion, directory) {
  if (!/^[a-f0-9]{64}$/.test(assertion.sourceSha256) || typeof assertion.sourcePath !== "string") throw new Error("Pinned controller-only original Office bytes are required.");
  const source = await readFile(assertion.sourcePath), saved = await readFile(inside(directory, assertion.path));
  if (digest(source) !== assertion.sourceSha256) throw new Error("Frozen original Office input changed on the controller.");
  const mismatches = [];
  const mismatch = (test, detail) => { if (!test) mismatches.push(detail); };
  if (assertion.type === "artifact.office_xlsx") {
    const options = { type: "buffer", cellFormula: true, cellNF: true, cellStyles: true, sheetStubs: true };
    const before = XLSX.read(source, options), after = XLSX.read(saved, options);
    mismatch(equal(after.SheetNames, before.SheetNames), "Existing sheet names/order changed.");
    const changed = new Set(Object.keys(assertion.cells));
    for (const name of before.SheetNames) {
      const previous = before.Sheets[name], current = after.Sheets[name];
      if (!current) { mismatches.push(`Missing sheet: ${name}`); continue; }
      mismatch(current["!ref"] === previous["!ref"], `Existing grid extent changed: ${name}`);
      for (const [address, old] of Object.entries(previous)) {
        if (address.startsWith("!")) continue;
        const cell = current[address];
        mismatch(cell?.z === old.z, `Original number format changed: ${name}!${address}`);
        if (changed.has(`${name}!${address}`)) continue;
        mismatch(Boolean(cell) && formula(cell.f) === formula(old.f) && (old.f || equal(cell.v, old.v)),
          `Unrelated value/formula/number format changed: ${name}!${address}`);
      }
      for (const [address, cell] of Object.entries(current)) if (!address.startsWith("!") && !previous[address] && !changed.has(`${name}!${address}`) && (cell.f || cell.v !== undefined && cell.v !== null)) mismatches.push(`Unexpected new cell outside requested edits: ${name}!${address}`);
    }
    for (const [address, expected] of Object.entries(assertion.cells)) {
      const split = address.lastIndexOf("!"), cell = after.Sheets[address.slice(0, split)]?.[address.slice(split + 1)];
      mismatch(Boolean(cell) && (expected.formula === undefined ? !cell.f : formula(cell.f) === formula(expected.formula)), `Incorrect formula: ${address}`);
      mismatch(typeof expected.value === "number" ? typeof cell?.v === "number" && Number.isFinite(cell.v) && Math.abs(cell.v - expected.value) <= (expected.tolerance ?? 0.0000001) : equal(cell?.v, expected.value), `Incorrect/missing saved calculated value: ${address}`);
    }
    const originalParts = archive(source), savedParts = archive(saved);
    for (const name of assertion.preserveParts) mismatch(Boolean(savedParts[name]) && digest(savedParts[name]) === digest(originalParts[name]), `Unrelated workbook part changed: ${name}`);
    return { passed: mismatches.length === 0, evidence: { artifact: assertion.path, sourceSha256: assertion.sourceSha256, savedSha256: digest(saved), sheetNames: after.SheetNames, checkedCells: Object.keys(assertion.cells), mismatches, source: "saved-XLSX-formulas-and-numeric-caches; not a mocked calculation" } };
  }
  if (assertion.type !== "artifact.office_pptx") throw new Error("Unknown saved Office artifact criterion.");
  const before = inspectOfficePresentation(source), after = inspectOfficePresentation(saved);
  mismatch(after.slides.length === assertion.slideCount, "Saved slide count is incorrect.");
  for (const [index, expected] of assertion.slides.entries()) {
    const slide = after.slides[index];
    if (!slide) { mismatches.push(`Missing slide: ${index}`); continue; }
    for (const phrase of expected.includes) mismatch(slide.text.includes(phrase), `Saved slide ${index} lacks: ${phrase}`);
    if (expected.titleFontSizeHundredthsPoint !== undefined) {
      const title = slide.shapes.find(shape => shape.text === expected.title);
      mismatch(Boolean(title) && equal(title.fontSizes, [String(expected.titleFontSizeHundredthsPoint)]), `Saved title font size is incorrect: ${index}`);
    }
  }
  for (let index = 0; index < before.slides.length; index++) {
    mismatch(after.slides[index]?.notes === before.slides[index].notes, `Original speaker notes changed: ${index}`);
    for (const old of before.slides[index].shapes) {
      const change = assertion.changedShapes.find(change => change.slideIndex === index && change.name === old.name);
      const unchanged = shape => Object.entries(old).every(([key, value]) => change?.allow.includes(key) || equal(shape[key], value));
      mismatch(after.slides[index]?.shapes.some(unchanged), `Unrelated original shape geometry/style/content changed: slide ${index}, ${old.name}`);
    }
  }
  for (const name of assertion.preserveParts) mismatch(Boolean(after.parts[name]) && digest(after.parts[name]) === digest(before.parts[name]), `Unrelated presentation part changed: ${name}`);
  return { passed: mismatches.length === 0, evidence: { artifact: assertion.path, sourceSha256: assertion.sourceSha256, savedSha256: digest(saved), slideCount: after.slides.length, originalNotesPreserved: before.slides.every((slide, index) => after.slides[index]?.notes === slide.notes), mismatches, source: "saved-PPTX-ordered-slides-shapes-notes-and-retained-parts" } };
}

function serviceResult(result) {
  let output = result?.output;
  if (typeof output !== "string" && Array.isArray(result?.content)) output = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  if (typeof output !== "string") return null;
  try {
    const parsed = JSON.parse(output), result = parsed.result;
    const hasError = value => value.error !== undefined && value.error !== null && value.error !== false;
    if (parsed.ok !== true || parsed.success === false || hasError(parsed) || !result || typeof result !== "object" || Array.isArray(result)
      || hasError(result) || result.ok === false || result.success === false) return null;
    if (["ok", "success"].some(key => key in parsed && typeof parsed[key] !== "boolean")) return null;
    if (["ok", "success"].some(key => key in result && typeof result[key] !== "boolean")) return null;
    return result.ok === true || result.success === true ? result : null;
  } catch { return null; }
}
function includesServiceResult(actual, expected) {
  // V1's real editor domain result uses `ok`; other bridges use `success`.
  // Preserve the raw result and identify its marker in evidence, rather than
  // adding a fabricated success field to the captured service return.
  if (expected?.success === true) {
    const { success, ...rest } = expected;
    return (actual.success === true || actual.ok === true) && includes(actual, rest);
  }
  return includes(actual, expected);
}
function includes(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => includes(actual[index], item));
  if (expected && typeof expected === "object") return actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => includes(actual[key], value));
  return typeof expected === "number" ? typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual - expected) <= 0.0000001 : actual === expected;
}

/** Native children require complete actual observer results. Persisted execute
 * metadata only names a returned call; it cannot establish a service success. */
export function evaluateOfficeExecution(assertion, summary, context = {}) {
  if (!["xlsx", "pptx"].includes(assertion.format) || !Array.isArray(assertion.operations) || !assertion.operations.length) throw new Error("Exact Office format and required operations are required.");
  if (!context.workspace || !context.executionDirectory) throw new Error("Office tool criteria require the actual guest task directory and workspace.");
  const expectedPath = inside(context.executionDirectory, assertion.path);
  const allowed = assertion.format === "xlsx" ? ["inapp_xlsx_read", "inapp_xlsx_write"] : ["inapp_pptx_read_presentation", "inapp_pptx_read", "inapp_pptx_replace_text", "inapp_pptx_update_layout", "inapp_pptx_add_slide", "inapp_pptx_preview"];
  const calls = [];
  const ownedSessions = new Set(context.ownedSessionIDs ?? []);
  for (const call of summary.tools) {
    if (call.state?.status !== "completed" || call.state.error || call.state.metadata?.error === true || !call.messageID || !(call.callID ?? call.id)) continue;
    if (allowed.includes(call.tool)) {
      const result = serviceResult(call.state);
      if (result) calls.push({ tool: call.tool, input: call.state.input, result, serviceSuccessField: result.success === true ? "success" : "ok", messageID: call.messageID, callID: call.callID ?? call.id,
        startedAt: call.time?.ran ?? call.state.time?.start, completedAt: call.time?.completed ?? call.state.time?.end, path: "direct-persisted-result" });
    }
  }
  // The observer records must already be filtered to the exact owned session
  // subtree by the controller. Require explicit identities/timing and public
  // source markers; never accept generated code or claimed summary strings.
  for (const event of context.toolExecutions ?? []) {
    const completedAt = timestamp(event.completedAt);
    if (event.phase !== "after" || event.status !== "completed" || !allowed.includes(event.toolID) || event.error || !ownedSessions.has(event.sessionID) || !event.callID
      || !Number.isFinite(completedAt)) continue;
    const result = serviceResult(event.result);
    if (result) calls.push({ tool: event.toolID, input: event.input, result, serviceSuccessField: result.success === true ? "success" : "ok", sessionID: event.sessionID, callID: event.callID, messageID: event.messageID,
      path: "actual-public-tool-observer", observerInstance: event.observerInstance, recordSha256: event.recordSha256,
      startedAt: event.startedAt, completedAt: event.completedAt, elapsedMs: event.elapsedMs, pairing: event.pairing });
  }
  const operations = assertion.operations.map(operation => {
    if (!allowed.includes(operation.tool)) throw new Error("Unrecognized exact Office tool criterion.");
    const sameDocument = call => typeof call.input?.path === "string" && path.resolve(context.workspace, call.input.path) === expectedPath;
    const edits = calls.filter(call => sameDocument(call) && ["inapp_xlsx_write", "inapp_pptx_replace_text", "inapp_pptx_update_layout", "inapp_pptx_add_slide"].includes(call.tool)
      && (operation.afterEditsForSlide === undefined || (call.input.slideIndex ?? call.input.insertIndex) === operation.afterEditsForSlide));
    const matches = calls.filter(call => call.tool === operation.tool && sameDocument(call) && includes(call.input, operation.input) && includesServiceResult(call.result, operation.result)
      && (!operation.afterEdits && operation.afterEditsForSlide === undefined || edits.length > 0 && Number.isFinite(timestamp(call.startedAt)) && edits.every(edit => Number.isFinite(timestamp(edit.completedAt)) && timestamp(call.startedAt) >= timestamp(edit.completedAt))));
    return { tool: operation.tool, input: operation.input, successfulMatches: matches };
  });
  return { passed: operations.every(operation => operation.successfulMatches.length > 0), evidence: { format: assertion.format, operations,
    limitation: "Code Mode metadata without separately captured actual service results is insufficient; saved-file and live-tool criteria are independent." } };
}
