import { marked } from "marked";
import type { Extension } from "micromark-util-types";
import { markdownFrontmatter } from "./markdown-block-model";

/** Instruction documents and wikis display HTML-like placeholders literally, without interpreting tags. */
export const literalHtmlSyntax: Extension = { disable: { null: ["htmlText", "htmlFlow"] } };

/** Compare content without parser offsets, table identity, or element insertion-format caches.
 * Existing text formatting lives on text nodes' `format` and `style` fields. */
export function documentFingerprint(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (key === "position" || key === "__cacheKey" || key === "textFormat" || key === "textStyle") return undefined;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });
}

/** These dialects are not represented by the configured rich editor schema. */
export function requiresMarkdownSource(source: string, literalHtml = false): boolean {
  const tokens = marked.lexer(markdownFrontmatter(source).body);
  let unsupported = false;
  marked.walkTokens(tokens, token => {
    if (token.type === "html" && !literalHtml) unsupported = true;
    if (token.type === "paragraph" && /^ {0,3}:{2,}[\w-]+/m.test(token.raw)) unsupported = true;
    if ((token.type === "text" && !("tokens" in token && token.tokens) || token.type === "link") && /\[\^[^\]\r\n]+\]|(?:^|\s):[a-zA-Z][\w-]*\[/.test(token.raw)) unsupported = true;
  });
  return unsupported;
}
