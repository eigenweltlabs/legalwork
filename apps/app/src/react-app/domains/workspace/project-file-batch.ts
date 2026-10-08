import type { ProjectFileSource } from "@legalwork/types/project-files";
import { projectFileSourceKey } from "@/app/lib/project-file-drag";

export type FileTransferItem = { source: ProjectFileSource; name: string; done: boolean; error: string };
export function fileTransferItems(sources: ProjectFileSource[]): FileTransferItem[] {
  return [...new Map(sources.map(source => [projectFileSourceKey(source), source])).values()]
    .map(source => ({ source, name: source.name, done: false, error: "" }));
}
/** Preserve successes across retries; a failed file must not re-copy completed files. */
export async function transferFileBatch(items: FileTransferItem[], write: (item: FileTransferItem) => Promise<unknown>, report: (items: FileTransferItem[]) => void) {
  const results = items.map(item => ({ ...item }));
  for (const [index, item] of results.entries()) {
    if (item.done) continue;
    try { await write(item); results[index] = { ...item, done: true, error: "" }; }
    catch (error) { results[index] = { ...item, error: error instanceof Error ? error.message : String(error) }; }
    report([...results]);
  }
  return results;
}
