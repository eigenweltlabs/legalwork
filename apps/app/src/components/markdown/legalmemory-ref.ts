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

/** A LegalMemory download card asked for its original to be opened. The app
 * cannot fetch the appliance itself, so the surface hands the link to the
 * server, which validates it against the firm's configured appliance origins
 * and drops the file into the workspace. */
export const LEGALMEMORY_OPEN_EVENT = "legalwork:legalmemory-open";

/**
 * Inline citations in an answer.
 *
 * Two forms are accepted, and the markdown one is what the model actually
 * writes. Measured from the session store: with the markdown-link instruction
 * the model emitted citations reliably; after switching the instruction to an
 * inert `[[doc:id|title]]` form it emitted none at all, and wrote "Source:" in
 * bold prose instead. A syntax that survives streaming is worth nothing if the
 * model will not produce it, so the instruction asks for the markdown link and
 * the bracket form stays supported for anything already written.
 */
export const LEGALMEMORY_CITATION = /\[\[doc:([^\]|\s]+)\|([^\]]+)\]\]/g;
const LEGALMEMORY_MD_CITATION = /\[([^\]\n]+)\]\(legalmemory:\/{0,2}document\/([\w.:-]+)\/?\)/gi;

export type CitedDocument = { documentId: string; title: string };

/**
 * The documents an answer cited, in the order it cited them.
 *
 * Deduplicated by id: a claim supported twice is still one source. The first
 * title wins, since that is the name the answer introduced the document under.
 */
export function citedDocuments(text: string): CitedDocument[] {
  const seen = new Map<string, CitedDocument>();
  const add = (documentId: string, title: string) => {
    const id = documentId.trim();
    if (!id || seen.has(id)) return;
    seen.set(id, { documentId: id, title: title.trim() || id });
  };
  // Scan in document order so the list matches the order of the prose.
  const matches = [
    ...[...text.matchAll(LEGALMEMORY_MD_CITATION)].map((m) => ({ index: m.index ?? 0, id: m[2], title: m[1] })),
    ...[...text.matchAll(LEGALMEMORY_CITATION)].map((m) => ({ index: m.index ?? 0, id: m[1], title: m[2] })),
  ].sort((a, b) => a.index - b.index);
  for (const match of matches) add(match.id, match.title);
  return [...seen.values()];
}
