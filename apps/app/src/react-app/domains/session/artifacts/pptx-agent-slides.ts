import type { PowerPointViewerHandle } from "pptx-react-viewer/viewer";
import { pptxAddSlideSchema } from "@legalwork/types/office-editor";
import { readPptxContent } from "./pptx-agent-read";

type SlideEditor = Pick<PowerPointViewerHandle, "getSlides" | "getSlide" | "getActiveSlideIndex" | "getSelectedElementIds" | "duplicateSlides" | "moveSlide" | "setActiveSlideIndex" | "updateElement">;

/** Reacquire the React handle after each render; its mutations close over the active slide. */
export async function addPptxSlide(getEditor: () => SlideEditor, rawArgs: unknown, settle: () => Promise<void>) {
  const args = pptxAddSlideSchema.parse(rawArgs);
  const api = getEditor();
  const source = api.getSlide(args.templateSlideIndex);
  if (!source) throw new Error("Template slide not found. Read the presentation again.");
  const insertIndex = args.insertIndex ?? args.templateSlideIndex + 1;
  if (insertIndex > api.getSlides().length) throw new Error("insertIndex must be between 0 and slideCount.");
  const replacements = args.replacements ?? [];
  const seen = new Set<string>();
  // Validate every change before creating anything, so bad IDs cannot leave a partial slide.
  const edits = replacements.map(({ elementId, text }) => {
    if (seen.has(elementId)) throw new Error(`Duplicate replacement for ${elementId}.`);
    seen.add(elementId);
    const index = source.elements.findIndex(element => element.id === elementId);
    const element = source.elements[index];
    if (!element || (element.type !== "text" && element.type !== "shape")) throw new Error(`Template element ${elementId} is not an editable text box or shape.`);
    return { index, text, textStyle: element.textStyle, runStyle: element.textSegments?.[0]?.style };
  });

  api.duplicateSlides([args.templateSlideIndex]);
  await settle();
  const cloneIndex = args.templateSlideIndex + 1;
  if (insertIndex !== cloneIndex) {
    getEditor().moveSlide(cloneIndex, insertIndex);
    await settle();
  }
  getEditor().setActiveSlideIndex(insertIndex);
  await settle();
  const clone = getEditor().getSlide(insertIndex);
  if (!clone || clone.id === source.id) throw new Error("The editor did not create the slide. Inspect the draft before retrying.");
  for (const edit of edits) {
    const element = clone.elements[edit.index];
    getEditor().updateElement(element.id, {
      text: edit.text,
      textStyle: edit.textStyle,
      textSegments: [{ text: edit.text, style: { ...edit.textStyle, ...edit.runStyle } }],
    });
    await settle();
  }
  return { mutated: true, data: readPptxContent(getEditor(), insertIndex) };
}
