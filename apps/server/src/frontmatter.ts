import { parse, stringify } from "yaml";

// Match OpenCode's retry for unquoted colons in frontmatter values.
function sanitizeUnquotedColons(raw: string): string {
  return raw.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line];
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!entry) return [line];
    const value = entry[2]!.trim();
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line];
    if (!value.includes(":")) return [line];
    return [`${entry[1]}: |-`, `  ${value}`];
  }).join("\n");
}

function parseYamlWithOpenCodeFallback(raw: string): Record<string, unknown> {
  try {
    return (parse(raw) as Record<string, unknown>) ?? {};
  } catch {
    return (parse(sanitizeUnquotedColons(raw)) as Record<string, unknown>) ?? {};
  }
}

export function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { data: {}, body: content };
  }
  const raw = match[1] ?? "";
  const data = parseYamlWithOpenCodeFallback(raw);
  const body = content.slice(match[0].length);
  return { data, body };
}

export function buildFrontmatter(data: Record<string, unknown>): string {
  const yaml = stringify(data).trimEnd();
  return `---\n${yaml}\n---\n`;
}
