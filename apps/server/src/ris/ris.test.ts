import upstreamSchemas from "./fixtures/upstream-input-schemas.json" with { type: "json" };
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { RisClient } from "./client/ris-client.js";
import { RisRequestQueue, allowedRisUrl, boundedText } from "./client/request.js";
import { normaliseIdInput } from "./client/content.js";
import { risTools, RIS_ACTIONS } from "./tools.js";

const record = (id: string, app = "BrKons", overrides: Record<string, unknown> = {}) => ({ Data: { Metadaten: {
  Technisch: { ID: id, Applikation: app }, Allgemein: { DokumentUrl: `https://www.ris.bka.gv.at/Dokument.wxe?Dokumentnummer=${id}` },
  Bundesrecht: { Kurztitel: "Testgesetz", BrKons: { Gesetzesnummer: "10001622", ArtikelParagraphAnlage: "§ 1", Inkrafttretensdatum: "2020-01-01", ...overrides } },
}, Dokumentliste: { ContentReference: { ContentType: "MainDocument", Urls: { ContentUrl: { DataType: "Html", Url: `https://ogd.ris.bka.gv.at/Dokumente/Bundesnormen/${id}/${id}.html` } } } } } });
const result = (records: unknown[], total = records.length) => Response.json({ OgdSearchResult: { OgdDocumentResults: {
  Hits: { "#text": String(total), "@pageNumber": "1", "@pageSize": "10" }, OgdDocumentReference: records,
} } });
function fixture(respond: (url: URL) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const client = new RisClient({ queue: new RisRequestQueue({ intervalMs: 0 }), fetchImpl: async value => {
    const url = new URL(value); urls.push(url); return respond(url);
  } });
  const call = async (action: string, args: unknown) => {
    const tool = risTools(client).find(tool => tool.action === action);
    if (!tool) throw new Error("Missing tool");
    return tool.run(args);
  };
  return { client, urls, call };
}
const searchOutput = z.object({ total: z.number(), count: z.number(), next_offset: z.number().nullable(),
  applikations_failed: z.array(z.object({ applikation: z.string() })).optional(), items: z.array(z.object({ ris_citation: z.object({ id: z.string() }) })) });

test("preserves the eight MCP action names and its search, section and citation contract", () => {
  expect(RIS_ACTIONS.map(value => value.action)).toEqual(["ris_about", "ris_list_scopes", "ris_search", "ris_get_document", "ris_get_section", "ris_get_related", "ris_verify", "ris_get_history"]);
  expect(JSON.stringify(Object.fromEntries(RIS_ACTIONS.map(value => [value.action, value.inputSchema])))).toBe(JSON.stringify(upstreamSchemas));
  const search = RIS_ACTIONS.find(value => value.action === "ris_search");
  expect(search?.inputSchema.properties).toHaveProperty("gesetzesnummer");
  expect(search?.inputSchema.properties).toHaveProperty("bulk_acknowledged");
  expect(search?.inputSchema.additionalProperties).toBe(false);
  expect(RIS_ACTIONS.every(value => value.writes === false && value.outputSchema)).toBe(true);
});

test("rejects invalid dates, inverted ranges, unsupported fields and bulk paging before any request", async () => {
  const { call, urls } = fixture(() => result([]));
  await expect(call("ris_search", { corpus: "federal_law", date_from: "2026-02-30" })).rejects.toThrow("real calendar date");
  await expect(call("ris_search", { corpus: "federal_law", date_from: "2026-05-02", date_to: "2026-05-01" })).rejects.toThrow("must not be after");
  await expect(call("ris_search", { corpus: "federal_law", url: "http://localhost" })).rejects.toThrow("Invalid RIS tool arguments");
  await expect(call("ris_search", { corpus: "federal_law", offset: 1000 })).rejects.toThrow("threshold");
  expect(urls).toHaveLength(0);
});

test("makes fresh requests, preserves full metadata and maps federal law to its controller", async () => {
  const { call, urls } = fixture(() => result([record("NOR40198929")]));
  for (let i = 0; i < 2; i++) {
    const value = z.object({ items: z.array(z.object({ ris_citation: z.object({ source: z.string(), gesetzesnummer: z.string() }) })) })
      .parse(await call("ris_search", { corpus: "federal_law", title: "ABGB", include_full_metadata: true }));
    expect(value.items[0].ris_citation.gesetzesnummer).toBe("10001622");
  }
  expect(urls).toHaveLength(2);
  expect(urls[0].pathname).toBe("/ris/api/v2.6/Bundesrecht");
  expect(urls[0].searchParams.get("Titel")).toBe("ABGB");
});

test("case-law filters include both principles and complete decisions", async () => {
  const { call, urls } = fixture(() => result([]));
  await call("ris_search", { corpus: "case_law", applikation: "Vwgh", norm: "§ 1 ABGB", sort_by: "date_desc" });
  expect(urls[0].pathname).toEndWith("/Judikatur");
  expect(urls[0].searchParams.get("Dokumenttyp.SucheInRechtssaetzen")).toBe("True");
  expect(urls[0].searchParams.get("Dokumenttyp.SucheInEntscheidungstexten")).toBe("True");
  expect(urls[0].searchParams.get("Sortierung.SortedByColumn")).toBe("Datum");
});

test("rejects ambiguous state-law numbers before reading, verifying or resolving relations", async () => {
  const { call, urls } = fixture(() => result([]));
  for (const action of ["ris_get_document", "ris_get_section", "ris_get_related", "ris_verify"]) {
    await expect(call(action, { id: "20000911", applikation: "LrKons", ...(action === "ris_get_section" ? { section_ref: "§ 1" } : {}) })).rejects.toThrow("do not identify a unique Austrian state");
  }
  await expect(call("ris_get_section", { id: "LTI40053243", applikation: "LrKons" })).rejects.toThrow("section_ref");
  expect(urls).toHaveLength(0);
});

test("scopes a state law's structure to the exact document's Bundesland", async () => {
  const stateRecord = { Data: { Metadaten: {
    Technisch: { ID: "LTI40053243", Applikation: "LrKons" },
    Landesrecht: { Bundesland: "Tirol", Kurztitel: "Bauordnung 2022, Tiroler", LrKons: { Gesetzesnummer: "20000911", ArtikelParagraphAnlage: "§ 1", Inkrafttretensdatum: "2025-10-14" } },
  } } };
  const { call, urls } = fixture(url => result(url.searchParams.has("Suchworte") || url.searchParams.get("Bundesland.SucheInTirol") === "true" ? [stateRecord] : [record("LBG40014005", "LrKons")]));
  const output = z.object({ structure: z.array(z.object({ ref: z.string() })) }).parse(await call("ris_get_document", { id: "LTI40053243", applikation: "LrKons", include_structure: true }));
  expect(output.structure).toEqual([{ ref: "§ 1" }]);
  expect(urls[1].searchParams.get("Bundesland.SucheInTirol")).toBe("true");
  expect(urls[1].searchParams.get("Gesetzesnummer")).toBe("20000911");
  const unknown = fixture(() => result([record("LTI40053243", "LrKons", { Bundesland: "Unknown" })]));
  await expect(unknown.call("ris_get_document", { id: "LTI40053243", applikation: "LrKons", include_structure: true })).rejects.toThrow("unknown Bundesland");
  expect(unknown.urls).toHaveLength(1);
});

test("reads a state document's footer law number and keeps its identity for validity checks", async () => {
  const { call } = fixture(url => url.hostname === "data.bka.gv.at" ? result([]) : new Response('<h2>Bundesland</h2><p>Tirol</p><h2>Kurztitel</h2><p>Bauordnung 2022, Tiroler</p><h2>Inkrafttretensdatum</h2><p>14.10.2025</p><h2>Text</h2><p>§ 1 Testtext</p><h2>Gesetzesnummer</h2><p>20000911</p><h2>Dokumentnummer</h2><p>LTI40053243</p>'));
  const section = z.object({ ris_citation: z.object({ id: z.string(), gesetzesnummer: z.string() }) }).parse(await call("ris_get_section", { id: "LTI40053243", applikation: "LrKons", section_ref: "", format: "plain" }));
  expect(section.ris_citation).toEqual({ id: "LTI40053243", gesetzesnummer: "20000911" });
  const validity = z.object({ in_force: z.boolean(), note: z.string(), ris_citation: z.object({ id: z.string() }) }).parse(await call("ris_verify", { id: "LTI40053243", applikation: "LrKons", at_date: "2020-01-01" }));
  expect(validity.in_force).toBe(false);
  expect(validity.note).toContain("exact document version");
  expect(validity.ris_citation.id).toBe("LTI40053243");
});

test("cross-database pagination reaches later databases and discloses failed databases", async () => {
  const { call, urls } = fixture(url => {
    const app = url.searchParams.get("Applikation");
    if (app === "BgblPdf") return Response.json({ OgdSearchResult: { Error: { Message: "soap:Client Unavailable" } } });
    return app === "BgblAuth" ? result([record("BGBLA_2026_I_1", "BgblAuth")], 1) : app === "BgblAlt" ? result([record("BGBL_1930_1", "BgblAlt")], 1) : result([]);
  });
  const output = searchOutput.parse(await call("ris_search", { corpus: "gazettes", offset: 1, limit: 1 }));
  expect(output.items[0].ris_citation.id).toBe("BGBL_1930_1");
  expect(output.applikations_failed?.map(value => value.applikation)).toContain("BgblPdf");
  expect(urls.some(url => url.searchParams.get("Applikation") === "Bvb")).toBe(true);
});

test("aligns pagination across upstream pages without dropping records", async () => {
  const { client } = fixture(url => {
    const page = Number(url.searchParams.get("Seitennummer"));
    return result(Array.from({ length: 10 }, (_, index) => record(`NOR${40000000 + (page - 1) * 10 + index}`)), 25);
  });
  const value = await client.queryPaged("Bundesrecht", new Map([["Applikation", "BrKons"]]), { limit: 4, offset: 8, upstreamPageSize: 10 });
  expect(value.records.map(rec => rec.Data.Metadaten.Technisch?.ID)).toEqual(["NOR40000008", "NOR40000009", "NOR40000010", "NOR40000011"]);
});

test("reports a repealed law without claiming an upstream failure or inventing current text", async () => {
  const { call, urls } = fixture(url => url.searchParams.has("Fassung.FassungVom") ? result([]) : result([record("NOR40000001", "BrKons", {
    Ausserkrafttretensdatum: "2020-12-31", Kundmachungsorgan: "BGBl. I Nr. 1/2020 aufgehoben durch BGBl. I Nr. 2/2021",
  })]));
  const value = z.object({ in_force: z.boolean(), note: z.string() }).parse(await call("ris_verify", { id: "10001622", at_date: "2026-01-01" }));
  expect(value.in_force).toBe(false); expect(value.note).toContain("repealed");
  await expect(call("ris_get_document", { id: "10001622", fassung_vom: "2026-01-01" })).rejects.toThrow("No version is in force");
  expect(urls).toHaveLength(3);
});

test("does not label a timeout, malformed envelope or unknown document as an empty successful result", async () => {
  const { call } = fixture(() => Response.json({ OgdSearchResult: { OgdDocumentResults: { Hits: { "#text": "oops" } } } }));
  await expect(call("ris_search", { corpus: "federal_law" })).rejects.toThrow("unexpected response format");
  const broken = fixture(() => { throw new Error("offline"); });
  await expect(broken.call("ris_get_section", { id: "NOR40198929", section_ref: "§ 1" })).rejects.toThrow("could not be reached");
});

test("history keeps actual deletion status and never fabricates an added/modified distinction", async () => {
  // Shape from OGD_Response.xsd / OgdDeleteContentType, rather than a guessed
  // Data.Deleted flag. History uses the legacy application name in tombstones.
  const response = { Deleted: { ID: "NOR40000001", Applikation: "Bundesnormen", ImportTimestamp: "2026-01-02T12:00:00" } };
  const { call, urls } = fixture(() => result([response, record("NOR40000002")]));
  const value = z.object({ items: z.array(z.object({ action: z.string(), import_timestamp: z.string().optional(), ris_citation: z.object({ applikation: z.string() }) })) }).parse(await call("ris_get_history", { anwendung: "BrKons", from_date: "2026-01-01", include_deleted: true }));
  expect(value.items.map(item => item.action)).toEqual(["deleted", "modified"]);
  expect(urls[0].searchParams.get("Anwendung")).toBe("Bundesnormen");
  expect(urls[0].searchParams.get("IncludeDeletedDocuments")).toBe("True");
  expect(value.items[0].ris_citation.applikation).toBe("BrKons");
  expect(value.items[0].import_timestamp).toBe("2026-01-02T12:00:00");
});

test("reads and converts actual document markup while preserving accents and rejecting browser challenges", async () => {
  const { call } = fixture(() => new Response('<html><head><title>Remove me</title></head><body><h2>Kurztitel</h2><p>Testgesetz</p><h2>Text</h2><p>§ 1 &#196;nderung <span class="sr-only">Paragraph eins</span><strong>gilt</strong>.</p></body></html>', { headers: { "content-type": "text/html" } }));
  const value = z.object({ text: z.string(), ris_citation: z.object({ id: z.string() }) }).parse(await call("ris_get_section", { id: "NOR40198929", section_ref: "§ 1", format: "plain" }));
  expect(value.text).toContain("§ 1 Änderung gilt."); expect(value.text).not.toContain("Paragraph eins"); expect(value.text).not.toContain("Remove me");
  const challenge = fixture(() => new Response("<title>Just a moment</title>"));
  await expect(challenge.call("ris_get_section", { id: "NOR40198929", section_ref: "§ 1" })).rejects.toThrow("browser verification");
});

describe("official endpoint boundary", () => {
  test("rejects private hosts, credentials, nonstandard ports, lookalike hosts and unsafe redirects", async () => {
    const withCredentials = new URL("https://ris.bka.gv.at/Dokumente/x");
    withCredentials.username = "fixture-user";
    withCredentials.password = "not-a-real-password";
    for (const url of ["http://127.0.0.1/", "https://ris.bka.gv.at.evil.test/Dokumente/x", "https://ris.bka.gv.at:444/Dokumente/x", withCredentials.href, "https://ris.bka.gv.at/admin"])
      expect(() => allowedRisUrl(url, true)).toThrow();
    const { client, urls } = fixture(() => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }));
    await expect(client.fetchHtml("https://ogd.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40198929/NOR40198929.html")).rejects.toThrow("permitted official");
    expect(urls).toHaveLength(1);
  });
  test("normalizes official RIS and ELI links without ever treating arbitrary URLs as search input", () => {
    expect(normaliseIdInput("https://ris.bka.gv.at/eli/jgs/1811/946/P0/NOR40198929")).toBe("NOR40198929");
    expect(normaliseIdInput("https://www.ris.bka.gv.at/GeltendeFassung.wxe?Gesetzesnummer=10001622")).toBe("10001622");
    expect(() => normaliseIdInput("https://evil.test/?Dokumentnummer=NOR40198929")).toThrow("official HTTPS");
  });
  test("bounds streamed response bodies even without Content-Length", async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.close(); } }));
    await expect(boundedText(response, 10)).rejects.toThrow("too large");
  });
});

test("one shared queue serializes concurrent operations, spaces requests and skips cancelled work", async () => {
  let now = 0, active = 0, maximum = 0;
  const starts: number[] = [];
  const queue = new RisRequestQueue({ now: () => now, sleep: async ms => { now += ms; } });
  const cancelled = AbortSignal.abort();
  const execute = () => queue.run(new AbortController().signal, async () => {
    starts.push(now); maximum = Math.max(maximum, ++active); await Promise.resolve(); active--; return starts.length;
  });
  const values = await Promise.allSettled([execute(), queue.run(cancelled, async () => { throw new Error("must not execute"); }), execute(), execute()]);
  expect(values[1].status).toBe("rejected"); expect(maximum).toBe(1); expect(starts).toEqual([0, 2000, 4000]);
});

test("respects Retry-After and retries a temporary response once", async () => {
  let attempts = 0;
  const { call } = fixture(() => ++attempts === 1 ? new Response(null, { status: 429, headers: { "retry-after": "0" } }) : result([]));
  await call("ris_search", { corpus: "federal_law" }); expect(attempts).toBe(2);
  const paused = fixture(() => new Response(null, { status: 429, headers: { "retry-after": "120" } }));
  await expect(paused.call("ris_search", { corpus: "federal_law" })).rejects.toThrow("longer pause");
  expect(paused.urls).toHaveLength(1);
});
