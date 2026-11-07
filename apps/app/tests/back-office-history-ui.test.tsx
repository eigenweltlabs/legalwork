import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "twenty-ui/theme";
import { HistoryEntries } from "../src/react-app/domains/back-office/history-panel";
import {
  BackOfficeFieldSchema,
  BackOfficeHistoryItemSchema,
  BackOfficeStoredRecordSchema,
} from "@legalwork/types/back-office";
import {
  newBackOfficeAuditKey,
  newBackOfficeAuditNonce,
  signBackOfficeAudit,
} from "../../server/src/back-office/audit-integrity";

function item() {
  const id = crypto.randomUUID(),
    streamId = crypto.randomUUID();
  const record = BackOfficeStoredRecordSchema.parse({
    id,
    objectId: "companies",
    values: { name: "Previous company name" },
    revision: 1,
    schemaRevision: 2,
    ownerId: "lawyer-a",
    createdAt: "2026-11-07T09:00:00.000Z",
    updatedAt: "2026-11-07T09:00:00.000Z",
    archivedAt: null,
  });
  const json = (value: unknown) => JSON.parse(JSON.stringify(value));
  const entry = signBackOfficeAudit(
    {
      version: 2,
      payloadNonce: newBackOfficeAuditNonce(),
      beforeNonce: newBackOfficeAuditNonce(),
      afterNonce: newBackOfficeAuditNonce(),
      streamId,
      sequence: 1,
      eventId: crypto.randomUUID(),
      recordedAt: "2026-11-07T10:00:00.000Z",
      scope: "local",
      actor: {
        id: "lawyer-a",
        name: "Maria Baumann",
        kind: "user",
        identitySource: "account-cache",
        deviceId: crypto.randomUUID(),
        agentId: null,
      },
      action: "record.update",
      entityType: "record",
      entityId: id,
      modelRevision: 2,
      before: json(record),
      after: json({
        ...record,
        values: { name: "Current company name" },
        revision: 2,
      }),
    },
    "0".repeat(64),
    newBackOfficeAuditKey(),
  );
  const field = BackOfficeFieldSchema.parse({
    id: "name",
    label: "Historical field label",
    type: "text",
    required: true,
  });
  return BackOfficeHistoryItemSchema.parse({
    eventId: entry.payload.eventId,
    entityType: "record",
    entityId: id,
    recordedAt: entry.payload.recordedAt,
    actor: entry.payload.actor,
    action: entry.payload.action,
    modelRevision: 2,
    before: entry.payload.before,
    after: entry.payload.after,
    beforeFields: [field],
    afterFields: [field],
    redacted: false,
    payload: entry.payload,
    proof: entry.proof,
  });
}

test("history renders the original field label, author and before/after values with Twenty components", () => {
  const entry = item();
  const html = renderToStaticMarkup(
    <ThemeProvider colorScheme="dark">
      <HistoryEntries
        items={[entry]}
        records={[]}
        userId="lawyer-b"
        onOpen={() => {}}
      />
    </ThemeProvider>,
  );
  expect(html).toContain("Maria Baumann");
  expect(html).toContain("Historical field label");
  expect(html).toContain("Previous company name");
  expect(html).toContain("Current company name");
  expect(html).toContain('aria-label="Before"');
  expect(html).not.toContain(entry.proof.hash);
});

test("the history renderer never renders a raw payload in place of the redacted display", () => {
  const entry = item();
  entry.payload!.after = JSON.parse(
    JSON.stringify({ privateValue: "Hidden raw evidence" }),
  );
  entry.redacted = true;
  const html = renderToStaticMarkup(
    <ThemeProvider colorScheme="light">
      <HistoryEntries
        items={[entry]}
        records={[]}
        userId="lawyer-b"
        onOpen={() => {}}
      />
    </ThemeProvider>,
  );
  expect(html).not.toContain("Hidden raw evidence");
  expect(html).toContain("Some original details are hidden or unavailable.");
});
