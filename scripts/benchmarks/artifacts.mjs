import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));

function plainXml(xml) {
  return xml.replace(/<\/(?:w:p|a:p|row)>/g, "\n").replace(/<(?:w:tab|w:br)[^>]*\/>/g, "\t").replace(/<[^>]+>/g, "").replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(parseInt(value, 16))).replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value))).replace(/&(lt|gt|quot|apos|amp);/g, (_, value) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[value]);
}

/** Complete extraction for evaluation; source files and source XML are retained separately. */
export async function extractFullArtifact(path) {
  const bytes = await readFile(path);
  const extension = extname(path).toLowerCase();
  if ([".docx", ".pptx", ".xlsx"].includes(extension)) {
    const { unzipSync } = require("fflate");
    const archive = unzipSync(bytes);
    const parts = Object.keys(archive).filter(name => extension === ".docx" ? /^word\/(document|footnotes|endnotes|comments|header\d+|footer\d+)\.xml$/.test(name) : extension === ".pptx" ? /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/.test(name) : /^xl\/(sharedStrings|workbook|worksheets\/sheet\d+)\.xml$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!parts.length) throw new Error(`No readable document parts in ${path}`);
    return { format: extension, text: parts.map(name => `--- ${name} ---\n${plainXml(Buffer.from(archive[name]).toString())}`).join("\n\n"), xml: Object.fromEntries(parts.map(name => [name, Buffer.from(archive[name]).toString()])), limitations: extension === ".xlsx" ? ["XML text preserves cell values, formula strings and shared strings but does not reconstruct rendered table coordinates. Inspect retained source XML/workbook for layout assertions."] : ["Text extraction does not evaluate visual layout, drawings, tracked-change rendering or embedded media; inspect the real Electron renderer and retained artifact."] };
  }
  if ([".txt", ".md", ".json", ".csv", ".tsv", ".xml", ".html", ".eml"].includes(extension)) return { format: extension, text: bytes.toString("utf8"), limitations: [] };
  throw new Error(`No complete extractor for ${extension}; evaluation must provide an explicit reader instead of silently using a preview`);
}

export function makeWordFixture(paragraphs) {
  const { zipSync, strToU8 } = require("fflate");
  const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`).join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`),
  }));
}
