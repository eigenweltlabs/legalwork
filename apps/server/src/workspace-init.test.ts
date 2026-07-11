import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ensureWorkspaceFiles } from "./workspace-init.js";
import { legalworkExtensionsPreviewPluginPath, legalworkPluginPath } from "./legalwork-extensions-plugin-path.js";

async function withWorkspace(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-workspace-init-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("ensureWorkspaceFiles", () => {
  test("creates LegalWork workspace config and seeds bundled-core skills", async () => {
    await withWorkspace(async (root) => {
      const result = await ensureWorkspaceFiles(root, "starter");
      const legalwork = await readFile(join(root, ".opencode", "legalwork.json"), "utf8");
      await expect(readFile(join(root, "opencode.jsonc"), "utf8")).rejects.toThrow();
      expect(legalwork).toContain('"authorizedRoots"');

      // bundled-core: the tabular-review engine + its HTML template + the extractor agent
      const skill = await readFile(join(root, ".opencode", "skills", "tabular-review", "SKILL.md"), "utf8");
      expect(skill).toContain("name: tabular-review");
      await expect(
        stat(join(root, ".opencode", "skills", "tabular-review", "assets", "review-template.html")),
      ).resolves.toBeDefined();
      await expect(stat(join(root, ".opencode", "agents", "document-extractor.md"))).resolves.toBeDefined();
      await expect(stat(join(root, ".opencode", "agents", "fusion-candidate.md"))).resolves.toBeDefined();
      expect([...result.reloadReasons].sort()).toEqual(["agents", "commands", "skills"]);

      // idempotent: a second ensure writes nothing
      const secondResult = await ensureWorkspaceFiles(root, "starter");
      expect(secondResult).toEqual({ changed: false, reloadReasons: [] });
    });
  });

  test("uses shipped extension preview plugin", async () => {
    const pluginPath = legalworkExtensionsPreviewPluginPath();
    const plugin = await readFile(pluginPath, "utf8");
    expect(pluginPath).toContain(join("opencode-plugins", "legalwork-extensions-preview.ts"));
    expect(plugin).toContain("legalwork_extension_call");
  });

  test("uses external resources plugin path in packaged Electron", () => {
    const previousResourcesPath = process.resourcesPath;
    const resourcesPath = join("/Applications", "LegalWork.app", "Contents", "Resources");
    process.resourcesPath = resourcesPath;
    try {
      const pluginPath = legalworkPluginPath(
        "legalwork-extensions-preview",
        join(resourcesPath, "app.asar", "server", "dist"),
      );

      expect(pluginPath).toBe(join(resourcesPath, "opencode-plugins", "legalwork-extensions-preview.js"));
      expect(pluginPath).not.toContain("app.asar");
    } finally {
      if (previousResourcesPath) {
        process.resourcesPath = previousResourcesPath;
      } else {
        delete process.resourcesPath;
      }
    }
  });

  test("does not create workspace extension preview plugin", async () => {
    await withWorkspace(async (root) => {
      await ensureWorkspaceFiles(root, "starter");
      await expect(stat(join(root, ".opencode", "plugins", "legalwork-extensions-preview.ts"))).rejects.toThrow();
    });
  });

  test("does not rewrite existing LegalWork agents", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, ".opencode", "agents"), { recursive: true });
      await writeFile(join(root, ".opencode", "agents", "legalwork.md"), "---\ndescription: Old\n---\n\nOld instructions\n", "utf8");
      const result = await ensureWorkspaceFiles(root, "starter");
      const agent = await readFile(join(root, ".opencode", "agents", "legalwork.md"), "utf8");
      expect(agent).toContain("Old instructions");
      expect(agent).not.toContain("LegalWork Artifacts");
      // seeding the bundled-core extractor must not touch the pre-existing legalwork agent
      expect([...result.reloadReasons].sort()).toEqual(["agents", "commands", "skills"]);
    });
  });

  test("refreshes a stale bundled-core file (older copy, no stamp)", async () => {
    await withWorkspace(async (root) => {
      const tpl = join(root, ".opencode", "skills", "tabular-review", "assets", "review-template.html");
      await mkdir(dirname(tpl), { recursive: true });
      await writeFile(tpl, "OLD UGLY TEMPLATE", "utf8");

      const result = await ensureWorkspaceFiles(root, "starter");
      const after = await readFile(tpl, "utf8");
      expect(after).not.toBe("OLD UGLY TEMPLATE");
      expect(after).toContain("__REVIEW_DATA__"); // refreshed to the current bundled template
      expect(result.reloadReasons).toContain("skills");

      // now stamped at the current bundle — a second ensure is a no-op
      const second = await ensureWorkspaceFiles(root, "starter");
      expect(second).toEqual({ changed: false, reloadReasons: [] });
    });
  });

  test("does not rewrite an existing valid opencode config", async () => {
    await withWorkspace(async (root) => {
      const configPath = join(root, "opencode.jsonc");
      const config = `{
  // User formatting should survive routine workspace resolution.
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "custom"
}
`;
      await writeFile(configPath, config, "utf8");

      const result = await ensureWorkspaceFiles(root, "starter");

      expect(await readFile(configPath, "utf8")).toBe(config);
      expect(result.reloadReasons).not.toContain("config");
    });
  });

  test("does not add a default agent to an existing valid opencode config", async () => {
    await withWorkspace(async (root) => {
      const configPath = join(root, "opencode.jsonc");
      const config = `{
  // Existing project configs must not trigger reload events on route reads.
  "$schema": "https://opencode.ai/config.json"
}
`;
      await writeFile(configPath, config, "utf8");

      const result = await ensureWorkspaceFiles(root, "starter");

      expect(await readFile(configPath, "utf8")).toBe(config);
      expect(result.reloadReasons).not.toContain("config");
    });
  });

  test("does not repair or inject into desktop-created schema-only opencode config", async () => {
    await withWorkspace(async (root) => {
      await mkdir(join(root, ".opencode"), { recursive: true });
      await writeFile(join(root, ".opencode", "legalwork.json"), "{}\n", "utf8");
      const configPath = join(root, "opencode.jsonc");
      await writeFile(configPath, `{
  "$schema": "https://opencode.ai/config.json"
}
`, "utf8");

      const result = await ensureWorkspaceFiles(root, "starter");
      const config = await readFile(configPath, "utf8");

      expect(config).toBe(`{
  "$schema": "https://opencode.ai/config.json"
}
`);
      expect(result.reloadReasons).not.toContain("config");
    });
  });
});
