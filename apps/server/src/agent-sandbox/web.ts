import { z } from "zod";
import { ApiError } from "../errors.js";
import { convertHtml } from "./web-convert.js";
import type { OutboundResponse } from "./network.js";
import type { SearchProvider } from "./search-provider.js";
import { eigenweltUsageLimitFromText } from "../provider-usage-limit.js";

export const webFetchArgs = z.object({
  url: z.string().url().max(8192).describe("The HTTP or HTTPS page to read."),
  format: z.enum(["text", "markdown", "html"]).default("markdown"),
  timeout: z.number().int().min(1).max(120).optional(),
});
export const webSearchArgs = z.object({
  query: z.string().min(1).max(8000),
  numResults: z.number().int().min(1).max(20).default(8),
  livecrawl: z.enum(["fallback", "preferred"]).default("fallback"),
  type: z.enum(["auto", "fast", "deep"]).default("auto"),
  contextMaxCharacters: z.number().int().min(1000).max(50000).optional(),
});
export const webInputSchema = z.discriminatedUnion("kind", [
  webFetchArgs.extend({ kind: z.literal("fetch"), sessionID: z.string().min(1).max(200), agent: z.string().min(1).max(200) }).strict(),
  webSearchArgs.extend({ kind: z.literal("search"), sessionID: z.string().min(1).max(200), agent: z.string().min(1).max(200) }).strict(),
]);
export type WebInput = z.infer<typeof webInputSchema>;

export function webRequest(input: WebInput, provider: SearchProvider = { name: "exa" }): { url: string; method: string; headers: Record<string, string>; bodyBase64: string } {
  if (input.kind === "fetch") return { url: input.url, method: "GET", headers: {
    accept: input.format === "html" ? "text/html, */*;q=0.5" : "text/markdown, text/plain, text/html;q=0.8, */*;q=0.5",
    "user-agent": "LegalWork", "accept-encoding": "identity",
  }, bodyBase64: "" };
  if (provider.name === "aws") {
    if (Array.from(input.query).length > 200)
      throw new Error("Paid AWS web search accepts up to 200 characters. Reformulate this as a shorter query; do not truncate legal citations.");
    if (input.type !== "auto" || input.livecrawl !== "fallback")
      throw new Error("Paid AWS web search uses its own search mode. Use type auto and livecrawl fallback; use webfetch to read complete pages.");
    return { url: provider.url, method: "POST", headers: {
      accept: "application/json", "content-type": "application/json", "accept-encoding": "identity",
      authorization: `Bearer ${provider.apiKey}`,
    }, bodyBase64: Buffer.from(JSON.stringify({ query: input.query, max_results: input.numResults,
      preferred_region: provider.preferredRegion })).toString("base64") };
  }
  // The desktop enables Exa for the engine's web search. Keep that provider,
  // but broker its exact query/body instead of letting the engine send it.
  const url = new URL("https://mcp.exa.ai/mcp");
  if (process.env.EXA_API_KEY) url.searchParams.set("exaApiKey", process.env.EXA_API_KEY);
  return { url: url.href, method: "POST", headers: {
    accept: "application/json, text/event-stream", "content-type": "application/json", "accept-encoding": "identity",
  }, bodyBase64: Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "web_search_exa", arguments: { query: input.query, numResults: input.numResults, livecrawl: input.livecrawl,
      type: input.type, contextMaxCharacters: input.contextMaxCharacters },
  } })).toString("base64") };
}

export async function webResult(input: WebInput, url: string, response: OutboundResponse, signal = new AbortController().signal,
  provider: SearchProvider = { name: "exa" }) {
  signal.throwIfAborted();
  if (response.status < 200 || response.status >= 300) {
    if (input.kind === "search" && provider.name === "aws" && response.status === 429) {
      // A transient rate limit is not an allowance failure. Never echo provider diagnostics.
      const body = Buffer.from(response.bodyBase64, "base64");
      if (body.length <= 8192) {
        let payload: unknown;
        try { payload = JSON.parse(body.toString("utf8")); } catch { /* Keep outages generic. */ }
        const error = z.object({ detail: z.string().optional(), error: z.object({ message: z.string() }).optional() }).safeParse(payload);
        const limit = error.success ? eigenweltUsageLimitFromText(error.data.detail) ?? eigenweltUsageLimitFromText(error.data.error?.message) : null;
        if (limit) throw new ApiError(429, "web_search_usage_limit",
          "Web search is blocked because your AI allowance or spending limit has been reached. Request more usage from your firm admin, or add credit if available. Do not retry or use another search route until access is restored. " +
          "Eigenwelt usage limit: " + JSON.stringify(limit), limit);
      }
    }
    if (input.kind === "search" && provider.name === "aws" && response.status === 403)
      throw new ApiError(403, "web_search_not_allowed",
        "Paid web search is not allowed for this account. Ask your firm admin to check your subscription, paid seat and enabled EU/US regions on the Model API Models page.");
    if (input.kind === "search") throw new ApiError(502, "web_search_unavailable",
      "The web search service is unavailable. Please try again later.");
    throw new Error(`Website returned HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(response.bodyBase64, "base64");
  const content = bytes.toString("utf8");
  if (input.kind === "search") {
    if (provider.name === "aws") {
      let payload: unknown;
      try { payload = JSON.parse(content); }
      catch { throw new Error("The search provider returned an unreadable response."); }
      const result = z.object({ provider: z.literal("aws"), region: z.enum(["eu-west-1", "us-east-1"]), results: z.array(z.object({
        title: z.string().nullable(), url: z.string().url().nullable(), text: z.string(), publishedDate: z.string().nullable(),
      })) }).safeParse(payload);
      if (!result.success) throw new Error("The search provider returned an unreadable response.");
      let remaining = input.contextMaxCharacters ?? 50000;
      const output = result.data.results.map(item => {
        const text = item.text.slice(0, Math.max(0, remaining));
        remaining -= text.length;
        return `Title: ${item.title ?? "Web information"}\n${item.url ? `URL: ${item.url}\n` : ""}${item.publishedDate ? `Published: ${item.publishedDate}\n` : ""}Highlights:\n${text}`;
      }).join("\n\n");
      const notes: string[] = [];
      if (/(?:^|\s)site:[^\s/]+\/\S+/i.test(input.query))
        notes.push("Query note: URL paths inside site: may return no matches. Use a domain-only site: filter plus relevant keywords, then check result URLs; keywords do not enforce a path. No matches do not establish that the source is absent.");
      return { title: `Web search: ${input.query}`, output: [...notes, output || "No search results found."].join("\n\n"), metadata: { provider: "aws", region: result.data.region } };
    }
    const payloads = content.trim().startsWith("{") ? [content] : content.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim());
    for (const payload of payloads) {
      let parsed: unknown;
      try { parsed = JSON.parse(payload); } catch { continue; }
      const result = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }) }).safeParse(parsed);
      if (!result.success) continue;
      const output = result.data.result.content.flatMap(part => part.text ? [part.text] : []).join("\n");
      if (result.data.result.isError) throw new Error(output || "Web search failed.");
      return { title: `Web search: ${input.query}`, output: output || "No search results found.", metadata: { provider: "exa" } };
    }
    throw new Error("The search provider returned an unreadable response.");
  }
  const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "";
  if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) return {
    title: url, output: "Image fetched successfully", metadata: {},
    attachments: [{ type: "file", mime, url: `data:${mime};base64,${response.bodyBase64}` }],
  };
  if (mime === "text/html" && input.format !== "html") {
    return { title: url, output: await convertHtml(content, input.format, signal), metadata: {} };
  }
  return { title: url, output: content, metadata: {} };
}
