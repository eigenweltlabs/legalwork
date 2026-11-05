import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { nativePluginTools } from "./native-plugin-test-support.js";
import HistoryImages from "./legalwork-history-image-tools.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const reference = { sessionID: "parent", messageID: "msg_original", selector: { kind: "user-file", fileIndex: 0 }, sha256: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") };

test("native history image tools bind invocation, carry exact cursors and return image content without a base64 output echo", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "legalwork-history-image-plugin-"))); roots.push(root);
  const saved = { url: process.env.LEGALWORK_SERVER_URL, token: process.env.LEGALWORK_SERVER_TOKEN, scoped: process.env.LEGALWORK_WIKI_AGENT_TOKEN };
  const requests: Array<{ path: string; search: string; authorization: string | null }> = [];
  const metadata = { reference, mime: "image/png", name: "Original.png", bytes: 68, provenance: "stored-session-image" };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    expect(request.headers.get("x-legalwork-wiki-agent-session")).toBe("actual-child");
    expect(request.headers.get("x-legalwork-wiki-agent-token")).toBe("scoped-fixture");
    expect(request.headers.get("x-legalwork-wiki-agent-directory")).toBe(encodeURIComponent(root));
    if (url.pathname === "/workspaces") return Response.json({ items: [{ id: "matter", path: root }] });
    requests.push({ path: url.pathname, search: url.search, authorization: request.headers.get("authorization") });
    if (request.method === "POST") {
      expect(await request.json()).toEqual(reference);
      return Response.json({ image: metadata, uri: `data:image/png;base64,${data}` });
    }
    return Response.json({ sessionID: "parent", images: [metadata], cursor: { next: "opaque-next", previous: null }, coverage: "native-message-page", parent: { status: "none" } });
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "full-bearer-must-not-reach-image-route"; process.env.LEGALWORK_WIKI_AGENT_TOKEN = "scoped-fixture";
  const plugin = await nativePluginTools(HistoryImages, { directory: root });
  const asks: unknown[] = [];
  const context = { directory: root, sessionID: "actual-child", ask: async (input: unknown) => { asks.push(input); } };
  try {
    const before: { sessionID: string; agent: string; system: Array<{ type: string; text: string }> } = { sessionID: "actual-child", agent: "legalwork", system: [] };
    await plugin.runtime.hook("session", "context", before);
    const page = await plugin.tool.legalwork_history_image_list.execute({ sessionID: "parent", cursor: "opaque-original" }, context);
    expect(JSON.parse(page).cursor.next).toBe("opaque-next"); expect(page).not.toContain(data);
    const result = await plugin.tool.legalwork_history_image_read.executeResult(reference, context);
    expect(JSON.stringify(result.output)).not.toContain(data);
    expect(result.content).toContainEqual({ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png", name: "Original.png" });
    expect(requests.every(request => request.authorization === null)).toBe(true);
    expect(requests.map(request => request.path)).toEqual(["/workspace/matter/sessions/actual-child/history-images", "/workspace/matter/sessions/actual-child/history-images/read"]);
    expect(requests[0].search).toContain("cursor=opaque-original");
    expect(asks).toMatchObject([{ permission: "legalwork_history_image_list", patterns: ["session:parent"] }, { permission: "legalwork_history_image_read", patterns: ["session:parent"] }]);
    await expect(plugin.tool.legalwork_history_image_read.executeResult(reference, { ...context, ask: async () => { throw new Error("History denied"); } })).rejects.toThrow("History denied");
    expect(requests).toHaveLength(2);
    delete process.env.LEGALWORK_WIKI_AGENT_TOKEN;
    await expect(plugin.tool.legalwork_history_image_read.executeResult(reference, context)).rejects.toThrow("scoped runtime credential");
    expect(requests).toHaveLength(2);
    const after: { sessionID: string; agent: string; system: Array<{ type: string; text: string }> } = { sessionID: "actual-child", agent: "legalwork", system: [] };
    await plugin.runtime.hook("session", "context", after);
    expect(after.system).toEqual(before.system);
    expect(JSON.stringify(after.system)).not.toContain(data);
  } finally {
    await plugin.close(); server.stop(true);
    if (saved.url === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = saved.url;
    if (saved.token === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = saved.token;
    if (saved.scoped === undefined) delete process.env.LEGALWORK_WIKI_AGENT_TOKEN; else process.env.LEGALWORK_WIKI_AGENT_TOKEN = saved.scoped;
  }
});
