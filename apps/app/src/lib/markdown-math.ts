import katex from "katex";
import type { MarkedExtension, TokenizerAndRendererExtension } from "marked";
import "katex/dist/katex.min.css";

function mathExtension(
  name: string,
  level: "block" | "inline",
  pattern: RegExp,
  displayMode: boolean,
): TokenizerAndRendererExtension {
  return {
    name,
    level,
    start(source) {
      const index = source.search(level === "block" ? /(?:^|\n) {0,3}(?:\$\$|\\\[)[ \t]*\n/ : /\$|\\\(|\\\[/);
      return index < 0 ? undefined : index;
    },
    tokenizer(source) {
      const match = pattern.exec(source);
      // Permit the trailing space used in generated equations such as
      // $180,00 - 66,00 = $, without pairing a price with a later formula.
      if (name === "dollarMath" && match && /\s$/.test(match[1]) && !/[\\=+*/<>^_-]/.test(match[1])) return;
      if (match) return { type: name, raw: match[0], text: match[1] };
    },
    renderer(token) {
      if (typeof token.text !== "string") return false;
      const html = katex.renderToString(token.text.trim(), {
        displayMode,
        throwOnError: false,
        trust: false,
        strict: "ignore",
        maxSize: 20,
        maxExpand: 1000,
        macros: { "\\euro": "\\text{€}" },
      });
      return displayMode ? `<span class="block max-w-full overflow-x-auto">${html}</span>` : html;
    },
  };
}

// Tokenize before Markdown handles backslashes/emphasis. Code spans and fenced
// code keep their own tokens; an unfinished streamed formula stays literal text.
export function markedMath(): MarkedExtension {
  return {
    extensions: [
      mathExtension("dollarMathBlock", "block", /^ {0,3}\$\$[ \t]*\n([\s\S]+?)\n {0,3}\$\$[ \t]*(?:\n|$)/, true),
      mathExtension("bracketMathBlock", "block", /^ {0,3}\\\[[ \t]*\n([\s\S]+?)\n {0,3}\\\][ \t]*(?:\n|$)/, true),
      // A closing dollar followed by a digit belongs to a price, as in $10 and $20.
      mathExtension("dollarMath", "inline", /^\$(?![\s$])((?:\\.|[^\\$\n])+?)\$(?![\d$])/, false),
      mathExtension("dollarMathDisplay", "inline", /^\$\$([\s\S]+?)\$\$(?!\$)/, true),
      mathExtension("parenMath", "inline", /^\\\(([\s\S]+?)\\\)/, false),
      mathExtension("bracketMath", "inline", /^\\\[([\s\S]+?)\\\]/, true),
    ],
  };
}
