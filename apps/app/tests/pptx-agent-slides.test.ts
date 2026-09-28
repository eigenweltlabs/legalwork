import { describe, expect, test } from "bun:test";
import type { PowerPointViewerHandle } from "pptx-react-viewer/viewer";
import { addPptxSlide } from "../src/react-app/domains/session/artifacts/pptx-agent-slides";

type Slide = NonNullable<ReturnType<PowerPointViewerHandle["getSlide"]>>;
function editor() {
  const slides: Slide[] = Array.from({ length: 3 }, (_, index) => ({
    id: `slide-${index}`, rId: `rId${index}`, slideNumber: index + 1, layoutPath: "ppt/slideLayouts/slideLayout1.xml",
    elements: [
      { id: `title-${index}`, type: "text", x: 20, y: 30, width: 800, height: 80, text: `Original ${index}`, textStyle: { fontSize: 32, bold: true }, textSegments: [{ text: `Original ${index}`, style: { fontSize: 32, bold: true } }] },
      { id: `image-${index}`, type: "image", x: 40, y: 140, width: 400, height: 250, altText: "Logo" },
    ],
  }));
  let active = 2;
  const pending: (() => void)[] = [];
  return {
    slides,
    settle: async () => { for (const commit of pending.splice(0)) commit(); },
    // Each handle captures its slide, like the real React editor.
    getEditor: () => {
      const currentSlide = active;
      return {
        getSlides: () => slides,
        getSlide: (index: number) => slides[index],
        getActiveSlideIndex: () => active,
        getSelectedElementIds: () => [],
        setActiveSlideIndex: (index: number) => { pending.push(() => { active = index; }); },
        duplicateSlides: (indexes: number[]) => { pending.push(() => {
          for (const index of indexes) {
            const source = slides[index];
            slides.splice(index + 1, 0, { ...source, id: `${source.id}-new`, elements: source.elements.map(element => ({ ...element, id: `${element.id}-new` })) });
          }
        }); },
        moveSlide: (from: number, to: number) => { pending.push(() => { const [slide] = slides.splice(from, 1); slides.splice(to, 0, slide); active = to; }); },
        updateElement: (id: string, updates: Parameters<PowerPointViewerHandle["updateElement"]>[1]) => { pending.push(() => {
          const slide = slides[currentSlide];
          slide.elements = slide.elements.map(element => element.id === id ? { ...element, ...updates, type: element.type } : element);
        }); },
      };
    },
  };
}

describe("add a slide using an existing design", () => {
  for (const insertIndex of [0, 1, 3]) {
    test(`inserts at ${insertIndex}, fills the copy, and preserves existing slides`, async () => {
      const api = editor();
      const before = structuredClone(api.slides);
      const result = await addPptxSlide(api.getEditor, { path: "Deck.pptx", templateSlideIndex: 1, insertIndex, replacements: [{ elementId: "title-1", text: "Eigenwelt Labs\nIntroduction" }] }, api.settle);
      expect(result.mutated).toBe(true);
      expect(result.data).toMatchObject({ slideCount: 4, slideIndex: insertIndex, elements: [{ id: "title-1-new", text: "Eigenwelt Labs\nIntroduction", textStyle: { fontSize: 32, bold: true } }, { id: "image-1-new", altText: "Logo" }] });
      expect(api.slides[insertIndex].layoutPath).toBe(before[1].layoutPath);
      expect(api.slides.filter(slide => slide.id !== "slide-1-new")).toEqual(before);
    });
  }
  test("defaults to immediately after the template and supports an unchanged copy", async () => {
    const api = editor();
    const result = await addPptxSlide(api.getEditor, { path: "Deck.pptx", templateSlideIndex: 1 }, api.settle);
    expect(result.data).toMatchObject({ slideIndex: 2, elements: [{ text: "Original 1" }, { altText: "Logo" }] });
  });
  test("rejects invalid indexes, duplicate IDs and non-text replacements before changing the deck", async () => {
    for (const args of [
      { templateSlideIndex: 9 }, { templateSlideIndex: 0, insertIndex: 4 },
      { templateSlideIndex: 0, replacements: [{ elementId: "missing", text: "No" }] },
      { templateSlideIndex: 0, replacements: [{ elementId: "image-0", text: "No" }] },
      { templateSlideIndex: 0, replacements: [{ elementId: "title-0", text: "One" }, { elementId: "title-0", text: "Two" }] },
    ]) {
      const api = editor();
      const before = structuredClone(api.slides);
      await expect(addPptxSlide(api.getEditor, { path: "Deck.pptx", ...args }, api.settle)).rejects.toThrow();
      await api.settle();
      expect(api.slides).toEqual(before);
    }
  });
});
