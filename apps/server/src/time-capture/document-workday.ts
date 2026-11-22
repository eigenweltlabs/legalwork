import { extname, isAbsolute, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { digest, type WorkdayEvidence } from "./private-workday.js";

const documents = new Set([
  ".md",
  ".txt",
  ".rtf",
  ".doc",
  ".docx",
  ".odt",
  ".xls",
  ".xlsx",
  ".ods",
  ".ppt",
  ".pptx",
  ".odp",
  ".pdf",
]);

export function eligibleDocumentReference(reference: string) {
  return eligibleFileReference(reference) && documents.has(extname(reference).toLowerCase());
}

export function eligibleFileReference(reference: string) {
  if (isAbsolute(reference) || win32.isAbsolute(reference)) return false;
  const parts = reference.split(/[\\/]/);
  return parts.every(part => part && !part.startsWith(".") && !part.startsWith("~$"));
}

/** Paths come from an explicit project save. Do not inspect contents, other files or application state. */
export function documentEvidence(
  projectId: string,
  reference: string,
  created: boolean,
  observedAt: Date,
  stableId?: string,
  action?: "Attached" | "Imported" | "Copied" | "Uploaded" | "Saved",
): WorkdayEvidence | undefined {
  if (!(action ? eligibleFileReference(reference) : eligibleDocumentReference(reference))) return;
  const parts = reference.split(/[\\/]/);
  const name = parts[parts.length - 1];
  const date = [
    observedAt.getFullYear(),
    String(observedAt.getMonth() + 1).padStart(2, "0"),
    String(observedAt.getDate()).padStart(2, "0"),
  ].join("-");
  const body = {
    date,
    source: "documents" as const,
    projectId,
    documentId: stableId ?? digest([projectId, "path", parts.join("/")]),
    activity: action ? (action === "Saved" ? "MOD" : "") : created ? "DFT" : "MOD",
    ...(action ? { changeSummary: action + " " + name.slice(0, 240) } : {}),
    narrative: name.slice(0, 240),
    startAt: null,
    endAt: null,
    workedMinutes: null,
    observedAt: observedAt.toISOString(),
  };
  const eventKey = digest([body.source, date, projectId, body.documentId, ...(stableId ? [body.observedAt] : [])]);
  return {
    eventKey,
    proposal: { ...body, key: randomUUID(), digest: digest([eventKey, body]), dismissed: false },
  };
}
