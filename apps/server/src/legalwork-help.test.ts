import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import { CORE_OPENCODE_FILES } from "./core-skills.js";
import { listSkills } from "./skills.js";
import { ensureWorkspaceFiles } from "./workspace-init.js";
import LegalWorkCapabilitiesKnowledge from "./opencode-plugins/legalwork-capabilities-knowledge.js";
import { nativePluginTestRuntime } from "./opencode-plugins/native-plugin-test-support.js";
import { readSkillPackageFile, skillPackageDirectory } from "./skill-package.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const skillRoot = ".opencode/skills/legalwork-help";
const helpFiles = CORE_OPENCODE_FILES.filter((file) => file.path.startsWith(`${skillRoot}/`));
const referenceSchema = z.object({
  shippedLocales: z.array(z.string()),
  locales: z.record(z.string(), z.object({
    shipped: z.boolean(),
    source: z.string(),
    entryCount: z.number(),
    entries: z.record(z.string(), z.string()),
  })),
});

function bundled(path: string) {
  const found = helpFiles.find((file) => file.path === `${skillRoot}/${path}`);
  if (!found) throw new Error(`Missing bundled help resource: ${path}`);
  return found.content;
}

async function withWorkspace(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-help-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("bundled LegalWork help", () => {
  test("maps every routed screen to a guide and rejects undocumented routes/settings", async () => {
    const inventory = z.object({
      routes: z.array(z.object({ path: z.string(), guide: z.string() })),
      settings: z.array(z.object({ id: z.string(), guide: z.string() })),
    }).parse(JSON.parse(bundled("references/screens.json")));
    const routerPath = "apps/app/src/react-app/shell/app-root.tsx";
    const settingsPath = "apps/app/src/react-app/domains/settings/shell/settings-page.tsx";
    const router = await readFile(join(repoRoot, routerPath), "utf8");
    const settings = await readFile(join(repoRoot, settingsPath), "utf8");
    expect(inventory.routes.map((route) => route.path).sort()).toEqual(
      [...new Set([...router.matchAll(/\bpath="([^"]+)"/g)].map((match) => match[1]))].sort(),
    );
    for (const entry of [...inventory.routes, ...inventory.settings]) {
      expect(bundled(`references/${entry.guide}`).length).toBeGreaterThan(0);
    }
    expect(inventory.settings.map((entry) => entry.id)).toContain("recorder");
    const moduleUrl = pathToFileURL(join(repoRoot, "scripts/help-docs.mjs")).href;
    const generate = (root: string) => spawnSync("node", ["--input-type=module", "-e",
      `import { generateHelpScreens } from ${JSON.stringify(moduleUrl)}; process.stdout.write(generateHelpScreens(process.argv[1]));`, root,
    ], { encoding: "utf8" });
    await withWorkspace(async (root) => {
      await mkdir(dirname(join(root, routerPath)), { recursive: true });
      await mkdir(dirname(join(root, settingsPath)), { recursive: true });
      await writeFile(join(root, routerPath), router);
      await writeFile(join(root, settingsPath), settings);
      const baseline = generate(root);
      expect(baseline.status).toBe(0);
      expect(baseline.stdout).toBe(bundled("references/screens.json"));
      await writeFile(join(root, routerPath), router.replace("<Routes>", '<Routes><Route path="/undocumented-screen" element={null} />'));
      const missingRoute = generate(root);
      expect(missingRoute.status).not.toBe(0);
      expect(missingRoute.stderr).toContain("Missing help coverage for /undocumented-screen");
      await writeFile(join(root, routerPath), router);
      await writeFile(join(root, settingsPath), settings.replace("return tabs;", 'tabs.push("undocumented-setting"); return tabs;'));
      const missingSetting = generate(root);
      expect(missingSetting.status).not.toBe(0);
      expect(missingSetting.stderr).toContain("Missing help coverage for undocumented-setting");
    });
  });

  test("packages every manual page exactly and resolves links without the source checkout", async () => {
    const docs = await readdir(join(repoRoot, "docs/user-guide"));
    for (const file of docs.filter((file) => file.endsWith(".md") || file.endsWith(".json"))) {
      expect(bundled(`references/${file}`)).toBe((await readFile(join(repoRoot, "docs/user-guide", file), "utf8")).replace(/\r\n/g, "\n"));
      if (file !== "index.md" && file.endsWith(".md")) {
        expect(bundled("references/index.md")).toContain(`](${file})`);
      }
    }
    const paths = new Set(helpFiles.map((file) => file.path));
    for (const file of helpFiles.filter((file) => file.path.endsWith(".md"))) {
      for (const match of file.content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^[a-z]+:/i.test(target)) continue;
        expect(paths.has(posix.normalize(posix.join(posix.dirname(file.path), target)))).toBe(true);
      }
    }
  });

  test("preserves all actual runtime-exported translations in every existing locale", async () => {
    const reference = referenceSchema.parse(JSON.parse(bundled("references/i18n.json")));
    const localeDir = join(repoRoot, "apps/app/src/i18n/locales");
    const files = (await readdir(localeDir)).filter((file) => file.endsWith(".ts") && file !== "index.ts");
    expect(Object.keys(reference.locales).sort()).toEqual(files.map((file) => file.slice(0, -3)).sort());
    const runtime = await import(pathToFileURL(join(repoRoot, "apps/app/src/i18n/index.ts")).href);
    expect(reference.shippedLocales).toEqual(runtime.LANGUAGES);
    for (const file of files) {
      const code = file.slice(0, -3);
      const original = await import(pathToFileURL(join(localeDir, file)).href);
      const entries = z.record(z.string(), z.string()).parse(original.default);
      expect(reference.locales[code].entries).toEqual(entries);
      expect(reference.locales[code].entryCount).toBe(Object.keys(entries).length);
      expect(reference.locales[code].shipped).toBe(reference.shippedLocales.includes(code));
    }
  });

  test("is discoverable and supports localized lookups after seeding a workspace", async () => {
    await withWorkspace(async (root) => {
      await ensureWorkspaceFiles(root, "starter");
      const skill = (await listSkills(root, false)).find((item) => item.name === "legalwork-help");
      expect(skill?.path).toBe(join(root, skillRoot, "SKILL.md"));
      expect(skill?.scope).toBe("project");
      if (!skill) throw new Error("Help skill is missing");
      const email = await readSkillPackageFile(skill.path, await skillPackageDirectory(skill.path), "references/email.md");
      expect(email.content).toBe(bundled("references/email.md"));
      expect(email.nextOffset).toBeUndefined();
      for (const file of helpFiles) {
        expect(await readFile(join(root, file.path), "utf8")).toBe(file.content);
      }
      const helper = join(root, skillRoot, "scripts/lookup-label.mjs");
      // No repo cwd, source files, dependencies or network are needed by this helper.
      const exact = spawnSync("node", [helper, "de", "settings.tab_ai"], { cwd: tmpdir(), encoding: "utf8" });
      expect(exact.stderr).toBe("");
      expect(exact.status).toBe(0);
      const result = JSON.parse(exact.stdout);
      expect(result.shipped).toBe(true);
      expect(result.totalMatches).toBe(1);
      const reference = referenceSchema.parse(JSON.parse(bundled("references/i18n.json")));
      expect(result.matches[0].label).toBe(reference.locales.de.entries["settings.tab_ai"]);

      const parked = spawnSync("node", [helper, "fr", "common.save"], { cwd: tmpdir(), encoding: "utf8" });
      expect(parked.status).toBe(0);
      expect(JSON.parse(parked.stdout).shipped).toBe(false);

      const search = spawnSync("node", [helper, "en", "Speichern"], { cwd: tmpdir(), encoding: "utf8" });
      expect(search.status).toBe(0);
      expect(JSON.parse(search.stdout).totalMatches).toBeGreaterThan(0);

      const missing = spawnSync("node", [helper, "de", "a-label-that-does-not-exist-8712"], { encoding: "utf8" });
      expect(missing.status).toBe(0);
      expect(JSON.parse(missing.stdout).matches).toEqual([]);
      const invalid = spawnSync("node", [helper, "unknown", "Save"], { encoding: "utf8" });
      expect(invalid.status).toBe(1);
      expect(await ensureWorkspaceFiles(root, "starter")).toEqual({ changed: false, reloadReasons: [] });
    });
  });

  test("refreshes existing workspaces and repairs a missing reference without touching custom skills", async () => {
    await withWorkspace(async (root) => {
      await ensureWorkspaceFiles(root, "starter");
      const index = join(root, skillRoot, "references/index.md");
      const custom = join(root, ".opencode/skills/my-firm/SKILL.md");
      await mkdir(dirname(custom), { recursive: true });
      await writeFile(custom, "Firm-owned instructions");
      await writeFile(index, "Old manual");
      await writeFile(join(root, ".opencode/.legalwork-core"), "previous-release");
      expect((await ensureWorkspaceFiles(root, "starter")).reloadReasons).toContain("skills");
      expect(await readFile(index, "utf8")).toBe(bundled("references/index.md"));
      expect(await readFile(custom, "utf8")).toBe("Firm-owned instructions");
      await rm(join(root, skillRoot, "references/i18n.json"));
      expect((await ensureWorkspaceFiles(root, "starter")).reloadReasons).toContain("skills");
      expect(await readFile(join(root, skillRoot, "references/i18n.json"), "utf8")).toBe(bundled("references/i18n.json"));
    });
  });

  test("the product-help router refers to an installed, valid skill", async () => {
    const plugin = nativePluginTestRuntime();
    try {
      await plugin.start(LegalWorkCapabilitiesKnowledge);
      const output: { system: Array<{ text: string }> } = { system: [] };
      await plugin.hook("session", "context", output);
      await withWorkspace(async (root) => {
        await ensureWorkspaceFiles(root, "starter");
        const skills = await listSkills(root, false);
        const help = skills.find((skill) => skill.name === "legalwork-help");
        expect(help).toBeDefined();
        if (!help) throw new Error("Product help was not installed");
        expect(output.system.map(part => part.text).join("\n")).toContain(help.name);
      });
    } finally { await plugin.close(); }
  });
});
