import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import JSZip from "jszip";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { ArtifactDocxEditor, type DocxEditorApi } from "../src/react-app/domains/session/artifacts/artifact-docx-editor";
import { ArtifactFrame } from "../src/react-app/domains/session/artifacts/artifact-frame";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/sonner";
import "../src/app/index.css";

// Development-only fixture using the production wrapper and its real persistence path.
// No React updates or DOM reads happen while samples are collected.
function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : 0;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? 0, over50ms: sorted.filter((value) => value > 50).length };
}

function createMetrics() {
  const frames: number[] = [];
  const events: number[] = [];
  const longTasks: number[] = [];
  const painted: number[] = [];
  let paintCount = 0;
  let epoch = 0;
  let startedAt = performance.now();
  return {
    frames, events, longTasks, painted,
    recordPaint() { paintCount++; },
    get epoch() { return epoch; },
    get startedAt() { return startedAt; },
    reset() { epoch++; frames.length = 0; events.length = 0; longTasks.length = 0; painted.length = 0; paintCount = 0; startedAt = performance.now(); },
    report() {
      return {
        elapsedMs: performance.now() - startedAt,
        keydownToSecondFrameMs: summarize(frames),
        keydownToDocumentPaintMs: summarize(painted),
        paintCount,
        eventDurationMs: summarize(events),
        longTasksMs: { ...summarize(longTasks), total: longTasks.reduce((sum, value) => sum + value, 0) },
      };
    },
  };
}

declare global {
  interface Window { __docxPerf: ReturnType<typeof createMetrics>; }
}

const metrics = createMetrics();
window.__docxPerf = metrics;

function useTypingMetrics() {
  useEffect(() => {
    let pending: { start: number; epoch: number }[] = [];
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('[contenteditable="true"]')) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1 && !["Backspace", "Delete", "Enter"].includes(event.key)) return;
      const start = event.timeStamp;
      const epoch = metrics.epoch;
      pending.push({ start, epoch });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (epoch === metrics.epoch) metrics.frames.push(performance.now() - start);
      }));
    };
    document.addEventListener("keydown", onKeyDown, true);
    const onPaint = () => {
      metrics.recordPaint();
      for (const sample of pending) {
        if (sample.epoch === metrics.epoch) metrics.painted.push(performance.now() - sample.start);
      }
      pending = [];
    };
    document.addEventListener("painter:painted", onPaint);
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < metrics.startedAt) continue;
        if (entry.entryType === "longtask") metrics.longTasks.push(entry.duration);
        if (entry.entryType === "event" && entry.name === "keydown") metrics.events.push(entry.duration);
      }
    });
    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) observer.observe({ type: "longtask" });
    const eventOptions = { type: "event", durationThreshold: 16 };
    if (PerformanceObserver.supportedEntryTypes.includes("event")) observer.observe(eventOptions);
    return () => { document.removeEventListener("keydown", onKeyDown, true); document.removeEventListener("painter:painted", onPaint); observer.disconnect(); };
  }, []);
}

async function createContract(pages: number) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const clause = "The parties shall maintain complete and accurate records of the services performed under this agreement. Each party will promptly notify the other of any material change affecting its obligations. No amendment is effective unless recorded in writing and signed by both parties.";
  const sections = Array.from({ length: pages }, (_, page) => {
    const title = `<w:p><w:pPr>${page ? '<w:pageBreakBefore/>' : ''}<w:spacing w:after="180"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>Section ${page + 1}: Services and obligations</w:t></w:r></w:p>`;
    const paragraphs = Array.from({ length: 8 }, (_, paragraph) => `<w:p><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr><w:t>${page + 1}.${paragraph + 1} ${clause}</w:t></w:r></w:p>`).join("");
    return title + paragraphs;
  }).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${sections}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}

function PerformanceHarness({ initial, pages }: { initial: ArrayBuffer; pages: number }) {
  const api = useRef<DocxEditorApi | null>(null);
  const [content, setContent] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loaded synthetic contract");
  const [report, setReport] = useState("");
  const [savedText, setSavedText] = useState("");
  useTypingMetrics();
  return <TooltipProvider><div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fff" }}>
    <div style={{ padding: 10, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", borderBottom: "1px solid #ddd" }}>
      <strong>{pages}-page contract</strong>
      <a href="?pages=30">30 pages</a><a href="?pages=100">100 pages</a>
      <button onClick={() => { metrics.reset(); setReport(""); }}>Reset metrics</button>
      <button onClick={() => setReport(JSON.stringify(metrics.report(), null, 2))}>Report metrics</button>
      <button onClick={async () => { try { const ok = await api.current?.save(); setStatus(ok ? "Saved to workspace" : "Save failed"); } catch { setStatus("Save failed; draft retained"); } }}>Save to workspace</button>
      <button onClick={() => { setContent(saved.slice(0)); setGeneration((value) => value + 1); setDirty(false); setStatus("Reopened saved copy"); }}>Reopen saved copy</button>
      <output aria-label="Document status">{dirty ? "Unsaved changes" : "No unsaved changes"} · {status}</output>
    </div>
    {report && <pre aria-label="Performance report" style={{ padding: 10, maxHeight: 200, overflow: "auto", fontSize: 12 }}>{report}</pre>}
    <details><summary>Saved DOCX text</summary><pre aria-label="Saved DOCX text" style={{ maxHeight: 120, overflow: "auto" }}>{savedText}</pre></details>
    <div style={{ flex: 1, minHeight: 0 }}>
      <ArtifactFrame title={`performance-${pages}.docx`} meta={dirty ? "Unsaved changes" : "Saved"} actions={null} expandable>
        <ArtifactDocxEditor key={generation} name={`performance-${pages}.docx`} content={content} apiRef={api} recoveryKey={`synthetic-performance-${pages}-${new URLSearchParams(location.search).get("run") ?? "default"}`} baseUpdatedAt={1} onDirtyChange={setDirty} onSave={async (buffer) => {
          setSaved(buffer.slice(0));
          const reopened = await DocxReviewer.fromBuffer(buffer.slice(0));
          setSavedText(reopened.getContentAsText());
          setStatus("Saved to workspace");
        }} />
      </ArtifactFrame>
    </div><Toaster />
  </div></TooltipProvider>;
}

if (import.meta.env.DEV || import.meta.env.MODE === "docx-performance") {
  const pages = new URLSearchParams(location.search).get("pages") === "100" ? 100 : 30;
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<PerformanceHarness initial={await createContract(pages)} pages={pages} />);
}
