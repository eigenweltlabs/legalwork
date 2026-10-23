import { useViewPortals } from "@/react-app/domains/views/view-portals";
import { useViewHost } from "@/react-app/domains/views/view-host";
import { parseViewReference, viewPanelTab } from "@/react-app/domains/views/view-reference";
import { useRequestPanelTab } from "@/react-app/domains/session/panel/panel-tab-destination";
import { useRequestOpenTask } from "@/react-app/domains/session/panel/panel-tab-destination";
/** @jsxImportSource react */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Marked, type Tokens } from "marked";
import { markedEmoji } from "marked-emoji";
import { useNavigate } from "react-router-dom";
import markedShiki from "marked-shiki";
import emojiKeywords from "emojilib";
import {
  transformerMetaHighlight,
  transformerMetaWordHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { bundledLanguages, codeToHtml } from "shiki";

import { cn } from "@/lib/utils";
import { sanitizeMarkdownHtml } from "@/lib/sanitize-markdown";
import { useOpenTargets } from "@/lib/target-provider";
import { resolveHrefOpenTarget, type OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { parseWikiPageUrl } from "@legalwork/types/wiki";
import { wikiPanelTab } from "@/react-app/domains/wiki/wiki-tabs";

import { applyTextHighlights } from "./text-highlights";
import { LinkActionMenu } from "./link-action-menu";
import {
  buildLegalMemoryRefPrompt,
  LEGALMEMORY_CITATION,
  LEGALMEMORY_OPEN_EVENT,
  LEGALMEMORY_REF_EVENT,
  parseLegalMemoryRef,
} from "./legalmemory-ref";
import { t } from "@/i18n";
import { parseTaskLink } from "@/react-app/domains/tasks/task-reference";
import { parseWorkspaceSessionLink } from "@/react-app/shell/workspace-routes";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function safeHref(href: string) {
  const trimmed = href.trim();

  if (!trimmed) {
    return "#";
  }

  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);

    if (["http:", "https:", "mailto:"].includes(parsed.protocol)) {
      return trimmed;
    }
  } catch {
    return "#";
  }

  return "#";
}

function alignAttribute(align: Tokens.TableCell["align"]) {
  return align ? ` style="text-align: ${align}"` : "";
}

function codeLanguageClass(lang: string | undefined) {
  const normalized = lang?.trim().split(/\s+/)[0];

  return normalized ? ` class="language-${escapeAttribute(normalized)}"` : "";
}

function createEmojiAliases() {
  const aliases: Record<string, string> = {};

  for (const [emoji, names] of Object.entries(emojiKeywords)) {
    for (const name of names) {
      if (!aliases[name]) {
        aliases[name] = emoji;
      }
    }
  }

  return aliases;
}

const emojiAliases = createEmojiAliases();
const MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT = 100;

function parseShikiLanguage(lang: string) {
  const normalized = lang.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return normalized in bundledLanguages ? normalized : "text";
}

function hasFencedCodeBlock(text: string) {
  return /(^|\n)```/.test(text);
}

function estimatedRenderedImageHeight(image: HTMLImageElement) {
  if (!image.naturalWidth || !image.naturalHeight) return 0;

  const renderedWidth = image.clientWidth || image.getBoundingClientRect().width;
  return renderedWidth > 0
    ? (image.naturalHeight / image.naturalWidth) * renderedWidth
    : image.naturalHeight;
}

function syncMarkdownImagePreviews(root: HTMLElement) {
  const previews = root.querySelectorAll("[data-legalwork-image-preview]");

  for (const preview of previews) {
    if (!(preview instanceof HTMLElement)) continue;

    const image = preview.querySelector("img");
    const button = preview.querySelector("[data-legalwork-image-toggle]");
    if (!(image instanceof HTMLImageElement) || !(button instanceof HTMLButtonElement)) continue;

    const previewable = estimatedRenderedImageHeight(image) > MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT;
    button.hidden = !previewable;

    if (!previewable) {
      preview.style.maxHeight = "";
      continue;
    }

    const expanded = preview.dataset.legalworkImagePreview === "expanded";
    preview.style.maxHeight = expanded ? "" : `${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px`;

    const label = button.querySelector("[data-legalwork-image-toggle-label]");
    if (label) label.textContent = expanded ? t("markdown.show_less") : t("markdown.show_full_image");
  }
}

const baseMarkedOptions = {
  async: false,
  breaks: false,
  gfm: true,
  pedantic: false,
  silent: true,
  renderer: {
    html({ text }) {
      return text;
    },
    paragraph({ tokens }) {
      return `<p class="my-3 leading-relaxed">${this.parser.parseInline(tokens)}</p>`;
    },
    heading({ tokens, depth }) {
      const className = cn(
        "font-semibold",
        depth === 1 && "my-5 text-xl",
        depth === 2 && "my-4 text-lg",
        depth >= 3 && "my-3 text-base",
      );

      return `<h${depth} class="${className}">${this.parser.parseInline(tokens)}</h${depth}>`;
    },
    list(token) {
      const tag = token.ordered ? "ol" : "ul";
      const className = cn(
        "my-3 pl-6",
        token.ordered ? "list-decimal" : "list-disc",
      );
      const start = token.ordered && typeof token.start === "number" && token.start !== 1
        ? ` start="${token.start}"`
        : "";
      return `<${tag}${start} class="${className}">${token.items.map((item) => this.listitem(item)).join("")}</${tag}>`;
    },
    listitem(item) {
      const checkbox = item.task
        ? `<input disabled="" type="checkbox"${item.checked ? " checked=\"\"" : ""}> `
        : "";

      return `<li class="my-1">${checkbox}${this.parser.parse(item.tokens)}</li>`;
    },
    blockquote({ tokens }) {
      return `<blockquote class="my-4 rounded-r-lg border-l border-border bg-muted/40 pl-4 italic text-muted-foreground">${this.parser.parse(tokens)}</blockquote>`;
    },
    code({ text, lang }) {
      if (lang === "legalwork-view") return `<div data-legalwork-view-block="${escapeAttribute(text)}"></div>`;
      return `<pre class="my-4 overflow-x-auto rounded-[18px] border border-border/70 bg-gray-1/80 px-4 py-3 text-xs leading-6 text-muted-foreground"><code${codeLanguageClass(lang)}>${escapeHtml(text)}</code></pre>`;
    },
    codespan({ text }) {
      return `<code class="rounded-sm bg-foreground/4 px-1 py-0.5 [font:inherit] text-inherit">${escapeHtml(text)}</code>`;
    },
    del({ raw, tokens }) {
      if (!raw.startsWith("~~")) {
        return escapeHtml(raw);
      }
      
      return `<del>${this.parser.parseInline(tokens)}</del>`;
    },
    link({ href, title, tokens }) {
      const safe = escapeAttribute(safeHref(href));
      const originalHref = escapeAttribute(href);
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

      const chatRoute = parseWorkspaceSessionLink(href);
      if (chatRoute) return `<a href="${escapeAttribute(chatRoute)}" data-legalwork-link-href="${originalHref}"${titleAttr} class="text-indigo-10 underline underline-offset-2 transition-colors hover:text-indigo-8">${this.parser.parseInline(tokens)}</a>`;

      // LegalMemory reference chip: a sibling of the file-mention chip for
      // legalmemory://document/<id> and legalmemory://matter/<id> links. The
      // click handler turns it into an agent prompt (export into workspace /
      // matter preview) — the app itself holds no appliance credentials.
      if (parseLegalMemoryRef(href)) {
        const memoryIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-indigo-10"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>`;
        return `<span data-legalwork-file-badge="" class="inline-flex items-stretch overflow-hidden rounded-md border border-indigo-6/60 bg-indigo-2/40 text-xs font-medium text-foreground align-middle"><a href="#" data-legalwork-legalmemory-ref="${originalHref}"${titleAttr} class="inline-flex items-center gap-1 px-1.5 py-0.5 no-underline transition-colors hover:bg-indigo-3/50">${memoryIcon}${this.parser.parseInline(tokens)}</a></span>`;
      }

      // A task chip: the agent links a task it filed or worked on the way it
      // links a document, and the click opens it in the Tasks pane.
      if (parseViewReference(href)) return `<a href="#" data-legalwork-view-ref="${originalHref}" class="inline-flex rounded-md border px-2 py-0.5 text-sm">${this.parser.parseInline(tokens)}</a>`;
      if (parseWikiPageUrl(href)) return `<a href="#" data-legalwork-wiki-ref="${originalHref}"${titleAttr} class="inline-flex rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-sm font-medium no-underline hover:bg-muted">${this.parser.parseInline(tokens)}</a>`;
      const taskLink = parseTaskLink(href);
      if (taskLink) {
        const inboxIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;
        const openTaskLabel = escapeAttribute(t("message_list.open_task"));
        return `<span data-legalwork-file-badge="" class="inline-flex items-stretch overflow-hidden rounded-md border border-blue-6/35 bg-blue-3/20 text-xs font-medium text-blue-11 align-middle"><a href="#" data-legalwork-task-ref="${escapeAttribute(taskLink.taskId)}" title="${openTaskLabel}" class="inline-flex items-center gap-1 px-1.5 py-0.5 no-underline transition-colors hover:bg-blue-3/40">${inboxIcon}${this.parser.parseInline(tokens)}</a></span>`;
      }

      const isFilePath = !/^(https?|wss?|ftp|mailto|tel|file):/i.test(href);

      if (isFilePath) {
        const fileIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/></svg>`;
        // Injected as raw HTML, so the translated label goes through the same
        // attribute escaping as every other interpolated value here.
        const openWithLabel = escapeAttribute(t("markdown.open_with"));
        const chevron = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-muted-foreground"><path d="m6 9 6 6 6-6"/></svg>`;

        return `<span data-legalwork-file-badge="" class="inline-flex items-stretch overflow-hidden rounded-md border border-border/60 bg-muted/40 text-xs font-medium text-foreground align-middle"><a href="${safe}" data-legalwork-link-href="${originalHref}"${titleAttr} target="_blank" rel="noreferrer noopener" class="inline-flex items-center gap-1 px-1.5 py-0.5 no-underline transition-colors hover:bg-muted">${fileIcon}${this.parser.parseInline(tokens)}</a><button type="button" data-legalwork-link-chevron="${originalHref}" class="inline-flex items-center border-l border-border/60 px-1 transition-colors hover:bg-muted" aria-label="${openWithLabel}">${chevron}</button></span>`;
      }

      return `<a href="${safe}" data-legalwork-link-href="${originalHref}"${titleAttr} target="_blank" rel="noreferrer noopener" class="text-indigo-10 underline underline-offset-2 transition-colors hover:text-indigo-8">${this.parser.parseInline(tokens)}</a>`;
    },
    image({ href, title, text }) {
      const safe = escapeAttribute(safeHref(href));
      const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";

      return `<span data-legalwork-image-preview="collapsed" class="relative my-4 inline-block max-w-full overflow-hidden rounded-lg border border-border/70 align-top" style="max-height: ${MARKDOWN_IMAGE_PREVIEW_MAX_HEIGHT}px"><img src="${safe}" alt="${escapeAttribute(text)}"${titleAttr} loading="lazy" decoding="async" class="block h-auto max-w-full"><button type="button" data-legalwork-image-toggle="" hidden class="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-background via-background/90 to-transparent pb-2 pt-8"><span data-legalwork-image-toggle-label="" class="rounded-full border border-border bg-background/95 px-3 py-1 text-xs font-medium text-foreground shadow-sm">Show full image</span></button></span>`;
    },
    table(token) {
      const header = token.header.map((cell) => this.tablecell({ ...cell, header: true })).join("");
      const body = token.rows.map((row) => this.tablerow({ text: row.map((cell) => this.tablecell(cell)).join("") })).join("");

      return `<table class="my-4 w-full border-collapse"><thead>${this.tablerow({ text: header })}</thead><tbody>${body}</tbody></table>`;
    },
    tablerow({ text }) {
      return `<tr>${text}</tr>`;
    },
    tablecell({ tokens, header, align }) {
      const className = cn(
        "border border-border p-2",
        header ? "bg-muted text-left" : "align-top",
      );

      if (header) {
        return `<th${alignAttribute(align)} class="${className}">${this.parser.parseInline(tokens)}</th>`;
      }

      return `<td${alignAttribute(align)} class="${className}">${this.parser.parseInline(tokens)}</td>`;
    },
    hr() {
      return `<hr class="my-6 border-none h-px bg-gray-4">`;
    },
  },
} satisfies ConstructorParameters<typeof Marked<string, string>>[0];

const markdownParser = new Marked(baseMarkedOptions).use(
  markedEmoji({
    emojis: emojiAliases,
    renderer: (token) => escapeHtml(token.emoji),
  }),
);

const highlightedMarkdownParser = new Marked({
  ...baseMarkedOptions,
  async: true,
}).use(
  markedEmoji({
    emojis: emojiAliases,
    renderer: (token) => escapeHtml(token.emoji),
  }),
  markedShiki({
    async highlight(code, lang, props) {
      if (lang === "legalwork-view") return `<div data-legalwork-view-block="${escapeAttribute(code)}"></div>`;
      const language = parseShikiLanguage(lang);

      return codeToHtml(code, {
        lang: language,
        meta: { __raw: props.join(" ") },
        themes: { light: "github-light", dark: "github-dark" },
        transformers: [
          transformerNotationDiff({ matchAlgorithm: "v3" }),
          transformerNotationHighlight({ matchAlgorithm: "v3" }),
          transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
          transformerNotationFocus({ matchAlgorithm: "v3" }),
          transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
          transformerMetaHighlight(),
          transformerMetaWordHighlight(),
        ],
      });
    },
    container: `<div data-legalwork-shiki="true" class="my-4 overflow-x-auto rounded-lg border border-border/70 bg-gray-1/80 p-4 text-xs leading-6">%s</div>`,
  }),
);

type MarkdownBlockInnerProps = {
  className?: string;
  text: string;
  streaming?: boolean;
  highlightQuery?: string;
} & Omit<
  React.ComponentProps<typeof motion.div>,
  "ref" | "className" | "children" | "dangerouslySetInnerHTML"
>;


/**
 * Rewrite `[[doc:<id>|<title>]]` citations into the same markdown link the
 * chip renderer already handles.
 *
 * Done before parsing rather than after, so a citation inside a code span or a
 * table cell goes through the markdown machinery that already knows about those
 * boundaries. A partially streamed citation simply does not match and renders
 * as the plain text it currently is.
 */
function rewriteLegalMemoryCitations(text: string): string {
  return text.replace(LEGALMEMORY_CITATION, (_match, id: string, title: string) => {
    const safeTitle = title.trim().replace(/[[\]]/g, "");
    return `[${safeTitle}](legalmemory://document/${id.trim()})`;
  });
}

function MarkdownBlockInner({
  className,
  text,
  streaming,
  highlightQuery,
  ...props
}: MarkdownBlockInnerProps) {
  const requestOpenTask = useRequestOpenTask();
  const requestViewTab = useRequestPanelTab();
  const viewHost = useViewHost();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const { openTargets, onOpenTarget } = useOpenTargets();
  const [linkMenu, setLinkMenu] = useState<{ target: OpenTarget; anchor: HTMLElement } | null>(null);
  const syncHtml = useMemo(() => {
    if (!text.trim()) {
      return "";
    }
    return sanitizeMarkdownHtml(markdownParser.parse(rewriteLegalMemoryCitations(text), { async: false }));
  }, [text]);
  const [highlightedHtml, setHighlightedHtml] = useState<{ text: string; html: string } | null>(null);

  useEffect(() => {
    if (streaming || !hasFencedCodeBlock(text)) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    void highlightedMarkdownParser.parse(rewriteLegalMemoryCitations(text), { async: true }).then((html) => {
      const sanitizedHtml = sanitizeMarkdownHtml(html);

      if (!cancelled && sanitizedHtml.trim()) {
        setHighlightedHtml({ text, html: sanitizedHtml });
      }
    }).catch(() => {
      if (!cancelled) {
        setHighlightedHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [streaming, text]);

  const html = !streaming && highlightedHtml?.text === text ? highlightedHtml.html : syncHtml;
  const viewPortals = useViewPortals(rootRef, html);
  // Preserve the clicked chevron while opening its menu rerenders this block.
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  useEffect(() => { setLinkMenu(null); }, [html]);

  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    queueMicrotask(() => {
      if (!rootRef.current || rootRef.current !== root) {
        return;
      }

      applyTextHighlights(root, highlightQuery ?? "");
    });
  }, [html, highlightQuery]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const sync = () => syncMarkdownImagePreviews(root);

    sync();

    const handleLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) sync();
    };

    const handleClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;

      const wikiLink = event.target.closest<HTMLElement>("[data-legalwork-wiki-ref]");
      if (wikiLink) {
        event.preventDefault(); event.stopPropagation();
        const reference = parseWikiPageUrl(wikiLink.dataset.legalworkWikiRef ?? "");
        if (reference && viewHost?.client) requestViewTab(wikiPanelTab(viewHost.client.baseUrl, reference.wikiId, { kind: "page", path: reference.path }, wikiLink.textContent?.trim() || reference.path));
        return;
      }

      const viewLink = event.target.closest<HTMLElement>("[data-legalwork-view-ref]");
      if (viewLink) {
        event.preventDefault(); event.stopPropagation();
        const reference = parseViewReference(viewLink.dataset.legalworkViewRef ?? "");
        if (reference && viewHost?.client) requestViewTab(viewPanelTab(viewHost.client.baseUrl, reference, viewLink.textContent ?? "Report"));
        return;
      }
      const memoryRefLink = event.target.closest("[data-legalwork-legalmemory-ref]");
      if (memoryRefLink instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const ref = parseLegalMemoryRef(memoryRefLink.dataset.legalworkLegalmemoryRef ?? "");
        if (ref) {
          const label = memoryRefLink.textContent?.trim() ?? "";
          // A document opens directly. A matter has no file to fetch, so that
          // one still goes to the agent for a preview.
          window.dispatchEvent(
            ref.kind === "document"
              ? new CustomEvent(LEGALMEMORY_OPEN_EVENT, { detail: { documentId: ref.id, label } })
              : new CustomEvent(LEGALMEMORY_REF_EVENT, { detail: { prompt: buildLegalMemoryRefPrompt(ref, label) } }),
          );
        }
        return;
      }

      const taskRefLink = event.target.closest("[data-legalwork-task-ref]");
      if (taskRefLink instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const taskId = taskRefLink.dataset.legalworkTaskRef ?? "";
        if (taskId) requestOpenTask(taskId, taskRefLink.textContent?.trim() || undefined);
        return;
      }

      const chevron = event.target.closest("[data-legalwork-link-chevron]");
      if (chevron instanceof HTMLElement) {
        event.preventDefault();
        event.stopPropagation();
        const href = chevron.dataset.legalworkLinkChevron ?? "";
        const target = resolveHrefOpenTarget(href, openTargets);
        if (target) {
          setLinkMenu((current) => current?.anchor === chevron ? null : { target, anchor: chevron });
        }
        return;
      }

      const link = event.target.closest("a[data-legalwork-link-href]");
      if (link instanceof HTMLAnchorElement) {
        const href = link.dataset.legalworkLinkHref ?? link.getAttribute("href") ?? "";
        const chatRoute = parseWorkspaceSessionLink(href);
        if (chatRoute) {
          event.preventDefault();
          navigate(chatRoute);
          return;
        }
        const target = resolveHrefOpenTarget(href, openTargets);

        if (target && onOpenTarget) {
          event.preventDefault();
          onOpenTarget(target, { external: event.metaKey || event.ctrlKey });
          return;
        }
      }

      const button = event.target.closest("[data-legalwork-image-toggle]");
      if (!(button instanceof HTMLButtonElement)) return;

      const preview = button.closest("[data-legalwork-image-preview]");
      if (!(preview instanceof HTMLElement)) return;

      preview.dataset.legalworkImagePreview = preview.dataset.legalworkImagePreview === "expanded"
        ? "collapsed"
        : "expanded";
      sync();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !onOpenTarget) return;
      const anchor = event.target.closest<HTMLAnchorElement>("a[data-legalwork-link-href]");
      if (!anchor) return;
      const target = resolveHrefOpenTarget(anchor.dataset.legalworkLinkHref ?? "", openTargets);
      if (!target) return;
      event.preventDefault();
      setLinkMenu({ target, anchor });
    };

    root.addEventListener("load", handleLoad, true);
    root.addEventListener("click", handleClick);
    root.addEventListener("contextmenu", handleContextMenu);

    if (globalThis.ResizeObserver === undefined) {
      return () => {
        root.removeEventListener("load", handleLoad, true);
        root.removeEventListener("click", handleClick);
        root.removeEventListener("contextmenu", handleContextMenu);
      };
    }

    const observer = new ResizeObserver(sync);
    observer.observe(root);

    return () => {
      observer.disconnect();
      root.removeEventListener("load", handleLoad, true);
      root.removeEventListener("click", handleClick);
      root.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [html, onOpenTarget, openTargets, requestViewTab, viewHost, navigate]);

  if (!html) {
    return null;
  }

  return (
    <>
      <motion.div
        ref={rootRef}
        className={cn("markdown-content max-w-none text-foreground", className)}
        dangerouslySetInnerHTML={innerHtml}
        {...props}
      />
      {viewPortals}
      {linkMenu && onOpenTarget ? (
        <LinkActionMenu
          target={linkMenu.target}
          anchor={linkMenu.anchor}
          onOpenTarget={onOpenTarget}
          onClose={() => setLinkMenu(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Memoize so a message block that has already been rendered — the usual
 * case for every assistant bubble above the currently-streaming one —
 * doesn't re-parse its markdown on every token. Only re-renders when its
 * own text / streaming / highlightQuery props change.
 */
export const MarkdownBlock = memo(MarkdownBlockInner);
MarkdownBlock.displayName = "MarkdownBlock";
