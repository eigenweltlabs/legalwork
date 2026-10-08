import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { projectFileLinkSchema } from "@legalwork/types/project-files";

const roots: string[] = [];
const servers: StartedServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function serve(readOnly = false) {
  const root = await mkdtemp(join(tmpdir(), "project-files-api-")); roots.push(root);
  const source = join(root, "source"), target = join(root, "target");
  await mkdir(source); await mkdir(target); await mkdir(join(target, "Folder"));
  await writeFile(join(source, "contract.md"), "Original");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test_project_files", hostToken: "test_project_host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [{ id: "source", name: "Source", path: source, preset: "starter", workspaceType: "local" }, { id: "target", name: "Target", path: target, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const server = await startServer(config); servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const request = (route: string, body?: object, token = config.token) => fetch(`${base}/workspace/target/files/${route}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { source, target, request, base, token: config.token };
}
const sourceRef = { projectId: "source", workspaceId: "source", path: "contract.md", name: "contract.md" };

test("file-session batch writes serialize revision checks for concurrent editors", async () => {
  const { target, request, base, token } = await serve();
  await writeFile(join(target, "shared.md"), "Before");
  const session = (await (await request("sessions", { write: true })).json()).session;
  const batch = (operation: string, body: object) => fetch(`${base}/files/sessions/${session.id}/${operation}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(response => response.json());
  const before = (await batch("read-batch", { paths: ["shared.md"] })).items[0];
  expect(before.ok).toBe(true);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => batch("write-batch", { writes: [{ path: "shared.md", contentBase64: Buffer.from(`After ${index}`).toString("base64"), ifMatchRevision: before.revision }] })));
  const items = results.flatMap(result => result.items);
  expect(items.filter(item => item.ok)).toHaveLength(1);
  expect(items.filter(item => item.code === "conflict")).toHaveLength(7);
});

test("concurrent no-overwrite moves to one destination preserve the other source files", async () => {
  const { target, request, base, token } = await serve();
  const session = (await (await request("sessions", { write: true })).json()).session;
  const names = Array.from({ length: 8 }, (_, index) => `source-${index}.md`);
  await Promise.all(names.map(name => writeFile(join(target, name), name)));
  const results = await Promise.all(names.map(from => fetch(`${base}/files/sessions/${session.id}/ops`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operations: [{ type: "rename", from, to: "Folder/same.md", overwrite: false }] }),
  }).then(response => response.json())));
  expect(results.flatMap(result => result.items).filter(item => item.ok)).toHaveLength(1);
  expect(results.flatMap(result => result.items).filter(item => item.code === "file_exists")).toHaveLength(7);
  const winner = await readFile(join(target, "Folder/same.md"), "utf8");
  for (const name of names.filter(name => name !== winner)) expect(await readFile(join(target, name), "utf8")).toBe(name);
});

test("cross-project API links persist, deduplicate and rename independently of original bytes", async () => {
  const { source, request } = await serve();
  expect((await request("links", undefined, "wrong-token")).status).toBe(401);
  const body = { name: "Reference", folder: "Folder", source: sourceRef };
  for (let i = 0; i < 2; i++) { const response = await request("links", body); expect(response.status).toBe(200); await response.arrayBuffer(); }
  const links = await (await request("links")).json();
  expect(links.links).toHaveLength(1);
  const link = projectFileLinkSchema.parse(links.links[0]);
  const renamed = await request("links", { ...link, name: "Renamed reference" });
  expect(renamed.status).toBe(200); await renamed.arrayBuffer();
  expect((await (await request("links")).json()).links[0].name).toBe("Renamed reference");
  const removed = await request("links", { id: link.id, remove: true });
  expect(removed.status).toBe(200); await removed.arrayBuffer();
  expect((await (await request("links")).json()).links).toEqual([]);
  expect(await readFile(join(source, "contract.md"), "utf8")).toBe("Original");
});

test("cross-project API copies saved bytes once, rejects traversal and never overwrites", async () => {
  const { source, target, request } = await serve();
  const body = { source: sourceRef, path: "Folder/copy.md", dataBase64: Buffer.from("Saved bytes").toString("base64") };
  const copied = await request("import", body); expect(copied.status).toBe(201); await copied.arrayBuffer();
  const collision = await request("import", { ...body, dataBase64: Buffer.from("Replacement").toString("base64") }); expect(collision.status).toBe(409); await collision.arrayBuffer();
  for (const path of ["../escape.md", "/absolute.md", "Folder/../escape.md"]) {
    const invalid = await request("import", { ...body, path }); expect(invalid.status).toBe(400); await invalid.arrayBuffer();
  }
  await writeFile(join(source, "contract.md"), "Later source edit");
  expect(await readFile(join(target, body.path), "utf8")).toBe("Saved bytes");
});

test("read-only servers reject both new file operations", async () => {
  const { request } = await serve(true);
  for (const route of ["links", "import"]) { const response = await request(route, { source: sourceRef, folder: "", name: "Reference", path: "copy.md", dataBase64: "" }); expect(response.status).toBe(403); await response.arrayBuffer(); }
});
