import { nativePluginTools } from "./opencode-plugins/native-plugin-test-support.js";
const LegalWorkProjectTools = (context = {}) => nativePluginTools(LegalWorkProjectToolsDefinition, context);
import type { ProjectField } from "@legalwork/types/workspace";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { projectTemplateCatalogSchema } from "./project-schema.js";
import { readProjectDetails } from "./project-store.js";
import { readProjectTemplates, localizeProjectTemplates } from "./project-templates.js";
import LegalWorkProjectToolsDefinition from "./opencode-plugins/legalwork-project-tools.js";

test("humans and agents create projects from the same edited catalog, with custom fields or no template", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-template-api-"));
  const previous = {
    LEGALWORK_DATA_DIR: process.env.LEGALWORK_DATA_DIR,
    LEGALWORK_TOKEN_STORE: process.env.LEGALWORK_TOKEN_STORE,
    LEGALWORK_SERVER_URL: process.env.LEGALWORK_SERVER_URL,
    LEGALWORK_SERVER_TOKEN: process.env.LEGALWORK_SERVER_TOKEN,
  };
  process.env.LEGALWORK_DATA_DIR = join(root, "data");
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"),
    projectsDirectory: join(root, "projects"), token: "template-owner", hostToken: "template-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config);
  const url = `http://127.0.0.1:${server.port}`;
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${url}${path}`, {
    method, headers: { authorization: "Bearer template-owner", "x-legalwork-host-token": "template-host", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  process.env.LEGALWORK_SERVER_URL = url;
  process.env.LEGALWORK_SERVER_TOKEN = "template-owner";
  try {
    const initial = projectTemplateCatalogSchema.parse(await (await request("/workspaces/project-templates?language=de")).json());
    expect(initial.templates.map((template) => template.name)).toEqual(["Akte", "Internes Projekt", "Vertrag & Transaktion", "Recherche & Analyse"]);
    const draft = { ...initial, defaultTemplateId: "company", templates: [...initial.templates, {
      id: "company", name: "Our company workflow", fields: [
        { id: "cost", label: "Agreed price", type: "number", value: 999 },
        { id: "phase", label: "Our phase", type: "select", options: ["Draft", "Signed"], value: null },
      ],
    }] };
    const competing = await Promise.all([request("/workspaces/project-templates", draft, "PUT"), request("/workspaces/project-templates", draft, "PUT")]);
    expect(competing.map((response) => response.status).sort()).toEqual([200, 409]);
    const persisted = await readProjectTemplates(config);
    expect(persisted.revision).toBe(1);
    expect(persisted.templates.at(-1)?.fields[0].value).toBeNull();
    const plugin = await LegalWorkProjectTools();
    const catalog = projectTemplateCatalogSchema.parse(JSON.parse(await plugin.tool.legalwork_project_templates.execute({ language: "de" })));
    expect(catalog).toEqual(localizeProjectTemplates(persisted, "de"));
    const agentProject: { activeId: string } = JSON.parse(await plugin.tool.legalwork_project_create.execute({ name: "Agent custom template", templateId: "company", templateLanguage: "de" }));
    const details = async (id: string) => {
      const workspace = config.workspaces.find((entry) => entry.id === id);
      if (!workspace) throw new Error("Created project missing");
      return readProjectDetails(workspace.path);
    };
    const original = await details(agentProject.activeId);
    expect(original.fields).toEqual(catalog.templates.at(-1)!.fields);
    const humanResponse = await request("/workspaces/local", { name: "Human custom template", folderMode: "default", templateId: "company", templateLanguage: "de" });
    expect(humanResponse.status).toBe(201);
    const human: { activeId: string } = await humanResponse.json();
    expect((await details(human.activeId)).fields).toEqual(original.fields);
    // Selection omitted uses the saved default; explicit null is a saved, empty schema.
    const byDefault: { activeId: string } = JSON.parse(await plugin.tool.legalwork_project_create.execute({ name: "Default" }));
    expect((await details(byDefault.activeId)).fields).toEqual(original.fields);
    const none: { activeId: string } = JSON.parse(await plugin.tool.legalwork_project_create.execute({ name: "No template", templateId: null }));
    expect(await details(none.activeId)).toMatchObject({ revision: 1, fields: [] });
    const ownFields: ProjectField[] = [
      { id: "vendor", label: "Our supplier", type: "text", value: "Example GmbH" },
      { id: "budget", label: "Approved budget", type: "number", value: 1200 },
      { id: "due", label: "Target date", type: "date", value: "2026-10-30" },
      { id: "phase", label: "Phase", type: "select", options: ["Draft", "Signed"], value: "Draft" },
      { id: "unknown", label: "Unknown fact", type: "text", value: null },
    ];
    const custom: { activeId: string } = JSON.parse(await plugin.tool.legalwork_project_create.execute({ name: "Ad hoc fields", projectFields: ownFields }));
    expect((await details(custom.activeId)).fields).toEqual(ownFields.map((field) => ({ ...field, labelSource: "custom" })));
    for (const templateId of ["legal_matter", "internal", "contracts", "research"]) {
      const created: { activeId: string } = JSON.parse(await plugin.tool.legalwork_project_create.execute({ name: templateId, templateId, templateLanguage: "de" }));
      expect((await details(created.activeId)).fields).toEqual(catalog.templates.find((entry) => entry.id === templateId)!.fields);
    }
    // Template changes affect future projects only.
    expect((await request("/workspaces/project-templates", { ...persisted, templates: persisted.templates.map((entry) => entry.id === "company" ? { ...entry, fields: [] } : entry) }, "PUT")).status).toBe(200);
    expect(await details(agentProject.activeId)).toEqual(original);
    const later: { activeId: string } = JSON.parse(await plugin.tool.legalwork_project_create.execute({ name: "Updated template", templateId: "company" }));
    expect((await details(later.activeId)).fields).toEqual([]);
    const folders = await readdir(config.projectsDirectory!);
    for (const invalid of [
      { templateId: "deleted" }, { templateId: false }, { templateId: "company", projectFields: [] },
      { templateLanguage: "xx" }, { projectFields: [{ id: "bad", label: "Bad", type: "number", value: "wrong" }] },
    ]) expect((await request("/workspaces/local", { name: "Invalid", folderMode: "default", ...invalid })).status).toBe(400);
    expect(await readdir(config.projectsDirectory!)).toEqual(folders);
    expect((await fetch(`${url}/workspaces/project-templates`)).status).toBe(401);
    const viewer = { token: "owt_retired_viewer" };
    const viewerCreate = await fetch(`${url}/workspaces/projects`, { method: "POST", headers: { authorization: `Bearer ${viewer.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "Viewer", templateId: null }) });
    expect(viewerCreate.status).toBe(401);
    const agentForbidden = await fetch(`${url}/workspaces/projects`, { method: "POST", headers: { authorization: "Bearer template-owner", "content-type": "application/json" }, body: JSON.stringify({ name: "Registration", folderPath: root }) });
    expect(agentForbidden.status).toBe(400);
    expect(await readdir(config.projectsDirectory!)).toEqual(folders);
    config.readOnly = true;
    expect((await request("/workspaces/local", { name: "Read only", folderMode: "default", templateId: null })).status).toBe(403);
    expect((await request("/workspaces/project-templates", { ...persisted, revision: 2 }, "PUT")).status).toBe(403);
  } finally {
    await server.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
