import { test } from "node:test";
import assert from "node:assert/strict";
import { measureRun, resetCanvasContext } from "@eigenpal/docx-editor-core/layout-bridge/measuring";

function rawWidth(character: string) {
  return character.charCodeAt(0) % 19 + 1;
}

function withCanvas(check: (canvas: ReturnType<typeof createCanvas>) => void) {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const canvas = createCanvas();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ getContext: () => canvas.context }) },
  });
  resetCanvasContext();
  try {
    check(canvas);
  } finally {
    resetCanvasContext();
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
}

function createCanvas() {
  const calls: string[] = [];
  let fontScale = 1;
  const context = {
    font: "16px sans-serif",
    direction: "ltr",
    fontKerning: "auto",
    measureText(text: string) {
      calls.push(text);
      const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 16) / 16;
      const kerning = this.fontKerning === "none" ? 2 : 1;
      return {
        width: text.split("").reduce((width, character) => width + rawWidth(character), 0) * size * fontScale * kerning,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
      };
    },
  };
  return { context, calls, setFontScale(value: number) { fontScale = value; } };
}

const style = { fontFamily: "Calibri", fontSize: 12 };

test("repeated characters reuse exact widths across typing transactions", () => {
  withCanvas(({ calls }) => {
    const text = "aabb abba ".repeat(40);
    const result = measureRun(text, style);
    assert.deepEqual(result.charWidths, text.split("").map(rawWidth));
    assert.equal(result.width, result.charWidths.reduce((sum, width) => sum + width, 0));
    assert.equal(calls.filter((text) => text !== "Hg").length, 3);
    measureRun(text + "a", style);
    assert.equal(calls.filter((text) => text !== "Hg").length, 3);
  });
});

test("cached widths preserve letter spacing, CJK and UTF-16 surrogate positions", () => {
  withCanvas(() => {
    const text = "a😀漢é a😀漢é";
    measureRun(text, style);
    const result = measureRun(text, { ...style, letterSpacing: 2 });
    const expected = text.split("").map((character, index) => rawWidth(character) + (index < text.length - 1 ? 2 : 0));
    assert.equal(result.charWidths.length, text.length);
    assert.deepEqual(result.charWidths, expected);
    assert.equal(result.width, expected.reduce((sum, width) => sum + width, 0));
  });
});

test("font size, canvas shaping state and loaded fonts invalidate cached widths", () => {
  withCanvas(({ context, setFontScale }) => {
    const width = measureRun("aaa", style).width;
    assert.equal(measureRun("aaa", { ...style, fontSize: 24 }).width, width * 2);
    context.fontKerning = "none";
    assert.equal(measureRun("aaa", style).width, width * 2);
    context.fontKerning = "auto";
    setFontScale(3);
    resetCanvasContext();
    assert.equal(measureRun("aaa", style).width, width * 3);
  });
});

test("the character cache stays bounded and evicted widths are remeasured", () => {
  withCanvas(({ calls }) => {
    measureRun("a", style);
    const manyCharacters = Array.from({ length: 1100 }, (_, index) => String.fromCharCode(0x1000 + index)).join("");
    measureRun(manyCharacters, style);
    const before = calls.filter((text) => text === "a").length;
    assert.equal(measureRun("a", style).width, rawWidth("a"));
    assert.equal(calls.filter((text) => text === "a").length, before + 1);
  });
});
