import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DocxReviewer } from "@eigenpal/docx-editor-agents";
import { ArtifactDocxEditor, type DocxEditorApi } from "../src/react-app/domains/session/artifacts/artifact-docx-editor";
import { ArtifactFrame } from "../src/react-app/domains/session/artifacts/artifact-frame";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Toaster } from "../src/components/ui/sonner";
import "../src/app/index.css";

// Development-only harness: real production editor, synthetic contract, in-memory persistence.
function ReviewHarness({ initial, fixture }: { initial: ArrayBuffer; fixture: string }) {
  const api = useRef<DocxEditorApi | null>(null);
  const [content, setContent] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [generation, setGeneration] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loaded original");
  const [narrow, setNarrow] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [failSave, setFailSave] = useState(false);
  const [savedReport, setSavedReport] = useState("");
  return <TooltipProvider><div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#fff" }}>
    <div style={{ padding: 10, display: "flex", gap: 16, flexWrap: "wrap", borderBottom: "1px solid #ddd" }}>
      <button onClick={async () => { try { const ok = await api.current?.save(); setStatus(ok ? "Saved to workspace" : "Save failed"); } catch { setStatus("Save failed; draft retained"); } }}>Save to workspace</button>
      <button onClick={() => { setContent(saved.slice(0)); setGeneration((value) => value + 1); setDirty(false); setStatus("Reopened saved copy"); }}>Reopen saved copy</button>
      <button onClick={() => setNarrow(!narrow)}>{narrow ? "Full width" : "Narrow panel"}</button>
      <label><input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} /> Read only</label>
      <label><input type="checkbox" checked={failSave} onChange={(event) => setFailSave(event.target.checked)} /> Simulate save failure</label>
      <output aria-label="Document status">{dirty ? "Unsaved changes" : "No unsaved changes"} · {status}</output>
    </div>
    <details><summary>Saved DOCX contents</summary><pre aria-label="Saved DOCX contents" style={{ maxHeight: 160, overflow: "auto" }}>{savedReport}</pre></details>
    <div style={{ width: narrow ? 620 : "100%", maxWidth: "100%", flex: 1, minHeight: 0 }}>
      <ArtifactFrame title="legal-review.docx" meta={dirty ? "Unsaved changes" : "Saved"} expandable actions={<button onClick={() => void api.current?.save()}>Save</button>}>
      <ArtifactDocxEditor key={generation} name="legal-review.docx" content={content} apiRef={api} readOnly={readOnly} recoveryKey={`synthetic-contract-qa-${fixture}`} baseUpdatedAt={1} onDirtyChange={setDirty} onSave={async (buffer) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (failSave) throw new Error("Simulated workspace write failure");
        setSaved(buffer.slice(0));
        const reopened = await DocxReviewer.fromBuffer(buffer.slice(0));
        setSavedReport(JSON.stringify({ comments: reopened.getComments(), changes: reopened.getChanges(), text: reopened.getContentAsText() }, null, 2));
        setStatus("Saved to workspace");
      }} />
      </ArtifactFrame>
    </div><Toaster />
  </div></TooltipProvider>;
}

if (import.meta.env.DEV || import.meta.env.MODE === "docx-review") {
  const root = document.getElementById("root");
  const positions = new URLSearchParams(location.search).get("fixture") === "positions";
  const response = await fetch(positions
    ? new URL("./fixtures/legal-review-positions.docx", import.meta.url)
    : new URL("./fixtures/legal-review.docx", import.meta.url));
  if (root) createRoot(root).render(<ReviewHarness initial={await response.arrayBuffer()} fixture={positions ? "positions" : "review"} />);
}
