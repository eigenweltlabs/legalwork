import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import JSZip from "jszip";

const reviewMarkup = /<(?:[\w.-]+:)?(?:ins|del|delText|delInstrText|conflictIns|conflictDel|move(?:From|To)(?:Range(?:Start|End))?|customXml(?:Ins|Del|MoveFrom|MoveTo)Range(?:Start|End)|\w+PrChange|tblGridChange|numberingChange|cellIns|cellDel|cellMerge|comment|commentRangeStart|commentRangeEnd|commentReference)\b/;

/** Work on a detached copy. Never accept changes in the user's live editor. */
export async function createCleanDocx(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const reviewer = await DocxReviewer.fromBuffer(buffer.slice(0));
  reviewer.acceptAll({ includeFootnotes: true, includeEndnotes: true });
  for (const comment of reviewer.getComments()) reviewer.removeComment(comment.id);
  const output = await reviewer.toBuffer();
  const zip = await JSZip.loadAsync(output);
  // The pinned serializer keeps original comment parts when the model is empty.
  // Clear their contents, retaining valid roots and existing relationships.
  for (const [path, file] of Object.entries(zip.files)) {
    if (!/^word\/comments[^/]*\.xml$/.test(path)) continue;
    const xml = await file.async("string");
    zip.file(path, xml.replace(/(<(?:[\w.-]+:)?(?:comments|commentsEx|commentsIds|commentsExtensible)\b[^>]*>)[\s\S]*(<\/(?:[\w.-]+:)?(?:comments|commentsEx|commentsIds|commentsExtensible)>)/, "$1$2"));
  }
  for (const [path, file] of Object.entries(zip.files)) {
    if (!path.startsWith("word/") || !path.endsWith(".xml")) continue;
    if (reviewMarkup.test(await file.async("string"))) {
      throw new Error("This document contains review markup that cannot yet be removed safely. Download a copy with markup and finish the clean copy in Word.");
    }
  }
  return await zip.generateAsync({ type: "arraybuffer" });
}

export function downloadDocx(buffer: ArrayBuffer, name: string) {
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
