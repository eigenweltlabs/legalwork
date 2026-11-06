import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import DOMPurify from "dompurify";
import { MemoryRouter } from "react-router-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { Marked } from "marked";
import markedShiki from "marked-shiki";
import { markedMath } from "../src/lib/markdown-math";
import { MarkdownBlock } from "../src/components/markdown/markdown";
import { MarkdownBlock as SurfaceMarkdownBlock } from "../src/react-app/domains/session/surface/markdown";

describe("math in answers", () => {
  // Bun has no browser DOM. Sanitization is verified separately in the browser.
  beforeAll(() => Object.defineProperty(DOMPurify, "sanitize", {
    value: (html: string) => html,
    configurable: true,
  }));
  afterAll(() => { Reflect.deleteProperty(DOMPurify, "sanitize"); });

  for (const [name, Component] of [["chat", MarkdownBlock], ["surface", SurfaceMarkdownBlock]] satisfies [string, typeof MarkdownBlock][]) {
    const render = (text: string, streaming = false) => renderToStaticMarkup(<MemoryRouter><Component text={text} streaming={streaming} /></MemoryRouter>);

    test(`${name}: renders euro amounts and display calculations`, () => {
      const html = render(String.raw`Gesamterlös: $180,00 - 66,00 = $ $\mathbf{114,00\text{\euro/MWh}}$

$$140{,}00\text{\euro} - 31{,}86\text{\euro} = \mathbf{108{,}14\text{\euro/MWh}}$$`);
      expect(html).toContain('class="katex"');
      expect(html).toContain('class="katex-display"');
      expect(html).toContain("€");
      expect(html).not.toContain('class="katex-error"');
      expect(html).toContain("<math");
    });

    test(`${name}: renders math while streaming and tolerates partial formulas`, () => {
      expect(render(String.raw`Betrag: $\mathbf{114,00\text{\euro/MWh}}$`, true)).toContain('class="katex"');
      expect(render(String.raw`Betrag: $\mathbf{114,00`, true)).toContain("114,00");
    });

    test(`${name}: preserves prices, escaped dollars and code`, () => {
      for (const source of ["Costs $10 and $20.", String.raw`Costs \$10 and \$20.`, "`$x + y$`", "```tex\n$x + y$\n```", "An unmatched $ delimiter."]) {
        expect(render(source)).not.toContain('class="katex"');
      }
      expect(render("Costs $10 and $20.")).toContain("Costs $10 and $20.");
      expect(render("Costs $10 and $20. Formula: $x + y$")).toContain("Costs $10 and $20. Formula: ");
      expect(render("`$x + y$`")).toContain("$x + y$");
    });

    test(`${name}: renders standard delimiters, multiline blocks, tables and formulas with underscores`, () => {
      for (const source of [String.raw`\(x_1 + x_2\)`, String.raw`\[x_1 + x_2\]`, "$$\nx_1 + x_2\n\n+ x_3\n$$", "\\[\nx_1 + x_2\n\\]", "| Amount |\n| --- |\n| $x_1 + x_2$ |", "- Total: $x_1 + x_2$"]) {
        const html = render(source);
        expect(html).toContain('class="katex"');
        expect(html).not.toContain('class="katex-error"');
      }
    });

    test(`${name}: rejects trusted HTML commands and tolerates invalid TeX`, () => {
      const html = render(String.raw`$\href{javascript:alert(1)}{open}$ $\htmlClass{evil}{x}$`);
      expect(html).not.toContain('href="javascript:');
      expect(html).not.toContain('class="evil"');
      expect(render(String.raw`$\unknowncommand{x}$`)).toContain("unknowncommand");
    });
  }

  test("math remains formatted after asynchronous code highlighting", async () => {
    const parser = new Marked({ async: true }).use(markedMath(), markedShiki({
      highlight: async (code) => `<pre><code>${code}</code></pre>`,
    }));
    const html = await parser.parse("$x_1 + x_2$\n\n```txt\ncode\n```", { async: true });
    expect(html).toContain('class="katex"');
    expect(html).toContain("<pre><code>code</code></pre>");
  });
});
