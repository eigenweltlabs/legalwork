import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webInputSchema, webRequest, webResult } from "./web.js";
import { searchProvider } from "./search-provider.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "../eigenwelt-auth.js";
import { writeCachedEigenweltPaidManifest } from "../eigenwelt-paid-manifest.js";
import { closeRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import type { ServerConfig } from "../types.js";

const fixtures: Array<{ config: ServerConfig; root: string }> = [];
afterEach(async () => {
  for (const { config, root } of fixtures.splice(0)) {
    await closeRuntimeOpencodeConfig(config);
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-search-"));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
    readOnly: false, startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  fixtures.push({ root, config });
  return config;
}
const input = (query = "§ 823 BGB") => webInputSchema.parse({ kind: "search", query, sessionID: "s", agent: "build" });

test("paid search preserves the exact approved query and explains path-scoped site misses", async () => {
  const provider = { name: "aws", url: "https://gateway.example/v1/web/search", apiKey: "secret" } satisfies Awaited<ReturnType<typeof searchProvider>>;
  for (const query of ["site:ris.bka.gv.at ABGB § 1295", "site:ris.bka.gv.at/GeltendeFassung ABGB § 1295"]) {
    const request = webRequest(input(query), provider);
    expect(JSON.parse(Buffer.from(request.bodyBase64, "base64").toString()).query).toBe(query);
    const result = await webResult(input(query), request.url, { status: 200, headers: {},
      bodyBase64: Buffer.from(JSON.stringify({ provider: "aws", region: "eu-west-1", results: [] })).toString("base64") }, undefined, provider);
    expect(result.output).toContain("No search results found.");
    expect(result.output.includes("Query note:")).toBe(query.includes("/GeltendeFassung"));
    if (query.includes("/GeltendeFassung")) {
      expect(result.output).toContain("keywords do not enforce a path");
      expect(result.output).toContain("No matches do not establish that the source is absent");
    }
  }
});

test("search-index dates remain unverified, unknown dates are omitted and historical source dates are preserved", async () => {
  const provider = { name: "aws", url: "https://gateway.example/v1/web/search", apiKey: "secret" } satisfies Awaited<ReturnType<typeof searchProvider>>;
  const rows = [
    { title: "Article", url: "https://example.org/article", text: "The change takes effect on 1 January 2024.", publishedDate: "04:00PM, Monday, December 31 1979, PST" },
    { title: "Dated article", url: "https://example.org/dated", text: "Published 12 February 2024.", publishedDate: "2024-02-12" },
    { title: "Historical judgment", url: "https://example.org/historical", text: "Judgment date: 31 December 1979.", publishedDate: "1979-12-31" },
    ...[null, "unknown", " N/A ", ""].map((publishedDate, index) => ({ title: "Undated", url: `https://example.org/undated/${index}`, text: "No publication date stated.", publishedDate })),
  ];
  const result = await webResult(input(), provider.url, { status: 200, headers: {},
    bodyBase64: Buffer.from(JSON.stringify({ provider: "aws", region: "eu-west-1", results: rows })).toString("base64") }, undefined, provider);
  expect(result.output).not.toContain("\nPublished:");
  expect(result.output).toContain("Search index date (unverified): 04:00PM, Monday, December 31 1979, PST");
  expect(result.output.match(/Search index date \(unverified\):/g)).toHaveLength(3);
  expect(result.output).toContain("keep judgment and effective dates separate");
  expect(result.output).toContain("If no publication date is stated, report it as unknown");
  for (const row of rows) {
    expect(result.output).toContain(row.url);
    expect(result.output).toContain(row.text);
  }
});

test("free and lapsed accounts keep the unchanged free Exa request", async () => {
  const config = await fixture();
  expect(await searchProvider(config, async () => { throw new Error("Free search must not read a hosted model"); })).toEqual({ name: "exa" });
  await writeCachedEigenweltPaidManifest(config, { baseURL: "https://gateway.example/v1", apiKey: "paid-secret", models: [] });
  await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "canceled", features: [] }) });
  const provider = await searchProvider(config);
  const request = webRequest(input(), provider);
  expect(request.url).toBe("https://mcp.exa.ai/mcp");
  expect(request.headers.authorization).toBeUndefined();
  expect(JSON.parse(Buffer.from(request.bodyBase64, "base64").toString()).params.name).toBe("web_search_exa");
});

test("paid search takes its preference from the server-read hosted model and leaves BYOK unknown", async () => {
  const config = await fixture();
  await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active", features: ["premium_models"] }) });
  await writeCachedEigenweltPaidManifest(config, { baseURL: "https://gateway.example/v1", apiKey: "paid-secret", models: [
    { id: "europe", region: "EU" }, { id: "america", region: "US" }, { id: "unknown" },
  ] });
  const cases = [
    { model: { id: "europe", providerID: "eigenwelt" }, expected: "EU" },
    { model: { id: "america", providerID: "eigenwelt" }, expected: "US" },
    { model: { id: "america", providerID: "openai" }, expected: undefined },
    { model: { id: "unknown", providerID: "eigenwelt" }, expected: undefined },
    { model: undefined, expected: undefined },
  ];
  for (const { model, expected } of cases) {
    const provider = await searchProvider(config, async () => model);
    const body = JSON.parse(Buffer.from(webRequest(input(), provider).bodyBase64, "base64").toString());
    expect(body.preferred_region).toBe(expected);
  }
  await expect(searchProvider(config, async () => { throw new Error("Cannot read session"); })).rejects.toThrow("Cannot read session");
  expect(webInputSchema.safeParse({ ...input(), preferred_region: "US" }).success).toBe(false);
  expect(webInputSchema.safeParse({ ...input(), model: "america" }).success).toBe(false);
});

test("paid results preserve the actual regional endpoint without accepting an unknown region", async () => {
  const provider = { name: "aws", url: "https://gateway.example/v1/web/search", apiKey: "secret" } satisfies Awaited<ReturnType<typeof searchProvider>>;
  const regions: Array<"eu-west-1" | "us-east-1" | "ap-southeast-2"> = ["eu-west-1", "us-east-1", "ap-southeast-2"];
  for (const region of regions) {
    const result = webResult(input(), provider.url, { status: 200, headers: {},
      bodyBase64: Buffer.from(JSON.stringify({ provider: "aws", region, results: [] })).toString("base64") }, undefined, provider);
    if (region === "ap-southeast-2") await expect(result).rejects.toThrow("unreadable");
    else expect((await result).metadata).toEqual({ provider: "aws", region });
  }
});

test("paid search uses the saved gateway key, even with no hosted chat models", async () => {
  const config = await fixture();
  await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active", features: ["premium_models"] }) });
  await writeCachedEigenweltPaidManifest(config, { baseURL: "https://gateway.example/v1/", apiKey: "paid-secret", models: [] });
  const provider = await searchProvider(config);
  const request = webRequest(input(), provider);
  expect(request.url).toBe("https://gateway.example/v1/web/search");
  expect(request.headers.authorization).toBe("Bearer paid-secret");
  expect(JSON.parse(Buffer.from(request.bodyBase64, "base64").toString())).toEqual({ query: "§ 823 BGB", max_results: 8 });
  const result = await webResult(input(), request.url, { status: 200, headers: {},
    bodyBase64: Buffer.from(JSON.stringify({ provider: "aws", region: "us-east-1", results: [
      { title: "§ 823 BGB", url: "https://example.org/law", text: "Provision text", publishedDate: null },
    ] })).toString("base64") }, undefined, provider);
  expect(result.output).toContain("URL: https://example.org/law");
  expect(result.output).toContain("Provision text");
  expect(result.metadata).toEqual({ provider: "aws", region: "us-east-1" });
  expect(JSON.stringify(result)).not.toContain("paid-secret");
});

test("paid search never truncates queries, downgrades on failure, or follows an invalid gateway URL", async () => {
  const provider = { name: "aws", url: "https://gateway.example/v1/web/search", apiKey: "secret" } satisfies Awaited<ReturnType<typeof searchProvider>>;
  expect(() => webRequest(input("x".repeat(201)), provider)).toThrow("200 characters");
  expect(() => webRequest(input("😀".repeat(200)), provider)).not.toThrow();
  await expect(webResult(input(), provider.url, { status: 503, headers: {}, bodyBase64: "" }, undefined, provider))
    .rejects.toMatchObject({ status: 502, code: "web_search_unavailable" });
  await expect(webResult(input(), provider.url, { status: 403, headers: {}, bodyBase64: Buffer.from("private policy details").toString("base64") }, undefined, provider))
    .rejects.toMatchObject({ status: 403, code: "web_search_not_allowed",
      message: "Paid web search is not allowed for this account. Ask your firm admin to check your subscription, paid seat and enabled EU/US regions on the Model API Models page." });
  const config = await fixture();
  await writeEigenweltConnection(config, { entitlements: parseEigenweltEntitlements({ plan: "pro", subscriptionStatus: "active", features: ["premium_models"] }) });
  await expect(searchProvider(config)).rejects.toThrow("Sign in again");
  await writeCachedEigenweltPaidManifest(config, { baseURL: "https://gateway.example/v1?redirect=elsewhere", apiKey: "secret", models: [] });
  await expect(searchProvider(config)).rejects.toThrow("invalid");
});
