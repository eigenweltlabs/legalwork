import type { PowerPointViewerHandle } from "pptx-react-viewer/viewer";
import { t } from "@/i18n";

type PresentationReader = Pick<PowerPointViewerHandle, "getSlides" | "getActiveSlideIndex" | "getSelectedElementIds">;
type SlideElement = ReturnType<PowerPointViewerHandle["getElements"]>[number];

function readElement(element: SlideElement, detail: boolean): Record<string, unknown> {
  return {
    id: element.id, name: element.name, type: element.type,
    ...(detail ? { x: element.x, y: element.y, width: element.width, height: element.height } : {}),
    ...("text" in element ? {
      text: element.text,
      ...(detail ? {
        textStyle: { fontSize: element.textStyle?.fontSize, fontFamily: element.textStyle?.fontFamily, bold: element.textStyle?.bold, align: element.textStyle?.align },
        textRuns: element.textSegments?.map(segment => ({ text: segment.text, fontSize: segment.style?.fontSize, bold: segment.style?.bold })),
      } : {}),
    } : {}),
    ...("altText" in element ? { altText: element.altText } : {}),
    ...(element.type === "group" ? { children: element.children.map(child => readElement(child, detail)) } : {}),
    ...(element.type === "chart" ? { chart: {
      title: element.chartData?.title, type: element.chartData?.chartType, categories: element.chartData?.categories,
      series: element.chartData?.series.map(series => ({ name: series.name, values: series.values, xValues: series.xValues, bubbleSizes: series.bubbleSizes })),
    } } : {}),
    ...(element.type === "table" ? { rows: element.tableData?.rows.map(row => row.cells.map(cell => cell.text)) } : {}),
    ...(element.type === "smartArt" ? { nodes: element.smartArtData?.nodes.map(function readNode(node): Record<string, unknown> { return { id: node.id, text: node.text, parentId: node.parentId, children: node.children?.map(readNode) }; }) } : {}),
  };
}

/** Read the live model, never the rendered canvas or a navigation API. */
export function readPptxContent(api: PresentationReader, slideIndex?: number) {
  const slides = api.getSlides();
  if (!slides.length) throw new Error(t("pptx.still_loading"));
  const context = {
    activeSlideIndex: api.getActiveSlideIndex(),
    selectedElementIds: api.getSelectedElementIds(),
    slideCount: slides.length,
  };
  const content = (slide: typeof slides[number], index: number) => ({
    slideIndex: index, name: slide.name, hidden: slide.hidden,
    elements: slide.elements.map(element => readElement(element, slideIndex !== undefined)), notes: slide.notes,
  });
  if (slideIndex === undefined) return { ...context, slides: slides.map(content) };
  const slide = slides[slideIndex];
  if (!slide) throw new Error(t("pptx.slide_not_found"));
  return {
    ...context, ...content(slide, slideIndex),
    slides: slides.map((item, index) => ({ index, elementCount: item.elements.length })),
  };
}
