// Same cap as validateSkillName. The engine passes a skill's name to its single
// `skill` tool as an argument, so the providers' 64-char tool-name cap doesn't apply.
const MAX_SKILL_NAME_LENGTH = 200;

/**
 * Coerce a free-text name into a valid kebab-case slug of at most 200 chars,
 * dropping whole trailing words rather than cutting mid-word (same rule the
 * desktop import uses, so a name behaves identically whichever path created it).
 */
export function fitSkillName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return "";
  if (cleaned.length <= MAX_SKILL_NAME_LENGTH) return cleaned;
  const words = cleaned.split("-");
  let candidate = words[0]!.slice(0, MAX_SKILL_NAME_LENGTH);
  for (let index = 1; index < words.length; index += 1) {
    const next = `${candidate}-${words[index]}`;
    if (next.length > MAX_SKILL_NAME_LENGTH) break;
    candidate = next;
  }
  return candidate.replace(/-+$/g, "");
}

/**
 * Workflows are marked by a `workflow-<type>-` name prefix, not by frontmatter:
 * the app detects them by it, and the engine skips a SKILL.md that carries
 * non-standard frontmatter keys. Mirrors the Workflows view's naming.
 */
export function resolveSkillName(input: { name: string; kind: "skill" | "workflow"; workflowType: "assistant" | "tabular" }): string {
  const slug = fitSkillName(input.name);
  if (!slug) return "";
  if (input.kind !== "workflow") return slug;
  const bare = slug.replace(/^workflow-(?:assistant|tabular)-/, "").replace(/^workflow-/, "");
  return fitSkillName(`workflow-${input.workflowType}-${bare}`);
}

function titleFromName(name: string): string {
  return name
    .replace(/^workflow-(?:assistant|tabular)-/, "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Build the SKILL.md. Frontmatter stays standard (name + description only) so
 * the engine loads it as an ordinary skill; a tabular workflow's body carries
 * the instruction to use saved project review tools.
 */
export function buildSkillMarkdown(input: {
  fullName: string;
  description: string;
  instructions: string;
  kind: "skill" | "workflow";
  workflowType: "assistant" | "tabular";
}): string {
  const frontmatter = `---\nname: ${input.fullName}\ndescription: ${JSON.stringify(input.description.trim())}\n---\n`;
  const body = input.instructions.trim();
  if (input.kind !== "workflow" || input.workflowType === "assistant") {
    return `${frontmatter}\n${body}\n`;
  }
  const title = titleFromName(input.fullName);
  return `${frontmatter}\n${[
    `# ${title}`,
    ``,
    "This is a **tabular review workflow**. Run it as a saved project review using legalwork_review_create and legalwork_review_start.",
    "First read legalwork_review_settings. Its mode is mandatory: Only JEV accepts yes/no or fixed-choice classification; mixed mode routes decisions to JEV and text to LLM; Only LLM never uses JEV inference.",
    "Use legalwork_review_library to reuse exact column definitions and sets. Do not silently rewrite or drop incompatible questions; ask the user to choose compatible questions or change settings.",
    "Create one row per project document and the columns defined below. The live review card shows progress and opens the saved grid. Do not build an HTML artifact or run separate extraction agents.",
    ``,
    `## What to extract`,
    ``,
    body,
    ``,
    `When the user asks to run "${title}", use the saved-review tools above.`,
  ].join("\n")}\n`;
}
