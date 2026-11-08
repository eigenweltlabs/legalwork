import { validateProjectReferences } from "./back-office/project-references.js";
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { BackOfficeModelSchema, BackOfficeRecordSchema } from "./back-office/schema.js";
import { startServer } from "./server.js";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import { defaultProjectTemplates, projectFieldsSchema } from "./project-schema.js";
import { internalPeopleFilters } from "@legalwork/types/workspace";
import { nativePluginTools } from "./opencode-plugins/native-plugin-test-support.js";
import ProjectTools from "./opencode-plugins/legalwork-project-tools.js";

const stateSchema = z.object({ directoryId: z.string(), model: BackOfficeModelSchema });
const optionsSchema = z.object({ directoryId: z.string(), records: z.array(BackOfficeRecordSchema), selectedRecords: z.array(BackOfficeRecordSchema) });

test("metadata record filters discover dynamic types, enforce agent/UI writes and preserve existing inactive assignments", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-reference-filters-"));
  const previous = { LEGALWORK_DATA_DIR: process.env.LEGALWORK_DATA_DIR, LEGALWORK_TOKEN_STORE: process.env.LEGALWORK_TOKEN_STORE, LEGALWORK_SERVER_URL: process.env.LEGALWORK_SERVER_URL, LEGALWORK_SERVER_TOKEN: process.env.LEGALWORK_SERVER_TOKEN };
  process.env.LEGALWORK_DATA_DIR = join(root, "data"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const config = backOfficeTestConfig(root, { token: "owner", projectsDirectory: join(root, "projects"), corsOrigins: ["*"], authorizedRoots: [root] });
  await validateProjectReferences(config, [], defaultProjectTemplates()[0].fields);
  expect(await readdir(root)).toEqual([]);
  const server = await startServer(config), url = `http://127.0.0.1:${server.port}`;
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(`${url}${path}`, { method, headers: { authorization: "Bearer owner", "x-legalwork-host-token": "host", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  process.env.LEGALWORK_SERVER_URL = url; process.env.LEGALWORK_SERVER_TOKEN = "owner";
  let plugin: Awaited<ReturnType<typeof nativePluginTools>> | undefined;
  try {
    const directory = stateSchema.parse(await (await request("/back-office")).json());
    const people = directory.model.objects.find(object => object.id === "people")!;
    people.fields.find(field => field.id === "personType")!.options.push("Research fellow");
    expect((await request("/back-office/model", { revision: directory.model.revision, model: directory.model }, "PUT")).status).toBe(200);
    const createPerson = async (name: string, personType: string, active?: boolean) => {
      const response = await request("/back-office/records", { objectId: "people", revision: 0, values: { name, personType, ...(active === undefined ? {} : { active }) } });
      expect(response.status).toBe(200);
      return z.object({ record: BackOfficeRecordSchema }).parse(await response.json()).record;
    };
    const partner = await createPerson("Partner", "Partner"), researcher = await createPerson("Researcher", "Research fellow"), external = await createPerson("External", "External contact");
    await createPerson("Inactive partner", "Partner", false);
    expect(researcher.values.active).toBe(true);
    const created = await request("/workspaces/projects", { name: "Filtered project", projectFields: [{ id: "responsible", label: "Project owner", type: "backoffice", objectId: "people", multiple: true, filters: internalPeopleFilters(), value: null }] });
    expect(created.status).toBe(201);
    const id = z.object({ activeId: z.string() }).parse(await created.json()).activeId, path = `/workspace/${id}/project`;
    const detailsSchema = z.object({ revision: z.number(), fields: projectFieldsSchema });
    let details = detailsSchema.parse(await (await request(path)).json());
    const fields = details.fields.map(field => field.id === "responsible" && field.type === "backoffice" ? { ...field, filters: { mode: "all" satisfies "all", conditions: [{ fieldId: "personType", operator: "is" satisfies "is", values: ["Partner", "Research fellow"] }, { fieldId: "active", operator: "is" satisfies "is", values: [true] }] } } : field);
    details = detailsSchema.parse(await (await request(path, { revision: details.revision, fields }, "PATCH")).json());
    const workspace = config.workspaces.find(workspace => workspace.id === id)!;
    plugin = await nativePluginTools(ProjectTools, { directory: workspace.path });
    const eligible = optionsSchema.parse(JSON.parse(await plugin.tool.legalwork_project_reference_options.execute({ fieldId: "responsible" })));
    expect(eligible.records.map(record => record.id).sort()).toEqual([partner.id, researcher.id].sort());
    const values = (ids: string[]) => ({ responsible: { directoryId: eligible.directoryId, recordIds: ids } });
    expect((await request(`${path}/metadata`, { revision: details.revision, values: values([external.id]) }, "PATCH")).status).toBe(400);
    expect(detailsSchema.parse(await (await request(path)).json()).revision).toBe(details.revision);
    details = detailsSchema.parse(await (await request(`${path}/metadata`, { revision: details.revision, values: values([researcher.id]) }, "PATCH")).json());
    expect((await request("/back-office/records", { id: researcher.id, objectId: "people", revision: researcher.revision, values: { active: false } })).status).toBe(200);
    const changed = optionsSchema.parse(JSON.parse(await plugin.tool.legalwork_project_reference_options.execute({ fieldId: "responsible" })));
    expect(changed.records.map(record => record.id)).toEqual([partner.id]);
    expect(changed.selectedRecords.map(record => record.id)).toEqual([researcher.id]);
    details = detailsSchema.parse(JSON.parse(await plugin.tool.legalwork_project_set_metadata.execute({ revision: details.revision, values: values([researcher.id, partner.id]) })));
    const filtered = details.fields.find(field => field.id === "responsible");
    expect(filtered?.value).toEqual({ directoryId: eligible.directoryId, recordIds: [researcher.id, partner.id] });
    const foreign = await request(`${path}/metadata`, { revision: details.revision, values: { responsible: { directoryId: "local:another-directory", recordIds: [partner.id] } } }, "PATCH");
    expect(foreign.status).toBe(409);
    const restricted = details.fields.map(field => field.id === "responsible" && field.type === "backoffice" ? { ...field, filters: { mode: "all" satisfies "all", conditions: [{ fieldId: "taxNumber", operator: "is" satisfies "is", values: ["secret"] }] } } : field);
    expect((await request(path, { revision: details.revision, fields: restricted }, "PATCH")).status).toBe(400);
    const folders = await readdir(config.projectsDirectory!);
    const invalidFields = details.fields.map(field => field.id === "responsible" && field.type === "backoffice" ? { ...field, value: { directoryId: eligible.directoryId, recordIds: [external.id] } } : field);
    expect((await request("/workspaces/projects", { name: "Invalid assignment", projectFields: invalidFields })).status).toBe(400);
    expect(await readdir(config.projectsDirectory!)).toEqual(folders);
    expect((await request(`${path}/metadata`, { revision: details.revision, values: { responsible: null } }, "PATCH")).status).toBe(200);
  } finally {
    await plugin?.close(); await server.stop();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
