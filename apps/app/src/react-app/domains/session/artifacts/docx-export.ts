import JSZip from "jszip";
import { t } from "@/i18n";
import { elements, finalizeWordPackage, parseXml, readWordMetadata, reviewWordPackage, xmlText } from "./docx-word-package";

const reviewMarkup = /<(?:[\w.-]+:)?(?:ins|del|delText|delInstrText|conflictIns|conflictDel|move(?:From|To)(?:Range(?:Start|End))?|customXml(?:Ins|Del|MoveFrom|MoveTo)Range(?:Start|End)|\w+PrChange|tblGridChange|numberingChange|cellIns|cellDel|cellMerge|comment|commentRangeStart|commentRangeEnd|commentReference)\b/;

/** Work on a detached copy. Never accept changes in the user's live editor. */
export async function createCleanDocx(buffer: ArrayBuffer, options = { acceptChanges: true, removeComments: true }): Promise<ArrayBuffer> {
  const output = options.acceptChanges ? await reviewWordPackage(buffer, "accept") : buffer.slice(0);
  const zip = await JSZip.loadAsync(output);
  // Retain valid comment-part roots and relationships while clearing content.
  for (const [path, file] of Object.entries(zip.files)) {
    if (!options.removeComments || !/^word\/comments[^/]*\.xml$/.test(path)) continue;
    const xml = await file.async("string");
    zip.file(path, xml.replace(/(<(?:[\w.-]+:)?(?:comments|commentsEx|commentsIds|commentsExtensible)\b[^>]*>)[\s\S]*(<\/(?:[\w.-]+:)?(?:comments|commentsEx|commentsIds|commentsExtensible)>)/, "$1$2"));
  }
  for (const [path, file] of Object.entries(zip.files)) {
    if (!path.startsWith("word/") || !path.endsWith(".xml")) continue;
    const doc = parseXml(await file.async("string"));
    if (options.removeComments) for (const kind of ["commentRangeStart", "commentRangeEnd", "commentReference"]) for (const node of elements(doc, kind)) node.parentNode?.removeChild(node);
    zip.file(path, xmlText(doc));
    if (options.acceptChanges && options.removeComments && reviewMarkup.test(xmlText(doc))) {
      throw new Error(t("artifact.markup_blocked"));
    }
  }
  return finalizeWordPackage(await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }), await readWordMetadata(buffer));
}

export function downloadDocx(buffer: ArrayBuffer, name: string) {
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
