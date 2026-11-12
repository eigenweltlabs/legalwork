import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "./server.js";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { nativeAssistantFixture } from "./assistant-engine.test-support.js";
import { BackOfficeModelSchema, BackOfficeRecordSchema } from "./back-office/schema.js";
import { defaultProjectTemplates, projectFieldsSchema } from "./project-schema.js";
import { nativePluginTools } from "./opencode-plugins/native-plugin-test-support.js";
import ProjectPlugin from "./opencode-plugins/legalwork-project-tools.js";
import AssistantPlugin from "./opencode-plugins/legalwork-assistant-tools.js";

const detailsSchema = z.object({ revision: z.number(), fields: projectFieldsSchema });
const directorySchema = z.object({ directoryId: z.string(), model: BackOfficeModelSchema });
const optionsSchema = z.object({ directoryId: z.string(), records: z.array(BackOfficeRecordSchema) });
const contextSchema = z.object({ records: z.array(BackOfficeRecordSchema) });

test("Assistant and ordinary chats discover CRM models, create/reuse records and link the correct new project", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-crm-agent-flows-"));
  const previous = { OPENCODE_DB: process.env.OPENCODE_DB, LEGALWORK_DATA_DIR: process.env.LEGALWORK_DATA_DIR, LEGALWORK_TOKEN_STORE: process.env.LEGALWORK_TOKEN_STORE, LEGALWORK_SERVER_URL: process.env.LEGALWORK_SERVER_URL, LEGALWORK_SERVER_TOKEN: process.env.LEGALWORK_SERVER_TOKEN };
  process.env.LEGALWORK_DATA_DIR = join(root, "data"); process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  process.env.OPENCODE_DB = join(root, "engine.sqlite");
  const sessions = new Map<string, { id: string; directory: string; title: string }>();
  const engine = Bun.serve({ port: 0, fetch: nativeAssistantFixture(async request => {
    const url = new URL(request.url);
    if (url.pathname === "/session" && request.method === "POST") {
      const input = z.object({ title: z.string() }).parse(await request.json());
      const session = { id: `session-${sessions.size}`, directory: decodeURIComponent(request.headers.get("x-opencode-directory") ?? root), title: input.title };
      sessions.set(session.id, session); return Response.json(session);
    }
    if (url.pathname === "/session") return Response.json([...sessions.values()]);
    if (url.pathname.startsWith("/session/")) return Response.json(sessions.get(url.pathname.split("/")[2]) ?? {});
    return Response.json({});
  }, root) });
  const config = backOfficeTestConfig(root, { token: "owner", projectsDirectory: join(root, "projects"),
    opencodeBaseUrl: engine.url.origin, authorizedRoots: [root], startedAt: 0 });
  await writeEigenweltConnection(config, { platformToken: "subscription", entitlements: { plan: "plus", subscriptionStatus: "active", trialEndsAt: null, features: [], seats: 1, usage: { window: "month", allowanceCents: 1000, remainingCents: 1000, usedPercent: 0, resetsAt: null, dailyAllowanceCents: 1000, dailyRemainingCents: 1000, dailyUsedPercent: 0, extraUsageEnabled: false, prepaidBalanceCents: 0 } } });
  const server = await startServer(config), base = `http://127.0.0.1:${server.port}`;
  process.env.LEGALWORK_SERVER_URL = base; process.env.LEGALWORK_SERVER_TOKEN = "owner";
  const request = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => fetch(base + path, { method, headers: { authorization: "Bearer owner", "x-legalwork-host-token": "host", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const plugins: Awaited<ReturnType<typeof nativePluginTools>>[] = [];
  try {
    const current = await request("/assistant/current", { projectFields: defaultProjectTemplates()[0].fields });
    expect(current.status).toBe(200);
    const main = z.object({ workspace: z.object({ id: z.string(), path: z.string() }) }).parse(await current.json());
    const crm = await nativePluginTools(ProjectPlugin, { directory: main.workspace.path }); plugins.push(crm);
    const assistant = await nativePluginTools(AssistantPlugin, { directory: main.workspace.path }); plugins.push(assistant);
    for (const name of ["discover", "records", "save", "create_batch", "model_preview", "model"]) expect(crm.tool).toHaveProperty(`legalwork_back_office_${name}`);
    const discovered = directorySchema.parse(JSON.parse(await crm.tool.legalwork_back_office_discover.execute({})));
    const people = discovered.model.objects.find(object => object.id === "people")!;
    people.fields.find(field => field.id === "personType")!.options.push("Research fellow");
    discovered.model.objects.push({ ...people, id: "engagements", label: "Engagement", plural: "Engagements", protected: false, fields: people.fields.filter(field => field.id === "name") });
    await crm.tool.legalwork_back_office_model_preview.execute({ revision: discovered.model.revision, model: discovered.model });
    const updated = await crm.tool.legalwork_back_office_model.execute({ revision: discovered.model.revision, model: discovered.model });
    expect(updated).not.toContain('"error"');
    expect(directorySchema.parse(JSON.parse(await crm.tool.legalwork_back_office_discover.execute({}))).model.objects.some(object => object.id === "engagements")).toBe(true);
    const save = async (objectId: string, values: Record<string, unknown>) => z.object({ record: BackOfficeRecordSchema }).parse(JSON.parse(await crm.tool.legalwork_back_office_save.execute({ objectId, revision: 0, values }))).record;
    const organisation = await save("companies", { name: "Northbridge Foundation", organisationType: "Association / nonprofit", registrationNumber: "CRM-8842" });
    const client = await save("clients", { name: "Northbridge client", company: organisation.id, clientNumber: "NB-44" });
    const partner = await save("people", { name: "Alice", personType: "Partner" });
    const matter = await save("matters", { name: "Acquisition work", fileNumber: "MAT-771", clients: [client.id], leadLawyer: partner.id });
    const external = await save("people", { name: "Outside contact", personType: "External contact" });
    const engagement = await save("engagements", { name: "Custom engagement" });
    const batch = (records: unknown[], directoryId = discovered.directoryId) =>
      crm.tool.legalwork_back_office_create_batch.execute({ directoryId, records });
    const parent = { objectId: "companies", id: crypto.randomUUID(), values: { name: "Imported organisation" } };
    const contact = { objectId: "people", id: crypto.randomUUID(), values: { name: "Imported contact", company: parent.id } };
    const custom = { objectId: "engagements", id: crypto.randomUUID(), values: { name: "Imported engagement" }, access: "members", members: ["local"] };
    const imported = [parent, contact, custom];
    await expect(batch(imported, "wrong-directory")).rejects.toThrow("directory changed");
    await expect(batch([parent, { ...contact, values: { name: "Invalid", invalidField: true } }])).rejects.toThrow("Row 2");
    const organisations = () => crm.tool.legalwork_back_office_records.execute({ objectId: "companies" });
    expect(await organisations()).not.toContain(parent.id);
    expect(JSON.parse(await batch(imported))).toEqual({ processed: 3 });
    expect(JSON.parse(await batch(imported))).toEqual({ processed: 3 });
    await expect(batch([{ ...parent, values: { name: "Changed input" } }])).rejects.toThrow("Row 1");
    const existing = z.object({ records: z.array(BackOfficeRecordSchema) }).parse(JSON.parse(await crm.tool.legalwork_back_office_records.execute({ objectId: "clients" })));
    expect(existing.records.map(record => record.id)).toEqual([client.id]);
    const created = z.object({ project: z.object({ id: z.string(), path: z.string() }), details: detailsSchema }).parse(JSON.parse(await assistant.tool.legalwork_assistant_project_create.execute({ name: "Project Alpha" })));
    const eligible = optionsSchema.parse(JSON.parse(await assistant.tool.legalwork_assistant_project_reference_options.execute({ projectId: created.project.id, fieldId: "matter" })));
    expect(eligible.records.map(record => record.id)).toEqual([matter.id]);
    const invalid = JSON.parse(await assistant.tool.legalwork_assistant_project_set_metadata.execute({ projectId: created.project.id, revision: created.details.revision, values: { matter: { directoryId: eligible.directoryId, recordIds: [external.id] } } }));
    expect(invalid.error).toContain("400");
    const foreign = JSON.parse(await assistant.tool.legalwork_assistant_project_set_metadata.execute({ projectId: created.project.id, revision: created.details.revision, values: { matter: { directoryId: "local:foreign", recordIds: [matter.id] } } }));
    expect(foreign.error).toContain("409");
    const fields = created.details.fields;
    expect(fields.map(field => field.id)).toEqual(["matter", "client"]);
    const matterField = fields.find(field => field.type === "backoffice" && field.objectId === "matters")!;
    const linked = detailsSchema.parse(JSON.parse(await assistant.tool.legalwork_assistant_project_set_metadata.execute({ projectId: created.project.id, revision: created.details.revision, values: {
      [matterField.id]: { directoryId: eligible.directoryId, recordIds: [matter.id] },
    } })));
    expect(linked.revision).toBe(created.details.revision + 1);
    const context = contextSchema.parse(JSON.parse(await assistant.tool.legalwork_assistant_project_back_office_context.execute({ projectId: created.project.id })));
    expect(context.records.map(record => record.id).sort()).toEqual([organisation.id, client.id, matter.id, partner.id].sort());
    for (const query of ["Northbridge", "MAT-771", "NB-44"]) {
      const matches = z.object({ projects: z.array(z.object({ id: z.string() })), backOfficeUnavailable: z.boolean() }).parse(JSON.parse(await assistant.tool.legalwork_assistant_projects.execute({ query })));
      expect(matches.projects.map(project => project.id)).toContain(created.project.id); expect(matches.backOfficeUnavailable).toBe(false);
    }
    const renamed = z.object({ record: BackOfficeRecordSchema }).parse(JSON.parse(await crm.tool.legalwork_back_office_save.execute({ id: client.id, objectId: "clients", revision: client.revision, values: { name: "Renamed customer" } })));
    expect(renamed.record.values.company).toBe(organisation.id);
    const renamedMatch = z.object({ projects: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(await assistant.tool.legalwork_assistant_projects.execute({ query: "Renamed customer" })));
    expect(renamedMatch.projects.map(project => project.id)).toContain(created.project.id);
    // The creating chat remains in Alpha while targeting a new project explicitly.
    const chat = await nativePluginTools(ProjectPlugin, { directory: created.project.path }); plugins.push(chat);
    const second = z.object({ activeId: z.string() }).parse(JSON.parse(await chat.tool.legalwork_project_create.execute({ name: "Project Beta", projectFields: [
      ...defaultProjectTemplates()[0].fields,
      { id: "engagement", label: "Engagement", type: "backoffice", objectId: "engagements", multiple: false, value: null },
    ] })));
    const target = detailsSchema.parse(JSON.parse(await chat.tool.legalwork_project_get_details.execute({ projectId: second.activeId })));
    const choices = optionsSchema.parse(JSON.parse(await chat.tool.legalwork_project_reference_options.execute({ projectId: second.activeId, fieldId: "engagement", query: "Custom" })));
    expect(choices.records.map(record => record.id)).toEqual([engagement.id]);
    await chat.tool.legalwork_project_set_metadata.execute({ projectId: second.activeId, revision: target.revision, values: { engagement: { directoryId: choices.directoryId, recordIds: [engagement.id] } } });
    const beta = contextSchema.parse(JSON.parse(await chat.tool.legalwork_project_back_office_context.execute({ projectId: second.activeId })));
    expect(beta.records.map(record => record.id)).toEqual([engagement.id]);
    const customMatch = z.object({ projects: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(await assistant.tool.legalwork_assistant_projects.execute({ query: "Custom engagement" })));
    expect(customMatch.projects.map(project => project.id)).toContain(second.activeId);
    const alpha = detailsSchema.parse(JSON.parse(await chat.tool.legalwork_project_get_details.execute({})));
    expect(alpha).toEqual(linked);
    expect(JSON.parse(await chat.tool.legalwork_project_get_details.execute({ projectId: "unregistered" })).error).toContain("not inside");
    expect(z.object({ records: z.array(BackOfficeRecordSchema) }).parse(JSON.parse(await crm.tool.legalwork_back_office_records.execute({ objectId: "projectLinks" }))).records).toEqual([]);
    // Targeted Assistant reads/writes use the same project access checks as other Assistant tools.
    expect((await request("/assistant/settings", { systemPromptAddition: "", resourceIds: [], projectAccess: { mode: "include", projectIds: [created.project.id] } }, "PATCH")).status).toBe(200);
    expect(JSON.parse(await assistant.tool.legalwork_assistant_project_back_office_context.execute({ projectId: second.activeId })).error).toContain("403");
    expect(JSON.parse(await assistant.tool.legalwork_assistant_project_reference_options.execute({ projectId: second.activeId, fieldId: "engagement" })).error).toContain("403");
    expect(JSON.parse(await assistant.tool.legalwork_assistant_project_set_metadata.execute({ projectId: second.activeId, revision: 0, values: { engagement: null } })).error).toContain("403");
    await expect(assistant.runtime.hook("tool", "execute.before", { sessionID: "ses_test", tool: "legalwork_project_set_metadata", input: { projectId: second.activeId } })).rejects.toThrow("403");
    const instruction = { sessionID: "ses_test", system: [] };
    await crm.runtime.hook("session", "context", instruction);
    const text = z.array(z.object({ text: z.string() })).parse(instruction.system).map(part => part.text).join("\n");
    expect(text).toContain("structured CRM and metadata data store");
    expect(text).toContain("reuse matching accessible records");
    expect(text).toContain("Never create projectLinks");
    const assistantInstruction = { sessionID: "ses_test", system: [] };
    await assistant.runtime.hook("session", "context", assistantInstruction);
    const assistantText = z.array(z.object({ text: z.string() })).parse(assistantInstruction.system).map(part => part.text).join("\n");
    expect(assistantText).toContain("structured CRM data store");
    expect(assistantText).toContain("legalwork_assistant_project_reference_options");
    expect(assistantText).toContain("legalwork_assistant_project_back_office_context");
  } finally {
    for (const plugin of plugins) await plugin.close();
    await server.stop(); engine.stop(true);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
