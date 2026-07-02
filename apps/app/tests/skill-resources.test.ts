import { describe, expect, test } from "bun:test";

import { syncAttachedFilesSection } from "../src/app/utils/skill-resources";

const block = (files: string[]) =>
  [
    "<!-- legalwork:resources:start -->",
    "## Attached resources",
    "",
    ...files.map((name) => `- \`resources/${name}\``),
    "<!-- legalwork:resources:end -->",
  ].join("\n");

const skill = (body: string) => `---\nname: a\ndescription: b\n---\n\n${body}`;

describe("syncAttachedFilesSection", () => {
  test("appends the server block when the editor content has none", () => {
    const current = skill("Body text.\n");
    const server = skill(`Body text.\n\n${block(["nda.md"])}\n`);
    const next = syncAttachedFilesSection(current, server);
    expect(next).toBe(skill(`Body text.\n\n${block(["nda.md"])}\n`));
  });

  test("replaces a stale block with the server one", () => {
    const current = skill(`Body text.\n\n${block(["old.md"])}\n`);
    const server = skill(`Body text.\n\n${block(["new.md", "other.md"])}\n`);
    const next = syncAttachedFilesSection(current, server);
    expect(next).toContain("resources/new.md");
    expect(next).toContain("resources/other.md");
    expect(next).not.toContain("old.md");
  });

  test("removes the block when the server content has none", () => {
    const current = skill(`Body text.\n\n${block(["gone.md"])}\n`);
    const next = syncAttachedFilesSection(current, skill("Body text.\n"));
    expect(next).toBe(skill("Body text.\n"));
  });

  test("preserves unsaved user edits outside the block", () => {
    const current = skill(`My unsaved edit.\n\n${block(["old.md"])}\n`);
    const server = skill(`Original body.\n\n${block(["new.md"])}\n`);
    const next = syncAttachedFilesSection(current, server);
    expect(next).toContain("My unsaved edit.");
    expect(next).not.toContain("Original body.");
    expect(next).toContain("resources/new.md");
  });

  test("is idempotent", () => {
    const server = skill(`Body.\n\n${block(["a.md"])}\n`);
    const once = syncAttachedFilesSection(skill("Body.\n"), server);
    expect(syncAttachedFilesSection(once, server)).toBe(once);
  });

  test("matches the server content exactly for a clean editor", () => {
    const server = skill(`Body.\n\n${block(["a.md"])}\n`);
    expect(syncAttachedFilesSection(server, server)).toBe(server);
  });
});
