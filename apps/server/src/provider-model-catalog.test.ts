import { afterEach, expect, test } from "bun:test";
import { fetchProviderModelCatalog } from "./provider-model-catalog.js";
import type { ProviderConfig } from "@opencode-ai/sdk/v2/client";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function endpoint(response: () => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    expect(new URL(request.url).pathname).toBe("/api.json");
    expect(request.headers.get("authorization")).toBeNull();
    return response();
  } });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

test("fetches new catalog data each time and keeps capabilities and token limits", async () => {
  const details = { name: "New reasoning model", reasoning: true, tool_call: true, attachment: true,
    limit: { context: 200000, output: 64000 }, cost: { input: 2, output: 8 },
    modalities: { input: ["text", "image", "pdf"], output: ["text"] } } satisfies NonNullable<ProviderConfig["models"]>[string];
  let id = "model-1";
  const url = endpoint(() => Response.json({ anthropic: { models: { [id]: { ...details, knowledge: "2026-09" } } }, unrelated: { models: "invalid" } }));
  expect(await fetchProviderModelCatalog("anthropic", url)).toEqual({ "model-1": details });
  id = "model-2";
  expect(await fetchProviderModelCatalog("anthropic", `${url}/`)).toEqual({ "model-2": details });
});

test("reports unavailable or malformed catalogs instead of claiming a successful refresh", async () => {
  for (const response of [new Response("Unavailable", { status: 503 }), Response.json([]),
    Response.json({}), Response.json({ anthropic: { models: { broken: { name: "Missing limits" } } } })]) {
    await expect(fetchProviderModelCatalog("anthropic", endpoint(() => response.clone()))).rejects.toThrow();
  }
});
