/**
 * LegalMemory references in assistant output.
 *
 * The LegalMemory (Knowledge Index) agent guidance asks the model to cite
 * firm-knowledge sources as markdown links carrying an opaque id:
 *
 *   [Share Purchase Agreement (final)](legalmemory://document/<id>)
 *   [Project Falcon](legalmemory://matter/<id>)
 *
 * The chat renderer shows these as clickable reference chips (a sibling of
 * the file-mention chip). The app holds no appliance credentials — only the
 * engine's MCP session does — so clicking a chip sends a prompt turn that has
 * the agent do the authorized round-trip: export the original document into
 * the workspace and link it, or pull up a compact matter preview.
 */

export const LEGALMEMORY_REF_EVENT = "legalwork:legalmemory-ref";
export const LEGALMEMORY_URI_PATTERN = /^legalmemory:/i;

export type LegalMemoryRefKind = "document" | "matter";

export type LegalMemoryRef = {
  kind: LegalMemoryRefKind;
  id: string;
};

const REF_PATTERN = /^legalmemory:\/{0,2}(document|matter)\/([\w.:-]+)\/?$/i;

export function parseLegalMemoryRef(href: string): LegalMemoryRef | null {
  const match = REF_PATTERN.exec(href.trim());
  if (!match) return null;
  const kind = match[1].toLowerCase();
  if (kind !== "document" && kind !== "matter") return null;
  return { kind, id: match[2] };
}

/** The user turn a chip click sends, phrased so the agent completes the whole
 * fetch-into-workspace (or preview) round-trip without follow-up questions. */
export function buildLegalMemoryRefPrompt(ref: LegalMemoryRef, label: string): string {
  const name = label.trim() && label.trim() !== ref.id ? `"${label.trim()}"` : `id ${ref.id}`;
  if (ref.kind === "document") {
    return `Export the LegalMemory document ${name} (document_id ${ref.id}) into the workspace: call the LegalMemory download_document tool, run its save_command from the workspace root so the exact original file lands here, then reply with the saved file as a workspace-relative link so I can open it.`;
  }
  return `Pull up the LegalMemory matter ${name} (matter_id ${ref.id}): give me a compact preview — status, parties, key documents, and recent decision records — citing each document as a LegalMemory reference link.`;
}
