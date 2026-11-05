import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateWrite, sha256 } from "./evidence.mjs";

export const LONG_MCP_CONNECTOR = "benchmark_long_mcp";
export const LONG_MCP_TOOL = "fetch_agreement_archive";
export const LONG_MCP_URL = "http://127.0.0.1:39182/mcp";

// Controller only. Neither this generator nor its expectations enter the guest.
export async function prepareLongMcp(output) {
  const root = resolve(output);
  await mkdir(root, { mode: 0o700 });
  const matter = "MTR-SYNTHETIC-2026-1042";
  const quote = "With effect from 1 October 2026, the renewal notice period is 75 calendar days; this replaces the notice periods in MASTER-2024 and AMENDMENT-2025-A.";
  const records = [];
  for (let index = 1; index <= 7000; index++) {
    records.push({
      kind: "administrative_record",
      record_id: `LOGISTICS-${String(index).padStart(5, "0")}`,
      text: "Synthetic sealed-crate reconciliation: the delivery reference has been checked against the dispatch register and archived. This administrative record does not amend the agreement or any contractual notice obligation.",
    });
    if (index === 2500) records.push({
      kind: "signed_amendment", document_id: "AMENDMENT-2025-A", signed: "2025-04-15", effective: "2025-05-01",
      signed_by_both_parties: true, clause: "Clause 1",
      text: "The renewal notice period is 45 calendar days with effect from 1 May 2025. This replaces the 30-day notice period in MASTER-2024; all other terms remain unchanged.",
    });
  }
  records.push(
    { kind: "signed_amendment", document_id: "AMENDMENT-2026-B", signed: "2026-09-15", effective: "2026-10-01", signed_by_both_parties: true, clause: "Clause 2", text: quote },
    { kind: "signed_amendment", document_id: "AMENDMENT-2026-C", signed: "2026-10-20", effective: "2027-01-01", signed_by_both_parties: true, clause: "Clause 1", text: "The renewal notice period becomes 90 calendar days with effect from 1 January 2027. Until that effective date, AMENDMENT-2026-B remains operative." },
    { kind: "archive_receipt", record_id: "LW-MCP-ARCHIVE-END-819f2c6a", text: "Synthetic custody receipt: the signed master and amendments listed in this archive are the complete supplied contractual record." },
  );
  const archive = {
    archive_id: "LW-MCP-NORDHAFEN-2026-ARCHIVE", matter_id: matter,
    counterparty: "Nordhafen Synthetic Distribution GmbH", governing_law: "England and Wales",
    master: { document_id: "MASTER-2024", signed: "2024-02-01", effective: "2024-03-01", clause: "Clause 7", text: "Renewal requires 30 calendar days' notice. Later effective signed amendments prevail over an earlier notice clause." },
    records,
  };
  const bytes = Buffer.from(JSON.stringify(archive));
  const controllingOffset = bytes.indexOf(Buffer.from(quote));
  if (controllingOffset <= 1024 * 1024) throw new Error("Fixture must place its operative tail clause beyond one MiB");
  const expected = {
    counterparty: archive.counterparty, as_of: "2026-10-24", notice_days: 75,
    superseded_notice_days: [30, 45], governing_law: archive.governing_law,
    controlling_document: "AMENDMENT-2026-B", controlling_clause: "Clause 2", source_quote: quote,
    future_document: "AMENDMENT-2026-C", future_notice_days: 90, future_effective_date: "2027-01-01",
    archive_id: archive.archive_id, matter_id: matter, archive_verification_record: "LW-MCP-ARCHIVE-END-819f2c6a",
    record_count: records.length, source_sha256: sha256(bytes),
  };
  const definition = {
    name: LONG_MCP_TOOL,
    description: "Retrieve the complete synthetic contractual archive for a matter, including its signed master, amendments and administrative records.",
    inputSchema: { type: "object", properties: { matter_id: { type: "string", const: matter } }, required: ["matter_id"], additionalProperties: false },
    outputSchema: { type: "object", properties: {
      archive_id: { type: "string" }, matter_id: { type: "string" }, counterparty: { type: "string" }, governing_law: { type: "string" },
      master: { type: "object", additionalProperties: true }, records: { type: "array", items: { type: "object", additionalProperties: true } },
    }, required: Object.keys(archive), additionalProperties: false },
  };
  const token = randomBytes(32).toString("hex");
  const connection = { type: "remote", url: LONG_MCP_URL, headers: { Authorization: `Bearer ${token}` }, enabled: true, oauth: false };
  const nativeConnection = { type: "remote", url: LONG_MCP_URL, headers: connection.headers, disabled: false, oauth: false };
  const suite = {
    id: "legalwork-long-mcp-v1",
    model: { providerID: "benchmark", modelID: "Eigenwelt Europe Gemini", backendModel: "gemini-3.8-flash", variant: "medium" },
    interactionPolicy: { mode: "autonomous", expectedPermissions: [], expectedForms: [] },
    coverage: { implemented: ["controller-only full JSON MCP archive and substantive tail/chronology/source assertions"], pending: ["real Electron and model execution in both isolated arms", "other acceptance-register scenarios"] },
    tasks: [{
      id: "long-mcp-amendment-chronology",
      source: { kind: "synthetic-mcp", connector: LONG_MCP_CONNECTOR, tool: LONG_MCP_TOOL, bytes: bytes.length, sha256: sha256(bytes) },
      prompt: `Use connector ${LONG_MCP_CONNECTOR} and its ${LONG_MCP_TOOL} tool to obtain matter ${matter}'s complete contractual archive. Review every signed amendment and determine the renewal notice obligation in force on 2026-10-24; distinguish a signed amendment whose effective date has not yet arrived. Use only this source. Save mcp-notice-review.json in the task folder with these keys: counterparty, as_of (ISO date), notice_days (integer), superseded_notice_days (integers in chronological order), governing_law, controlling_document (exact ID), controlling_clause, source_quote (exact complete operative sentence), future_document (exact ID), future_notice_days (integer), future_effective_date (ISO date), archive_id, matter_id, archive_verification_record (the final custody receipt's record ID), record_count (the complete records array length), source_sha256 (SHA256 of the complete archive's compact JSON encoding, preserving its field and record order, without a trailing newline). Retrieve and process the full result; an excerpt is insufficient. Report the saved file when complete.`,
      artifacts: ["mcp-notice-review.json"],
      assertions: [
        { id: "completed-without-engine-error", type: "agent.no_error", scope: "subtree" },
        { id: "actual-completed-archive-tool", type: "capability.mcp_tool", scope: "subtree", connector: LONG_MCP_CONNECTOR, tool: LONG_MCP_TOOL },
        { id: "complete-supported-chronology-and-source-identity", type: "artifact.json", path: "mcp-notice-review.json", equals: expected },
      ],
    }],
  };
  await privateWrite(join(root, "source-response.json"), bytes);
  await privateWrite(join(root, "tool-definition.json"), definition);
  await privateWrite(join(root, "transport.json"), { connector: LONG_MCP_CONNECTOR, url: LONG_MCP_URL, token, v1: { mcp: { [LONG_MCP_CONNECTOR]: connection } }, v2: { mcp: { servers: { [LONG_MCP_CONNECTOR]: nativeConnection } } } });
  await privateWrite(join(root, "suite.json"), suite);
  await privateWrite(join(root, "source-provenance.json"), {
    kind: "synthetic-long-mcp-fixture", source: suite.tasks[0].source, controllingClauseByteOffset: controllingOffset,
    structuredContentEqualsOriginalTextJson: true, guestFiles: [], guestAccess: ["authenticated MCP endpoint", "task prompt"],
    controllerOnly: ["source-response.json", "tool-definition.json", "transport.json", "suite.json", "source-provenance.json", "fixture server and generator code", "fixture traces"],
    inferenceCalls: 0, status: "prepared-not-real-agent-executed", note: "No request, result, token, tool or task cap is configured. Keep this entire directory on the controller.",
  });
  return { root, suite, suitePath: join(root, "suite.json"), bytes: bytes.length, sourceSha256: sha256(bytes) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--output");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--output <NEW-controller-only-directory> is required");
  const result = await prepareLongMcp(process.argv[index + 1]);
  console.log(JSON.stringify({ suite: result.suitePath, bytes: result.bytes, sourceSha256: result.sourceSha256, inferenceCalls: 0 }));
}
