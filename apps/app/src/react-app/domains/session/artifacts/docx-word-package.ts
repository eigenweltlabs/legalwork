import JSZip from "jszip";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export type Xml = ReturnType<DOMParser["parseFromString"]>;
export type XmlElement = NonNullable<Xml["documentElement"]>;
const isXmlElement = (node: NonNullable<XmlElement["parentNode"]>): node is XmlElement => node.nodeType === 1;
export const parseXml = (text: string) => new DOMParser().parseFromString(text, "application/xml");
export const xmlText = (node: Parameters<XMLSerializer["serializeToString"]>[0]) => new XMLSerializer().serializeToString(node);
export const elements = (node: Xml | XmlElement, local: string) => Array.from(node.getElementsByTagNameNS(W, local));
export const children = (node: XmlElement) => Array.from(node.childNodes).filter((child): child is XmlElement => child.nodeType === 1);
export const val = (node: XmlElement, name = "val") => node.getAttributeNS(W, name);
export const wordElement = (doc: Xml, name: string, attrs: Record<string, string> = {}) => {
  const node = doc.createElementNS(W, `w:${name}`);
  for (const [key, value] of Object.entries(attrs)) node.setAttributeNS(W, `w:${key}`, value);
  return node;
};
const activeSections = (doc: Xml) => elements(doc, "sectPr").filter((section) => {
  for (let node = section.parentNode; node; node = node.parentNode) if (/PrChange$/.test(node.localName ?? "")) return false;
  return true;
});

export type PageNumberRule = { start?: number; format: string };
export type Protection = { mode: "none" | "forms" | "trackedChanges" | "readOnly" | "comments"; password: boolean };
export type WordMetadata = { pages: PageNumberRule[]; protection: Protection; tocLevels: [number, number] };
export const emptyWordMetadata = (): WordMetadata => ({ pages: [], protection: { mode: "none", password: false }, tocLevels: [1, 3] });

export async function readWordMetadata(buffer: ArrayBuffer): Promise<WordMetadata> {
  const zip = await JSZip.loadAsync(buffer);
  const document = parseXml(await zip.file("word/document.xml")!.async("string"));
  const pages = activeSections(document).map((section) => {
    const numbering = children(section).find((node) => node.localName === "pgNumType");
    const start = numbering && val(numbering, "start");
    return { format: numbering && val(numbering, "fmt") || "decimal", ...(start !== null && start !== undefined ? { start: Number(start) } : {}) };
  });
  const metadata = emptyWordMetadata();
  metadata.pages = pages;
  const instruction = elements(document, "instrText").find((node) => /^\s*TOC\b/i.test(node.textContent ?? ""))?.textContent ?? "";
  const levels = instruction.match(/\\o\s+"?(\d)-(\d)"?/i);
  if (levels) metadata.tocLevels = [Number(levels[1]), Number(levels[2])];
  const settings = zip.file("word/settings.xml");
  if (settings) {
    const protection = elements(parseXml(await settings.async("string")), "documentProtection")[0];
    if (protection && !["0", "false", "off"].includes(val(protection, "enforcement") ?? "0")) {
      const mode = val(protection, "edit");
      metadata.protection = {
        mode: mode === "forms" || mode === "trackedChanges" || mode === "comments" ? mode : "readOnly",
        password: Boolean(val(protection, "hash") || val(protection, "hashValue") || val(protection, "password")),
      };
    }
  }
  return metadata;
}

/** Keep section-numbering/protection settings the pinned parser does not model. */
export async function finalizeWordPackage(buffer: ArrayBuffer, metadata: WordMetadata): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(buffer);
  const document = parseXml(await zip.file("word/document.xml")!.async("string"));
  activeSections(document).forEach((section, index) => {
    const rule = metadata.pages[index];
    if (!rule) return;
    const old = children(section).find((node) => node.localName === "pgNumType");
    if (old) section.removeChild(old);
    const node = wordElement(document, "pgNumType", { fmt: rule.format, ...(rule.start !== undefined ? { start: String(rule.start) } : {}) });
    // pgNumType follows lnNumType and precedes cols in CT_SectPr.
    section.insertBefore(node, children(section).find((child) => ["cols", "formProt", "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings", "sectPrChange"].includes(child.localName ?? "")) ?? null);
  });
  const hasToc = elements(document, "instrText").some((node) => /^\s*TOC\b/i.test(node.textContent ?? ""));
  const entries = elements(document, "p").filter((paragraph) => /^TOC\d+$/i.test(val(elements(paragraph, "pStyle")[0] ?? paragraph) ?? ""));
  if (!hasToc && entries.length) {
    const first = entries[0];
    const last = entries[entries.length - 1];
    const run = (name: string, attrs: Record<string, string> = {}, text?: string) => {
      const r = wordElement(document, "r");
      const node = wordElement(document, name, attrs);
      if (text) { node.setAttribute("xml:space", "preserve"); node.appendChild(document.createTextNode(text)); }
      r.appendChild(node); return r;
    };
    const anchor = children(first).find((child) => child.localName !== "pPr") ?? null;
    first.insertBefore(run("fldChar", { fldCharType: "begin" }), anchor);
    first.insertBefore(run("instrText", {}, ` TOC \\o "${metadata.tocLevels.join("-")}" \\h \\z \\u `), anchor);
    first.insertBefore(run("fldChar", { fldCharType: "separate" }), anchor);
    last.appendChild(run("fldChar", { fldCharType: "end" }));
  }
  // Word deletes a TOC's old target bookmarks when updating it. Contract REF
  // targets must never be shared with those disposable TOC bookmarks.
  let bookmarkId = Math.max(0, ...elements(document, "bookmarkStart").map((node) => Number(val(node, "id")))) + 1;
  const tocTargets = new Map<string, string>();
  for (const paragraph of entries) for (const link of elements(paragraph, "hyperlink")) {
    const name = val(link, "anchor");
    if (!name || /^_(?:Toc|LW_Toc)/i.test(name)) continue;
    let target = tocTargets.get(name);
    if (!target) {
      const start = elements(document, "bookmarkStart").find((node) => val(node, "name") === name);
      const end = start && elements(document, "bookmarkEnd").find((node) => val(node, "id") === val(start, "id"));
      if (!start || !end) continue;
      const id = String(bookmarkId++); target = `_LW_Toc${id}`; tocTargets.set(name, target);
      start.parentNode!.insertBefore(wordElement(document, "bookmarkStart", { id, name: target }), start.nextSibling);
      end.parentNode!.insertBefore(wordElement(document, "bookmarkEnd", { id }), end);
    }
    link.setAttributeNS(W, "w:anchor", target);
  }
  for (const paragraph of entries) for (const instruction of elements(paragraph, "instrText")) {
    instruction.textContent = (instruction.textContent ?? "").replace(/^(\s*PAGEREF\s+)([^\s\\]+)/i, (match, prefix: string, name: string) => tocTargets.has(name) ? prefix + tocTargets.get(name) : match);
  }
  zip.file("word/document.xml", xmlText(document));
  const numberingFile = zip.file("word/numbering.xml");
  if (numberingFile) {
    const numbering = parseXml(await numberingFile.async("string"));
    const order = (parent: XmlElement, names: string[]) => { for (const name of names) for (const child of children(parent).filter((node) => node.localName === name)) parent.appendChild(child); };
    order(numbering.documentElement!, ["numPicBullet", "abstractNum", "num", "numIdMacAtCleanup"]);
    for (const level of elements(numbering, "lvl")) order(level, ["start", "numFmt", "lvlRestart", "pStyle", "isLgl", "suff", "lvlText", "lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr"]);
    zip.file("word/numbering.xml", xmlText(numbering));
  }
  const settings = parseXml(await zip.file("word/settings.xml")?.async("string") ?? `<w:settings xmlns:w="${W}"/>`);
  const existing = elements(settings, "documentProtection")[0];
  if (!metadata.protection.password) {
    existing?.parentNode?.removeChild(existing);
    if (metadata.protection.mode !== "none") settings.documentElement!.appendChild(wordElement(settings, "documentProtection", { edit: metadata.protection.mode, enforcement: "1" }));
  }
  if (!elements(settings, "updateFields").length) settings.documentElement!.appendChild(wordElement(settings, "updateFields", { val: "true" }));
  zip.file("word/settings.xml", xmlText(settings));
  const relationships = parseXml(await zip.file("word/_rels/document.xml.rels")?.async("string") ?? '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  const settingsType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings";
  if (!Array.from(relationships.getElementsByTagName("Relationship")).some((node) => node.getAttribute("Type") === settingsType)) {
    const relationship = relationships.createElementNS(relationships.documentElement!.namespaceURI, "Relationship");
    const ids = new Set(Array.from(relationships.getElementsByTagName("Relationship"), (node) => node.getAttribute("Id")));
    let id = "rIdLWSettings"; while (ids.has(id)) id += "_";
    relationship.setAttribute("Id", id); relationship.setAttribute("Type", settingsType); relationship.setAttribute("Target", "settings.xml");
    relationships.documentElement!.appendChild(relationship); zip.file("word/_rels/document.xml.rels", xmlText(relationships));
  }
  const types = parseXml(await zip.file("[Content_Types].xml")!.async("string"));
  if (!Array.from(types.getElementsByTagName("Override")).some((node) => node.getAttribute("PartName") === "/word/settings.xml")) {
    const type = types.createElementNS(types.documentElement!.namespaceURI, "Override");
    type.setAttribute("PartName", "/word/settings.xml"); type.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml");
    types.documentElement!.appendChild(type); zip.file("[Content_Types].xml", xmlText(types));
  }
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export type InspectionKind = "properties" | "hiddenText" | "customXml" | "comments" | "revisions" | "externalLinks";
export type InspectionFinding = { kind: InspectionKind; count: number };
async function hiddenRunResolver(zip: JSZip) {
  const styleFile = zip.file("word/styles.xml");
  const styles = styleFile ? parseXml(await styleFile.async("string")) : null;
  const definitions = new Map(styles ? elements(styles, "style").map((style) => [style.getAttributeNS(W, "styleId")!, style]) : []);
  const setting = (node: XmlElement | undefined): boolean | undefined => {
    if (!node) return undefined;
    const flag = children(node).find((child) => child.localName === "vanish" || child.localName === "webHidden");
    return flag ? !["0", "false", "off"].includes(val(flag) ?? "1") : undefined;
  };
  const styleHidden = (id: string | null, seen = new Set<string>()): boolean | undefined => {
    if (!id || seen.has(id)) return undefined;
    seen.add(id); const style = definitions.get(id);
    return setting(style && children(style).find((node) => node.localName === "rPr")) ?? styleHidden(style ? val(elements(style, "basedOn")[0] ?? style) : null, seen);
  };
  const defaultHidden = styles ? setting(elements(elements(styles, "docDefaults")[0] ?? styles, "rPr")[0]) : undefined;
  return (run: XmlElement) => {
    const direct = children(run).find((node) => node.localName === "rPr");
    let paragraph: XmlElement | undefined;
    for (let node = run.parentNode; node; node = node.parentNode) if (isXmlElement(node) && node.localName === "p") { paragraph = node; break; }
    const rStyle = elements(run, "rStyle")[0]; const pStyle = paragraph && elements(paragraph, "pStyle")[0];
    return setting(direct) ?? styleHidden(rStyle ? val(rStyle) : null) ?? styleHidden(pStyle ? val(pStyle) : null) ?? defaultHidden ?? false;
  };
}

export async function inspectWordPackage(buffer: ArrayBuffer): Promise<InspectionFinding[]> {
  const zip = await JSZip.loadAsync(buffer);
  const hidden = await hiddenRunResolver(zip);
  const counts: Record<InspectionKind, number> = { properties: 0, hiddenText: 0, customXml: 0, comments: 0, revisions: 0, externalLinks: 0 };
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || !/\.xml$/.test(path) && !/\.rels$/.test(path)) continue;
    if (path.startsWith("docProps/")) {
      const doc = parseXml(await file.async("string"));
      counts.properties += children(doc.documentElement!).filter((node) => Boolean(node.textContent?.trim())).length;
    }
    if (/^customXml\/item\d+\.xml$/.test(path)) counts.customXml++;
    if (path.startsWith("word/")) {
      const doc = parseXml(await file.async("string"));
      counts.hiddenText += elements(doc, "r").filter(hidden).length;
      counts.comments += elements(doc, "comment").length;
      for (const kind of ["ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange", "tblPrChange", "trPrChange", "tcPrChange"]) counts.revisions += elements(doc, kind).length;
    }
    if (/\.rels$/.test(path)) counts.externalLinks += Array.from(parseXml(await file.async("string")).getElementsByTagName("Relationship")).filter((n) => n.getAttribute("TargetMode") === "External").length;
  }
  return Object.entries(counts).filter(([, count]) => count > 0).map(([kind, count]) => ({ kind: kind === "properties" || kind === "hiddenText" || kind === "customXml" || kind === "comments" || kind === "revisions" ? kind : "externalLinks", count }));
}

/** Apply only the user's selected inspection removals to a detached copy. */
export async function removeWordPrivateData(buffer: ArrayBuffer, selected: InspectionKind[]): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(buffer);
  const hidden = await hiddenRunResolver(zip);
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    if (selected.includes("customXml") && path.startsWith("customXml/")) { zip.remove(path); continue; }
    if (!/\.(xml|rels)$/.test(path)) continue;
    const doc = parseXml(await file.async("string"));
    let changed = false;
    if (selected.includes("properties") && path.startsWith("docProps/")) {
      for (const node of children(doc.documentElement!)) { node.parentNode?.removeChild(node); changed = true; }
    }
    if (selected.includes("hiddenText") && path.startsWith("word/")) {
      for (const run of elements(doc, "r")) if (hidden(run)) { run.parentNode?.removeChild(run); changed = true; }
    }
    if (selected.includes("customXml")) {
      for (const node of elements(doc, "dataBinding")) { node.parentNode?.removeChild(node); changed = true; }
      for (const node of Array.from(doc.getElementsByTagName("Relationship"))) if ((node.getAttribute("Type") ?? "").endsWith("/customXml")) { node.parentNode?.removeChild(node); changed = true; }
      for (const node of Array.from(doc.getElementsByTagName("Override"))) if ((node.getAttribute("PartName") ?? "").startsWith("/customXml/")) { node.parentNode?.removeChild(node); changed = true; }
    }
    if (changed) zip.file(path, xmlText(doc));
  }
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

/** Review every Word story, including notes, headers, and property revisions. */
export async function reviewWordPackage(buffer: ArrayBuffer, decision: "accept" | "reject"): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(buffer);
  for (const [path, file] of Object.entries(zip.files)) {
    if (!/^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(path)) continue;
    const doc = parseXml(await file.async("string"));
    const keep = decision === "accept" ? ["ins", "moveTo", "conflictIns"] : ["del", "moveFrom", "conflictDel"];
    const discard = decision === "accept" ? ["del", "moveFrom", "conflictDel"] : ["ins", "moveTo", "conflictIns"];
    for (const row of elements(doc, "tr")) {
      const properties = children(row).find((node) => node.localName === "trPr");
      if (properties && children(properties).some((node) => node.localName === (decision === "accept" ? "del" : "ins"))) row.parentNode?.removeChild(row);
    }
    const join: XmlElement[] = [];
    for (const paragraph of elements(doc, "p")) {
      const properties = children(paragraph).find((node) => node.localName === "pPr");
      const runProperties = properties && children(properties).find((node) => node.localName === "rPr");
      if (runProperties && children(runProperties).some((node) => node.localName === (decision === "accept" ? "del" : "ins"))) join.push(paragraph);
    }
    if (decision === "reject") for (const node of Array.from(doc.getElementsByTagName("*"))) {
      if (!/PrChange$|^tblGridChange$/.test(node.localName ?? "")) continue;
      const parent = node.parentNode;
      const previous = children(node)[0];
      if (parent && previous && parent.nodeType === 1) {
        const restored = doc.importNode(previous, true);
        // CT_PPrChange excludes sectPr: rejecting paragraph formatting must not
        // remove the live section break. Section changes have their own history.
        if (parent.localName === "pPr" && isXmlElement(restored)) {
          const section = Array.from(parent.childNodes).find((child) => child.nodeType === 1 && child.localName === "sectPr");
          if (section && !children(restored).some((child) => child.localName === "sectPr")) restored.appendChild(doc.importNode(section, true));
        }
        parent.parentNode?.replaceChild(restored, parent);
      }
    }
    for (const kind of discard) for (const node of elements(doc, kind)) node.parentNode?.removeChild(node);
    for (const kind of keep) for (const node of elements(doc, kind)) {
      const parent = node.parentNode; if (!parent) continue;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
    }
    if (decision === "reject") for (const name of ["delText", "delInstrText"]) for (const node of elements(doc, name)) {
      const replacement = wordElement(doc, name === "delText" ? "t" : "instrText");
      replacement.setAttribute("xml:space", "preserve"); replacement.appendChild(doc.createTextNode(node.textContent ?? "")); node.parentNode?.replaceChild(replacement, node);
    }
    for (const paragraph of join) {
      if (!paragraph.parentNode) continue;
      const next = paragraph.nextSibling;
      if (decision === "reject" && !elements(paragraph, "t").some((node) => Boolean(node.textContent))) paragraph.parentNode.removeChild(paragraph);
      else if (next?.nodeType === 1 && next.localName === "p") {
        for (const node of Array.from(next.childNodes)) if (node.nodeType !== 1 || node.localName !== "pPr") paragraph.appendChild(node);
        next.parentNode?.removeChild(next);
      }
    }
    for (const node of Array.from(doc.getElementsByTagName("*"))) if (/PrChange$|^(tblGridChange|numberingChange|cellIns|cellDel|cellMerge|move(?:From|To)Range(?:Start|End)|customXml(?:Ins|Del|MoveFrom|MoveTo)Range(?:Start|End))$/.test(node.localName ?? "")) node.parentNode?.removeChild(node);
    zip.file(path, xmlText(doc));
  }
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
