import { createHash } from "node:crypto";
import { z } from "zod";
import type { StorageFilenameSearch, StorageFilenameSearchPage, StoragePage } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import { storagePath, type StorageAdapter } from "./common.js";
import { STORAGE_PAGE_SIZE } from "./schema.js";

const frameSchema = z.object({
  name: z.string().max(4096),
  cursor: z.string().max(16_384).optional(),
  offset: z.number().int().min(0),
});
const cursorSchema = z.object({
  scope: z.string(),
  frames: z.array(frameSchema).min(1).max(2048),
});
const invalidCursor = () =>
  new ApiError(400, "invalid_storage_cursor", "This search page is no longer valid. Start the search again.");
const fold = (value: string) => value.normalize("NFC").toLowerCase();

/** Read metadata only, with bounded work per request and resumable depth-first traversal.
 * Object stores enumerate flat pages; directory protocols only walk on an explicit search.
 * The cursor retains positions, never file contents or a persistent index.
 */
export async function searchFilenames(
  adapter: Pick<StorageAdapter, "list" | "listFiles">,
  input: StorageFilenameSearch,
  connectionRevision: string,
  signal?: AbortSignal,
): Promise<StorageFilenameSearchPage> {
  const root = storagePath(input.path);
  const query = fold(input.query);
  const flat = Boolean(adapter.listFiles);
  const scope = createHash("sha256")
    .update(JSON.stringify([connectionRevision, root, query, flat]))
    .digest("hex");
  let frames: z.infer<typeof frameSchema>[] = [{ name: "", offset: 0 }];
  if (input.cursor) {
    try {
      const cursor = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
      if (cursor.scope !== scope || cursor.frames[0]!.name !== "" || (flat && cursor.frames.length !== 1))
        throw invalidCursor();
      for (const frame of cursor.frames.slice(1)) {
        if (storagePath(frame.name, false).includes("/")) throw invalidCursor();
      }
      frames = cursor.frames;
    } catch {
      throw invalidCursor();
    }
  }
  const entries: StorageFilenameSearchPage["entries"] = [];
  const pages = new Map<string, StoragePage>();
  let scanned = 0;
  const deadline = Date.now() + 2000;
  while (frames.length && entries.length < STORAGE_PAGE_SIZE) {
    signal?.throwIfAborted();
    const frame = frames.at(-1)!;
    const path = storagePath([root, ...frames.slice(1).map((item) => item.name)].filter(Boolean).join("/"));
    const key = JSON.stringify([path, frame.cursor]);
    let page = pages.get(key);
    if (!page) {
      if (pages.size >= 10 || (pages.size > 0 && Date.now() >= deadline)) break;
      page = adapter.listFiles
        ? await adapter.listFiles(path, frame.cursor, signal)
        : await adapter.list(path, frame.cursor);
      signal?.throwIfAborted();
      pages.set(key, page);
    }
    if (frame.offset >= page.entries.length) {
      if (page.nextCursor) {
        if (page.nextCursor === frame.cursor)
          throw new ApiError(
            502,
            "storage_listing_stalled",
            "The connection repeated a folder page. Try the search again.",
          );
        frame.cursor = page.nextCursor;
        frame.offset = 0;
      } else frames.pop();
      continue;
    }
    const item = page.entries[frame.offset++]!;
    const prefix = path ? `${path}/` : "";
    const relative = storagePath(item.path, false).slice(prefix.length);
    // Never follow malformed directory entries outside the requested subtree.
    if (!item.path.startsWith(prefix) || !relative || (!flat && relative.includes("/")))
      throw new ApiError(502, "storage_invalid_listing", "The connection returned an invalid folder entry.");
    if (item.kind === "folder") {
      if (!flat) frames.push({ name: relative, offset: 0 });
    } else {
      scanned++;
      if (fold(item.path.split("/").at(-1)!).includes(query)) entries.push(item);
    }
  }
  const nextCursor = frames.length ? Buffer.from(JSON.stringify({ scope, frames })).toString("base64url") : undefined;
  if (nextCursor && nextCursor.length > 65_536)
    throw new ApiError(422, "storage_search_too_deep", "Search within a smaller folder to continue.");
  return { entries, scanned, ...(nextCursor ? { nextCursor } : {}) };
}
