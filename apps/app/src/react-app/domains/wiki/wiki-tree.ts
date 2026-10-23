export type WikiTreeEntry = { path: string; kind: "file" | "folder" };
export type WikiTreeNode = WikiTreeEntry & { name: string; children: WikiTreeNode[] };

export function wikiFileLabel(path: string, title?: string) {
  const filename = path.split("/").at(-1) ?? path;
  return /^AGENTS\.md$/i.test(filename) ? filename : title ?? filename.replace(/\.md$/i, "");
}

/** Folders are ordinary directories, including empty directories from the server. */
export function wikiTree(files: string[], folders: string[]): WikiTreeNode[] {
  const nodes = new Map<string, WikiTreeNode>();
  const roots: WikiTreeNode[] = [];
  const folder = (path: string): WikiTreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const name = path.split("/").at(-1) ?? path;
    const node: WikiTreeNode = { path, name, kind: "folder", children: [] };
    nodes.set(path, node);
    const parent = path.includes("/") ? folder(path.slice(0, path.lastIndexOf("/"))).children : roots;
    parent.push(node);
    return node;
  };
  for (const path of folders) folder(path);
  for (const path of files) {
    const parent = path.includes("/") ? folder(path.slice(0, path.lastIndexOf("/"))).children : roots;
    parent.push({ path, name: (path.split("/").at(-1) ?? path).replace(/\.md$/i, ""), kind: "file", children: [] });
  }
  const sort = (children: WikiTreeNode[]) => {
    children.sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name, undefined, { numeric: true }));
    children.forEach((node) => sort(node.children));
  };
  sort(roots);
  return roots;
}

export function wikiCopyPath(path: string, existing: string[]): string {
  const dot = /\.view\.json$/i.test(path) ? path.length - ".view.json".length : path.lastIndexOf(".");
  const extension = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
  const stem = extension ? path.slice(0, dot) : path;
  let count = 1;
  let candidate = `${stem} copy${extension}`;
  while (existing.includes(candidate)) candidate = `${stem} copy ${++count}${extension}`;
  return candidate;
}

/** A folder is empty only when it contains neither files nor subfolders. */
export function wikiFolderEmpty(node: WikiTreeNode): boolean {
  return node.kind === "folder" && node.children.length === 0;
}
