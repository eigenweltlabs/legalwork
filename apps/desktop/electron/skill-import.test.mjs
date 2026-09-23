import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { normalizeImportedSkill } from "./skill-import.mjs";

const NAME = "workflow-assistant-irp2-initial-product-evaluation";

test("adds a runtime-loadable name to description-only workflow frontmatter", () => {
  const result = normalizeImportedSkill("---\r\ndescription: Evaluate a product.\r\n---\r\n\r\n# IRP2\r\nFollow the workflow.\r\n", NAME);
  const header = result.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(header);
  assert.deepEqual(parse(header[1]), { description: "Evaluate a product.", name: NAME });
  assert.ok(result.endsWith("\r\n# IRP2\r\nFollow the workflow.\r\n"));
});

test("replaces an old name and derives a description when importing a plain skill", () => {
  const result = normalizeImportedSkill("# IRP2\nEvaluate the product and its evidence.\n", NAME);
  assert.match(result, new RegExp(`name: ${NAME}`));
  assert.match(result, /description: Evaluate the product and its evidence\./);
  assert.ok(result.endsWith("# IRP2\nEvaluate the product and its evidence.\n"));

  const renamed = normalizeImportedSkill("---\nname: initial-product-evaluation\ndescription: Evaluate a product.\n---\nBody\n", NAME);
  assert.match(renamed, new RegExp(`name: ${NAME}`));
  assert.doesNotMatch(renamed, /name: initial-product-evaluation/);
});

test("rejects imports that cannot be loaded or advertised", () => {
  assert.throws(() => normalizeImportedSkill("---\ndescription: [broken\n---\nBody\n", NAME), /invalid YAML/);
  assert.throws(() => normalizeImportedSkill("---\ndescription: missing end\nBody\n", NAME), /incomplete frontmatter/);
  assert.throws(() => normalizeImportedSkill("# Heading only\n", NAME), /needs a description/);
  assert.throws(() => normalizeImportedSkill(`---\ndescription: ${"x".repeat(1025)}\n---\nBody\n`, NAME), /at most 1024/);
});
