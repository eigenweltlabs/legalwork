import { expect, test } from "bun:test";
import { ViewInputSchema, ViewPreviewSchema, ViewRecordSchema, type ViewInput, type ViewOwner } from "@legalwork/types/views";
import { saveViewPreview, viewInputForDestination } from "../src/react-app/domains/views/view-save";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { viewToolOutcome } from "../src/react-app/domains/views/view-generation";
import { viewSaveDestinationGroups } from "../src/react-app/domains/views/view-save-destinations";
const owner: ViewOwner = { kind: "wiki", id: "source" };
const input: ViewInput = { version: 1, title: "Cases", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Cases")', queries: { cases: { fields: ["title"] } }, datasets: { cases: { rows: [{ title: "A" }], total: 1, revision: "r1", asOf: 1, truncated: false } } };
test("save destinations prioritize the originating wiki or project and search within either category", () => {
  const project: ViewOwner = { kind: "workspace", id: "project" };
  const destinations = [
    { owner: project, name: "Zebra project" },
    { owner: { kind: "workspace", id: "other" } satisfies ViewOwner, name: "Alpha project" },
    { owner, name: "Zebra wiki" },
    { owner: { kind: "wiki", id: "other" } satisfies ViewOwner, name: "Alpha wiki" },
  ];
  const wikiGroups = viewSaveDestinationGroups(destinations, owner);
  expect(wikiGroups.map(group => group.kind)).toEqual(["wiki", "workspace"]);
  expect(wikiGroups[0].items.map(item => item.name)).toEqual(["Zebra wiki", "Alpha wiki"]);
  const projectGroups = viewSaveDestinationGroups(destinations, project);
  expect(projectGroups.map(group => group.kind)).toEqual(["workspace", "wiki"]);
  expect(projectGroups[0].items[0].owner).toEqual(project);
  expect(viewSaveDestinationGroups(destinations, owner, "  PROJECT alpha ")[0].items.map(item => item.name)).toEqual(["Alpha project"]);
  expect(viewSaveDestinationGroups(destinations, owner, "Zebra", "workspace")[0].items).toEqual([destinations[0]]);
  expect(viewSaveDestinationGroups(destinations, owner, "missing")).toEqual([]);
  expect(destinations[0].owner).toEqual(project);
});
test("a completed preview is recognized without a saved identity or location", () => {
  const preview = ViewPreviewSchema.parse({ status: "preview", owner, input });
  expect(viewToolOutcome(JSON.stringify(preview))).toEqual({ preview });
  expect(viewToolOutcome({ status: "preview", owner, input: { ...input, program: "" } })).toHaveProperty("error");
});
test("same-wiki saves retain live queries; project and foreign-wiki copies retain attributed snapshots", () => {
  expect(viewInputForDestination(input, owner, owner)).toEqual({ ...input, datasets: {} });
  for (const destination of [{ kind: "workspace", id: "project" }, { kind: "wiki", id: "other" }] satisfies ViewOwner[]) {
    const copy = viewInputForDestination(input, owner, destination);
    expect(copy.queries).toEqual({});
    expect(copy.datasets?.cases.sourceOwner).toEqual(owner);
    expect(copy.datasets?.cases.rows).toEqual(input.datasets?.cases.rows);
  }
  expect(input.datasets?.cases.sourceOwner).toBeUndefined();
});
test("same-owner live saves omit redundant query snapshots but keep static data and report snapshots", () => {
  const withStatic: ViewInput = { ...input, datasets: { ...input.datasets, manual: { rows: [{ title: "Manual" }], total: 1, revision: "s1", asOf: 1, truncated: false } } };
  const saved = viewInputForDestination(withStatic, owner, owner);
  expect(saved.datasets).toEqual({ manual: withStatic.datasets?.manual });
  expect(saved.queries).toEqual(input.queries);
  const report: ViewInput = { ...withStatic, mode: "report" };
  expect(viewInputForDestination(report, owner, owner)).toBe(report);
  expect(withStatic.datasets?.cases).toBeDefined();
});
test("preview save provenance uses an optional query while bodies and headers remain compatible with older strict servers", async () => {
  const calls: { source: string | null; body: unknown }[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const body = await request.json();
    expect(request.headers.has("X-LegalWork-View-Source")).toBe(false);
    calls.push({ source: new URL(request.url).searchParams.get("source"), body });
    const parsed = ViewInputSchema.safeParse(request.method === "PUT" ? body.input : body);
    return parsed.success ? Response.json({ ...parsed.data, owner, id: "00000000-0000-4000-8000-000000000001", updatedAt: 1, revision: "r2" }) : Response.json({ code: "invalid_payload", message: "Unsupported field" }, { status: 400 });
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "token" });
    const source = { workspaceId: "ws", sessionId: "chat", callId: "call" };
    const created = await client.createView(owner, input, source);
    await client.updateView(owner, created.id, { input, baseRevision: created.revision }, source);
    expect(calls).toEqual([{ source: JSON.stringify(source), body: input }, { source: JSON.stringify(source), body: { input, baseRevision: "r2" } }]);
  } finally { server.stop(true); }
});
test("missing data cannot silently create a misleading cross-wiki copy", () => {
  expect(() => viewInputForDestination({ ...input, datasets: {} }, owner, { kind: "wiki", id: "other" })).toThrow("Refresh the preview");
});

test("Save creates in the originating project and updates the same file; Save as never overwrites it", async () => {
  const project: ViewOwner = { kind: "workspace", id: "project" };
  const preview = ViewPreviewSchema.parse({ status: "preview", owner: project, input: { ...input, queries: {} } });
  const files = new Map<string, ReturnType<typeof ViewRecordSchema.parse>>();
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    calls.push(request.method);
    const url = new URL(request.url);
    const body = await request.json();
    const id = request.method === "POST" ? crypto.randomUUID() : url.pathname.split("/").at(-1)!;
    const current = files.get(id);
    if (request.method === "PUT" && current?.revision !== body.baseRevision) return Response.json({ code: "view_revision_conflict", message: "Changed on disk" }, { status: 409 });
    const view = ViewRecordSchema.parse({ ...ViewInputSchema.parse(request.method === "PUT" ? body.input : body), owner: project, id, updatedAt: 1, revision: `revision-${calls.length}` });
    files.set(id, view);
    return Response.json(view);
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "token" });
    const first = await saveViewPreview(client, preview);
    expect(first.owner).toEqual(project);
    expect(first.title).toBe(input.title);
    const edited = { ...preview, input: { ...preview.input, program: 'root = Text("Updated")' }, target: { viewId: first.id, baseRevision: first.revision } };
    const updated = await saveViewPreview(client, edited);
    expect(updated.id).toBe(first.id);
    expect(files.size).toBe(1);
    const copy = await saveViewPreview(client, edited, { copy: true, title: "  Custom title  " });
    expect(copy.id).not.toBe(first.id);
    expect(copy.title).toBe("Custom title");
    expect(files.get(first.id)).toEqual(updated);
    expect(calls).toEqual(["POST", "PUT", "POST"]);
    await expect(saveViewPreview(client, edited)).rejects.toMatchObject({ code: "view_revision_conflict" });
    expect(files.size).toBe(2);
    expect(files.get(first.id)).toEqual(updated);
    expect(calls).toEqual(["POST", "PUT", "POST", "PUT"]);
  } finally { server.stop(true); }
});

test("Save as to another owner retains snapshot attribution and chat provenance", async () => {
  const project: ViewOwner = { kind: "workspace", id: "project" };
  const source = { workspaceId: "wiki-workspace", sessionId: "chat", callId: "generation" };
  const preview = ViewPreviewSchema.parse({ status: "preview", owner, input, target: { viewId: "00000000-0000-4000-8000-000000000001", baseRevision: "r1" } });
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    expect(request.method).toBe("POST");
    expect(url.pathname).toBe("/workspace/project/ui-views");
    expect(JSON.parse(url.searchParams.get("source")!)).toEqual(source);
    const savedInput = ViewInputSchema.parse(await request.json());
    expect(savedInput.queries).toEqual({});
    expect(savedInput.datasets?.cases.sourceOwner).toEqual(owner);
    return Response.json({ ...savedInput, owner: project, id: crypto.randomUUID(), updatedAt: 1, revision: "r2" });
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "token" });
    const saved = await saveViewPreview(client, preview, { owner: project, copy: true, title: "Project copy", savedFrom: source });
    expect(saved.title).toBe("Project copy");
    expect(saved.owner).toEqual(project);
  } finally { server.stop(true); }
});
