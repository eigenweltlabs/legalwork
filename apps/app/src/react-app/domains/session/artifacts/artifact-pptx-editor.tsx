import { useState, useRef, useEffect, useCallback } from "react";
import { PowerPointViewer, type PowerPointViewerHandle } from "pptx-react-viewer/viewer";
import { pptxReadSchema, pptxReplaceSchema } from "@legalwork/types/office-editor";
import { replaceTextSegments } from "./office-agent-text";
import { translationsEn, keyToLabel } from "pptx-react-viewer/i18n";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { toast } from "@/components/ui/sonner";
import { useOfficeEditor, type OfficeEditorProps } from "./office-editor-state";
import viewerStyles from "pptx-react-viewer/styles.css?inline";
import "./office-editor.css";

const i18n = createInstance();
void i18n.init({ lng: "en", fallbackLng: "en", keySeparator: false, resources: { en: { translation: translationsEn } }, parseMissingKeyHandler: keyToLabel, initAsync: false });

export function ArtifactPptxEditor(props: OfficeEditorProps) {
  const editor = useRef<PowerPointViewerHandle>(null);
  const state = useOfficeEditor(props);
  const onDirtyChange = useCallback((dirty: boolean) => { if (dirty) state.changed(); }, [state.changed]);
  state.afterSave.current = () => editor.current?.markSaved();
  const [content] = useState(() => new Uint8Array(props.content));
  useEffect(() => {
    const host = state.host.current;
    if (!host) return;
    let lastWidth = 0;
    // The upstream layout follows the window, while Legalwork resizes a panel.
    // Collapse side panes when the panel first crosses a compact breakpoint;
    // users can still reopen either pane using the editor's own controls.
    const fit = () => {
      if (!host.querySelector("[data-pptx-viewport]")) return;
      const width = host.clientWidth;
      if (width < 960 && (lastWidth === 0 || lastWidth >= 960) && host.querySelector("[data-pptx-inspector]")) host.querySelector<HTMLButtonElement>('[aria-label="Toggle inspector panel"]')?.click();
      if (width < 760 && (lastWidth === 0 || lastWidth >= 760) && host.querySelector('aside[aria-label="Slides"]')) host.querySelector<HTMLButtonElement>('[aria-label="Toggle slides panel"]')?.click();
      lastWidth = width;
    };
    const resize = new ResizeObserver(fit);
    const mount = new MutationObserver(() => { if (host.querySelector("[data-pptx-viewport]")) { fit(); mount.disconnect(); } });
    resize.observe(host); mount.observe(host, { childList: true, subtree: true }); fit();
    return () => { resize.disconnect(); mount.disconnect(); };
  }, [state.host]);
  state.serialize.current = async () => {
    if (!editor.current || editor.current.getSlideCount() === 0) throw new Error("The presentation is still loading.");
    const bytes = await editor.current.getContent();
    return new Uint8Array(bytes).buffer;
  };
  state.agentTool.current = async (name, rawArgs) => {
    const api = editor.current;
    if (!api || !api.getSlideCount()) throw new Error("The presentation is still loading.");
    if (name !== "read" && name !== "replace_text") throw new Error("Unknown presentation tool.");
    const args = name === "read" ? pptxReadSchema.parse(rawArgs) : pptxReplaceSchema.parse(rawArgs);
    const slideIndex = args.slideIndex ?? api.getActiveSlideIndex();
    const slide = api.getSlide(slideIndex);
    if (!slide) throw new Error("Slide not found. Read the slide inventory first.");
    if (name === "read") return { data: {
      activeSlideIndex: api.getActiveSlideIndex(), slideIndex,
      slides: api.getSlides().map((item, index) => ({ index, elementCount: item.elements.length })),
      elements: api.getElements(slideIndex).map((element) => ({ id: element.id, type: element.type, x: element.x, y: element.y, width: element.width, height: element.height, ...("text" in element ? { text: element.text } : {}), ...(element.type === "chart" ? { chart: { type: element.chartData?.chartType, categories: element.chartData?.categories, series: element.chartData?.series.map((series) => ({ name: series.name, values: series.values })) } } : {}), ...(element.type === "table" ? { rows: element.tableData?.rows.map((row) => row.cells.map((cell) => cell.text)) } : {}) })),
      notes: slide.notes,
      selectedElementIds: api.getSelectedElementIds(),
    } };
    const edit = pptxReplaceSchema.parse(rawArgs);
    const element = api.getElementById(edit.elementId, slideIndex);
    if (!element || (element.type !== "text" && element.type !== "shape")) throw new Error("Choose a text or shape element from the read result. Other element types are not editable with this tool.");
    const text = element.text ?? "";
    const start = text.indexOf(edit.search);
    if (start < 0 || text.indexOf(edit.search, start + 1) >= 0) throw new Error("Search must match exactly once in the current element. Read it again before editing.");
    const textSegments = element.textSegments?.length ? replaceTextSegments(element.textSegments, text, edit.search, edit.replaceWith) : undefined;
    api.setActiveSlideIndex(slideIndex);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    // Switching slides changes the handle's active-slide mutation closure.
    editor.current!.updateElement(edit.elementId, { text: text.replace(edit.search, () => edit.replaceWith), ...(textSegments ? { textSegments } : {}) });
    return { mutated: true, data: { slideIndex, elementId: edit.elementId, text: text.replace(edit.search, () => edit.replaceWith) } };
  };
  return <div ref={state.host} className="office-editor office-slides relative h-full min-h-0" aria-label="Presentation editor" aria-busy={state.saving}>
    <style>{`@scope (.office-slides) { ${viewerStyles.replace(":root,:host", ":scope")} }`}</style>
    <div className="h-full" inert={state.saving}>
      <I18nextProvider i18n={i18n}>
        <PowerPointViewer ref={editor} content={content} fileName={props.name} canEdit={!props.readOnly} autosave={false}
          onOpenFile={() => toast.info("Open presentations from the workspace file browser.")}
          onDirtyChange={onDirtyChange}
          hiddenActions={["file", "share", "broadcast", "record", "export", "help"]}
          theme={{ colors: { background: "var(--background)", foreground: "var(--foreground)", card: "var(--background)", cardForeground: "var(--foreground)", popover: "var(--popover)", popoverForeground: "var(--popover-foreground)", primary: "var(--primary)", primaryForeground: "var(--primary-foreground)", secondary: "var(--muted)", secondaryForeground: "var(--foreground)", input: "var(--border)", ring: "var(--ring)", muted: "var(--muted)", mutedForeground: "var(--muted-foreground)", border: "var(--border)", accent: "var(--accent)", accentForeground: "var(--accent-foreground)" } }} />
      </I18nextProvider>
    </div>
    {state.saving && <div className="office-saving" role="status">Saving presentation…</div>}
  </div>;
}
