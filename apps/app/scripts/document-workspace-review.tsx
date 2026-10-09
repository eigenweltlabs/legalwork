import { DocumentDiscardDialog } from "../src/react-app/domains/session/artifacts/document-discard-dialog";
// Development-only harness; absent from production build inputs. The matching
// server script creates disposable original DOCX files and uses real API routes.
import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { writeWorkspaceFileDrag } from "../src/app/lib/workspace-file-drag";
import { classifyOpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { SidePanel } from "../src/react-app/domains/session/panel/side-panel";
import { usePanelTabStore, useSessionPanelState } from "../src/react-app/domains/session/panel/panel-tab-store";
import { type DocumentDropEdge } from "../src/react-app/domains/session/panel/document-layout";
import { LegalworkControlProvider, useLegalworkControl } from "../src/react-app/shell/control/control-provider";
import { Toaster } from "../src/components/ui/sonner";
import { initLocale } from "../src/i18n";
import { checkDocumentRecovery } from "./document-recovery-review";
import "../src/app/index.css";

initLocale();
const sessionId = "document-workspace-validation";
const workspaceId = "document-validation";
const baseUrl = new URLSearchParams(window.location.search).has("localAlias") ? "http://localhost:5175" : "http://127.0.0.1:5175";
const server = createLegalworkServerClient({ baseUrl, token: "document-validation-client" });
const open = (name: string) => usePanelTabStore.getState().openTab(sessionId, { id: `file:${name}`, type: "artifact", label: name, value: name, preview: classifyOpenTarget(name, "file") });
// Test native event routing through a portaled editor without depending on OS
// pointer automation. These controls are not evidence of a native mouse gesture.
function projectDrop(type: "dragover" | "drop", edge: "right" | "bottom" | null) {
  const pane = document.querySelector('[data-document-drop-pane="main"]');
  if (!pane) return;
  const rect = pane.getBoundingClientRect();
  const dataTransfer = new DataTransfer();
  writeWorkspaceFileDrag(dataTransfer, { workspaceId, path: "Precedent.docx", name: "Precedent.docx" });
  (pane.querySelector('[contenteditable="true"]') ?? pane).dispatchEvent(new DragEvent(type, {
    bubbles: true, cancelable: true, dataTransfer,
    clientX: rect.left + rect.width * (edge === "right" ? 0.9 : 0.4), clientY: rect.top + rect.height * (edge === "bottom" ? 0.9 : 0.5),
  }));
}
// Unlike projectDrop, hit-test the live page so a PDF iframe can expose the bug.
function frameDrop(type: "dragenter" | "dragover" | "drop" | "dragend") {
  const frame = document.querySelector('iframe[title="Reference.pdf"]');
  if (!frame) return;
  const rect = frame.getBoundingClientRect();
  const clientX = rect.left + rect.width * 0.9;
  const clientY = rect.top + rect.height * 0.5;
  const target = type === "dragenter" || type === "dragend" ? document.documentElement : document.elementFromPoint(clientX, clientY);
  if (!target || target instanceof HTMLIFrameElement) return;
  const dataTransfer = new DataTransfer();
  writeWorkspaceFileDrag(dataTransfer, { workspaceId, path: "Precedent.docx", name: "Precedent.docx" });
  target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }));
}
if (!usePanelTabStore.getState().sessions[sessionId]?.tabs.length) {
  open("Agreement.docx"); open("Precedent.docx");
  usePanelTabStore.getState().moveTab(sessionId, "file:Precedent.docx", "main", "right");
}

function FreeSplitChecks() {
  const session = useSessionPanelState(sessionId);
  const [file, setFile] = useState("Notes.md");
  const [targetId, setTargetId] = useState("");
  const [edge, setEdge] = useState<DocumentDropEdge | "center">("bottom");
  const [sourceKind, setSourceKind] = useState("project");
  const drag = useRef<DataTransfer | null>(null);
  const target = session.panes.find(pane => pane.id === targetId) ?? session.panes[0];
  const dispatch = (type: "dragover" | "drop") => {
    const pane = [...document.querySelectorAll<HTMLElement>("[data-document-drop-pane]")].find(element => element.dataset.documentDropPane === target.id);
    if (!pane) return;
    const dataTransfer = drag.current ?? new DataTransfer();
    if (sourceKind === "project") writeWorkspaceFileDrag(dataTransfer, { workspaceId, path: file, name: file });
    const rect = pane.getBoundingClientRect();
    const clientX = rect.left + rect.width * (edge === "left" ? 0.1 : edge === "right" ? 0.9 : 0.5);
    const clientY = rect.top + rect.height * (edge === "top" ? 0.1 : edge === "bottom" ? 0.9 : 0.5);
    document.documentElement.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer }));
    pane.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, clientX, clientY }));
    if (type === "drop") { document.documentElement.dispatchEvent(new DragEvent("dragend", { bubbles: true })); drag.current = null; }
  };
  return <details><summary>Free split checks</summary><div className="space-y-2 text-xs">
    <label>Source<select aria-label="Drop source" value={file} onChange={event => setFile(event.target.value)}>
      {["Agreement.docx", "Precedent.docx", "Reference.pdf", "Notes.md", "Clauses.md", "Timeline.md", "Checklist.md"].map(name => <option key={name}>{name}</option>)}
    </select></label>
    <label>Kind<select aria-label="Drag kind" value={sourceKind} onChange={event => setSourceKind(event.target.value)}><option value="project">Project file</option><option value="tab">Tab</option></select></label>
    <label>Target<select aria-label="Drop target" value={target.id} onChange={event => setTargetId(event.target.value)}>
      {session.panes.map(pane => <option key={pane.id} value={pane.id}>{session.tabs.find(tab => tab.id === pane.activeTabId)?.label ?? "Empty"}</option>)}
    </select></label>
    <label>Edge<select aria-label="Drop edge" value={edge} onChange={event => {
      const value = event.target.value;
      if (value === "left" || value === "right" || value === "top" || value === "bottom" || value === "center") setEdge(value);
    }}>{["left", "right", "top", "bottom", "center"].map(value => <option key={value}>{value}</option>)}</select></label>
    <button onClick={() => {
      const tab = [...document.querySelectorAll('[draggable="true"]')].find(element => element.querySelector(`[aria-label="Select tab: ${file}"]`));
      drag.current = new DataTransfer();
      tab?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: drag.current }));
    }}>Begin tab drag</button>
    <button onClick={() => dispatch("dragover")}>Preview free drop</button>
    <button onClick={() => dispatch("drop")}>Perform free drop</button>
    <button onClick={() => { document.documentElement.dispatchEvent(new DragEvent("dragend", { bubbles: true })); drag.current = null; }}>Cancel drag</button>
    <output aria-label="Pane count">{session.panes.length} panes</output>
  </div></details>;
}

function Harness() {
  const [fail, setFail] = useState(false);
  const [slow, setSlow] = useState(false);
  const pendingWrite = useRef<(() => void) | null>(null);
  const [writes, setWrites] = useState<string[]>([]);
  const [contents, setContents] = useState("");
  const [dockHeader, setDockHeader] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(true);
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const client = useMemo(() => ({ ...server, writeWorkspaceBinaryFile: async (...args: Parameters<typeof server.writeWorkspaceBinaryFile>) => {
    if (slow) await new Promise<void>((resolve) => { pendingWrite.current = resolve; });
    if (fail) throw new Error("Simulated offline write; original file unchanged.");
    const result = await server.writeWorkspaceBinaryFile(...args);
    setWrites((previous) => [...previous, args[1].path]);
    return result;
  } }), [fail, slow]);
  const control = useLegalworkControl();
  return <div className="flex h-screen flex-col bg-background text-foreground">
    <div className="flex flex-wrap items-center gap-4 border-b p-2 text-xs">
      <span>Disposable DOCX workspace</span>
      <button onClick={() => window.open(`${window.location.pathname}?detached=1`, "_blank")}>Open second window</button>
      <button onClick={() => setViewerOpen(open => !open)}>{viewerOpen ? "Hide viewer" : "Show viewer"}</button>
      <label><input type="checkbox" checked={dockHeader} onChange={(event) => setDockHeader(event.target.checked)} /> Dock tabs in header</label>
      <label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} /> Fail writes</label>
      <label><input type="checkbox" checked={slow} onChange={(event) => setSlow(event.target.checked)} /> Hold writes</label>
      <button onClick={() => { pendingWrite.current?.(); pendingWrite.current = null; }}>Release write</button>
      <button onClick={() => open("Agreement.docx")}>Open agreement</button>
      <button onClick={() => open("Precedent.docx")}>Open precedent</button>
      <button onClick={() => open("Reference.pdf")}>Open PDF</button>
      <button onClick={() => open("Notes.md")}>Open note</button>
      <button onClick={() => open("Plain.txt")}>Open plain text</button>
      <button onClick={() => void checkDocumentRecovery().then(setContents).catch(error => setContents(`FAILED: ${error}`))}>Check recovery migration</button>
      <label><input type="checkbox" onChange={event => {
        document.documentElement.classList.toggle("legalwork-electron", event.target.checked);
        document.documentElement.classList.toggle("legalwork-platform-mac", event.target.checked);
      }} /> Preview macOS title strip</label>
      <button onClick={async () => {
        const reports = await Promise.all(["Agreement.docx", "Precedent.docx"].map(async (path) => {
          const file = await server.downloadWorkspaceFile(workspaceId, path);
          return `${path}: ${(await DocxReviewer.fromBuffer(file.data)).getContentAsText()}`;
        }));
        setContents(reports.join("\n"));
      }}>Read original files</button>
      <button onClick={async () => setContents(JSON.stringify({ snapshot: control?.snapshot(), document: await control?.executeAction("document.read_metadata") }))}>Inspect active document</button>
      <output aria-label="Completed file writes">Writes: {writes.length} {writes.join(", ")}</output>
    </div>
    <details><summary>Saved file / control evidence</summary><pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs">{contents}</pre></details>
    {dockHeader && <div ref={setHeaderTarget} className="ml-48 h-11 shrink-0 border-b" />}
    <div className="flex min-h-0 flex-1">
      <aside className="w-48 shrink-0 space-y-3 border-r p-5 text-sm text-muted-foreground">
        <p>Project files — drop at any edge to split; in the centre to add a tab.</p>
        {["Agreement.docx", "Precedent.docx"].map((name) => <div key={name} draggable className="cursor-grab rounded border p-2" onDragStart={(event) => writeWorkspaceFileDrag(event.dataTransfer, { workspaceId, path: name, name })}>{name}</div>)}
        <FreeSplitChecks />
        <p className="text-xs">Synthetic drop events:</p>
        <button onClick={() => projectDrop("dragover", "right")}>Preview right-edge drop</button>
        <button onClick={() => projectDrop("drop", "right")}>Drop precedent at right edge</button>
        <button onClick={() => projectDrop("dragover", "bottom")}>Preview bottom-edge drop</button>
        <button onClick={() => projectDrop("drop", "bottom")}>Drop precedent at bottom edge</button>
        <button onClick={() => projectDrop("drop", null)}>Drop precedent into main</button>
        <details><summary>PDF drag checks</summary>
          <button onClick={() => frameDrop("dragenter")}>Enter file drag</button>
          <button onClick={() => frameDrop("dragover")}>Hover over PDF</button>
          <button onClick={() => frameDrop("drop")}>Drop over PDF</button>
          <button onClick={() => frameDrop("dragend")}>Cancel file drag</button>
        </details>
        <p>All documents are synthetic.</p>
      </aside>
      <main className="min-w-0 flex-1">{viewerOpen && <SidePanel headerTarget={dockHeader ? headerTarget : null} sessionId={sessionId} workspaceId={workspaceId} workspaceRoot="" client={client} onClose={() => setViewerOpen(false)} />}</main>
    </div><Toaster /><DocumentDiscardDialog />
  </div>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<StrictMode><MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LegalworkControlProvider><Harness /></LegalworkControlProvider></QueryClientProvider></MemoryRouter></StrictMode>);
import.meta.hot?.dispose(() => root.unmount());
