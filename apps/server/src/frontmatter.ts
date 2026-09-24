import matter from "gray-matter";
import { stringify } from "yaml";

// Match OpenCode's ConfigMarkdown.parse: retry invalid YAML after rewriting
// unquoted values containing colons as block scalars.
function sanitize(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;
  const frontmatter = match[1]!;
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line];
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!entry) return [line];
    const value = entry[2]!.trim();
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line];
    if (!value.includes(":")) return [line];
    return [`${entry[1]}: |-`, `  ${value}`];
  });
  return content.replace(frontmatter, () => result.join("\n"));
}

export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  try {
    const parsed = matter(content);
    return { data: parsed.data, body: parsed.content };
  } catch {
    const parsed = matter(sanitize(content));
    return { data: parsed.data, body: parsed.content };
  }
}

export function buildFrontmatter(data: Record<string, unknown>): string {
  const yaml = stringify(data).trimEnd();
  return `---\n${yaml}\n---\n`;
}
