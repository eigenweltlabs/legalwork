import { posix, win32 } from "node:path";

export function normalizeScopedDirectoryPath(input: string, platform = process.platform) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const withoutVerbatim = /^\\\\\?\\UNC[\\/]/i.test(trimmed)
    ? `\\\\${trimmed.slice(8)}`
    : /^\\\\\?\\[a-zA-Z]:[\\/]/.test(trimmed)
      ? trimmed.slice(4)
      : trimmed;
  const unified = withoutVerbatim.replace(/\\/g, "/");
  const withoutTrailing = unified.replace(/\/+$/, "");
  const normalized = withoutTrailing || "/";
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithinWorkspaceRootPath(input: {
  workspaceRoot: string;
  candidate: string;
  platform?: NodeJS.Platform;
}) {
  const platform = input.platform ?? process.platform;
  const paths = platform === "win32" ? win32 : posix;
  const root = paths.resolve(input.workspaceRoot);
  const rootForComparison =
    platform === "win32"
      ? normalizeScopedDirectoryPath(root, platform)
      : root;
  const resolved = paths.resolve(input.candidate || input.workspaceRoot);
  const resolvedForComparison =
    platform === "win32"
      ? normalizeScopedDirectoryPath(resolved, platform)
      : resolved;
  const relativePath = paths.relative(rootForComparison, resolvedForComparison);
  if (!relativePath || relativePath === ".") return true;
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relativePath)
  ) return false;
  const boundary = rootForComparison.endsWith("/")
    ? rootForComparison
    : `${rootForComparison}/`;
  return (
    resolvedForComparison === rootForComparison ||
    resolvedForComparison.startsWith(boundary)
  );
}
