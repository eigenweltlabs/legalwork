// Development-only harness; absent from production build inputs. The matching
// server script creates disposable original DOCX files and uses real API routes.
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
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
    <div className="flex min-h-0 flex-1">
      <aside className="w-48 shrink-0 border-r p-5 text-sm text-muted-foreground">Matter notes<br />Compare the agreement with the precedent. Both are synthetic documents.</aside>
      <main className="min-w-0 flex-1"><SidePanel sessionId={sessionId} workspaceId={workspaceId} workspaceRoot="" client={client} onClose={() => {}} /></main>
    </div><Toaster />
  </div>;
}

const root = createRoot(document.getElementById("root")!);
root.render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><LegalworkControlProvider><Harness /></LegalworkControlProvider></QueryClientProvider></MemoryRouter>);
import.meta.hot?.dispose(() => root.unmount());
