import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSkillFrontmatter } from "./skill-frontmatter.mjs";

test("parses unquoted colons in skill descriptions like OpenCode", () => {
  const parsed = parseSkillFrontmatter("---\nname: caption-templates\ndescription: Review: client captions\n---\n\n# Captions\n");
  assert.equal(parsed.data.name, "caption-templates");
  assert.equal(parsed.data.description, "Review: client captions");
  assert.equal(parsed.content, "\n# Captions\n");
});

test("preserves valid YAML without sanitizing it", () => {
  const parsed = parseSkillFrontmatter("---\nname: caption-templates\ndescription: 'Review: client captions'\n---\nBody\n");
  assert.equal(parsed.data.description, "Review: client captions");
  assert.equal(parsed.content, "Body\n");
});
