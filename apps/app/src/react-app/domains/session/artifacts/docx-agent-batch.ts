import { parseDocxEdit } from "@legalwork/types/office-editor";
import type { DocxEditorToolResult } from "./artifact-docx-editor";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A sequential batch, not an atomic transaction. Each operation checks the
 * revision left by its predecessor; partial failures are saved and reported. */
export async function executeWordBatch(
  rawArgs: Record<string, unknown>,
  execute: (name: string, args: Record<string, unknown>, persist: boolean) => Promise<DocxEditorToolResult>,
): Promise<DocxEditorToolResult> {
  const run = async (name: string, input: Record<string, unknown>, persist: boolean): Promise<DocxEditorToolResult> => {
    try { return await execute(name, input, persist); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  };
  const args = parseDocxEdit(rawArgs);
  if (args.action === "save") return run("save_document", args, true);
  const operations = args.operations!;
  let expectedRevision = args.draftRevision;
  const results: { index: number; operation: string; success: boolean; data?: unknown; error?: string }[] = [];
  const appliedOperations: number[] = [];
  let failure: DocxEditorToolResult | undefined;
  for (const [index, { operation, ...input }] of operations.entries()) {
    const result = await run(operation, { ...input, documentId: args.documentId, draftRevision: expectedRevision }, false);
    results.push({ index, operation, success: result.success, data: result.data, error: result.error });
    if (record(result.data) && typeof result.data.draftRevision === "number") expectedRevision = result.data.draftRevision;
    const applied = record(result.data) && (result.data.applied === true || record(result.data.result) && result.data.result.applied === true);
    if (result.success && !(record(result.data) && record(result.data.result) && result.data.result.applied === false) || applied) appliedOperations.push(index);
    if (!result.success) { failure = result; break; }
  }
  const saved = !failure || appliedOperations.length ? await run("save_document", { documentId: args.documentId, draftRevision: expectedRevision }, true) : undefined;
  return {
    success: !failure && (!saved || saved.success), saved: saved?.saved === true,
    error: failure?.error ?? saved?.error,
    data: { documentId: args.documentId, draftRevision: expectedRevision, operations: results, appliedOperations,
      ...(failure ? { failedIndex: results.length - 1 } : {}),
      ...(saved && !saved.success ? { saveError: saved.error } : {}),
      nextStep: failure || saved && !saved.success ? "Read the live draft again. Do not repeat applied operations. Retry persistence only with action=save and the fresh identity." : "Read again for fresh handles before further edits." },
  };
}
