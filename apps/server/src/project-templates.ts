import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProjectTemplateCatalog } from "@legalwork/types/workspace";
import { upgradeProjectTemplateReferences, defaultProjectTemplates, localizedTemplateFields, projectTemplateCatalogSchema, projectTemplateName } from "./project-schema.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

const writes = new Map<string, Promise<unknown>>();
function catalogPath(config: Pick<ServerConfig, "configPath">) {
  return join(config.configPath ? dirname(config.configPath) : join(homedir(), ".config", "legalwork"), "project-templates.json");
}

export async function readProjectTemplates(config: Pick<ServerConfig, "configPath">): Promise<ProjectTemplateCatalog> {
  try {
    return upgradeProjectTemplateReferences(projectTemplateCatalogSchema.parse(JSON.parse(await readFile(catalogPath(config), "utf8"))));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { revision: 0, defaultTemplateId: "legal_matter", templates: defaultProjectTemplates() };
    throw error;
  }
}

export function localizeProjectTemplates(catalog: ProjectTemplateCatalog, language: "en" | "de") {
  return { ...catalog, templates: catalog.templates.map((template) => ({
    ...template, name: projectTemplateName(template, language), fields: localizedTemplateFields(template.fields, language),
  })) };
}

export function saveProjectTemplates(config: Pick<ServerConfig, "configPath">, input: unknown): Promise<ProjectTemplateCatalog> {
  const parsed = projectTemplateCatalogSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_project_templates", parsed.error.issues[0]?.message ?? "Invalid templates.");
  const path = catalogPath(config);
  const operation = (writes.get(path) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const current = await readProjectTemplates(config);
    if (parsed.data.revision !== current.revision)
      throw new ApiError(409, "project_templates_conflict", "Templates changed. Reload them before saving again.");
    const updated = { ...parsed.data, revision: current.revision + 1 };
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return updated;
  });
  writes.set(path, operation);
  void operation.finally(() => { if (writes.get(path) === operation) writes.delete(path); }).catch(() => undefined);
  return operation;
}

export async function projectFieldsFromTemplate(config: Pick<ServerConfig, "configPath">, input: Record<string, unknown>) {
  if (input.templateLanguage !== undefined && input.templateLanguage !== "en" && input.templateLanguage !== "de")
    throw new ApiError(400, "invalid_project_template", "Template language must be en or de.");
  const catalog = await readProjectTemplates(config);
  const id = input.templateId === undefined ? catalog.defaultTemplateId : input.templateId;
  if (id === null) return [];
  const template = catalog.templates.find((entry) => entry.id === id);
  if (!template) throw new ApiError(400, "invalid_project_template", "Choose an existing project template.");
  return localizedTemplateFields(template.fields, input.templateLanguage === "de" ? "de" : "en");
}
