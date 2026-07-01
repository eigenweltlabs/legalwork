// Read/write the `templates:` list in a SKILL.md's YAML frontmatter without a
// YAML dependency. Template names are plain file names (validated server-side),
// so a line-based frontmatter edit is safe. The server regenerates the matching
// "Firm templates" body section from this list on save.

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;
const PLAIN_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Extract the `templates:` file names from SKILL.md content. */
export function getSkillTemplates(content: string): string[] {
  const match = content.match(FRONTMATTER_REGEX);
  if (!match) return [];
  const names: string[] = [];
  let inTemplates = false;
  for (const line of match[1].split(/\r?\n/)) {
    if (inTemplates) {
      const item = line.match(/^\s+-\s+(.+)$/);
      if (item) {
        const name = unquote(item[1]);
        if (name) names.push(name);
        continue;
      }
      inTemplates = false;
    }
    const inline = line.match(/^templates:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const raw of inline[1].split(",")) {
        const name = unquote(raw);
        if (name) names.push(name);
      }
      continue;
    }
    if (/^templates:\s*$/.test(line)) inTemplates = true;
  }
  return names;
}

/**
 * Return SKILL.md content with its frontmatter `templates:` list replaced by
 * `templates` (removed entirely when the list is empty). Other frontmatter
 * keys and the body are left untouched.
 */
export function setSkillTemplates(content: string, templates: string[]): string {
  const seen = new Set<string>();
  const names = templates.map((name) => name.trim()).filter((name) => {
    if (!name || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const block = names.length
    ? ["templates:", ...names.map((name) => `  - ${PLAIN_NAME_REGEX.test(name) ? name : JSON.stringify(name)}`)].join("\n")
    : "";

  const match = content.match(FRONTMATTER_REGEX);
  if (!match) {
    if (!block) return content;
    return `---\n${block}\n---\n\n${content.replace(/^\n+/, "")}`;
  }

  const kept: string[] = [];
  let inTemplates = false;
  for (const line of match[1].split(/\r?\n/)) {
    if (inTemplates && /^\s+-\s/.test(line)) continue;
    inTemplates = false;
    if (/^templates:/.test(line)) {
      inTemplates = /^templates:\s*$/.test(line);
      continue;
    }
    kept.push(line);
  }
  const frontmatter = [...kept, ...(block ? [block] : [])].join("\n");
  return `---\n${frontmatter}\n---\n${content.slice(match[0].length)}`;
}
