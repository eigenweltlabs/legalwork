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
  if (isAbsolute(reference) || win32.isAbsolute(reference)) return false;
  const parts = reference.split(/[\\/]/);
  return (
    parts.every((part) => part && !part.startsWith(".") && !part.startsWith("~$")) &&
    documents.has(extname(parts[parts.length - 1]).toLowerCase())
  );
}

/** Paths come from an explicit project save. Do not inspect contents, other files or application state. */
export function documentEvidence(
  projectId: string,
  reference: string,
  created: boolean,
  observedAt: Date,
): WorkdayEvidence | undefined {
  if (!eligibleDocumentReference(reference)) return;
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
    activity: created ? "DFT" : "MOD",
    narrative: name.slice(0, 240),
    startAt: null,
    endAt: null,
    workedMinutes: null,
  };
  const eventKey = digest([body.source, date, projectId, parts.join("/")]);
  return {
    eventKey,
    proposal: { ...body, key: randomUUID(), digest: digest([eventKey, body]), dismissed: false },
  };
}
