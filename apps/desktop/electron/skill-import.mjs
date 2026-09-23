import { parse, stringify } from "yaml";
import { extractDescription } from "./skill-description.mjs";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function normalizeImportedSkill(raw, name) {
  const content = raw.replace(/^\uFEFF/, "");
  const match = content.match(FRONTMATTER);
  let metadata = {};
  if (match) {
    try {
      metadata = parse(match[1]);
    } catch {
      throw new Error("SKILL.md has invalid YAML frontmatter");
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("SKILL.md frontmatter must be a YAML mapping");
    }
  } else if (content.startsWith("---")) {
    throw new Error("SKILL.md has an incomplete frontmatter block");
  }

  const body = content.slice(match?.[0].length ?? 0);
  const description = typeof metadata.description === "string" && metadata.description.trim()
    ? metadata.description.trim()
    : extractDescription(body);
  if (!description) {
    throw new Error("SKILL.md needs a description or a line of prose to describe when to use it");
  }
  if (description.length > 1024) {
    throw new Error("SKILL.md description must be at most 1024 characters");
  }

  return `---\n${stringify({ ...metadata, name, description }).trimEnd()}\n---\n${body}`;
}
