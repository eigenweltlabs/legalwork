import { z } from "zod";

const path = z.string().min(1).describe("Exact file path returned by inapp_documents_list. Must match the active editor.");
export const officeFileSchema = z.object({ path });
export function officeRange(range: string) {
  const match = /^([A-Z]{1,3})([1-9]\d*):([A-Z]{1,3})([1-9]\d*)$/.exec(range.includes(":") ? range : `${range}:${range}`);
  if (!match) throw new Error("Use a bounded A1 range, for example A1:D10.");
  const col = (letters: string) => [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  const startRow = Number(match[2]) - 1, endRow = Number(match[4]) - 1;
  const startColumn = col(match[1]!), endColumn = col(match[3]!);
  if (endRow < startRow || endColumn < startColumn || endRow >= 100000 || endColumn >= 1000 || (endRow - startRow + 1) * (endColumn - startColumn + 1) > 5000) throw new Error("Use an ordered range of at most 5,000 cells within rows 1–100,000 and columns A–ALL.");
  return { startRow, endRow, startColumn, endColumn };
}
const range = z.string().refine((value) => { try { officeRange(value); return true; } catch { return false; } }, "Invalid or oversized A1 range.");
export const documentNavigationTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), page: z.number().int().min(1).max(100000).describe("One-based rendered page number for PDF or DOCX.") }).strict(),
  z.object({ kind: z.literal("slide"), slide: z.number().int().min(1).max(100000).describe("One-based PowerPoint slide number.") }).strict(),
  z.object({ kind: z.literal("cells"), sheet: z.string().min(1), range }).strict(),
]);
export type DocumentNavigationTarget = z.infer<typeof documentNavigationTargetSchema>;
export const documentNavigationSchema = z.object({
  path,
  target: documentNavigationTargetSchema,
});
export const xlsxReadSchema = z.object({ path, sheet: z.string().optional().describe("Sheet name; defaults to the active sheet."), range: range.optional().describe("Bounded A1 range; defaults to A1:T50. Read in pages for larger workbooks.") });
export const xlsxWriteSchema = z.object({ path, sheet: z.string().min(1), range, values: z.array(z.array(z.union([z.string().max(32767), z.number().finite(), z.boolean(), z.null()])).min(1)).min(1).max(5000).describe("Rectangular values matching the range. Strings beginning '=' are formulas. Null clears a cell. Formatting is retained.") });
export const pptxReadSchema = z.object({ path, slideIndex: z.number().int().min(0).optional().describe("Zero-based slide index. Omit to read the entire presentation. For previews, omit to use the active slide. Reads never change the active slide.") });
export const pptxAddSlideSchema = z.object({
  path,
  templateSlideIndex: z.number().int().min(0).describe("Existing slide to copy, preserving its design, images and layout. Read it first. Zero-based."),
  insertIndex: z.number().int().min(0).optional().describe("Position of the new slide in the resulting deck (zero-based). Omit to insert immediately after the template. 0 prepends; slideCount appends."),
  replacements: z.array(z.object({
    elementId: z.string().min(1).describe("Text/shape ID on the TEMPLATE slide, from inapp_pptx_read."),
    text: z.string().max(32767).describe("Complete replacement text for this element on the new slide. Empty clears it. Retains the template element's base text style."),
  })).max(200).optional().describe("Fill the new slide's text in this same call. Omitted elements are copied unchanged. The template itself is never edited."),
});
export const pptxReplaceSchema = z.object({ path, slideIndex: z.number().int().min(0), elementId: z.string().min(1).describe("Text/shape ID from inapp_pptx_read."), search: z.string().min(1).max(32767).describe("Exact unique text within the element."), replaceWith: z.string().max(32767) });

export const pptxLayoutSchema = z.object({
  path, slideIndex: z.number().int().min(0), elementId: z.string().min(1),
  x: z.number().finite().min(0).max(20000).optional(),
  y: z.number().finite().min(0).max(20000).optional(),
  width: z.number().finite().positive().max(20000).optional(),
  height: z.number().finite().positive().max(20000).optional(),
  fontSize: z.number().finite().min(6).max(400).optional().describe("Font size in CSS pixels, applied to all text runs in this element."),
});


// Shared by the public Word tools and the live editor dispatcher. Native
// operations are typed and validated as a complete batch before the first edit.
const docxIdentity = {
  documentId: z.string().min(1).describe("Document instance from the latest live read."),
  draftRevision: z.number().int().min(0).describe("Revision from that read. Re-read after edits or stale-revision errors."),
};
const paraId = z.string().min(1).describe("Live paragraph handle from read_document or find_text.");
const docxArea = z.enum(["main", "table", "textBox", "contentControl"]).describe("Paragraph location.area from the live read. main is ordinary body text. Explicitly select a nested area only when the requested edit belongs inside it.");
export const docxSuggestSchema = z.object({
  path: path.optional(), ...docxIdentity, paraId,
  area: docxArea.default("main"),
  search: z.string().describe("Exact unique text to replace. Empty appends within this paragraph. Use insert_paragraphs to compose new paragraphs."),
  replaceWith: z.string(),
});
export const docxPreviewSchema = z.object({ path: path.optional(), page: z.number().int().min(1).default(1), annotate: z.boolean().default(true).describe("Label writing areas and body paragraph IDs in the returned image. Does not change the document or the user's view.") });
const docxTarget = {
  bookmark: z.string().min(1).optional(),
  targetSearch: z.string().min(1).optional().describe("Unique plain phrase in targetParaId, e.g. § 2 Schlussbestimmungen. Omit to reference the whole target paragraph; use only with targetParaId."),
  targetParaId: paraId.optional().describe("Creates a native target bookmark if needed; alternatively use bookmark."),
  kind: z.enum(["number", "text", "page"]),
};
export const docxReadSchema = z.object({
  path: path.optional(),
  view: z.enum(["all", "text", "structure", "formatting", "layout"]).optional().describe("Default all. layout maps main text, positioned containers, headers/footers and notes; formatting reads paragraph/run properties."),
  page: z.number().int().min(1).optional().describe("One-based page to inspect with view=layout. Defaults to 1."),
  paraId: paraId.optional(),
  fromIndex: z.number().int().min(0).optional(),
  toIndex: z.number().int().min(0).optional().describe("Optional inclusive end paragraph index. Omit to read through the end unless limit is supplied."),
  limit: z.number().int().min(1).optional().describe("Optional paragraph count for pagination. Omit to read the whole document. When paginating, follow nextIndex for the remaining paragraphs."),
  includeStyles: z.boolean().optional().describe("Include native style definitions with inheritance and explicit OOXML units."),
}).refine(value => value.toIndex === undefined || value.toIndex >= (value.fromIndex ?? 0), "Use an ordered paragraph range.");
export const docxTemplateSchema = z.object({
  path: path.optional(),
  documentId: docxIdentity.documentId.optional(),
  draftRevision: docxIdentity.draftRevision.optional(),
  paraId: paraId.optional(),
  placeholder: z.string().regex(/^(?:\{\{[^{}]+\}\}|\[\[[^\[\]]+\]\]|\[[^\[\]]+\])$/).optional(),
  controlId: z.string().min(1).optional(),
  tag: z.string().min(1).optional().describe("Exact native content-control tag; must identify one control."),
  value: z.string(),
}).refine(value => {
  const control = value.controlId !== undefined || value.tag !== undefined;
  return control ? (value.controlId === undefined || value.tag === undefined) && value.documentId !== undefined && value.draftRevision !== undefined && value.paraId === undefined && value.placeholder === undefined : value.paraId !== undefined && value.placeholder !== undefined;
}, "Use paraId/placeholder, or one controlId/tag with documentId/draftRevision from a fresh read.");
const docxFormattingOperation = z.object({
  operation: z.enum(["apply_formatting"]), paraId: z.string().min(1), search: z.string().min(1).optional().describe("Unique plain-text phrase for character formatting; omit for the whole paragraph. Paragraph properties always affect the whole paragraph."),
  marks: z.object({
    bold: z.boolean().optional(), italic: z.boolean().optional(), strike: z.boolean().optional(), smallCaps: z.boolean().optional(), allCaps: z.boolean().optional(), hidden: z.boolean().optional(),
    underline: z.union([z.boolean(), z.object({ style: z.enum(["single", "double", "dotted", "dash", "wave"]) }).strict()]).optional(),
    fontSize: z.number().min(1).max(400).multipleOf(0.5).optional().describe("Points, e.g. 11 or 10.5."),
    fontFamily: z.object({ ascii: z.string().min(1), hAnsi: z.string().min(1).optional() }).strict().optional(),
    color: z.union([z.object({ rgb: z.string().regex(/^[\da-f]{6}$/i) }).strict(), z.object({ themeColor: z.enum(["dark1", "light1", "dark2", "light2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hyperlink", "followedHyperlink"]) }).strict()]).optional(),
    highlight: z.enum(["yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray", "black", "white", "none"]).optional(),
    characterSpacing: z.object({ spacing: z.number().min(-100).max(100).optional().describe("Additional character spacing in points; 0 resets condensation."), scale: z.number().min(1).max(600).optional().describe("Character width percent; 100 is normal."), kerning: z.number().min(0).max(400).optional().describe("Kerning threshold in points; 0 disables it.") }).strict().optional(),
      vertAlign: z.enum(["baseline", "superscript", "subscript"]).optional(),
  }).strict().optional(),
  paragraph: z.object({
    alignment: z.enum(["left", "center", "right", "both", "distribute"]).optional().describe("both means justified."),
    spaceBefore: z.number().min(0).max(1584).optional(), spaceAfter: z.number().min(0).max(1584).optional(),
    indentLeft: z.number().min(-1584).max(1584).optional(), indentRight: z.number().min(-1584).max(1584).optional(), indentFirstLine: z.number().min(-1584).max(1584).optional(),
    hangingIndent: z.boolean().optional(), lineSpacing: z.number().positive().max(1584).optional().describe("Multiple for auto (e.g. 1.5), points for exact/atLeast."), lineSpacingRule: z.enum(["auto", "exact", "atLeast"]).optional(),
    keepNext: z.boolean().optional(), keepLines: z.boolean().optional(), pageBreakBefore: z.boolean().optional(), contextualSpacing: z.boolean().optional(),
  }).strict().optional().describe("Spacing and indents are points. Unspecified properties remain unchanged."),
}).strict();

export const docxEditOperationSchema = z.discriminatedUnion("operation", [
  docxFormattingOperation,
  z.object({ operation: z.enum(["set_paragraph_style"]), paraId, styleId: z.string().min(1).describe("Existing native style ID from read_document.") }).strict(),
  z.object({ operation: z.enum(["create_bookmark"]), paraId, bookmark: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/), search: z.string().min(1).optional().describe("Unique plain phrase to bookmark; omit for the whole paragraph.") }).strict(),
  z.object({ operation: z.enum(["insert_cross_reference"]), paraId, ...docxTarget, search: z.string().describe("Replace this unique plain phrase with a field; empty appends.") }).strict(),
  z.object({ operation: z.enum(["edit_cross_reference"]), paraId, ...docxTarget, ordinal: z.number().int().min(0).describe("Zero-based field ordinal in this paragraph from the live read.") }).strict(),
  z.object({ operation: z.enum(["edit_note"]), noteType: z.enum(["footnote", "endnote"]), noteId: z.number().int().min(1), search: z.string().min(1), replaceWith: z.string() }).strict(),
  z.object({ operation: z.enum(["insert_note"]), noteType: z.enum(["footnote", "endnote"]), paraId, search: z.string().describe("Place the note marker after this unique phrase; empty appends."), text: z.string().min(1) }).strict(),
  z.object({
    operation: z.enum(["insert_paragraphs"]),
    placement: z.enum(["start", "end", "before", "after", "replace_empty"]).describe("start/end inserts in the MAIN text flow. before/after/replace_empty requires a paragraph handle; replace_empty fills an empty template paragraph."),
    paraId: paraId.optional(), area: docxArea.default("main"),
    paragraphs: z.array(z.object({ text: z.string().max(100000), styleId: z.string().min(1).optional(), alignment: z.enum(["left", "center", "right", "both"]).optional() }).strict()).min(1).max(500).describe("One object per real Word paragraph. Single newlines within text are manual line breaks. For a letter, supply separate date, subject, salutation, body and closing paragraphs."),
  }).strict(),
  z.object({ operation: z.enum(["insert_break"]), paraId, type: z.enum(["page", "sectionNextPage", "sectionContinuous"]) }).strict(),
  z.object({ operation: z.enum(["set_page_numbering"]), sectionIndex: z.number().int().min(0), format: z.enum(["decimal", "decimalZero", "upperRoman", "lowerRoman", "upperLetter", "lowerLetter"]), start: z.number().int().min(1).max(32767).nullable().describe("Restart at this number; null continues numbering.") }).strict(),
  z.object({ operation: z.enum(["set_protection"]), mode: z.enum(["none", "forms", "trackedChanges"]) }).strict(),
  z.object({ operation: z.enum(["update_fields"]) }).strict(),
]);
export const DOCX_EDIT_OPERATIONS = docxEditOperationSchema.options.map(option => option.shape.operation.options[0]);
export const docxEditSchema = z.object({
  path: path.optional(), ...docxIdentity,
  action: z.enum(["apply", "save"]).optional().describe("Default apply. save retries persistence of the current draft without repeating any edit."),
  operations: z.array(docxEditOperationSchema).min(1).max(50).optional().describe("Sequential direct native edits; save once. Stops on failure, reports earlier applied edits. Note edits reload paragraph handles: put them last, then read again."),
}).refine(value => value.action === "save" ? value.operations === undefined : value.operations !== undefined, "Apply requires operations; save must omit operations.").superRefine((value, context) => {
  value.operations?.forEach((operation, index) => {
    if (operation.operation !== "insert_cross_reference" && operation.operation !== "edit_cross_reference") return;
    if ((operation.bookmark !== undefined) === (operation.targetParaId !== undefined) || operation.targetSearch !== undefined && operation.targetParaId === undefined) {
      context.addIssue({ code: "custom", path: ["operations", index], message: "Use either bookmark or targetParaId. targetSearch requires targetParaId." });
    }
  });
});
export function parseDocxEdit(input: unknown) {
  const result = docxEditSchema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues.map(issue => `${issue.path.join(".") || "edit"}: ${issue.message}`).join("; ");
  throw new Error(`Invalid Word edit: ${details}. Accepted operations: ${DOCX_EDIT_OPERATIONS.join(", ")}. Use create_bookmark (not set_bookmark); targetSearch selects a short reference label. Read the live document again for documentId/draftRevision and paragraph handles.`);
}
const docxCopyName = z.string().min(1).max(180).regex(/^[^/\\\u0000-\u001f]+\.docx$/i).describe("New filename in this task's project; existing files are never overwritten.");
const docxRelativePath = z.string().min(1).max(4096).refine(value => !/^[A-Za-z]:|^\/|[\\\u0000-\u001f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== ".."), "Use a workspace-relative path.");
export const docxCompareSchema = z.object({
  path: path.optional(), ...docxIdentity, fileName: docxCopyName,
  versions: z.array(z.object({ path: docxRelativePath.refine(value => /\.docx$/i.test(value), "Use a DOCX file."), author: z.string().min(1).max(120) }).strict()).min(1).max(8).describe("One saved returned draft to compare, or independent drafts to combine into a copy with reviewer authors. Source stays unchanged."),
});
export const docxInspectSchema = z.object({
  path: path.optional(),
  documentId: docxIdentity.documentId.optional(), draftRevision: docxIdentity.draftRevision.optional(),
  fileName: docxCopyName.optional(),
  categories: z.array(z.enum(["properties", "hiddenText", "customXml", "comments", "revisions"])).min(1).optional().describe("Explicit removals in a separate outgoing copy. Removing revisions accepts ALL edits in the copy. Omit fileName/categories to inspect only."),
}).refine(value => value.fileName === undefined ? value.categories === undefined : value.categories !== undefined && value.documentId !== undefined && value.draftRevision !== undefined, "Creating a copy requires fileName/categories and fresh documentId/draftRevision.");
