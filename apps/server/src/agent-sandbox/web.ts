import { z } from "zod";
import TurndownService from "turndown";
import type { OutboundResponse } from "./network.js";

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

export function webRequest(input: WebInput): { url: string; method: string; headers: Record<string, string>; bodyBase64: string } {
  if (input.kind === "fetch") return { url: input.url, method: "GET", headers: {
    accept: input.format === "html" ? "text/html, */*;q=0.5" : "text/markdown, text/plain, text/html;q=0.8, */*;q=0.5",
    "user-agent": "LegalWork", "accept-encoding": "identity",
  }, bodyBase64: "" };
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

export function webResult(input: WebInput, url: string, response: OutboundResponse) {
  if (response.status < 200 || response.status >= 300) throw new Error(`Website returned HTTP ${response.status}.`);
  const bytes = Buffer.from(response.bodyBase64, "base64");
  const content = bytes.toString("utf8");
  if (input.kind === "search") {
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
    const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    const hidden = ["script", "style", "meta", "link", "iframe", "object", "embed"];
    converter.remove(node => hidden.includes(node.nodeName.toLowerCase()));
    if (input.format === "text") converter.addRule("plainText", { filter: () => true,
      replacement: (content, node) => hidden.includes(node.nodeName.toLowerCase()) ? "" : /^(?:P|DIV|H[1-6]|LI|PRE|BLOCKQUOTE|TR|BR|HR|SECTION|ARTICLE)$/.test(node.nodeName) ? `\n\n${content}\n\n` : content,
    });
    return { title: url, output: converter.turndown(content), metadata: {} };
  }
  return { title: url, output: content, metadata: {} };
}
