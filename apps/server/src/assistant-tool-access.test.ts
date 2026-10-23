import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertAssistantToolAccess } from "./assistant-tool-access.js";
import { MainAssistant } from "./main-assistant.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
test("restricted Assistant children reject forbidden projects, native file escapes and unrestricted execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-access-")); roots.push(root);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "fixture", hostToken: "fixture-host", configPath: join(root, "server.json"),
    workspaces: ["assistant", "allowed", "private"].map(id => ({ id, name: id, path: join(root, id), preset: id === "assistant" ? "main-assistant" : "starter", workspaceType: "local" })),
    authorizedRoots: [root], approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], readOnly: false, startedAt: 0,
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  await Promise.all(config.workspaces.map(project => mkdir(project.path)));
  await writeFile(join(root, "private", "secret.txt"), "private data");
  await symlink(join(root, "private"), join(root, "assistant", "alias"));
  const assistant = await MainAssistant.open(config, join(root, "runtime.sqlite"), () => ({ get: async () => null, list: async () => [], create: async () => { throw new Error("not used"); } }));
  const settings = { systemPromptAddition: "", resourceIds: [], projectAccess: { mode: "include", projectIds: ["allowed"] } };
  assistant.updateSettings(settings);
  const guard = (tool: string, args: Record<string, unknown>) => assertAssistantToolAccess(config, assistant, join(root, "assistant"), tool, args);
  await expect(guard("legalwork_assistant_delegate", { projectId: "private" })).rejects.toThrow("allowed projects");
  await expect(guard("legalwork_assistant_delegate", { projectId: "allowed" })).resolves.toBeUndefined();
  for (const tool of ["bash", "legalwork_shell", "apply_patch", "legalwork_task_list", "legalwork_sandbox_execute"]) await expect(guard(tool, {})).rejects.toThrow("access rules");
  await expect(guard("read", { filePath: "alias/secret.txt" })).rejects.toThrow("allowed projects");
  await expect(guard("write", { filePath: "alias/new.txt" })).rejects.toThrow("allowed projects");
  await expect(guard("read", { filePath: join(root, "outside.txt") })).rejects.toThrow("access rules");
  await expect(guard("write", { filePath: "notes/new.txt" })).resolves.toBeUndefined();
  await expect(guard("read", { filePath: join(root, "allowed", "report.txt") })).resolves.toBeUndefined();
  const globalSkill = join(root, "library", "selected", "SKILL.md");
  await mkdir(join(root, "library", "selected"), { recursive: true });
  await writeFile(globalSkill, "Selected instructions.");
  assistant.updateSettings({ ...settings, resourceIds: ["selected"] }, [{ id: "selected", kind: "skill", name: "Selected", description: "Run research.", reference: globalSkill, projectId: null, projectName: null }]);
  await expect(guard("read", { filePath: globalSkill })).resolves.toBeUndefined();
  await expect(guard("write", { filePath: globalSkill })).rejects.toThrow("access rules");
  await expect(guard("read", { filePath: join(root, "library", "other", "SKILL.md") })).rejects.toThrow("access rules");
  assistant.updateSettings({ ...settings, resourceIds: ["selected"] }, [{ id: "selected", kind: "skill", name: "Deleted project's resource", description: "Unavailable.", reference: globalSkill, projectId: "deleted", projectName: "Deleted project" }]);
  await expect(guard("read", { filePath: globalSkill })).rejects.toThrow("access rules");
  // The human's ordinary project agents keep their existing permissions.
  await expect(assertAssistantToolAccess(config, assistant, join(root, "allowed"), "bash", {})).resolves.toBeUndefined();
  assistant.updateSettings({ ...settings, projectAccess: { mode: "all", projectIds: [] } });
  await expect(guard("bash", {})).resolves.toBeUndefined();
});
