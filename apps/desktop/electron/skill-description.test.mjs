import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDescription } from "./skill-description.mjs";

test("uses the authored YAML description instead of the import notice", () => {
  assert.equal(extractDescription('---\nname: workflow-assistant-discovery\ndescription: >-\n  Plan and review\n  document discovery.\n---\n<!-- Modified by LegalWork: metadata adapted. -->\n# Discovery\nOther body text.'), "Plan and review document discovery.");
});
test("body fallback skips multiline and inline HTML comments", () => {
  assert.equal(extractDescription('# Discovery\n<!-- Modified by LegalWork:\nmetadata adapted. -->\n\nReview <!-- internal -->documents.'), "Review documents.");
});
test("handles malformed metadata and empty visible content", () => {
  assert.equal(extractDescription('---\ndescription: [invalid\n---\n<!-- notice -->\n# Title\nUseful description.'), "Useful description.");
  assert.equal(extractDescription('<!-- notice -->\n# Title'), null);
});
