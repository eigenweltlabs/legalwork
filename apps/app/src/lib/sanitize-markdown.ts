import DOMPurify from "dompurify";

/**
 * Strips scripts, event handlers and other executable markup from rendered
 * markdown. Every markdown renderer must pass its HTML through this before
 * handing it to `dangerouslySetInnerHTML` — the app document holds the desktop
 * bridge, so markup that runs there runs with the user's own privileges.
 *
 * The allowed attributes are the ones our renderers emit themselves (shiki
 * highlighting, image toggles, link and task references).
 */
export function sanitizeMarkdownHtml(value: string) {
  return DOMPurify.sanitize(value, {
    ADD_ATTR: [
      "checked",
      "class",
      "data-legalwork-image-preview",
      "data-legalwork-image-toggle",
      "data-legalwork-image-toggle-label",
      "data-legalwork-legalmemory-ref",
      "data-legalwork-link-href",
      "data-legalwork-link-chevron",
      "data-legalwork-shiki",
      "data-legalwork-task-ref",
      "decoding",
      "disabled",
      "hidden",
      "loading",
      "rel",
      "start",
      "style",
      "target",
    ],
  });
}
