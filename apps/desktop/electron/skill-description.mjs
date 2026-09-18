import { parse } from "yaml";

export function extractDescription(raw) {
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let description = "";
  if (frontmatter) {
    try {
      const data = parse(frontmatter[1]);
      if (typeof data?.description === "string") description = data.description.trim();
    } catch {
      // Malformed metadata must not prevent the rest of the library from loading.
    }
  }
  if (!description) {
    const body = raw.slice(frontmatter?.[0].length ?? 0).replace(/<!--[\s\S]*?-->/g, "");
    description = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#") && line !== "---") ?? "";
  }
  const cleaned = description.replace(/`/g, "").replace(/\s+/g, " ").trim();
  return cleaned ? (cleaned.length > 180 ? `${cleaned.slice(0, 180)}...` : cleaned) : null;
}
