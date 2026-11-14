import { expect, test } from "bun:test";
import { convertHtml } from "./web-convert.js";
import { webResult } from "./web.js";
import type { SearchProvider } from "./search-provider.js";
import { ApiError } from "../errors.js";
import { eigenweltUsageLimitFromText, type UsageLimitDetails } from "../provider-usage-limit.js";
const signal = new AbortController().signal;

test("paid search preserves safe allowance reasons without leaking gateway diagnostics", async () => {
  const provider: SearchProvider = { name: "aws", url: "https://gateway.example/v1/web/search", apiKey: "secret" };
  const reasons: Array<UsageLimitDetails["reason"]> = ["member_limit", "organization_limit", "wallet_empty", "extra_disabled", "seat_required", "service_limit"];
  for (const reason of reasons) {
    const limit = { reason, requiredMicros: 1, availableMicros: 0 };
    for (const body of [
      { detail: "private diagnostics. Eigenwelt usage limit: " + JSON.stringify({ ...limit, private: "hidden" }) },
      { error: { message: "Budget has been exceeded. Eigenwelt usage limit: " + JSON.stringify(limit) } },
    ]) {
      try {
        await webResult({ kind: "search", sessionID: "chat", agent: "legalwork", query: "private query", numResults: 8,
          type: "auto", livecrawl: "fallback" }, provider.url, {
          status: 429, headers: {}, bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64"),
        }, signal, provider);
        throw new Error("Expected an allowance failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        if (!(error instanceof ApiError)) throw error;
        expect(error).toMatchObject({ status: 429, code: "web_search_usage_limit", details: limit });
        expect(eigenweltUsageLimitFromText(error.message)).toEqual(limit);
        expect(error.message).toContain("Do not retry or use another search route");
        expect(JSON.stringify(error)).not.toContain("private");
        expect(JSON.stringify(error)).not.toContain("hidden");
      }
    }
  }
});

test("throttling, malformed allowance details and Exa errors never become paid usage recovery", async () => {
  const aws: SearchProvider = { name: "aws", url: "https://gateway.example/v1/web/search", apiKey: "secret" };
  for (const [provider, body] of [
    [aws, { detail: "Rate limit exceeded" }],
    [aws, { detail: 'Eigenwelt usage limit: {"reason":"wallet_empty","requiredMicros":1,"availableMicros":1}' }],
    [aws, { detail: 'Eigenwelt usage limit: {"reason":"invented","requiredMicros":1,"availableMicros":0}' }],
    [{ name: "exa" }, { detail: 'Eigenwelt usage limit: {"reason":"wallet_empty","requiredMicros":1,"availableMicros":0}' }],
  ] satisfies Array<[SearchProvider, unknown]>) {
    await expect(webResult({ kind: "search", sessionID: "chat", agent: "legalwork", query: "query", numResults: 8,
      type: "auto", livecrawl: "fallback" }, aws.url, {
      status: 429, headers: {}, bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64"),
    }, signal, provider)).rejects.toMatchObject({ status: 502, code: "web_search_unavailable" });
  }
});

test("search outages return a clear API error without exposing the upstream body", async () => {
  const providers: SearchProvider[] = [{ name: "exa" }, { name: "aws", url: "https://gateway.example/v1/web/search", apiKey: "secret" }];
  for (const provider of providers) {
    await expect(webResult({ kind: "search", sessionID: "chat", agent: "legalwork", query: "private query", numResults: 8,
      type: "auto", livecrawl: "fallback" }, "https://gateway.example/v1/web/search", {
      status: 502, headers: {}, bodyBase64: Buffer.from("private upstream diagnostics").toString("base64"),
    }, signal, provider)).rejects.toMatchObject({ status: 502, code: "web_search_unavailable",
      message: "The web search service is unavailable. Please try again later." });
  }
});

test("web pages preserve readable markdown and hide non-content elements", async () => {
  const result = await webResult({ kind: "fetch", sessionID: "chat", agent: "build", url: "https://example.com", format: "markdown" }, "https://example.com", {
    status: 200, headers: { "content-type": "text/html" }, bodyBase64: Buffer.from('<h1>Title</h1><p>Hello <strong>world</strong>.</p><script>private script</script>').toString("base64"),
  });
  expect(result.output).toBe("# Title\n\nHello **world**.");
  expect(await convertHtml('<h1>Title</h1><p>Hello <strong>world</strong>.</p>', "text", signal)).toBe("Title\n\nHello world.");
});

test("the review's hostile page is rejected before parsing", async () => {
  await expect(convertHtml("<p>untrusted page text</p>".repeat(100000), "markdown", signal)).rejects.toThrow("too complex");
  expect(await convertHtml("<p>Still responsive</p>", "markdown", signal)).toBe("Still responsive");
});

test("conversion is interruptible, including while waiting for a worker slot", async () => {
  const controller = new AbortController();
  const pending = Array.from({ length: 6 }, () => convertHtml("<p>untrusted page text</p>".repeat(9000), "markdown", controller.signal));
  setTimeout(() => controller.abort(new Error("permissions changed")), 10);
  for (const result of await Promise.allSettled(pending)) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(String(result.reason)).toContain("permissions changed");
  }
  expect(await convertHtml("<p>Available again</p>", "markdown", signal)).toBe("Available again");
});

test("a conversion deadline terminates the parser without blocking server timers", async () => {
  let ticked = false;
  setTimeout(() => { ticked = true; }, 1);
  await expect(convertHtml("<p>text</p>".repeat(9000), "markdown", signal, 5)).rejects.toThrow("timed out");
  expect(ticked).toBe(true);
});

test("deeply nested markup is rejected without exhausting the parser", async () => {
  await expect(convertHtml("<blockquote>".repeat(160) + "text" + "</blockquote>".repeat(160), "markdown", signal)).rejects.toThrow("deeply nested");
});
