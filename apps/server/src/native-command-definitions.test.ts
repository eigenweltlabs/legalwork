import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { commandDefinitionsSchema, encodeCommandDefinitions, resolveNativeCommandDefinitions } from "./native-command-definitions.js";

test("native command entries, sorted Markdown and app overrides retain exact precedence and complete templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-command-definitions-"));
  try {
    await Promise.all(["command/nested", "commands/.hidden", "external"].map(name => mkdir(join(root, name), { recursive: true })));
    await writeFile(join(root, "command", "same.md"), "---\ndescription: first\n---\nFirst directory command\n");
    await writeFile(join(root, "commands", "same.md"), "---\ndescription: later\n---\nLater sorted directory command\n");
    await writeFile(join(root, "command", "nested", "child.md"), "---\nmodel: fixture/model#deep\nsubagent: true\n---\n  Nested command  \n");
    await writeFile(join(root, "commands", ".hidden", "colon.md"), "---\ndescription: Check: complete\n---\nColon description\n");
    await writeFile(join(root, "commands", "invalid.md"), "---\nsubagent: invalid\n---\nInvalid schema\n");
    await writeFile(join(root, "external", "linked.md"), "Linked command\n");
    await symlink(join(root, "external"), join(root, "commands", "linked"), "dir");
    await symlink(join(root, "commands"), join(root, "commands", "cycle"), "dir");
    const fullTemplate = "Long command input\n".repeat(15_000);
    const result = await resolveNativeCommandDefinitions([
      { type: "document", info: { commands: { same: { template: "Global default" }, first: { template: "First" } } } },
      { type: "directory", path: root },
      { type: "document", info: { commands: { final: { template: fullTemplate }, same: { template: "Project document" } } } },
    ], { same: { template: "App selection", agent: "legalwork" } });
    expect(result.commands.same?.template).toBe("App selection");
    expect(result.commands.first?.template).toBe("First");
    expect(result.commands.final?.template).toBe(fullTemplate);
    expect(result.commands["nested/child"]?.model).toMatchObject({ providerID: "fixture", model: "model", variant: "deep" });
    expect(result.commands["nested/child"]?.subagent).toBe(true);
    expect(result.commands[".hidden/colon"]?.description).toBe("Check: complete");
    expect(result.commands["linked/linked"]?.template).toBe("Linked command");
    expect(result.commands.invalid).toBeUndefined();
    const encoded = encodeCommandDefinitions(result);
    expect(Schema.decodeUnknownSync(commandDefinitionsSchema)(encoded).commands.final?.template).toBe(fullTemplate);
    expect((await resolveNativeCommandDefinitions([{ type: "directory", path: join(root, "missing") }])).commands).toEqual({});
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("same Markdown parses repeatedly after invalid-YAML colon recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-command-repeat-"));
  try {
    await mkdir(join(root, "commands"));
    await writeFile(join(root, "commands", "repeat.md"), "---\ndescription: Review: complete\n---\nRepeat\n");
    for (let i = 0; i < 2; i++) expect((await resolveNativeCommandDefinitions([{ type: "directory", path: root }])).commands.repeat?.description).toBe("Review: complete");
  } finally { await rm(root, { recursive: true, force: true }); }
});
