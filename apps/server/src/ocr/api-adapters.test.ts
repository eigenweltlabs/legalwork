import { expect, test } from "bun:test";
import { createConfiguredOcrService, defaultOcrSettings, OcrService, serverEngineSchema } from "./index.js";
import { createServerOcrEngine } from "./server-engine.js";
import type { OcrApiType } from "@legalwork/types/ocr";

const page = { pageNumber: 4, mimeType: "image/png", width: 100, height: 50, data: new Uint8Array([1, 2, 3]) } satisfies import("./types.js").OcrPage;
const request = { sourceId: "private-source", pages: [page], languages: ["en", "de"] };
const responseFor = (kind: OcrApiType, text = "Agreement / Vertrag") => kind === "mistral-ocr"
  ? { pages: [{ index: 0, markdown: text }] }
  : kind === "paddleocr" ? { errorCode: 0, result: { layoutParsingResults: [{ markdown: { text } }] } }
  : { choices: [{ message: { content: text }, finish_reason: "stop" }] };
const types: OcrApiType[] = ["chat-completions", "mistral-ocr", "paddleocr"];

for (const kind of types) {
  test(`${kind}: correct wire format over HTTP, optional localhost authentication and normalized result`, async () => {
    let calls = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
      calls++;
      expect(req.headers.has("authorization")).toBe(false);
      expect(req.headers.get("content-type")).toBe("application/json");
      const body = await req.json();
      if (kind === "paddleocr") expect(body).toEqual({ file: "AQID", fileType: 1, visualize: false, returnMarkdownImages: false });
      else if (kind === "mistral-ocr") expect(body).toEqual({ model: "test-model", document: { type: "image_url", image_url: "data:image/png;base64,AQID" }, include_image_base64: false });
      else { expect(body.model).toBe("test-model"); expect(JSON.stringify(body)).toContain("data:image/png;base64,AQID"); expect(body.messages).toHaveLength(2); }
      expect(JSON.stringify(body)).not.toContain(request.sourceId);
      return Response.json(responseFor(kind));
    } });
    try {
      const settings = defaultOcrSettings();
      settings.engines.push(serverEngineSchema.parse({ id: "custom", label: "Custom", kind, model: "test-model", endpoint: server.url.href, apiKeyRef: null }));
      settings.defaultEngineId = "custom";
      const service = createConfiguredOcrService(settings, {
        localRuntime: { python: "/unused", workerPath: "/unused", modelDirectory: "/unused" },
        resolveApiKey: async () => { throw new Error("Unauthenticated endpoints must not read secrets"); },
      });
      const result = await service.extract(request);
      expect(result.pages[0]).toMatchObject({ text: "Agreement / Vertrag", pageNumber: 4, width: 100, height: 50, regions: [], truncated: false });
      expect(result.sourceId).toBe(request.sourceId);
      expect(result.engine.id).toBe("custom");
      expect(calls).toBe(1);
    } finally { server.stop(true); }
  });

  test(`${kind}: bearer credentials, cancellation, response limits and errors remain bounded`, async () => {
    const settings = serverEngineSchema.parse({ id: "custom", label: "Custom", kind, model: "test-model", endpoint: "https://example.com/ocr", apiKeyRef: "vault-key" });
    const engine = createServerOcrEngine(settings, async () => "secret", async (_url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
      expect(init.redirect).toBe("error");
      return Response.json(responseFor(kind));
    });
    expect((await new OcrService([engine], "custom").extract(request)).pages[0].text).toBe("Agreement / Vertrag");
    for (const body of [{}, { pages: [] }, { pages: [{ markdown: "A" }, { markdown: "B" }] }, { errorCode: 1, errorMsg: "secret", result: { layoutParsingResults: [{ markdown: { text: "ignore" } }] } }]) {
      const invalid = createServerOcrEngine(settings, async () => "secret", async () => Response.json(body));
      await expect(new OcrService([invalid], "custom").extract(request)).rejects.toMatchObject({ code: "invalid-response" });
    }
    const huge = createServerOcrEngine(settings, async () => "secret", async () => new Response("x".repeat(4 * 1024 * 1024 + 1)));
    await expect(new OcrService([huge], "custom").extract(request)).rejects.toMatchObject({ code: "invalid-response" });
    const rejected = createServerOcrEngine(settings, async () => "secret", async () => new Response("secret provider details", { status: 401 }));
    await expect(new OcrService([rejected], "custom").extract(request)).rejects.toMatchObject({ message: "The OCR server rejected the request (HTTP 401)." });
    const controller = new AbortController();
    const cancelled = createServerOcrEngine(settings, async () => { controller.abort(); return "secret"; }, async () => { throw new Error("Must not send after cancellation"); });
    await expect(new OcrService([cancelled], "custom").extract({ ...request, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(serverEngineSchema.safeParse({ ...settings, apiKeyRef: null }).success).toBe(false);
  });
}
