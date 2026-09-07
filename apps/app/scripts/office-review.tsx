import { lazy, Suspense, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactFrame } from "../src/react-app/domains/session/artifacts/artifact-frame";
import type { OfficeEditorApi } from "../src/react-app/domains/session/artifacts/office-editor-state";
import { Button } from "../src/components/ui/button";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/sonner";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import "../src/app/index.css";
const Slides = lazy(() => import("../src/react-app/domains/session/artifacts/artifact-pptx-editor").then((m) => ({ default: m.ArtifactPptxEditor })));
const Sheets = lazy(() => import("../src/react-app/domains/session/artifacts/artifact-xlsx-editor").then((m) => ({ default: m.ArtifactXlsxEditor })));
function Review({ initial, slides }: { initial: ArrayBuffer; slides: boolean }) {
  const api = useRef<OfficeEditorApi | null>(null);
  const [content, setContent] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [fail, setFail] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [report, setReport] = useState("");
  const Editor = slides ? Slides : Sheets;
  const save = async () => { try { const ok = await api.current?.save(); setStatus(ok ? "Saved to workspace" : "Still loading"); } catch (error) { setStatus(error instanceof Error ? error.message : "Save failed"); } };
  return <TooltipProvider><div className="flex h-screen flex-col bg-muted">
    <div className="flex items-center gap-4 border-b bg-background px-5 py-3 text-xs">
      <strong>LEGALWORK <span className="font-normal text-muted-foreground">/ Office review</span></strong>
      <a href="?format=pptx">Presentation</a><a href="?format=xlsx">Workbook</a>
      <Button size="sm" variant="outline" onClick={() => { setContent(saved.slice(0)); setGeneration((n) => n + 1); setDirty(false); setStatus("Reopened saved copy"); }}>Reopen saved copy</Button>
      <Button size="sm" variant="ghost" onClick={() => setNarrow(!narrow)}>{narrow ? "Full width" : "Narrow panel"}</Button>
      <label><input type="checkbox" checked={fail} onChange={(e) => setFail(e.target.checked)} /> Fail save</label>
      <label><input type="checkbox" checked={readOnly} onChange={(e) => { setReadOnly(e.target.checked); setGeneration((n) => n + 1); }} /> Read only</label>
    </div>
    <output className="px-5 py-2 text-xs" aria-label="Save result">{status}</output>
    <div className="mx-auto flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-xl border bg-background shadow-sm" style={{ width: narrow ? 620 : "calc(100% - 40px)", maxWidth: "100%" }}>
      <ArtifactFrame title={slides ? "Matter review.pptx" : "Matter budget.xlsx"} expandable meta={dirty ? "Unsaved changes" : "Saved"} actions={<Button size="sm" disabled={readOnly} onClick={() => void save()}>Save</Button>}>
        <Suspense fallback={<div className="p-6">Opening editor…</div>}>
          <Editor key={generation} content={content} name={slides ? "Matter review.pptx" : "Matter budget.xlsx"} readOnly={readOnly} apiRef={api} onDirtyChange={setDirty} onSave={async (buffer) => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (fail) throw new Error("Save failed; draft retained");
            setSaved(buffer.slice(0));
            const zip = await JSZip.loadAsync(buffer);
            setReport(slides ? JSON.stringify({ slide: await zip.file("ppt/slides/slide1.xml")!.async("string"), charts: Object.keys(zip.files).filter((path) => /^ppt\/charts\/chart.*\.xml$/.test(path)), notes: await Promise.all(Object.keys(zip.files).filter((path) => /^ppt\/notesSlides\/notesSlide.*\.xml$/.test(path)).map((path) => zip.file(path)!.async("string"))) }) : JSON.stringify(XLSX.read(buffer, { type: "array", cellFormula: true, sheetStubs: true }).Sheets));
          }} />
        </Suspense>
      </ArtifactFrame>
    </div><details className="shrink-0 px-5 text-xs"><summary>Saved file contents</summary><pre style={{ maxHeight: 120, overflow: "auto" }}>{report}</pre></details><Toaster />
  </div></TooltipProvider>;
}
if (import.meta.env.DEV) {
  const slides = new URLSearchParams(location.search).get("format") === "pptx";
  const response = await fetch(slides ? new URL("./fixtures/office-review.pptx", import.meta.url) : new URL("./fixtures/office-review.xlsx", import.meta.url));
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<Review initial={await response.arrayBuffer()} slides={slides} />);
}
