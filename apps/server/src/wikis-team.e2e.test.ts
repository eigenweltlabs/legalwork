import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { ViewRecordSchema } from "@legalwork/types/views";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import { wikiTeamFixture } from "./wiki/team-test-helper.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const createdSchema = z.object({ wiki: z.object({ id: z.string(), name: z.string(), sharing: z.object({ id: z.string(), role: z.enum(["owner", "member"]) }), sync: z.object({ kind: z.literal("team"), wikiId: z.string(), orgId: z.string() }) }) });
async function host(config: ServerConfig) {
  const server = await startServer(config);
  cleanup.unshift(async () => { await server.stop(); });
  return (path: string, method = "GET", body?: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, {
    method, headers: { "content-type": "application/json", "x-legalwork-host-token": config.hostToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("two desktop API hosts create, discover and edit a wiki without projects; revocation blocks publication", async () => {
  const cloud = await wikiTeamFixture();
  cleanup.push(() => cloud.close());
  const owner = await cloud.account(), member = await cloud.account("member");
  expect(owner.config.workspaces).toHaveLength(0);
  expect(member.config.workspaces).toHaveLength(0);
  const a = await host(owner.config), b = await host(member.config);
  // Exercise the background discovery explicitly instead of relying on when
  // its timer happens to run during the complete server suite.
  for (const api of [a, b]) {
    const discovery = await api("/project-sync", "POST");
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({ round: { error: null, pulled: 0, arrived: 0 } });
  }
  const response = await a("/wikis", "POST", { name: "Independent knowledge", sharing: { access: "members", memberIds: ["member"] } });
  expect(response.status).toBe(201);
  const original = createdSchema.parse(await response.json()).wiki;
  expect(original.sharing.role).toBe("owner");
  await a(`/wikis/${original.id}/page`, "PUT", { path: "Process.md", content: "# Shared process\n", baseRevision: null });
  const viewInput = { version: 1, title: "Practice dashboard", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Practice overview")', queries: { pages: { fields: ["title"] } } };
  const createdView = await a(`/wikis/${original.id}/ui-views`, "POST", viewInput);
  expect(createdView.status).toBe(201);
  const view = ViewRecordSchema.parse(await createdView.json());
  expect(await (await a(`/wikis/${original.id}/sync`, "POST")).json()).toMatchObject({ state: "idle" });
  const overview = z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }).parse(await (await b("/wikis/team")).json());
  expect(overview.items).toEqual([{ id: original.sync.wikiId, name: original.name }]);
  const joinedResponse = await b("/wikis/join", "POST", { wikiId: original.sync.wikiId });
  expect(joinedResponse.status).toBe(201);
  const joined = createdSchema.parse(await joinedResponse.json()).wiki;
  expect(joined.sharing.role).toBe("member");
  await b(`/wikis/${joined.id}/sync`, "POST");
  const memberView = ViewRecordSchema.parse(await (await b(`/wikis/${joined.id}/ui-views/${view.id}`)).json());
  expect(memberView.id).toBe(view.id);
  expect(memberView.owner).toEqual({ kind: "wiki", id: joined.id });
  expect((await b(`/wikis/${joined.id}/ui-views/${view.id}`, "PUT", { baseRevision: memberView.revision, input: { ...viewInput, title: "Member dashboard" } })).status).toBe(200);
  const page = z.object({ content: z.string(), revision: z.string() }).parse(await (await b(`/wikis/${joined.id}/page?path=Process.md`)).json());
  expect(page.content).toBe("# Shared process\n");
  expect((await b(`/wikis/${joined.id}/page`, "PUT", { path: "Process.md", content: "# Member edit\n", baseRevision: page.revision })).status).toBe(200);
  await b(`/wikis/${joined.id}/sync`, "POST");
  await a(`/wikis/${original.id}/sync`, "POST");
  expect(await (await a(`/wikis/${original.id}/page?path=Process.md`)).json()).toMatchObject({ content: "# Member edit\n" });
  expect(await (await a(`/wikis/${original.id}/ui-views/${view.id}`)).json()).toMatchObject({ id: view.id, title: "Member dashboard" });
  expect((await b(`/wikis/${joined.id}/share`, "PATCH", { access: "org", memberIds: [] })).status).toBe(403);
  expect((await a(`/wikis/${original.id}/share`, "PATCH", { access: "members", memberIds: [] })).status).toBe(200);
  expect((await b(`/wikis/${joined.id}/page`, "PUT", { path: "Blocked.md", content: "# Revoked\n", baseRevision: null })).status).toBe(404);
  expect(cloud.wikis.get(original.sync.wikiId)?.files.has("Blocked.md")).toBe(false);
  expect((await b(`/wikis/${joined.id}/ui-views/${view.id}`)).status).toBe(404);
  await writeEigenweltConnection(member.config, { account: null, platformToken: null, refreshToken: null });
  expect((await b(`/wikis/${joined.id}/page?path=Process.md`)).status).toBe(401);
  expect((await b(`/wikis/${joined.id}`, "DELETE")).status).toBe(200);
  expect(owner.config.workspaces.every((workspace) => workspace.preset === "wiki")).toBe(true);
  // The desktop may list the empty registry in the background. Wiki sharing
  // must never create a project or access an individual project's resources.
  const projectRequests = cloud.requests.filter((request) => request.path.startsWith("/api/projects"));
  expect(projectRequests.length).toBeGreaterThanOrEqual(2);
  expect(projectRequests.filter((request) => request.method !== "GET" || request.path !== "/api/projects")).toEqual([]);
});
