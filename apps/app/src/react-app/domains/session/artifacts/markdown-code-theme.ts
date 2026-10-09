import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

// Stable extensions: MDXEditor recreates embedded CodeMirror state when their
// identity changes. CSS variables switch palettes without touching undo/drafts.
export const markdownCodeTheme = [
  EditorView.theme({
    "&": { color: "var(--lw-text-content)", backgroundColor: "var(--lw-canvas)" },
    ".cm-content": { caretColor: "var(--lw-text-primary)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--lw-text-primary)" },
    ".cm-gutters": { color: "var(--lw-text-secondary)", backgroundColor: "var(--lw-sunken)", borderColor: "var(--lw-border)" },
    ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--lw-hover)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--lw-accent-border)" },
    ".cm-panels, .cm-tooltip": { color: "var(--lw-text-primary)", backgroundColor: "var(--lw-surface)", borderColor: "var(--lw-border)" },
    ".cm-textfield, .cm-button": { color: "var(--lw-text-primary)", backgroundColor: "var(--lw-sunken)", backgroundImage: "none", border: "1px solid var(--lw-border-strong)" },
    ".cm-button:active": { backgroundColor: "var(--lw-surface-hover)", backgroundImage: "none" },
    ".cm-searchMatch, .cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--lw-warning-soft)", outline: "1px solid var(--lw-warning)" },
    ".cm-selectionMatch, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--lw-hover)", outline: "1px solid var(--lw-border-strong)" },
    ".cm-deletedChunk, .cm-deletedText": { backgroundColor: "var(--lw-danger-soft)" },
    ".cm-insertedChunk, .cm-insertedText": { backgroundColor: "var(--lw-success-soft)" },
  }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: tags.keyword, color: "var(--lw-code-keyword)" },
    { tag: [tags.string, tags.regexp], color: "var(--lw-code-string)" },
    { tag: [tags.number, tags.bool, tags.null, tags.typeName], color: "var(--lw-code-value)" },
    { tag: tags.comment, color: "var(--lw-text-secondary)", fontStyle: "italic" },
    { tag: tags.quote, color: "var(--lw-text-content)" },
    { tag: tags.heading, color: "var(--lw-text-primary)", fontWeight: "600" },
    { tag: tags.link, color: "var(--lw-code-value)", textDecoration: "underline" },
    { tag: tags.emphasis, color: "var(--lw-text-content)", fontStyle: "italic" },
    { tag: tags.strong, color: "var(--lw-text-content)", fontWeight: "bold" },
    { tag: tags.strikethrough, textDecoration: "line-through" },
  ])),
];
