import type { Node } from "prosemirror-model";
import type { Document } from "@eigenpal/docx-editor-core/types/document";
import type { BlockContent, ParagraphContent, Run } from "@eigenpal/docx-editor-core/types/content";
import { fromProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import JSZip from "jszip";
import { children, elements, parseXml, val, wordElement, xmlText, type XmlElement } from "./docx-word-package";
import { commit, paragraph, uniqueTextRange, type WordToolContext } from "./docx-agent-structure";
import { wordParagraphs } from "./docx-fields";

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
const toggles = ["bold", "italic", "strike", "smallCaps", "allCaps", "hidden"];
const paragraphKeys = ["alignment", "spaceBefore", "spaceAfter", "lineSpacing", "lineSpacingRule", "indentLeft", "indentRight", "indentFirstLine", "hangingIndent", "keepNext", "keepLines", "pageBreakBefore", "contextualSpacing"];
const twips = ["spaceBefore", "spaceAfter", "indentLeft", "indentRight", "indentFirstLine"];

/** Values use Word's displayed units: points, with auto line spacing as a multiple. */
export function readWordFormatting(doc: Node, document: Document, args: Record<string, unknown>) {
  const items = wordParagraphs(doc).map((item, index) => ({ ...item, index, paraId: typeof item.node.attrs.paraId === "string" ? item.node.attrs.paraId : `@paragraph:${index}` }));
  const from = typeof args.fromIndex === "number" ? args.fromIndex : 0;
  const limit = typeof args.limit === "number" ? args.limit : Math.max(1, items.length - from);
  if (!Number.isInteger(from) || from < 0 || !Number.isInteger(limit) || limit < 1) throw new Error("Formatting reads require fromIndex >= 0 and a positive integer limit.");
  const selected = typeof args.paraId === "string" ? items.filter((item) => item.paraId === args.paraId) : items.slice(from, from + limit);
  if (typeof args.paraId === "string" && selected.length !== 1) throw new Error("Paragraph is missing or ambiguous. Read the document again.");
  return {
    units: { fontSize: "points", paragraphSpacingAndIndents: "points", autoLineSpacing: "multiple", exactLineSpacing: "points" },
    paragraphs: selected.map(({ node, paraId, index }) => {
      const formatting: Record<string, unknown> = {};
      for (const key of paragraphKeys) if (node.attrs[key] !== null && node.attrs[key] !== undefined) formatting[key] = twips.includes(key) ? node.attrs[key] / 20 : key === "lineSpacing" ? node.attrs[key] / (node.attrs.lineSpacingRule === "auto" || !node.attrs.lineSpacingRule ? 240 : 20) : node.attrs[key];
      const runs: { from: number; to: number; text: string; kind: string; formatting: Record<string, unknown>; marks: { type: string; attrs: Record<string, unknown> }[] }[] = [];
      node.descendants((child, offset) => {
        if (!child.isInline || !child.isLeaf) return;
        const marks = child.marks.map((mark) => ({ type: mark.type.name, attrs: { ...mark.attrs } }));
        const formatting: Record<string, unknown> = Object.fromEntries(toggles.map((key) => [key, child.marks.some((mark) => mark.type.name === key)]));
        formatting.underline = child.marks.find((mark) => mark.type.name === "underline")?.attrs ?? false;
        formatting.vertAlign = child.marks.some((mark) => mark.type.name === "superscript") ? "superscript" : child.marks.some((mark) => mark.type.name === "subscript") ? "subscript" : "baseline";
        const size = child.marks.find((mark) => mark.type.name === "fontSize")?.attrs.size ?? node.attrs.defaultTextFormatting?.fontSize;
        if (typeof size === "number") formatting.fontSize = size / 2;
        for (const [key, type] of [["fontFamily", "fontFamily"], ["color", "textColor"], ["highlight", "highlight"], ["characterStyleId", "runStyle"]]) {
          const mark = child.marks.find((mark) => mark.type.name === type);
          if (mark) formatting[key] = type === "highlight" ? mark.attrs.color : type === "runStyle" ? mark.attrs.styleId : { ...mark.attrs };
        }
        runs.push({ from: offset, to: offset + child.nodeSize, text: child.text ?? (child.type.name === "field" ? String(child.attrs.displayText ?? "") : child.type.name === "tab" ? "\t" : child.type.name === "hardBreak" ? "\n" : ""), kind: child.type.name, formatting, marks });
      });
      return { paraId, index, styleId: node.attrs.styleId ?? null, formatting, runs };
    }),
    totalParagraphs: items.length, nextIndex: typeof args.paraId !== "string" && from + selected.length < items.length ? from + selected.length : null,
    // Native definitions retain OOXML units, for examining inheritance and advanced properties.
    styleDefinitions: args.includeStyles === true ? document.package.styles : undefined,
    styleDefinitionUnits: args.includeStyles === true ? { fontSize: "half-points", spacingAndIndents: "twips", autoLineSpacing: "240ths of a line" } : undefined,
  };
}

export function applyWordFormatting(context: WordToolContext, args: Record<string, unknown>) {
  if (typeof args.paraId !== "string") throw new Error("paraId is required.");
  const item = paragraph(context.view.state.doc, args.paraId);
  const marks = args.marks === undefined ? {} : args.marks;
  const properties = args.paragraph === undefined ? {} : args.paragraph;
  if (!record(marks) || !record(properties) || !Object.keys(marks).length && !Object.keys(properties).length) throw new Error("Provide marks and/or paragraph formatting.");
  let { from, to } = { from: item.pos + 1, to: item.pos + item.node.nodeSize - 1 };
  if (args.search !== undefined && (typeof args.search !== "string" || !args.search)) throw new Error("search must be a nonempty unique plain-text phrase; omit it for the whole paragraph.");
  if (typeof args.search === "string") ({ from, to } = uniqueTextRange(item.node, item.pos, args.search));
  let pending = false;
  context.view.state.doc.nodesBetween(from, to, (node) => { if (node.marks.some((mark) => ["insertion", "deletion"].includes(mark.type.name))) pending = true; });
  if (pending) throw new Error("Formatting a pending revision is unsupported. Resolve the relevant change first.");
  let tr = context.view.state.tr;
  const setMark = (name: string, enabled: boolean, attrs?: Record<string, unknown>) => {
    const type = tr.doc.type.schema.marks[name];
    if (!type) throw new Error(`Unsupported formatting: ${name}`);
    tr = enabled ? tr.addMark(from, to, type.create(attrs)) : tr.removeMark(from, to, type);
  };
  for (const [key, value] of Object.entries(marks)) {
    if (toggles.includes(key)) { if (typeof value !== "boolean") throw new Error(`${key} must be boolean.`); setMark(key, value); }
    else if (key === "underline") { if (typeof value !== "boolean" && (!record(value) || typeof value.style !== "string" || !["single", "double", "dotted", "dash", "wave"].includes(value.style))) throw new Error("Invalid underline style."); setMark("underline", value !== false, record(value) ? value : { style: "single" }); }
    else if (key === "fontSize") { if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 400 || value * 2 % 1) throw new Error("fontSize must be 1–400 points in half-point steps."); setMark("fontSize", true, { size: value * 2, sizeCs: value * 2 }); }
    else if (key === "fontFamily") { if (!record(value) || typeof value.ascii !== "string" || !value.ascii || value.hAnsi !== undefined && typeof value.hAnsi !== "string") throw new Error("fontFamily requires ascii and optional hAnsi font names."); setMark("fontFamily", true, { ascii: value.ascii, hAnsi: value.hAnsi ?? value.ascii }); }
    else if (key === "color") { if (!record(value) || !(typeof value.rgb === "string" && /^[\da-f]{6}$/i.test(value.rgb) || typeof value.themeColor === "string" && ["dark1", "light1", "dark2", "light2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hyperlink", "followedHyperlink"].includes(value.themeColor))) throw new Error("color requires a six-digit RGB or Word themeColor."); setMark("textColor", true, value); }
    else if (key === "highlight") { if (typeof value !== "string" || !["yellow", "green", "cyan", "magenta", "blue", "red", "darkBlue", "darkCyan", "darkGreen", "darkMagenta", "darkRed", "darkYellow", "darkGray", "lightGray", "black", "white", "none"].includes(value)) throw new Error("Invalid Word highlight color."); setMark("highlight", value !== "none", { color: value }); }
    else if (key === "vertAlign") { if (!["baseline", "superscript", "subscript"].includes(String(value))) throw new Error("Invalid vertAlign."); setMark("superscript", value === "superscript"); setMark("subscript", value === "subscript"); }
    else throw new Error(`Unsupported character formatting: ${key}`);
  }
  const attrs = { ...item.node.attrs }; const original = { ...item.node.attrs._originalFormatting };
  for (const [key, value] of Object.entries(properties)) {
    if (!paragraphKeys.includes(key)) throw new Error(`Unsupported paragraph formatting: ${key}`);
    if (key === "alignment") { if (!["left", "center", "right", "both", "distribute"].includes(String(value))) throw new Error("Invalid alignment."); }
    else if (key === "lineSpacingRule") { if (!["auto", "exact", "atLeast"].includes(String(value))) throw new Error("Invalid lineSpacingRule."); }
    else if (twips.includes(key) || key === "lineSpacing") { if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1584 || !key.startsWith("indent") && value < 0 || key === "lineSpacing" && value === 0) throw new Error(`Invalid ${key}.`); }
    else if (typeof value !== "boolean") throw new Error(`${key} must be boolean.`);
    const native = typeof value === "number" ? Math.round(value * (key === "lineSpacing" && (properties.lineSpacingRule ?? attrs.lineSpacingRule ?? "auto") === "auto" ? 240 : 20)) : value;
    attrs[key] = native;
    // The pinned converter otherwise preserves the old spacing/keep properties.
    original[key] = native;
  }
  if (properties.lineSpacingRule !== undefined && properties.lineSpacing === undefined) throw new Error("Supply lineSpacing when changing lineSpacingRule.");
  if (Object.keys(properties).length) tr = tr.setNodeMarkup(item.pos, undefined, { ...attrs, _originalFormatting: original });
  if (tr.doc.eq(context.view.state.doc)) {
    if (context.metadata.protection.mode !== "none") throw new Error("Word protection blocks direct formatting.");
    return { success: true, data: { applied: false, tracked: false } };
  }
  return commit(context, tr);
}

/** The pinned converter drops negative run properties. Write explicit overrides
 * so removing inherited emphasis stays removed when Word resolves the styles. */
export async function preserveWordFormatting(buffer: ArrayBuffer, doc: Node, document: Document) {
  const converted = fromProseDoc(doc, document);
  const defaults = new Map<string, Record<string, unknown>>();
  for (const { node } of wordParagraphs(doc)) if (typeof node.attrs.paraId === "string" && record(node.attrs.defaultTextFormatting)) defaults.set(node.attrs.paraId, node.attrs.defaultTextFormatting);
  let changed = false;
  const inheritedByParagraph: (Record<string, unknown> | undefined)[] = [];
  const normalizeRuns = (content: ParagraphContent[], inherited: NonNullable<Run["formatting"]>) => {
    for (const item of content) {
      if (item.type === "run") {
        if (!item.content.some((part) => part.type === "text")) continue;
        const format = { ...item.formatting }; let base = { ...inherited };
        const chain = new Set<string>(); let id = format.styleId;
        const styles: NonNullable<Run["formatting"]>[] = [];
        while (id && !chain.has(id)) { chain.add(id); const style = document.package.styles?.styles.find((style) => style.styleId === id); if (!style) break; if (style.rPr) styles.unshift(style.rPr); id = style.basedOn; }
        for (const style of styles) base = { ...base, ...style };
        for (const key of ["bold", "boldCs", "italic", "italicCs", "strike", "doubleStrike", "allCaps", "smallCaps", "hidden"] satisfies (keyof NonNullable<Run["formatting"]>)[]) if (base[key] === true && format[key] === undefined) { Object.assign(format, { [key]: false }); changed = true; }
        if (base.underline && base.underline.style !== "none" && !format.underline) { format.underline = { style: "none" }; changed = true; }
        if (base.vertAlign && base.vertAlign !== "baseline" && !format.vertAlign) { format.vertAlign = "baseline"; changed = true; }
        item.formatting = format;
      } else if (item.type === "hyperlink") normalizeRuns(item.children, inherited);
      else if (item.type === "inlineSdt") normalizeRuns(item.content, inherited);
      // Fields and pending revisions keep their original formatting.
    }
  };
  const walk = (blocks: BlockContent[]) => {
    for (const block of blocks) {
      if (block.type === "paragraph") {
        const inherited = block.paraId ? defaults.get(block.paraId) : undefined;
        inheritedByParagraph.push(inherited);
        if (inherited) normalizeRuns(block.content, inherited);
      }
      else if (block.type === "table") for (const row of block.rows) for (const cell of row.cells) walk(cell.content);
      else if (block.type === "blockSdt") walk(block.content);
    }
  };
  walk(converted.package.document.content);
  if (!changed) return buffer;
  // Patch the serialized run properties, preserving the SDK's revision/reply
  // anchors. Re-importing here inflated every media asset and rebuilt base64
  // previews on each save/checkpoint, even though only document.xml changes.
  const zip = await JSZip.loadAsync(buffer);
  const xml = parseXml(await zip.file("word/document.xml")!.async("string"));
  const paragraphs = elements(xml, "p").filter(paragraph => {
    for (let parent = paragraph.parentNode; parent; parent = parent.parentNode) if (parent.localName === "txbxContent") return false;
    return true;
  });
  if (paragraphs.length !== inheritedByParagraph.length) throw new Error("Saved paragraph structure changed while preserving formatting. Retry the save.");
  let fieldDepth = 0;
  const patch = (nodes: XmlElement[], inherited: Record<string, unknown>) => {
    for (const node of nodes) {
      if (node.localName === "hyperlink" || node.localName === "sdt" || node.localName === "sdtContent") { patch(children(node), inherited); continue; }
      if (node.localName !== "r") continue; // Preserve fields and pending revisions.
      for (const marker of elements(node, "fldChar")) {
        const type = val(marker, "fldCharType");
        if (type === "begin") fieldDepth++;
        else if (type === "end") fieldDepth = Math.max(0, fieldDepth - 1);
      }
      if (fieldDepth || !children(node).some(child => child.localName === "t")) continue;
      let properties = children(node).find(child => child.localName === "rPr");
      let base = { ...inherited };
      const styleId = properties && children(properties).find(child => child.localName === "rStyle");
      let id = styleId ? val(styleId) : null;
      const visited = new Set<string>(), styles: NonNullable<Run["formatting"]>[] = [];
      while (id && !visited.has(id)) {
        visited.add(id);
        const style = document.package.styles?.styles.find(style => style.styleId === id);
        if (!style) break;
        if (style.rPr) styles.unshift(style.rPr);
        id = style.basedOn ?? null;
      }
      for (const style of styles) base = { ...base, ...style };
      const add = (name: string, value: string) => {
        if (properties && children(properties).some(child => child.localName === name)) return;
        if (!properties) { properties = wordElement(xml, "rPr"); node.insertBefore(properties, node.firstChild); }
        properties.appendChild(wordElement(xml, name, { val: value }));
      };
      for (const [key, name] of Object.entries({ bold: "b", boldCs: "bCs", italic: "i", italicCs: "iCs", strike: "strike", doubleStrike: "dstrike", allCaps: "caps", smallCaps: "smallCaps", hidden: "vanish" })) if (base[key] === true) add(name, "0");
      if (record(base.underline) && base.underline.style !== "none") add("u", "none");
      if (base.vertAlign && base.vertAlign !== "baseline") add("vertAlign", "baseline");
    }
  };
  paragraphs.forEach((paragraph, index) => {
    // Even paragraphs without overrides can contain a begin/end field marker.
    patch(children(paragraph), inheritedByParagraph[index] ?? {});
  });
  zip.file("word/document.xml", xmlText(xml));
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}
