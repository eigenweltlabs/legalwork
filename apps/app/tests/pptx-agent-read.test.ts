import { describe, expect, mock, test } from "bun:test";
import type { PowerPointViewerHandle } from "pptx-react-viewer/viewer";
import { readPptxContent } from "../src/react-app/domains/session/artifacts/pptx-agent-read";

function presentation() {
  const slides: ReturnType<PowerPointViewerHandle["getSlides"]> = Array.from({ length: 24 }, (_, index) => ({
    id: `slide-${index}`, rId: `rId${index}`, slideNumber: index + 1,
    hidden: index === 23, notes: `Notes for slide ${index + 1}`,
    elements: [{ id: `title-${index}`, type: "text", x: 20, y: 30, width: 800, height: 50, text: `Slide ${index + 1}`, textStyle: { bold: true, fontSize: 32 } }],
  }));
  const box = { x: 20, y: 100, width: 400, height: 200 };
  slides[23].elements.push(
    { ...box, id: "group", type: "group", children: [{ ...box, id: "nested-text", type: "text", text: "Unsaved nested content" }] },
    { ...box, id: "table", type: "table", tableData: { columnWidths: [100, 100], rows: [{ cells: [{ text: "Revenue" }, { text: "42" }] }] } },
    { ...box, id: "chart", type: "chart", chartData: { title: "Results", chartType: "bar", categories: ["Q1"], series: [{ name: "Sales", values: [42] }] } },
    { ...box, id: "diagram", type: "smartArt", smartArtData: { nodes: [{ id: "parent", text: "Stage one", children: [{ id: "child", text: "Stage two" }] }] } },
    { ...box, id: "image", type: "image", altText: "Company logo" },
  );
  return {
    getSlides: () => slides,
    getActiveSlideIndex: () => 7,
    getSelectedElementIds: () => ["title-7"],
    setActiveSlideIndex: mock(() => { throw new Error("Reads must not navigate"); }),
    selectElements: mock(() => { throw new Error("Reads must not change selection"); }),
    getContent: mock(() => { throw new Error("Reads must use the live draft without serializing it"); }),
  };
}

describe("PowerPoint content reads", () => {
  test("reads every slide including hidden slides, notes and structured content in one call", () => {
    const api = presentation();
    const before = JSON.stringify(api.getSlides());
    const result = readPptxContent(api);
    expect(result.slideCount).toBe(24);
    expect(result.slides).toHaveLength(24);
    expect(result.slides[23]).toMatchObject({
      slideIndex: 23, hidden: true, notes: "Notes for slide 24",
      elements: [
        { id: "title-23", text: "Slide 24" },
        { id: "group", children: [{ id: "nested-text", text: "Unsaved nested content" }] },
        { id: "table", rows: [["Revenue", "42"]] },
        { id: "chart", chart: { title: "Results", categories: ["Q1"], series: [{ name: "Sales", values: [42] }] } },
        { id: "diagram", nodes: [{ text: "Stage one", children: [{ text: "Stage two" }] }] },
        { id: "image", altText: "Company logo" },
      ],
    });
    expect(result).toMatchObject({ activeSlideIndex: 7, selectedElementIds: ["title-7"] });
    expect(api.setActiveSlideIndex).not.toHaveBeenCalled();
    expect(api.selectElements).not.toHaveBeenCalled();
    expect(api.getContent).not.toHaveBeenCalled();
    expect(JSON.stringify(api.getSlides())).toBe(before);
  });

  test("a targeted read returns another slide without moving the user's current slide", () => {
    const api = presentation();
    expect(readPptxContent(api, 0)).toMatchObject({
      slideIndex: 0, activeSlideIndex: 7, selectedElementIds: ["title-7"],
      elements: [{ id: "title-0", text: "Slide 1" }], notes: "Notes for slide 1",
    });
    expect(api.setActiveSlideIndex).not.toHaveBeenCalled();
    expect(api.selectElements).not.toHaveBeenCalled();
  });

  test("whole-deck reads omit repeated formatting while targeted reads retain it", () => {
    const api = presentation();
    for (const slide of api.getSlides()) for (const element of slide.elements) {
      if (element.type === "text") element.textSegments = [{ text: element.text ?? "", style: { fontSize: 32, bold: true } }];
    }
    const compact = JSON.stringify(readPptxContent(api));
    expect(compact).not.toContain('"textRuns"');
    expect(compact).not.toContain('"textStyle"');
    expect(compact).not.toContain('"width"');
    expect(readPptxContent(api, 0)).toMatchObject({ elements: [{ id: "title-0", width: 800, textStyle: { fontSize: 32 }, textRuns: [{ text: "Slide 1", fontSize: 32 }] }] });
  });

  test("rejects missing slides and unloaded decks without navigating", () => {
    const api = presentation();
    expect(() => readPptxContent(api, 24)).toThrow();
    expect(() => readPptxContent({ ...api, getSlides: () => [] })).toThrow();
    expect(api.setActiveSlideIndex).not.toHaveBeenCalled();
  });
});
