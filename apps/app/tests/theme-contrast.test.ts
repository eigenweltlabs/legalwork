import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../../packages/ui/src/styles/tokens.css", import.meta.url), "utf8");

function palette(selector: string) {
  const body = css.split(selector)[1]?.split("}")[0];
  if (!body) throw new Error(`Missing palette: ${selector}`);
  return Object.fromEntries([...body.matchAll(/(--lw-[\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1], match[2]]));
}

function luminance(hex: string) {
  const linear = [1, 3, 5].map((offset) => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

const dark = palette('[data-theme="dark"] {');
const blackout = { ...dark, ...palette('[data-theme="dark"][data-appearance="blackout"] .dark {') };

for (const [name, tokens] of Object.entries({ dark, blackout })) {
  test(`${name}: readable text on every main application surface (WCAG AA)`, () => {
    for (const text of ["primary", "content", "secondary", "tertiary", "placeholder"]) {
      for (const surface of ["canvas", "surface", "surface-hover", "sunken", "sidebar", "chrome"]) {
        const fg = luminance(tokens[`--lw-text-${text}`]);
        const bg = luminance(tokens[`--lw-${surface}`]);
        expect((fg + 0.05) / (bg + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect((luminance(tokens["--lw-primary"]) + 0.05) / (luminance(tokens["--lw-primary-fg"]) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
}
