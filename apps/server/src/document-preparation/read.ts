import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { ApiError } from "../errors.js";
import { documentPath } from "./service.js";
import { preparedSchema } from "./schema.js";

/** Shared, source-verified structure for review, search and future document tools. */
export async function readPreparedDocument(workspace: string, file: string, preparationPath: string) {
  const source = await documentPath(workspace, file);
  if (!/^\.opencode\/legalwork\/prepared-documents\/[a-f0-9]{64}\.json$/.test(preparationPath))
    throw new ApiError(400, "preparation_path", "Invalid prepared document path.");
  const requested = resolve(source.root, preparationPath);
  const actual = await realpath(requested).catch(() => undefined);
  if (!actual || actual !== requested)
    throw new ApiError(404, "preparation_not_found", "Prepare this document first.");
  if ((await stat(actual)).size > 128 * 1024 * 1024) throw new ApiError(413, "preparation_size", "Prepared document exceeds the size limit.");
  const prepared = preparedSchema.parse(JSON.parse(await readFile(actual, "utf8")));
  const bytes = await readFile(source.path);
  if (bytes.length > 64 * 1024 * 1024) throw new ApiError(413, "preparation_size", "Document exceeds the size limit.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (prepared.sourceSha256 !== hash || prepared.fileAbs !== source.path || prepared.file !== source.file)
    throw new ApiError(409, "preparation_stale", "The document changed. Prepare it again to update its locations.");
  return prepared;
}
