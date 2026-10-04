// Development-only harness; absent from production build inputs. The matching
// server script creates disposable original DOCX files and uses real API routes.
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { writeWorkspaceFileDrag } from "../src/app/lib/workspace-file-drag";
import { SidePanel } from "../src/react-app/domains/session/panel/side-panel";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";
import { LegalworkControlProvider, useLegalworkControl } from "../src/react-app/shell/control/control-provider";
import { Toaster } from "../src/components/ui/sonner";
import { initLocale } from "../src/i18n";
import "../src/app/index.css";

initLocale();
const sessionId = "document-workspace-validation";
const workspaceId = "document-validation";
const server = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:5175", token: "document-validation-client" });
const open = (name: string) => usePanelTabStore.getState().openTab(sessionId, { id: `file:${name}`, type: "artifact", label: name, value: name, preview: "word" });
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
if (!usePanelTabStore.getState().sessions[sessionId]?.tabs.length) {
  open("Agreement.docx"); open("Precedent.docx");
  usePanelTabStore.getState().moveTabToSide(sessionId, "file:Precedent.docx");
}

function Harness() {
  const [fail, setFail] = useState(false);
  const [slow, setSlow] = useState(false);
  const pendingWrite = useRef<(() => void) | null>(null);
  const [writes, setWrites] = useState<string[]>([]);
  const [contents, setContents] = useState("");
  const [dockHeader, setDockHeader] = useState(false);
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
      <label><input type="checkbox" checked={dockHeader} onChange={(event) => setDockHeader(event.target.checked)} /> Dock tabs in header</label>
      <label><input type="checkbox" checked={fail} onChange={(event) => setFail(event.target.checked)} /> Fail writes</label>
      <label><input type="checkbox" checked={slow} onChange={(event) => setSlow(event.target.checked)} /> Hold writes</label>
      <button onClick={() => { pendingWrite.current?.(); pendingWrite.current = null; }}>Release write</button>
      <button onClick={() => open("Agreement.docx")}>Open agreement</button>
      <button onClick={() => open("Precedent.docx")}>Open precedent</button>
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
        <p>Project files — drag into either pane. The right or bottom edge opens a split.</p>
        {["Agreement.docx", "Precedent.docx"].map((name) => <div key={name} draggable className="cursor-grab rounded border p-2" onDragStart={(event) => writeWorkspaceFileDrag(event.dataTransfer, { workspaceId, path: name, name })}>{name}</div>)}
        <p className="text-xs">Synthetic drop events:</p>
        <button onClick={() => projectDrop("dragover", "right")}>Preview right-edge drop</button>
        <button onClick={() => projectDrop("drop", "right")}>Drop precedent at right edge</button>
        <button onClick={() => projectDrop("dragover", "bottom")}>Preview bottom-edge drop</button>
        <button onClick={() => projectDrop("drop", "bottom")}>Drop precedent at bottom edge</button>
        <button onClick={() => projectDrop("drop", null)}>Drop precedent into main</button>
        <p>Both documents are synthetic.</p>
      </aside>
      <main className="min-w-0 flex-1"><SidePanel headerTarget={dockHeader ? headerTarget : null} sessionId={sessionId} workspaceId={workspaceId} workspaceRoot="" client={client} onClose={() => {}} /></main>
    </div><Toaster />
  </div>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LegalworkControlProvider><Harness /></LegalworkControlProvider></QueryClientProvider></MemoryRouter>);
import.meta.hot?.dispose(() => root.unmount());
