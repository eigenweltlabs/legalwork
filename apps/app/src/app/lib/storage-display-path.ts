import type { StorageRoot } from "@legalwork/types/file-storage";

/** Presentation only: operations must retain the original provider identity path. */
export function storageDisplayPath(root: Pick<StorageRoot, "provider">, path: string) {
  if (!["google-drive", "onedrive", "onedrive-personal", "sharepoint-files"].includes(root.provider ?? "")) return path;
  return path.split("/").map(segment => segment.replace(/^~lw~[A-Za-z0-9_-]+~/, "")).join("/");
}
