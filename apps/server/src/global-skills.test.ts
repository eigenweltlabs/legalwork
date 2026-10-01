import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { listSkillResources, readSkillResource, upsertSkillResource } from "./skill-resources.js";
import { listSkills, upsertSkill } from "./skills.js";
import { exists } from "./utils.js";
import { globalSkillsDir } from "./workspace-files.js";
import { ensureBundledWorkflows } from "./bundled-workflows.js";
import { unzipSync } from "fflate";

const name = "workflow-assistant-cite-check";
let root: string;
let home: string;
let appData: string;
let workspaces: string[];
let originalPlatform: PropertyDescriptor | undefined;
let originalEnv: Record<string, string | undefined>;
let restoreHomedir = () => {};

beforeEach(async () => {
  root = await mkdtemp(join(os.tmpdir(), "legalwork-global-skills-"));
  home = join(root, "user");
  appData = join(home, "AppData", "Roaming");
  workspaces = [join(root, "matter-a"), join(root, "matter-b")];
  for (const workspace of workspaces) await mkdir(join(workspace, ".git"), { recursive: true });
  originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  originalEnv = { APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  const homeMock = spyOn(os, "homedir").mockReturnValue(home);
  restoreHomedir = () => homeMock.mockRestore();
  // Exercise Windows path selection on every CI platform using real temporary files.
  Object.defineProperty(process, "platform", { ...originalPlatform, value: "win32" });
  process.env.APPDATA = appData;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  restoreHomedir();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function importWorkflow(configHome = appData) {
  // Standalone servers retain their original library without a desktop migration.
  const folder = join(configHome, "opencode", "skills", name);
  await mkdir(join(folder, "resources"), { recursive: true });
  await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: Verify supplied citations.\n---\n\n# Cite check\nCheck every citation.\n`);
  await writeFile(join(folder, "resources", "checklist.md"), "Check the case name and citation.\n");
  return folder;
}

test("standalone Windows keeps its APPDATA library without a desktop migration", () => {
  expect(globalSkillsDir()).toBe(join(appData, "opencode", "skills"));
});

test("the bundled DD workflow and its Word attachment are available across workspaces and remote clients", async () => {
  await importWorkflow(); // Other personal workflows must stay out of remote listings.
  await Promise.all([ensureBundledWorkflows(), ensureBundledWorkflows()]);
  const bundled = "workflow-assistant-due-diligence";
  const canonical = await readFile(new URL(`../resources/core-opencode/skills/${bundled}/resources/DD-Report-Template.docx`, import.meta.url));
  for (const workspace of workspaces) {
    for (const includeGlobal of [true, false]) {
      const skills = await listSkills(workspace, includeGlobal);
      expect(skills.filter(item => item.name === bundled)).toMatchObject([
        { kind: "workflow", workflowType: "assistant", scope: "global" },
      ]);
      if (!includeGlobal) expect(skills.some(item => item.name === name)).toBe(false);
    }
    expect(await listSkillResources(workspace, bundled)).toMatchObject([{ name: "DD-Report-Template.docx" }]);
    const attachment = await readSkillResource(workspace, bundled, "DD-Report-Template.docx", "base64");
    const bytes = Buffer.from(attachment.content, "base64");
    expect(bytes.equals(canonical)).toBe(true);
    const parts = unzipSync(bytes);
    expect(new TextDecoder().decode(parts["word/document.xml"])).toContain("{{matter_name}}");
  }
});

test("startup preserves customized bundled workflows and attached templates", async () => {
  await ensureBundledWorkflows();
  const folder = join(globalSkillsDir(), "workflow-assistant-due-diligence");
  await writeFile(join(folder, "SKILL.md"), "Firm's customized workflow.");
  await writeFile(join(folder, "resources/DD-Report-Template.docx"), "Firm's customized template.");
  await ensureBundledWorkflows();
  expect(await readFile(join(folder, "SKILL.md"), "utf8")).toBe("Firm's customized workflow.");
  expect(await readFile(join(folder, "resources/DD-Report-Template.docx"), "utf8")).toBe("Firm's customized template.");
});

test("desktop Windows uses OpenCode's XDG folder after migration", () => {
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  expect(globalSkillsDir()).toBe(join(home, ".config", "opencode", "skills"));
});

test("an imported global workflow can be read from every workspace", async () => {
  const folder = await importWorkflow();
  for (const workspace of workspaces) {
    // The skill editor's GET route finds its file through this listing.
    const skill = (await listSkills(workspace, true)).find((item) => item.name === name);
    expect(skill).toMatchObject({ name, scope: "global", path: join(folder, "SKILL.md") });
    expect(await readFile(skill!.path, "utf8")).toContain("Check every citation.");
    expect((await listSkills(workspace, false)).some((item) => item.name === name)).toBe(false);
  }
});

test("global workflow attachments can be read and updated from every workspace", async () => {
  const folder = await importWorkflow();
  for (const workspace of workspaces) {
    expect(await listSkillResources(workspace, name)).toMatchObject([
      { name: "checklist.md", path: join(folder, "resources", "checklist.md") },
    ]);
    expect((await readSkillResource(workspace, name, "checklist.md")).content).toContain("Check the case name");
  }
  await upsertSkillResource(workspaces[0], name, { name: "checklist.md", content: "Also verify the year.\n" });
  expect((await readSkillResource(workspaces[1], name, "checklist.md")).content).toBe("Also verify the year.\n");
});

test("editing a global workflow updates the shared file without workspace copies", async () => {
  const folder = await importWorkflow();
  const result = await upsertSkill(workspaces[0], {
    name, description: "Verify supplied citations.", content: "Check the court and year.\n", scope: "global",
  });
  expect(result).toMatchObject({ action: "updated", scope: "global", path: join(folder, "SKILL.md") });
  for (const workspace of workspaces) {
    const skill = (await listSkills(workspace, true)).find((item) => item.name === name);
    expect(await readFile(skill!.path, "utf8")).toContain("Check the court and year.");
    expect(await exists(join(workspace, ".opencode", "skills", name))).toBe(false);
  }
  expect(await exists(join(folder, "resources", "checklist.md"))).toBe(true);
});

test("XDG_CONFIG_HOME takes precedence for all global skill operations on Windows", async () => {
  const configHome = join(root, "custom-config");
  process.env.XDG_CONFIG_HOME = configHome;
  const folder = await importWorkflow(configHome);
  expect(globalSkillsDir()).toBe(join(configHome, "opencode", "skills"));
  const skill = (await listSkills(workspaces[0], true)).find((item) => item.name === name);
  expect(skill?.path).toBe(join(folder, "SKILL.md"));
  expect(await listSkillResources(workspaces[1], name)).toHaveLength(1);
});

test("macOS and Linux keep the existing global folder even if APPDATA is set", () => {
  for (const platform of ["darwin", "linux"]) {
    Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
    expect(globalSkillsDir()).toBe(join(home, ".config", "opencode", "skills"));
  }
});

test("Windows without APPDATA keeps the same fallback as desktop", () => {
  process.env.APPDATA = " ";
  expect(globalSkillsDir()).toBe(join(home, ".config", "opencode", "skills"));
});
