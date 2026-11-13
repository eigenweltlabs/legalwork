import { expect, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";
import { readMcpStatuses } from "../src/react-app/domains/connections/native-mcp";

test("cancelled MCP polling preserves shared native readiness without starting another read", async () => {
  const paths: string[] = [];
  let release = () => {};
  const ready = new Promise<void>(resolve => { release = resolve; });
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === "/api/model") await ready;
    return Response.json({ location: { directory: "/fixture" }, data: path === "/api/model" ? [] : [{ name: "research", status: { status: "connected" } }] });
  } });
  const client = createClient(String(server.url));
  const controller = new AbortController();
  try {
    const reading = readMcpStatuses(client, "/fixture", controller.signal);
    while (!paths.length) await Bun.sleep(1);
    controller.abort(new Error("Left the workspace"));
    release();
    await expect(reading).rejects.toThrow("Left the workspace");
    expect(paths).toEqual(["/api/model"]);
    expect(await readMcpStatuses(client, "/fixture")).toEqual({ research: { status: "connected" } });
    expect(paths).toEqual(["/api/model", "/api/mcp"]);
  } finally { release(); server.stop(true); }
});
