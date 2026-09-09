import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const nativeFetch = globalThis.fetch;
const priorXdgDataHome = process.env.XDG_DATA_HOME;

const APPLIANCE = "https://memory.firm.example/mcp";

/** The folder the drag is aimed at, two levels deep and with one document the
 * appliance refuses, so the route's partial-failure path is exercised too. */
const TREE: Record<string, { folders: string[]; files: string[] }> = {
  "Project Falcon": { folders: ["Pleadings"], files: ["Cover letter.pdf"] },
  "Project Falcon/Pleadings": { folders: [], files: ["Answer.docx", "Broken.docx"] },
};

function fakeAppliance() {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (!url.host.endsWith("memory.firm.example")) return nativeFetch(input as RequestInfo, init);

    if (url.pathname === "/api/tree/children") {
      const path = url.searchParams.get("path") ?? "";
      const level = TREE[path] ?? { folders: [], files: [] };
      return Response.json({
        source_id: "src-1",
        path,
        folders: level.folders.map((name) => ({ name, path: `${path}/${name}`, files: 0 })),
        files: level.files.map((name) => ({
          source_object_id: `${path}/${name}`,
          source_id: "src-1",
          name,
          path: `${path}/${name}`,
          mime_type: null,
          size_bytes: null,
          mtime: null,
          document_id: `doc:${path}/${name}`,
        })),
        pagination: { total: level.files.length, offset: 0, limit: 200, returned: level.files.length, has_more: false },
      });
    }

    // The MCP endpoint: initialize, then download_document with inline bytes.
    if (url.pathname === "/mcp") {
      const body: unknown = JSON.parse(String(init?.body ?? "{}"));
      const request = body as { id?: number; method?: string; params?: { name?: string; arguments?: { document_id?: string } } };
      if (request.method !== "tools/call") return Response.json({ jsonrpc: "2.0", id: request.id, result: {} });
      const documentId = request.params?.arguments?.document_id ?? "";
      const name = documentId.split("/").pop() ?? "";
      if (name === "Broken.docx") {
        return Response.json({ jsonrpc: "2.0", id: request.id, error: { message: "access denied" } });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          content: [{
            type: "resource",
            resource: {
              name,
              mimeType: "application/octet-stream",
              blob: Buffer.from(`bytes of ${name}`).toString("base64"),
            },
          }],
        },
      });
    }
    return new Response("", { status: 404 });
  }) as typeof globalThis.fetch;
}

async function startLegalworkServer() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-legalmemory-folder-"));
  roots.push(root);
  process.env.XDG_DATA_HOME = join(root, "xdg-data");
  await writeFile(
    join(root, "opencode.json"),
    JSON.stringify({ mcp: { legalmemory: { type: "remote", url: APPLIANCE } } }),
    "utf8",
  );
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}`, token: config.token, root };
}

function openFolder(base: string, token: string, body: unknown) {
  return fetch(`${base}/workspace/ws_1/legalmemory/open-folder`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  globalThis.fetch = nativeFetch;
  if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorXdgDataHome;
});

describe("POST /workspace/:id/legalmemory/open-folder", () => {
  test("copies a dragged folder into the workspace with its structure intact", async () => {
    fakeAppliance();
    const { base, token, root } = await startLegalworkServer();

    const response = await openFolder(base, token, {
      source_id: "src-1",
      path: "Project Falcon",
      name: "Project Falcon",
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, path: ".legalmemory/Project Falcon", files: 2, skipped: 1, truncated: false });

    const exported = join(root, ".legalmemory", "Project Falcon");
    expect((await readdir(exported)).sort()).toEqual(["Cover letter.pdf", "Pleadings"]);
    expect(await readdir(join(exported, "Pleadings"))).toEqual(["Answer.docx"]);
    expect(await readFile(join(exported, "Pleadings", "Answer.docx"), "utf8")).toBe("bytes of Answer.docx");
    // The document the appliance refused is skipped, not written empty.
    expect(result.bytes).toBe("bytes of Cover letter.pdf".length + "bytes of Answer.docx".length);
  });

  test("keeps a hostile folder name inside the export directory", async () => {
    fakeAppliance();
    const { base, token } = await startLegalworkServer();

    const escaped = await openFolder(base, token, {
      source_id: "src-1",
      path: "Project Falcon",
      name: "../../../../etc",
    });
    // The name is reduced to its last segment rather than honoured as a path.
    expect((await escaped.json()).path).toBe(".legalmemory/etc");

    const rejected = await openFolder(base, token, { source_id: "src-1", path: "Project Falcon", name: ".ssh" });
    expect(rejected.status).toBe(400);
  });

  test("refuses a request without a folder to copy", async () => {
    fakeAppliance();
    const { base, token } = await startLegalworkServer();

    expect((await openFolder(base, token, { source_id: "src-1", path: "", name: "x" })).status).toBe(400);
    expect((await openFolder(base, token, { source_id: "", path: "Project Falcon", name: "x" })).status).toBe(400);
  });
});
