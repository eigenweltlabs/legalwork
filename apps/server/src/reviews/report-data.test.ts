import { expect, test } from "bun:test";
import { SavedReviewSchema } from "@legalwork/types/reviews";
import { ReportTemplateFieldsSchema, reportClassText, reportDraftData, reportPacketFiles, reportSourceText, reviewReportData } from "./report-data.js";

function fixture(count = 3) {
  return SavedReviewSchema.parse({ id: "8d421fb4-3f23-49e3-a5a2-01a2f3cd9911", name: "Customers", revision: 7,
    createdAt: 1, updatedAt: 2, settings: { mode: "jev", jev: null, llm: null }, status: "needs_review", runId: null,
    documents: Array.from({ length: count }, (_, i) => ({ id: `d${i}`, name: `Contract ${i}`, path: `room/${i}.pdf`, sourceHash: `h${i}`, status: "ready" })),
    columns: [{ key: "consent", label: "Consent", kind: "classification", question: "Consent required?", options: ["Yes", "No"] }],
    cells: Array.from({ length: count }, (_, i) => ({ documentId: `d${i}`, columnKey: "consent", status: i === 0 ? "needs_review" : "complete",
      result: { value: i === 0 ? "Needs review" : "Yes", reason: "", citations: [], confidence: null, evidence: i === 0 ? "uncertain" : "uncited",
        backend: "systemone", providerId: "eigenwelt", model: "Jev", requestedModel: "Jev", sourceHash: `h${i}`,
        prompt: { key: "consent", label: "Consent", kind: "classification", question: "Consent required?", options: ["Yes", "No"] }, completedAt: 1 } })),
  });
}

test("5,000 source rows retain every decision while drafting context stays bounded", () => {
  const packet = reviewReportData([fixture(5000)], []);
  expect(packet.distinctDocuments).toBe(5000);
  expect(packet.reviews[0].rows).toHaveLength(5000);
  expect(packet.reviews[0].distribution[0].values[0].examples).toHaveLength(3);
  expect(packet.reviews[0].distribution[0].open).toBe(1);
  expect(packet.reviews[0].distribution[0].values[0].documents).toBe(4999);
  expect(packet.reviews[0].distribution[0].values[0].value).toBe("Yes");
  expect(reportClassText(packet.reviews[0]).length).toBeLessThan(1500);
  expect(packet.openDocuments).toBe(1);
  expect(packet.openCells).toBe(1);
});

test("5,000 agreements with eight columns retain 40,000 cells in byte-bounded files", () => {
  const review = fixture(5000), column = review.columns[0], cells = [...review.cells];
  review.columns = Array.from({ length: 8 }, (_, i) => ({ ...column, key: `consent${i}` }));
  review.cells = cells.flatMap(cell => review.columns.map(column => ({ ...cell, columnKey: column.key })));
  const packet = reviewReportData([review], []);
  const stored = reportPacketFiles(packet, {}, "reports/data");
  const descriptor = JSON.parse(stored.descriptor.content);
  expect(packet.cells).toBe(40_000);
  expect(descriptor.reviews[0].rowFiles.length).toBeGreaterThan(1);
  expect([...stored.parts, stored.descriptor].every(file => Buffer.byteLength(file.content) < 4_000_000)).toBe(true);
  expect([...stored.parts, stored.descriptor].every(file => Buffer.byteLength(JSON.stringify(file)) < 5_000_000)).toBe(true);
  const rows = stored.parts.filter(file => descriptor.reviews[0].rowFiles.includes(file.path)).flatMap(file => JSON.parse(file.content));
  expect(rows).toHaveLength(5000);
  expect(rows.reduce((sum, row) => sum + row.answers.length, 0)).toBe(40_000);
});

test("stale evidence and missing cells remain open, with distinct-document counts", () => {
  const review = fixture();
  if (review.cells[1].result) review.cells[1].result.sourceHash = "old";
  review.cells.pop();
  const packet = reviewReportData([review], [{ document: "room/1.pdf", title: "Old evidence", sourceHash: "old", evidenceFiles: ["old.json"] }]);
  expect(packet.openCells).toBe(3);
  expect(packet.openDocuments).toBe(3);
  expect(packet.sources[1].evidenceFiles).toHaveLength(0);
  expect(packet.reviews[0].distribution[0].values).toHaveLength(0);
  expect(packet.reviews[0].unresolved[2].status).toBe("pending");
});

test("same source in multiple reviews is one source reference and one affected document", () => {
  const review = fixture(1), second = { ...review, id: "ad421fb4-3f23-49e3-a5a2-01a2f3cd9911" };
  const packet = reviewReportData([review, second], []);
  expect(packet.distinctDocuments).toBe(1);
  expect(packet.reviewedRows).toBe(2);
  expect(packet.openCells).toBe(2);
  expect(packet.openDocuments).toBe(1);
  expect(packet.sources).toHaveLength(1);
});

test("template count bindings fill measured values without assembling code", () => {
  const packet = reviewReportData([fixture()], []);
  const draft = reportDraftData(packet, ReportTemplateFieldsSchema.parse({ tokens: ["executive_summary", "reviewed_files", "customer_open", "sev"],
    repeat_tables: { executive: ["sev"] }, count_bindings: { reviewed_files: { metric: "documents" }, customer_open: { reviewName: "Customers", metric: "openDocuments" } } }));
  expect(draft.fields).toEqual({ executive_summary: "", reviewed_files: 3, customer_open: 1 });
  expect(draft.measuredFields).toEqual({ reviewed_files: 3, customer_open: 1 });
});

test("class counts use native library identity despite custom review names and deduplicate split classes", () => {
  const review = fixture(), second = fixture(2);
  review.name = "Customer Agreements Review";
  second.name = "Another customer batch";
  second.id = "ad421fb4-3f23-49e3-a5a2-01a2f3cd9911";
  second.documents[1].path = "room/extra.pdf";
  for (const item of [review, second]) item.columns[0].libraryId = "customers-library";
  const packet = reviewReportData([review, second], [], new Map([["customers-library", "Customers"]]));
  const fields = reportDraftData(packet, ReportTemplateFieldsSchema.parse({
    tokens: ["rows", "open", "cells", "open_cells", "absent_rows"], repeat_tables: {}, count_bindings: {
      rows: { reviewName: "Customers", metric: "documents" }, open: { reviewName: "Customers", metric: "openDocuments" },
      cells: { reviewName: "Customers", metric: "cells" }, open_cells: { reviewName: "Customers", metric: "openCells" },
      absent_rows: { reviewName: "Absent class", metric: "documents" },
    },
  })).fields;
  expect(fields).toEqual({ rows: 4, open: 1, cells: 5, open_cells: 2, absent_rows: 0 });
});

test("unmapped report classes fail instead of silently recording zero scope", () => {
  const packet = reviewReportData([fixture()], []);
  expect(() => reportDraftData(packet, ReportTemplateFieldsSchema.parse({
    tokens: ["rows"], repeat_tables: {}, count_bindings: { rows: { reviewName: "Wrong class", metric: "documents" } },
  }))).toThrow("No report count binding");
});

test("a new snapshot cannot overwrite parts referenced by the previous packet", () => {
  const review = fixture(), old = reportPacketFiles(reviewReportData([review], []), {}, "reports/data");
  review.revision++;
  const next = reportPacketFiles(reviewReportData([review], []), {}, "reports/data");
  expect(next.descriptor.path).toBe(old.descriptor.path);
  expect(next.parts.some(file => old.parts.some(previous => previous.path === file.path))).toBe(false);
});

test("refreshed evidence metadata cannot alter existing parts for the same review revision", () => {
  const review = fixture(), previous = reportPacketFiles(reviewReportData([review], []), {}, "reports/data");
  const next = reportPacketFiles(reviewReportData([review], [{
    document: "room/1.pdf", title: "Refreshed source title", sourceHash: "h1", evidenceFiles: ["evidence/1.json"],
  }]), {}, "reports/data");
  for (const file of next.parts) {
    const existing = previous.parts.find(part => part.path === file.path);
    if (existing) expect(file.content).toBe(existing.content);
  }
  expect(JSON.parse(next.descriptor.content).sourceFiles).not.toEqual(JSON.parse(previous.descriptor.content).sourceFiles);
});

test("source reading aids preserve literal text/pages and explicitly disclose omitted records", () => {
  const packet = reviewReportData([fixture()], []);
  const text = reportSourceText(packet.sources.map(source => ({ source, evidence: [{ document: source.document, sourceHash: source.sourceHash ?? "",
    passages: [{ page: 2, text: "Literal contractual language ".repeat(100) }] }] })), 3500);
  expect(text).toContain("Page 2:");
  expect(text).toContain("Literal contractual language");
  expect(text).toContain("Sources omitted from this bounded reading aid: 2");
  expect(text.length).toBeLessThan(4000);
});

test("running, empty or malformed review snapshots cannot claim report coverage", () => {
  expect(() => reviewReportData([{ ...fixture(), status: "running" }], [])).toThrow("Wait");
  expect(() => reviewReportData([{ ...fixture(), documents: [] }], [])).toThrow("nonempty");
  const review = fixture(); review.cells.push(review.cells[0]);
  expect(() => reviewReportData([review], [])).toThrow("snapshot");
});
