import { normalizeApplication } from "../types.js";
import { z } from "zod";
import type { Controller, RawDocRef } from "../types.js";
import { ApplikationEnum } from "../schemas/enums.js";
import { normaliseHits } from "./normalization.js";
import { allowedRisUrl, boundedText, risRequestQueue, type RisRequestQueue } from "./request.js";
import { RisNotFoundError, RisUpstreamError, translateUpstreamError, upstreamHttpError } from "../infrastructure/errors.js";

const rawContentUrl = z.object({ DataType: z.string().optional(), Url: z.string().optional() });
const rawContentRef = z.object({ ContentType: z.string().optional(), Name: z.string().optional(),
  Urls: z.object({ ContentUrl: z.union([rawContentUrl, z.array(rawContentUrl)]).optional() }).optional() });
const rawDoc = z.object({ Data: z.looseObject({
  Metadaten: z.looseObject({
    Technisch: z.looseObject({ ID: z.string().min(1), Applikation: z.preprocess(normalizeApplication, ApplikationEnum.optional()), Organ: z.string().optional(),
      Einbringer: z.string().optional(), ImportTimestamp: z.union([z.string(), z.object({ "@xsi:nil": z.literal("true").optional() })]).optional() }),
    Allgemein: z.looseObject({ Veroeffentlicht: z.string().optional(), Geaendert: z.string().optional(), DokumentUrl: z.string().optional() }).optional(),
  }),
  Dokumentliste: z.object({ ContentReference: z.union([rawContentRef, z.array(rawContentRef)]).optional() }).optional(),
  Deleted: z.object({ Reason: z.string().optional() }).optional(),
}) });
// OGD_Response.xsd defines Deleted as a sibling alternative to Data, with
// OgdDeleteContentType metadata (ID, application, deletion timestamp).
const rawDeleted = z.object({ Deleted: z.object({ ID: z.string().min(1),
  Applikation: z.preprocess(normalizeApplication, ApplikationEnum), Organ: z.string().optional(),
  ImportTimestamp: z.union([z.string(), z.object({ "@xsi:nil": z.literal("true").optional() })]),
}) }).transform(({ Deleted }) => ({ Data: { Metadaten: { Technisch: Deleted }, Deleted: {} } }));
const rawReference = z.union([rawDoc, rawDeleted]);
const envelope = z.object({ OgdSearchResult: z.object({
  "@status": z.string().optional(),
  Error: z.object({ Applikation: z.string().optional(), Message: z.string().optional() }).optional(),
  OgdDocumentResults: z.object({ Hits: z.object({ "#text": z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]), "@pageNumber": z.string().optional(), "@pageSize": z.string().optional() }), OgdDocumentReference: z.union([rawReference, z.array(rawReference)]).optional() }).optional(),
}) });

export interface RisClientOptions {
  fetchImpl?: (input: string | URL, init: RequestInit) => Promise<Response>;
  queue?: RisRequestQueue;
  signal?: AbortSignal;
  assertAllowed?: () => Promise<void>;
}

/** Fixed official endpoints, serial bounded requests, no stored responses. */
export class RisClient {
  private requests = 0;
  readonly signal: AbortSignal;
  constructor(private readonly options: RisClientOptions = {}) {
    this.signal = options.signal ?? AbortSignal.timeout(120_000);
  }

  private async request(value: string | URL, content = false): Promise<{ status: number; text: string; type: string }> {
    if (++this.requests > 32) throw new RisUpstreamError("This RIS operation needs too many requests. Select a specific application or narrow the query.");
    const queue = this.options.queue ?? risRequestQueue;
    const fetcher = this.options.fetchImpl ?? fetch;
    let url = allowedRisUrl(String(value), content);
    let retries = 0, redirects = 0;
    for (;;) {
      const result = await queue.run(this.signal, async () => {
        await this.options.assertAllowed?.();
        const signal = AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]);
        let response: Response;
        try {
          response = await fetcher(url, { method: "GET", redirect: "manual", signal,
            headers: { Accept: content ? "text/html,application/xml;q=0.8" : "application/json", "User-Agent": "LegalWork-RIS/1.0 (+https://eigenweltlabs.com)" } });
        } catch (error) {
          this.signal.throwIfAborted();
          throw new RisUpstreamError("RIS could not be reached or timed out. Try again shortly.");
        }
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel();
          return { status: response.status, text: "", type: "", location, retryAfter: null };
        }
        return { status: response.status, text: await boundedText(response), type: response.headers.get("content-type") ?? "",
          location: null, retryAfter: response.headers.get("retry-after") };
      });
      if (result.location) {
        if (++redirects > 3) throw new RisUpstreamError("RIS returned too many redirects.");
        url = allowedRisUrl(new URL(result.location, url).href, content);
        continue;
      }
      if ([429, 502, 503, 504].includes(result.status) && retries++ === 0) {
        const seconds = result.retryAfter && /^\d+$/.test(result.retryAfter) ? Number(result.retryAfter) : undefined;
        const requested = seconds === undefined && result.retryAfter ? Date.parse(result.retryAfter) - Date.now() : (seconds ?? 2) * 1000;
        if (Number.isFinite(requested) && requested > 30_000)
          throw new RisUpstreamError("RIS asked for a longer pause. Try again later.", { status: result.status, retry_after_ms: requested });
        if (requested > 0) await delayRetry(requested, this.signal);
        continue;
      }
      return result;
    }
  }

  async query(controller: Controller, params: Map<string, string>) {
    const url = new URL(`https://data.bka.gv.at/ris/api/v2.6/${controller}`);
    for (const [key, value] of params) url.searchParams.set(key, value);
    const response = await this.request(url);
    let json: unknown;
    try { json = JSON.parse(response.text); }
    catch {
      if (response.status < 200 || response.status >= 300) throw upstreamHttpError(response.status, "");
      throw new RisUpstreamError("RIS returned an unreadable response. Try again shortly.");
    }
    const parsed = envelope.safeParse(json);
    if (!parsed.success && (response.status < 200 || response.status >= 300)) throw upstreamHttpError(response.status, "");
    if (!parsed.success) throw new RisUpstreamError("RIS returned an unexpected response format. No legal result could be verified.");
    const result = parsed.data.OgdSearchResult;
    if (result.Error) throw translateUpstreamError(result.Error.Message ?? "Unknown RIS error", result.Error.Applikation);
    if (response.status < 200 || response.status >= 300) throw upstreamHttpError(response.status, "");
    if (result["@status"] === "error" || !result.OgdDocumentResults)
      throw new RisUpstreamError("RIS returned no valid search results envelope.");
    const docs = result.OgdDocumentResults;
    const references = docs.OgdDocumentReference;
    const records = references === undefined ? [] : Array.isArray(references) ? references : [references];
    for (const record of records) record.Data.Metadaten.Technisch.Applikation ??= ApplikationEnum.parse(normalizeApplication(params.get("Applikation") ?? params.get("Anwendung")));
    return { hits: normaliseHits(docs.Hits), records };
  }

  async queryPaged(controller: Controller, params: Map<string, string>, options: { limit: number; offset: number; upstreamPageSize: number }) {
    const { limit, offset, upstreamPageSize } = options;
    const startPage = Math.floor(offset / upstreamPageSize) + 1;
    const endPage = Math.floor((offset + limit - 1) / upstreamPageSize) + 1;
    const out: RawDocRef[] = [];
    let total = 0;
    for (let page = startPage; page <= endPage; page++) {
      const pageParams = new Map(params);
      pageParams.set("Seitennummer", String(page));
      const result = await this.query(controller, pageParams);
      total = result.hits.total;
      out.push(...result.records);
      if (!result.records.length || page * upstreamPageSize >= total) break;
    }
    return { total, records: out.slice(offset % upstreamPageSize, offset % upstreamPageSize + limit) };
  }

  async count(controller: Controller, params: Map<string, string>) {
    const page = new Map(params);
    page.set("DokumenteProSeite", "Ten"); page.set("Seitennummer", "1");
    return (await this.query(controller, page)).hits.total;
  }

  async fetchHtml(url: string) {
    const response = await this.request(url, true);
    if (response.status === 404) throw new RisNotFoundError("The RIS document was not found. Check its application and document number.");
    if (response.status < 200 || response.status >= 300) throw upstreamHttpError(response.status, "");
    if (/pdf|rtf|octet-stream/i.test(response.type)) throw new RisUpstreamError("This RIS source is not readable HTML. Use format=raw_url to open the original document.");
    if (/challenge-platform|cf-chl-|just a moment|enable javascript and cookies/i.test(response.text))
      throw new RisUpstreamError("RIS returned a browser verification page. Open the original RIS source link or try again later.");
    return { ok: true, status: response.status, html: response.text };
  }

  async health() {
    const response = await this.request("https://data.bka.gv.at/ris/api/v2.6/Version");
    if (response.status < 200 || response.status >= 300) throw upstreamHttpError(response.status, "");
    return { ok: true, version: response.text.slice(0, 200) };
  }
}

async function delayRetry(ms: number, signal: AbortSignal) {
  const { setTimeout } = await import("node:timers/promises");
  await setTimeout(ms, undefined, { signal });
}
