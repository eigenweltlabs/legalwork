/**
 * PowerPoint.js implementations of the agent's ppt_* tools.
 *
 * Contract (mirrored by the legalwork-powerpoint-tools OpenCode plugin):
 * - Slides are addressed by 1-based slide_number; shapes by exact name or
 *   1-based index within the slide.
 * - PowerPoint has neither tracked changes nor a comments API, so the
 *   safety pattern is behavioral: the plugin instructs the agent to report
 *   every slide/shape it changed (and edits are undoable with Cmd+Z).
 * - Handlers throw Error with a model-readable message; the relay client
 *   converts that into { ok: false, error } for the tool result.
 */
import { getDocumentUrl } from "./office";
import { runOfficeCode } from "./office-run-code";
import {
  isPowerPointApiSupported,
  powerPointRun,
  type PptRunContext,
  type PptShape,
  type PptSlide,
} from "./powerpoint-api";
import type { WordToolHandler } from "./word-document-tools";

const MAX_TEXT_PER_SHAPE = 4_000;
const MAX_TOTAL_CHARS = 60_000;

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireEditingSupport(): void {
  if (!isPowerPointApiSupported("1.4")) {
    throw new Error(
      "This PowerPoint version does not support editing shape text from add-ins (requires PowerPointApi 1.4). Ask the user to update PowerPoint/Microsoft 365.",
    );
  }
}

async function loadSlides(context: PptRunContext): Promise<PptSlide[]> {
  const slides = context.presentation.slides;
  slides.load("items/id");
  await context.sync();
  return slides.items;
}

function pickSlide(slides: PptSlide[], slideNumber: number): PptSlide {
  if (slideNumber < 1 || slideNumber > slides.length) {
    throw new Error(`slide_number ${slideNumber} is out of range: the presentation has ${slides.length} slide(s).`);
  }
  return slides[slideNumber - 1]!;
}

async function loadShapeTexts(context: PptRunContext, slide: PptSlide): Promise<PptShape[]> {
  const shapes = slide.shapes;
  shapes.load("items/id,items/name,items/textFrame/hasText,items/textFrame/textRange/text");
  await context.sync();
  return shapes.items;
}

function shapeText(shape: PptShape): string | null {
  try {
    if (!shape.textFrame?.hasText) return null;
    return shape.textFrame.textRange.text ?? null;
  } catch {
    return null;
  }
}

function describeSlideShapes(shapes: PptShape[]): Array<{ index: number; name: string; text: string }> {
  return shapes.flatMap((shape, index) => {
    const text = shapeText(shape);
    return text && text.trim()
      ? [{ index: index + 1, name: shape.name, text: text.slice(0, MAX_TEXT_PER_SHAPE) }]
      : [];
  });
}

function pickShape(shapes: PptShape[], ref: string): { shape: PptShape; index: number } {
  const byName = shapes
    .map((shape, index) => ({ shape, index }))
    .filter(({ shape }) => shape.name === ref);
  if (byName.length === 1) return { shape: byName[0]!.shape, index: byName[0]!.index };
  if (byName.length > 1) {
    throw new Error(`Shape name "${ref}" is ambiguous on this slide (${byName.length} shapes). Use the 1-based shape index instead.`);
  }
  const asIndex = Number(ref);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= shapes.length) {
    return { shape: shapes[asIndex - 1]!, index: asIndex - 1 };
  }
  throw new Error(
    `Shape "${ref}" not found. Available shapes: ${shapes.map((shape, index) => `${index + 1}:"${shape.name}"`).join(", ") || "none"}.`,
  );
}

async function readPresentation(): Promise<unknown> {
  return powerPointRun(async (context) => {
    const slides = await loadSlides(context);
    // Sequential on purpose: Office.js batches loads per context and
    // interleaved sync() calls from parallel loops are not deterministic.
    const loaded: PptShape[][] = [];
    for (const slide of slides) {
      loaded.push(await loadShapeTexts(context, slide).catch(() => [] as PptShape[]));
    }
    let total = 0;
    let truncated = false;
    const outline = slides.map((slide, index) => {
      const texts = describeSlideShapes(loaded[index] ?? []);
      const kept = texts.filter((entry) => {
        if (total + entry.text.length > MAX_TOTAL_CHARS) {
          truncated = true;
          return false;
        }
        total += entry.text.length;
        return true;
      });
      return { slide: index + 1, shapes: kept };
    });
    return {
      documentUrl: getDocumentUrl(),
      slideCount: slides.length,
      truncated,
      slides: outline,
    };
  });
}

async function readSlide(args: Record<string, unknown>): Promise<unknown> {
  const slideNumber = numberArg(args, "slide_number");
  if (!slideNumber) throw new Error("slide_number is required (1-based).");
  return powerPointRun(async (context) => {
    const slides = await loadSlides(context);
    const slide = pickSlide(slides, slideNumber);
    const shapes = await loadShapeTexts(context, slide);
    return {
      slide: slideNumber,
      slideCount: slides.length,
      shapes: shapes.map((shape, index) => ({
        index: index + 1,
        name: shape.name,
        text: shapeText(shape)?.slice(0, MAX_TEXT_PER_SHAPE) ?? null,
      })),
    };
  });
}

async function readSelection(): Promise<unknown> {
  if (!isPowerPointApiSupported("1.5")) {
    throw new Error("Reading the selection requires PowerPointApi 1.5.");
  }
  return powerPointRun(async (context) => {
    const textRange = context.presentation.getSelectedTextRangeOrNullObject();
    textRange.load("text");
    const selectedSlides = context.presentation.getSelectedSlides();
    selectedSlides.load("items/id");
    await context.sync();
    const slides = context.presentation.slides;
    slides.load("items/id");
    await context.sync();
    const selectedNumbers = selectedSlides.items.map(
      (slide) => slides.items.findIndex((candidate) => candidate.id === slide.id) + 1,
    );
    return {
      selectedText: textRange.isNullObject ? null : textRange.text,
      selectedSlides: selectedNumbers.filter((value) => value > 0),
    };
  });
}

async function setShapeText(args: Record<string, unknown>): Promise<unknown> {
  const slideNumber = numberArg(args, "slide_number");
  const shapeRef = stringArg(args, "shape");
  const text = stringArg(args, "text") ?? (typeof args.text === "string" ? args.text : undefined);
  if (!slideNumber) throw new Error("slide_number is required (1-based).");
  if (!shapeRef) throw new Error("shape is required (exact shape name or 1-based index).");
  if (text === undefined) throw new Error("text is required (empty string clears the shape).");
  requireEditingSupport();

  return powerPointRun(async (context) => {
    const slides = await loadSlides(context);
    const slide = pickSlide(slides, slideNumber);
    const shapes = await loadShapeTexts(context, slide);
    const { shape, index } = pickShape(shapes, shapeRef);
    const previous = shapeText(shape);
    shape.textFrame.textRange.text = text;
    await context.sync();
    return {
      applied: true,
      slide: slideNumber,
      shape: { index: index + 1, name: shape.name },
      previousText: previous,
    };
  });
}

async function replaceText(args: Record<string, unknown>): Promise<unknown> {
  const find = stringArg(args, "find");
  const replace = args.replace;
  const slideNumber = numberArg(args, "slide_number");
  const occurrence = numberArg(args, "occurrence");
  if (!find) throw new Error("find is required.");
  if (typeof replace !== "string") throw new Error("replace is required (empty string deletes the text).");
  requireEditingSupport();

  return powerPointRun(async (context) => {
    const slides = await loadSlides(context);
    const targets = slideNumber ? [pickSlide(slides, slideNumber)] : slides;
    const matches: Array<{ slide: number; shape: PptShape; shapeIndex: number; count: number }> = [];
    for (const slide of targets) {
      const slideIndex = slides.indexOf(slide) + 1;
      const shapes = await loadShapeTexts(context, slide);
      shapes.forEach((shape, index) => {
        const text = shapeText(shape);
        if (!text) return;
        const count = text.split(find).length - 1;
        if (count > 0) matches.push({ slide: slideIndex, shape, shapeIndex: index + 1, count });
      });
    }

    const totalOccurrences = matches.reduce((sum, match) => sum + match.count, 0);
    if (totalOccurrences === 0) {
      throw new Error(`"${find}" was not found${slideNumber ? ` on slide ${slideNumber}` : ""}. Text matching is exact and case-sensitive.`);
    }
    if (totalOccurrences > 1 && occurrence === undefined) {
      const locations = matches
        .map((match) => `slide ${match.slide} shape ${match.shapeIndex} ("${match.shape.name}") x${match.count}`)
        .join("; ");
      throw new Error(`"${find}" matches ${totalOccurrences} times: ${locations}. Pass occurrence (1-${totalOccurrences}) to pick one.`);
    }

    const target = occurrence ?? 1;
    if (target < 1 || target > totalOccurrences) {
      throw new Error(`occurrence ${target} is out of range (1-${totalOccurrences}).`);
    }
    let seen = 0;
    for (const match of matches) {
      if (target > seen + match.count) {
        seen += match.count;
        continue;
      }
      const within = target - seen; // 1-based occurrence inside this shape
      const text = shapeText(match.shape) ?? "";
      let position = -1;
      for (let i = 0; i < within; i += 1) {
        position = text.indexOf(find, position + 1);
      }
      const updated = text.slice(0, position) + replace + text.slice(position + find.length);
      match.shape.textFrame.textRange.text = updated;
      await context.sync();
      return {
        applied: true,
        slide: match.slide,
        shape: { index: match.shapeIndex, name: match.shape.name },
        occurrence: target,
        totalOccurrences,
      };
    }
    throw new Error("Internal error: occurrence resolution failed.");
  });
}

async function addSlide(): Promise<unknown> {
  if (!isPowerPointApiSupported("1.3")) {
    throw new Error("Adding slides requires PowerPointApi 1.3.");
  }
  return powerPointRun(async (context) => {
    context.presentation.slides.add();
    await context.sync();
    const slides = context.presentation.slides;
    slides.load("items/id");
    await context.sync();
    return { added: true, slide: slides.items.length, slideCount: slides.items.length };
  });
}

async function addTextBox(args: Record<string, unknown>): Promise<unknown> {
  const slideNumber = numberArg(args, "slide_number");
  const text = stringArg(args, "text");
  if (!slideNumber) throw new Error("slide_number is required (1-based).");
  if (!text) throw new Error("text is required.");
  requireEditingSupport();

  return powerPointRun(async (context) => {
    const slides = await loadSlides(context);
    const slide = pickSlide(slides, slideNumber);
    const shape = slide.shapes.addTextBox(text, {
      left: numberArg(args, "left") ?? 50,
      top: numberArg(args, "top") ?? 50,
      width: numberArg(args, "width") ?? 500,
      height: numberArg(args, "height") ?? 100,
    });
    shape.load("id,name");
    await context.sync();
    return { applied: true, slide: slideNumber, shape: { name: shape.name } };
  });
}

export function createPowerPointToolHandlers(): Record<string, WordToolHandler> {
  return {
    ppt_read_presentation: readPresentation,
    ppt_read_slide: readSlide,
    ppt_read_selection: readSelection,
    ppt_set_shape_text: setShapeText,
    ppt_replace_text: replaceText,
    ppt_add_slide: addSlide,
    ppt_add_text_box: addTextBox,
    ppt_run_code: (args) => runOfficeCode("powerpoint", args),
  };
}
