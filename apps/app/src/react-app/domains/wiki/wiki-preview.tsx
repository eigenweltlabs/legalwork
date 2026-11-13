import { withoutWikiSourceMarkers } from "@legalwork/types/wiki-suggestions";
import { WikiResearchIndex } from "./wiki-research-index";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { InlineView } from "../views/view-inline";
import { useViewPortals } from "../views/view-portals";
import { useViewHost } from "../views/view-host";
import { parseViewReference, viewPanelTab } from "../views/view-reference";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import type { WikiPage } from "@legalwork/types/wiki";
import { openDesktopUrl } from "@/app/lib/desktop";
import { t } from "@/i18n";
import { resolveWikiLink, wikiMarkdownBody } from "./wiki-model";
import "../session/artifacts/markdown-editor.css";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const parser = new Marked({ gfm: true, breaks: false, renderer: {
  code(token) { if (token.lang === "legalwork-view") return `<div data-legalwork-view-block="${escapeHtml(token.text)}"></div>`; return false; },
  checkbox(token) { return token.checked ? "☑ " : "☐ "; },
  image(token) { return `<img data-wiki-image="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" loading="lazy" />`; },
} });
parser.use({ extensions: [{
  name: "wikilink", level: "inline",
  start: (source) => source.indexOf("[["),
  tokenizer(source) {
    const match = /^\[\[([^\]\n]+)\]\]/.exec(source);
    if (!match) return;
    const [target, label] = match[1].replace(/\\\|/g, "|").split("|");
    return { type: "wikilink", raw: match[0], target, label: label ?? target };
  },
  renderer(token) {
    return `<a href="wiki:${encodeURIComponent(String(token.target))}">${escapeHtml(String(token.label))}</a>`;
  },
}] });

export function renderWikiMarkdown(content: string) {
  return DOMPurify.sanitize(parser.parse(withoutWikiSourceMarkers(wikiMarkdownBody(content)), { async: false }), {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|wiki|legalwork-view):|[^a-z]|[a-z+.-]+(?:[^a-z+.:\-]|$))/i,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "svg", "math", "video", "audio", "source", "track", "picture"],
    FORBID_ATTR: ["style", "srcset", "src"],
  });
}

function headingSlug(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "section";
}

export function WikiPreview(props: {
  files?: string[];
  content: string;
  path: string;
  anchor?: string;
  pages: WikiPage[];
  onOpen: (path: string, anchor?: string) => void;
  onMissing: (target: string) => void;
  onAsset: (path: string) => void;
  imagePreview: (path: string) => Promise<string>;
}) {
  const element = useRef<HTMLDivElement>(null);
  const host = useViewHost();
  const [historicalLink, setHistoricalLink] = useState<string | null>(null);
  const requestTab = useRequestPanelTab();
  const { html, outline, anchors } = useMemo(() => {
    const document = new DOMParser().parseFromString(renderWikiMarkdown(props.content), "text/html");
    const occurrences = new Map<string, number>();
    const usedIds = new Set(Array.from(document.body.querySelectorAll("[id]"), (element) => element.id));
    const anchors = new Map<string, string>();
    const headings: { id: string; title: string; nested: boolean }[] = [];
    for (const heading of document.body.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
      const title = heading.textContent?.trim() ?? "";
      const authoredId = heading.id;
      const slug = headingSlug(title);
      let occurrence = (occurrences.get(slug) ?? 0) + 1;
      let id = `wiki-heading-${slug}${occurrence > 1 ? `-${occurrence}` : ""}`;
      while (usedIds.has(id)) {
        occurrence++;
        id = `wiki-heading-${slug}-${occurrence}`;
      }
      occurrences.set(slug, occurrence);
      // Scope generated anchors to the reader, including duplicate heading names.
      heading.id = id;
      usedIds.add(id);
      if (authoredId && !anchors.has(authoredId)) anchors.set(authoredId, heading.id);
      if (title && (heading.tagName === "H2" || heading.tagName === "H3")) headings.push({ id: heading.id, title, nested: heading.tagName === "H3" });
    }
    return { html: document.body.innerHTML, outline: headings, anchors };
  }, [props.content]);
  // Keep the HTML prop stable when portals mount; resetting innerHTML would erase their DOM.
  const markup = useMemo(() => ({ __html: html }), [html]);
  const viewPortals = useViewPortals(element, html);
  const scrollToHeading = useCallback((id: string) => {
    const exact = element.current?.querySelector(`[id="${CSS.escape(id)}"]`);
    const heading = exact ?? element.current?.querySelector(`[id="${CSS.escape(anchors.get(id) ?? `wiki-heading-${headingSlug(id)}`)}"]`);
    const pageTitle = heading?.tagName === "H1" && heading === element.current?.querySelector("h1")
      ? element.current?.closest(".wiki-page-content")?.querySelector('.wiki-page-header[data-leading-heading="true"] .wiki-page-title') : null;
    (pageTitle ?? heading)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }, [anchors]);
  useEffect(() => {
    if (props.anchor) scrollToHeading(props.anchor);
  }, [html, props.anchor, scrollToHeading]);
  useEffect(() => {
    let cancelled = false;
    const images = element.current?.querySelectorAll("img");
    for (const img of images ?? []) {
      const source = img.getAttribute("data-wiki-image") ?? "";
      // Remote images need explicit user navigation; a wiki must not beacon its reader.
      img.removeAttribute("src");
      if (!source || /^[A-Za-z][A-Za-z0-9+.-]*:|^\/\//.test(source)) continue;
      void props.imagePreview(source).then((url) => { if (!cancelled) img.src = url; }).catch(() => { img.alt ||= source; });
    }
    return () => { cancelled = true; };
  }, [html, props.imagePreview]);

  const showOutline = outline.length >= 3;
  return <div className={`wiki-reader${showOutline ? " wiki-reader-with-outline" : ""}`}><div className="min-w-0"><div
    ref={element}
    className="lw-markdown-page wiki-preview"
    dangerouslySetInnerHTML={markup}
    onClick={(event) => {
      if (!(event.target instanceof Element)) return;
      const anchor = event.target.closest("a");
      const href = anchor?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      const view = parseViewReference(href);
      if (view && host?.historicalViews) { setHistoricalLink(href); return; }
      if (view && host?.client) { requestTab(viewPanelTab(host.client.baseUrl, view, anchor?.textContent ?? "Report")); return; }
      if (/^https?:|^mailto:|^tel:/i.test(href)) { void openDesktopUrl(href); return; }
      if (href.startsWith("#")) {
        let id: string;
        try { id = decodeURIComponent(href.slice(1)); } catch { return; }
        scrollToHeading(id);
        return;
      }
      let target: string;
      try { target = decodeURIComponent(href.replace(/^wiki:/, "")); } catch { return; }
      const destination = resolveWikiLink(props.pages, props.files ?? props.pages.map(page => page.path), target, props.path, href.startsWith("wiki:"));
      if (destination?.kind === "asset") props.onAsset(destination.path);
      else if (destination) {
        props.onOpen(destination.path, destination.anchor || undefined);
        if (destination.path === props.path && destination.anchor) scrollToHeading(destination.anchor);
      }
      else if (href.startsWith("wiki:") || /\.md(?:#.*)?$/i.test(href)) props.onMissing(target);
      else props.onAsset(target);
    }}
  />{!host?.historicalViews && <WikiResearchIndex key={props.path} content={props.content} pages={props.pages} onOpen={props.onOpen} />}</div>{viewPortals}{historicalLink && <Dialog open onOpenChange={open => { if (!open) setHistoricalLink(null); }}><DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl"><DialogTitle>{t("wiki.views_at_revision")}</DialogTitle><InlineView source={historicalLink} /></DialogContent></Dialog>}{showOutline ? <aside className="wiki-reader-outline"><nav aria-label={t("wiki.on_this_page")}><p className="wiki-outline-title">{t("wiki.on_this_page")}</p>{outline.map((heading) => <a key={heading.id} className={`wiki-outline-link${heading.nested ? " wiki-outline-subsection" : ""}`} href={`#${heading.id}`} onClick={(event) => { event.preventDefault(); scrollToHeading(heading.id); }}>{heading.title}</a>)}</nav></aside> : null}</div>;
}
