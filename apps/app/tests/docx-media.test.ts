import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { DocumentAgent } from "@eigenpal/docx-editor-core/agent";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { parseDocx } from "@eigenpal/docx-editor-core/docx";
import { toProseDoc, fromProseDoc } from "@eigenpal/docx-editor-core/prosemirror/conversion";
import { EditorState } from "prosemirror-state";
import { history, undo } from "prosemirror-history";
import { createCleanDocx } from "../src/react-app/domains/session/artifacts/docx-export";
import { W, finalizeWordPackage, parseXml, readWordMetadata, removeWordPrivateData, reviewWordPackage } from "../src/react-app/domains/session/artifacts/docx-word-package";

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/package/2006/relationships";
const namespaces = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"`;

function png(red: number, green: number, blue: number) {
  const chunk = (type: string, data: Buffer) => {
    const payload = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, payload, checksum]);
  };
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue]))), chunk("IEND", Buffer.alloc(0))]);
}
const originalImage = png(255, 0, 0), replacementImage = png(0, 0, 255);
const dataUrl = (data: Buffer) => `data:image/png;base64,${data.toString("base64")}`;
const relation = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;
const drawing = (id: string) => `<w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Synthetic picture"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Picture"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;

async function fixture(options: { sharedStories?: boolean; watermark?: boolean; tracked?: boolean } = {}) {
  const zip = new JSZip();
  const imageRun = `<w:r>${drawing("rId9")}</w:r>`;
  const image = options.watermark ? "" : options.tracked ? `<w:del w:id="73" w:author="Reviewer">${imageRun}</w:del>` : imageRun;
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${P}">${relation("rId1", "officeDocument", "word/document.xml")}</Relationships>`);
  zip.file("word/document.xml", `<w:document ${namespaces}><w:body><w:p><w:r><w:t>Original text.</w:t></w:r>${image}</w:p><w:sectPr>${options.sharedStories || options.watermark ? '<w:headerReference w:type="default" r:id="rId10"/>' : ""}${options.sharedStories ? '<w:footerReference w:type="default" r:id="rId11"/>' : ""}</w:sectPr></w:body></w:document>`);
  zip.file("word/styles.xml", `<w:styles xmlns:w="${W}">${Array.from({ length: 300 }, (_, i) => `<w:style w:type="paragraph" w:styleId="Style${i}"><w:name w:val="Synthetic style ${i}"/></w:style>`).join("")}</w:styles>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${P}">${relation("rId9", "image", "media/image1.png")}${relation("rId8", "styles", "styles.xml")}${options.sharedStories || options.watermark ? relation("rId10", "header", "header1.xml") : ""}${options.sharedStories ? relation("rId11", "footer", "footer1.xml") : ""}</Relationships>`);
  zip.file("word/media/image1.png", originalImage);
  if (options.sharedStories || options.watermark) {
    const content = options.watermark ? '<w:pict><v:shape id="PowerPlusWaterMarkObject1" type="#_x0000_t75" style="position:absolute;width:100pt;height:100pt;z-index:-1"><v:imagedata r:id="rId1" o:title=""/></v:shape></w:pict>' : drawing("rId1");
    zip.file("word/header1.xml", `<w:hdr ${namespaces}><w:p><w:r>${content}</w:r></w:p></w:hdr>`);
    zip.file("word/_rels/header1.xml.rels", `<Relationships xmlns="${P}">${relation("rId1", "image", "media/image1.png")}</Relationships>`);
  }
  if (options.sharedStories) {
    zip.file("word/footer1.xml", `<w:ftr ${namespaces}><w:p><w:r>${drawing("rId1")}</w:r></w:p></w:ftr>`);
    zip.file("word/_rels/footer1.xml.rels", `<Relationships xmlns="${P}">${relation("rId1", "image", "media/image1.png")}</Relationships>`);
  }
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

const mediaFiles = (zip: JSZip) => Object.values(zip.files).filter(file => !file.dir && file.name.startsWith("word/media/"));
async function pictureBytes(zip: JSZip, owner = "document") {
  const doc = parseXml(await zip.file(`word/${owner}.xml`)!.async("string"));
  const embed = doc.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/main", "blip")[0].getAttributeNS(R, "embed");
  const rels = parseXml(await zip.file(`word/_rels/${owner}.xml.rels`)!.async("string"));
  const target = Array.from(rels.getElementsByTagName("Relationship")).find(rel => rel.getAttribute("Id") === embed)?.getAttribute("Target");
  assert.ok(target, `${owner} has a valid picture relationship`);
  return zip.file(`word/${target}`)!.async("nodebuffer");
}

function compression(buffer: ArrayBuffer, filename: string) {
  const bytes = Buffer.from(buffer);
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = bytes.readUInt32LE(end + 16);
  while (bytes.readUInt32LE(offset) === 0x02014b50) {
    const length = bytes.readUInt16LE(offset + 28);
    if (bytes.toString("utf8", offset + 46, offset + 46 + length) === filename) return bytes.readUInt16LE(offset + 10);
    offset += 46 + length + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  throw new Error(`ZIP member not found: ${filename}`);
}

test("ten editor text edits/saves reuse one shared body/header/footer picture and compress the result", async () => {
  const original = await fixture({ sharedStories: true }), metadata = await readWordMetadata(original);
  let agent = await DocumentAgent.fromBuffer(original);
  for (let i = 0; i < 10; i++) {
    const document = agent.getDocument(), pm = toProseDoc(document);
    const edited = EditorState.create({ doc: pm }).tr.insertText(` edit-${i}`, 1).doc;
    agent = new DocumentAgent(fromProseDoc(edited, document));
    const raw = await agent.toBuffer();
    assert.equal(mediaFiles(await JSZip.loadAsync(raw)).length, 1, "the library's next-save input must stay bounded too");
    const output = await finalizeWordPackage(raw, metadata), zip = await JSZip.loadAsync(output);
    assert.equal(mediaFiles(zip).length, 1);
    for (const owner of ["document", "header1", "footer1"]) assert.deepEqual(await pictureBytes(zip, owner), originalImage);
    assert.equal(compression(output, "word/document.xml"), 8);
    assert.equal(compression(output, "word/styles.xml"), 8);
    assert.ok(output.byteLength < original.byteLength * 2);
  }
});

test("replacing a picture with the old rId preserves the replacement and the shared header original", async () => {
  const agent = await DocumentAgent.fromBuffer(await fixture({ sharedStories: true }));
  const document = agent.getDocument(), pm = toProseDoc(document);
  let state = EditorState.create({ doc: pm });
  pm.descendants((node, pos) => { if (node.type.name === "image") state = state.apply(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: dataUrl(replacementImage) })); });
  const replaced = new DocumentAgent(fromProseDoc(state.doc, document));
  for (let i = 0; i < 3; i++) {
    const zip = await JSZip.loadAsync(await replaced.toBuffer());
    assert.equal(mediaFiles(zip).length, 2);
    assert.deepEqual(await pictureBytes(zip), replacementImage);
    assert.deepEqual(await pictureBytes(zip, "header1"), originalImage);
  }
});

test("deleting, saving, undoing and saving again restores the actual image bytes", async () => {
  let agent = await DocumentAgent.fromBuffer(await fixture());
  let state = EditorState.create({ doc: toProseDoc(agent.getDocument()), plugins: [history()] });
  state.doc.descendants((node, pos) => { if (node.type.name === "image") state = state.apply(state.tr.delete(pos, pos + node.nodeSize)); });
  agent = new DocumentAgent(fromProseDoc(state.doc, agent.getDocument()));
  assert.equal(mediaFiles(await JSZip.loadAsync(await agent.toBuffer())).length, 1, "unused image bytes are intentionally retained");
  assert.ok(undo(state, tr => { state = state.apply(tr); }));
  agent = new DocumentAgent(fromProseDoc(state.doc, agent.getDocument()));
  const restored = await agent.toBuffer(), zip = await JSZip.loadAsync(restored);
  assert.equal(mediaFiles(zip).length, 1);
  assert.deepEqual(await pictureBytes(zip), originalImage);
  assert.equal(mediaFiles(await JSZip.loadAsync(await (await DocumentAgent.fromBuffer(restored)).toBuffer())).length, 1);
});

test("CJS consumers use the same image reuse behavior", async () => {
  const require = createRequire(import.meta.url);
  const { DocumentAgent: CommonJsAgent } = require("@eigenpal/docx-editor-core/agent");
  const agent = await CommonJsAgent.fromBuffer(await fixture());
  for (let i = 0; i < 3; i++) assert.equal(mediaFiles(await JSZip.loadAsync(await agent.toBuffer())).length, 1);
});

test("agent SDK round trips reuse images in their existing bundled writer", async () => {
  let buffer = await fixture({ sharedStories: true });
  for (let i = 0; i < 3; i++) {
    const reviewer = await DocxReviewer.fromBuffer(buffer);
    buffer = await reviewer.toBuffer();
    assert.equal(mediaFiles(await JSZip.loadAsync(buffer)).length, 1);
  }
});

test("an imported EMF keeps its original filename, bytes and content type", async () => {
  // Opaque bytes exercise save metadata preservation, rather than EMF rendering.
  const zip = await JSZip.loadAsync(await fixture());
  zip.remove("word/media/image1.png");
  zip.file("word/media/artwork.emf", originalImage);
  zip.file("word/_rels/document.xml.rels", (await zip.file("word/_rels/document.xml.rels")!.async("string")).replace("image1.png", "artwork.emf"));
  zip.file("[Content_Types].xml", (await zip.file("[Content_Types].xml")!.async("string")).replace("</Types>", '<Default Extension="emf" ContentType="image/x-emf"/></Types>'));
  const agent = await DocumentAgent.fromBuffer(await zip.generateAsync({ type: "arraybuffer" }));
  for (let i = 0; i < 3; i++) {
    const saved = await JSZip.loadAsync(await agent.toBuffer());
    assert.equal(mediaFiles(saved).length, 1);
    assert.deepEqual(await saved.file("word/media/artwork.emf")!.async("nodebuffer"), originalImage);
    assert.match(await saved.file("[Content_Types].xml")!.async("string"), /ContentType="image\/x-emf"/);
  }
});

for (const container of ["hyperlink", "control"]) {
  test(`deleting, saving and restoring a picture inside a ${container} retains its stored image`, async () => {
    const zip = await JSZip.loadAsync(await fixture());
    const xml = await zip.file("word/document.xml")!.async("string");
    const run = `<w:r>${drawing("rId9")}</w:r>`;
    const wrapped = container === "hyperlink" ? `<w:hyperlink w:anchor="bookmark">${run}</w:hyperlink>` : `<w:sdt><w:sdtPr><w:id w:val="123"/></w:sdtPr><w:sdtContent><w:p>${run}</w:p></w:sdtContent></w:sdt>`;
    zip.file("word/document.xml", container === "hyperlink" ? xml.replace(run, wrapped) : xml.replace(run, "").replace("<w:sectPr>", `${wrapped}<w:sectPr>`));
    let agent = await DocumentAgent.fromBuffer(await zip.generateAsync({ type: "arraybuffer" }));
    const doc = agent.getDocument(), original = structuredClone(doc.package.document.content);
    assert.ok(container === "control" ? original.some(block => block.type === "blockSdt") : original.some(block => block.type === "paragraph" && block.content.some(node => node.type === "hyperlink")));
    doc.package.document.content = original.filter(block => block.type !== "blockSdt").map(block => block.type === "paragraph" ? { ...block, content: block.content.filter(node => node.type !== "hyperlink") } : block);
    agent = new DocumentAgent(doc);
    const deleted = await agent.toBuffer();
    assert.equal(mediaFiles(await JSZip.loadAsync(deleted)).length, 1);
    const restored = agent.getDocument();
    restored.package.document.content = original;
    const output = await new DocumentAgent(restored).toBuffer();
    assert.deepEqual(await pictureBytes(await JSZip.loadAsync(output)), originalImage);
    const reviewer = await DocxReviewer.fromBuffer(output);
    const saved = await reviewer.toBuffer();
    assert.deepEqual(await pictureBytes(await JSZip.loadAsync(saved)), originalImage);
  });
}

test("valid escaped filenames and existing unused images remain unchanged", async () => {
  const zip = await JSZip.loadAsync(await fixture());
  const name = "company%20logo%25.png";
  zip.remove("word/media/image1.png");
  zip.file(`word/media/${name}`, originalImage);
  zip.file("word/media/unused.png", replacementImage);
  zip.file("word/_rels/document.xml.rels", (await zip.file("word/_rels/document.xml.rels")!.async("string")).replace("image1.png", name));
  const buffer = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  let agent = await DocumentAgent.fromBuffer(buffer);
  for (let i = 0; i < 3; i++) {
    const output = await finalizeWordPackage(await agent.toBuffer(), await readWordMetadata(buffer));
    const saved = await JSZip.loadAsync(output);
    assert.equal(mediaFiles(saved).length, 2);
    assert.deepEqual(await pictureBytes(saved), originalImage);
    assert.deepEqual(await saved.file("word/media/unused.png")!.async("nodebuffer"), replacementImage);
    assert.match(await saved.file("word/_rels/document.xml.rels")!.async("string"), /Target="media\/company%20logo%25\.png"/);
    agent = await DocumentAgent.fromBuffer(output);
  }
  const reviewer = await DocxReviewer.fromBuffer(buffer);
  assert.deepEqual(await pictureBytes(await JSZip.loadAsync(await reviewer.toBuffer())), originalImage);
});

test("CJS agent SDK uses its own corrected writer", async () => {
  const require = createRequire(import.meta.url);
  const { DocxReviewer: CommonJsReviewer } = require("@eigenpal/docx-editor-agents");
  let buffer = await fixture({ sharedStories: true });
  for (let i = 0; i < 3; i++) {
    buffer = await (await CommonJsReviewer.fromBuffer(buffer)).toBuffer();
    assert.equal(mediaFiles(await JSZip.loadAsync(buffer)).length, 1);
  }
});

test("new pictures use the existing insertion path and remain stable on later saves", async () => {
  const agent = await DocumentAgent.fromBuffer(await fixture());
  const doc = agent.getDocument(), pm = toProseDoc(doc);
  let state = EditorState.create({ doc: pm });
  pm.descendants(node => {
    if (node.type.name !== "image") return;
    const picture = node.type.create({ ...node.attrs, rId: null, src: dataUrl(replacementImage) });
    state = state.apply(state.tr.insert(state.doc.content.size - 1, [picture, picture]));
  });
  const inserted = new DocumentAgent(fromProseDoc(state.doc, doc));
  for (let i = 0; i < 3; i++) {
    const output = await JSZip.loadAsync(await inserted.toBuffer());
    assert.equal(mediaFiles(output).length, 3, "separate inserted pictures are not globally deduplicated");
    const parts = await Promise.all(mediaFiles(output).map(file => file.async("nodebuffer")));
    assert.equal(parts.filter(bytes => bytes.equals(replacementImage)).length, 2);
  }
});

test("review and clean export keep compression and retain unused image files", async () => {
  const zip = await JSZip.loadAsync(await fixture());
  zip.file("word/media/unused.png", replacementImage);
  const original = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  for (const output of [await reviewWordPackage(original, "accept"), await removeWordPrivateData(original, ["comments"]), await createCleanDocx(original)]) {
    assert.equal(compression(output, "word/document.xml"), 8);
    const saved = await JSZip.loadAsync(output);
    assert.equal(mediaFiles(saved).length, 2);
    assert.deepEqual(await pictureBytes(saved), originalImage);
  }
});
