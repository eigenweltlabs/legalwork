import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { LegalworkServerError } from "@/app/lib/legalwork-server";

export type WikiImportFile = { file: File | null; path: string };
type DropEntry = Pick<FileSystemEntry, "name" | "isFile" | "isDirectory"> & {
  file?: FileSystemFileEntry["file"];
  createReader?: () => { readEntries: (success: (entries: DropEntry[]) => void, error?: ErrorCallback) => void };
};
type DropData = { items: ArrayLike<{ kind: string; webkitGetAsEntry?: () => DropEntry | null }>; files: ArrayLike<File> };

/** Capture the drop entries synchronously, before the browser protects the drag data. */
export async function wikiDroppedFiles(data: DropData): Promise<WikiImportFile[]> {
  const entries = Array.from(data.items).filter(item => item.kind === "file").map(item => item.webkitGetAsEntry?.()).filter(entry => entry != null);
  const fallback = Array.from(data.files).map(file => ({ file, path: file.webkitRelativePath || file.name }));
  if (!entries.length) return fallback;
  const files: WikiImportFile[] = [];
  const visit = async (entry: DropEntry, parent: string): Promise<void> => {
    const path = parent + entry.name;
    if (entry.isFile && entry.file) {
      const readFile = entry.file.bind(entry);
      const file = await new Promise<File>((resolve, reject) => readFile(resolve, reject));
      files.push({ file, path });
    } else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      let empty = true;
      for (;;) {
        const children = await new Promise<DropEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!children.length) break;
        empty = false;
        for (const child of children) await visit(child, `${path}/`);
      }
      if (empty) files.push({ file: null, path });
    }
  };
  for (const entry of entries) await visit(entry, "");
  return files;
}

export function wikiImportPath(folder: string, path: string): string {
  const clean = `${folder ? `${folder}/` : ""}${path}`.replace(/\\/g, "/").split("/");
  if (path.startsWith("/") || clean.some(part => !part || part === "." || part === ".." || part.startsWith(".") || /[<>:"|?*%#\x00-\x1f]/.test(part))) throw new Error(`Invalid wiki filename: ${path}`);
  return clean.join("/");
}

function availablePath(path: string, occupied: Set<string>) {
  if (!occupied.has(path)) return path;
  const dot = /\.view\.json$/i.test(path) ? path.length - ".view.json".length : path.lastIndexOf(".");
  const extension = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
  const stem = extension ? path.slice(0, -extension.length) : path;
  for (let number = 2; ; number++) {
    const candidate = `${stem} (${number})${extension}`;
    if (!occupied.has(candidate)) return candidate;
  }
}

/** Creation-only writes never replace an existing file, including concurrent imports. */
export async function importWikiFiles(client: Pick<LegalworkServerClient, "uploadWikiAsset" | "changeWikiEntry">, wikiId: string, folder: string, files: WikiImportFile[], existing: string[]) {
  const occupied = new Set(existing);
  const saved: string[] = [];
  const errors: string[] = [];
  for (const item of files) {
    try {
      const original = wikiImportPath(folder, item.path);
      const data = item.file ? await item.file.arrayBuffer() : null;
      for (let attempt = 0; ; attempt++) {
        const path = availablePath(original, occupied);
        try {
          if (data) await client.uploadWikiAsset(wikiId, path, data);
          else await client.changeWikiEntry(wikiId, { action: "create-folder", path });
          occupied.add(path); saved.push(path); break;
        }
        catch (error) { if (!(error instanceof LegalworkServerError && error.status === 409) || attempt >= 20) throw error; occupied.add(path); }
      }
    } catch (error) { errors.push(`${item.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { saved, errors };
}
