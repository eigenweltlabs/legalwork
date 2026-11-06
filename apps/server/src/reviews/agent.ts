import { CORE_OPENCODE_FILES } from "../core-skills.js";
import { parseFrontmatter } from "../frontmatter.js";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";

import { REVIEW_AGENT } from "./worker-identity.js";
export { REVIEW_AGENT } from "./worker-identity.js";

/** Register the trusted review worker through the native agent schema. */
export function reviewAgentConfig(): Record<string, unknown> {
  const file = CORE_OPENCODE_FILES.find(file => file.path === `.opencode/agents/${REVIEW_AGENT}.md`);
  if (!file) throw new Error("The built-in review worker is missing from the LegalWork bundle.");
  const { data, body } = parseFrontmatter(file.content);
  const configuration = Schema.decodeUnknownSync(Config.Info)({ agents: { [REVIEW_AGENT]: {
    ...data, system: body.trim(), permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "legalwork_review_submit", resource: "*", effect: "allow" },
    ],
  } } }, { onExcessProperty: "error" });
  const agent = configuration.agents?.[REVIEW_AGENT];
  if (!agent) throw new Error("The native review worker configuration is missing.");
  return agent;
}
