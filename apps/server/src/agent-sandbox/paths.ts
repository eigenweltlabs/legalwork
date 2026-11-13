import type { SandboxMount } from "./vm.js";

/** Translate only complete mounted path prefixes, never an unrelated sibling.
 * Keep the original command for permission review; execute against the same
 * authorized files using their guest names. Longest prefixes win for skills
 * nested inside the workspace. */
export function sandboxPaths(value: string, mounts: Pick<SandboxMount, "source" | "target">[], options: { directory?: boolean } = {}) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches: Array<{ index: number; length: number; boundary: string; target: string; windows: boolean }> = [];
  for (const mount of mounts) {
    const windows = /^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(mount.source);
    const source = mount.source.replace(windows ? /[\\/]+$/ : /\/+$/, "");
    if (!source) continue;
    const prefix = windows ? source.split(/[\\/]/).map(escape).join("[\\\\/]") : escape(source);
    const boundary = options.directory ? "(^)" : "(^|[\\s\"'=:(])";
    const pattern = new RegExp(`${boundary}(${prefix})(?=${windows ? "[\\\\/]" : "/"}|["']|$)`, windows ? "gi" : "g");
    for (const match of value.matchAll(pattern)) matches.push({ index: match.index, length: match[0].length, boundary: match[1], target: mount.target, windows });
  }
  matches.sort((a, b) => a.index - b.index || b.length - a.length);
  let result = "", end = 0;
  for (const match of matches) {
    if (match.index < end) continue;
    const suffix = match.index + match.length;
    let until = suffix;
    if (match.windows) {
      const quote = match.boundary === "\"" || match.boundary === "'" ? match.boundary : null;
      while (until < value.length && (options.directory || (quote ? value[until] !== quote : !/[\s"';&|()]/.test(value[until])))) until++;
    }
    result += value.slice(end, match.index) + match.boundary + match.target + value.slice(suffix, until).replaceAll("\\", "/");
    end = until;
  }
  return result + value.slice(end);
}
