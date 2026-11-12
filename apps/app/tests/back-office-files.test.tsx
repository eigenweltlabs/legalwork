import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  BackOfficeFieldSchema,
  BackOfficeFileSchema,
  BackOfficeRecordSchema,
} from "@legalwork/types/back-office";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { ValueDisplay } from "../src/react-app/domains/back-office/record-values";
import { CellEditor } from "../src/react-app/domains/back-office/cell-editor";
import { RecordFilesProvider } from "../src/react-app/domains/back-office/record-files";
const field = BackOfficeFieldSchema.parse({
  id: "invoiceFile",
  label: "Invoice PDF",
  type: "file",
});
const now = new Date().toISOString();
const record = BackOfficeRecordSchema.parse({
  id: crypto.randomUUID(),
  objectId: "invoices",
  values: { name: "Invoice" },
  revision: 1,
  schemaRevision: 1,
  ownerId: "owner",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
});
const file = BackOfficeFileSchema.parse({
  id: crypto.randomUUID(),
  recordId: record.id,
  fieldId: field.id,
  name: "Invoice <final>.pdf",
  size: 20,
  sha256: "a".repeat(64),
  contentType: "application/pdf",
});

test("file values display escaped filenames instead of metadata or a local path", () => {
  const html = renderToStaticMarkup(
    <ValueDisplay
      field={field}
      value={[file]}
      records={[]}
      onOpen={() => {}}
    />,
  );
  expect(html).toContain("Invoice &lt;final&gt;.pdf");
  expect(html).not.toContain("[object Object]");
  expect(html).not.toContain(file.sha256);
  expect(html).not.toContain(file.recordId);
});
test("file editing offers upload and project copies with clear access and immutability semantics", () => {
  const client = createLegalworkServerClient({
    baseUrl: "http://fixture.invalid",
    token: "fixture",
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RecordFilesProvider client={client} records={[record]} projects={[]}>
        <CellEditor
          record={record}
          field={field}
          value={[]}
          records={[]}
          onSave={async () => {}}
          onCancel={() => {}}
        />
      </RecordFilesProvider>
    </QueryClientProvider>,
  );
  expect(html).toContain('type="file"');
  expect(html).toContain("Attach a copy");
  expect(html).toContain("Choose from a project");
  expect(html).toContain("Access follows this record and field");
  expect(html).not.toContain('type="text"');
});
