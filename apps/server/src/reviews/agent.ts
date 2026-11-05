import { CORE_OPENCODE_FILES } from "../core-skills.js";
import { parseFrontmatter } from "../frontmatter.js";

import { REVIEW_AGENT } from "./worker-identity.js";
export { REVIEW_AGENT } from "./worker-identity.js";

/** Register trusted review instructions even when project config discovery is disabled. */
export function reviewAgentConfig(): Record<string, unknown> {
  const file = CORE_OPENCODE_FILES.find(file => file.path === `.opencode/agents/${REVIEW_AGENT}.md`);
  if (!file) throw new Error("The built-in review worker is missing from the LegalWork bundle.");
  const { data, body } = parseFrontmatter(file.content);
  return { ...data, prompt: body.trim(), permission: { "*": "deny", legalwork_review_submit: "allow" } };
}
