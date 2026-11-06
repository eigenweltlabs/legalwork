import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { AssistantSaveReportSchema, ViewInputSchema, viewReferenceKey } from "./views/schema.js";
import { ApiError } from "./errors.js";
import { withFileWriteLock } from "./file-write-lock.js";
import { ViewRepository, workspaceViewFiles } from "./views/repository.js";

/** Same key means the same file, even after a lost response or simultaneous retry. */
export async function saveAssistantReport(workspace: { id: string; path: string }, raw: z.infer<typeof AssistantSaveReportSchema>) {
  const { key, input, baseRevision } = AssistantSaveReportSchema.parse(raw);
  const hash = createHash("sha256").update(JSON.stringify([workspace.id, key])).digest("hex");
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const repository = new ViewRepository({ kind: "workspace", id: workspace.id }, workspaceViewFiles(workspace.path));
  return withFileWriteLock(join(workspace.path, ".legalwork", `assistant-report-${id}`), async () => {
    const current = await repository.read(id).catch(error => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    });
    const previousInput = current ? ViewInputSchema.parse(Object.fromEntries(
      Object.entries(current).filter(([name]) => name !== "id" && name !== "updatedAt" && name !== "owner" && name !== "revision"),
    )) : null;
    const unchanged = current !== null && isDeepStrictEqual(previousInput, input);
    if (current && !unchanged && baseRevision !== current.revision)
      throw new ApiError(409, "view_revision_conflict", "This report already exists. Read it with view_read and provide its current baseRevision before updating it.");
    if (!current && baseRevision) throw new ApiError(409, "view_revision_conflict", "The original report is missing. Do not recreate it as an update.");
    const view = unchanged ? current : current ? await repository.update(id, input, current.revision) : await repository.create(input, id);
    const path = await repository.location(view.id);
    const reference = viewReferenceKey({ owner: view.owner, viewId: view.id });
    return { ok: true, view, path, reference, markdown: `\`\`\`legalwork-view\n${reference}\n\`\`\`` };
  });
}
