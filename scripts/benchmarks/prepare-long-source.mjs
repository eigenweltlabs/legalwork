import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateWrite, sha256 } from "./evidence.mjs";

/** Prepare once on the controller, then use the same frozen suite in both arms.
 * Only copyFiles source bytes enter the agent's guest; suite/expectations stay out. */
export async function prepareLongSource(output) {
  const root = resolve(output);
  await mkdir(root, { mode: 0o700 });
  const lines = [
    "SYNTHETIC AGREEMENT ARCHIVE — no real client or personal data.",
    "Counterparty: Nordhafen Synthetic Distribution GmbH.",
    "MASTER-2024, signed 2024-02-01, effective 2024-03-01.",
    "Clause 7: Renewal requires 30 calendar days' notice.",
    "Governing law: England and Wales.",
    "The archive below includes non-operative logistics records and signed amendments.",
    "Logistics records do not change contractual obligations. A later effective signed amendment prevails over an earlier notice clause.",
  ];
  for (let index = 1; index <= 14000; index++) {
    lines.push(`LOGISTICS-RECORD-${String(index).padStart(5, "0")}: synthetic delivery reconciliation; sealed crate received and archived. This administrative record changes no contractual notice obligation and contains no amendment.`);
    if (index === 6000) lines.push(
      "AMENDMENT-2025-A, signed 2025-04-15, effective 2025-05-01.",
      "Clause 1: Replace the master's renewal notice with 45 calendar days. All other terms remain unchanged.",
      "Signed by both parties; end of AMENDMENT-2025-A.",
    );
  }
  const quote = "With effect from 1 October 2026, the renewal notice period is 75 calendar days; this replaces the notice periods in MASTER-2024 and AMENDMENT-2025-A.";
  const endRecord = "LW-LONG-SOURCE-END-6d03e4a9";
  lines.push(
    "AMENDMENT-2026-B, signed 2026-09-15, effective 2026-10-01.",
    `Clause 2: ${quote}`,
    "Clause 3: All other terms remain unchanged.",
    "Signed by both parties; end of AMENDMENT-2026-B.",
    `Archive verification record: ${endRecord}`,
  );
  const bytes = Buffer.from(`${lines.join("\n")}\n`);
  const source = join(root, "source-only", "agreement-archive.txt");
  await privateWrite(source, bytes);
  const expected = {
    counterparty: "Nordhafen Synthetic Distribution GmbH",
    as_of: "2026-10-24",
    notice_days: 75,
    superseded_notice_days: [30, 45],
    governing_law: "England and Wales",
    controlling_document: "AMENDMENT-2026-B",
    controlling_clause: "Clause 2",
    source_quote: quote,
    archive_verification_record: endRecord,
  };
  const suite = {
    id: "legalwork-long-source-v1",
    model: { providerID: "benchmark", modelID: "Eigenwelt Europe Gemini", backendModel: "gemini-3.8-flash", variant: "medium" },
    interactionPolicy: { mode: "autonomous", expectedPermissions: [], expectedForms: [] },
    coverage: {
      implemented: ["runnable complete-source chronological amendment fixture and substantive artifact assertions"],
      pending: ["real Electron and model execution in both isolated arms", "long MCP result retrieval", "other acceptance-register scenarios"],
    },
    tasks: [{
      id: "long-source-amendment-chronology",
      source: { kind: "synthetic", name: "agreement-archive.txt", bytes: bytes.length, sha256: sha256(bytes) },
      copyFiles: [{ from: source, to: "agreement-archive.txt" }],
      prompt: "Review the entire supplied agreement archive and all its signed amendments. Determine the renewal notice obligation in force on 2026-10-24, explaining which earlier notice periods were superseded. Use only this source. Save notice-review.json in the task folder with these keys: counterparty, as_of (ISO date), notice_days (integer), superseded_notice_days (integers in chronological order), governing_law, controlling_document (its exact ID), controlling_clause, source_quote (the exact complete operative sentence without the clause label), archive_verification_record (the archive's verification ID). Do not change the source. Report the saved file when complete.",
      artifacts: ["notice-review.json"],
      assertions: [
        { id: "completed-without-engine-error", type: "agent.no_error" },
        { id: "controlling-amendment-and-complete-source-evidence", type: "artifact.json", path: "notice-review.json", equals: expected },
        { id: "original-source-bytes-unchanged", type: "artifact.sha256", path: "agreement-archive.txt", equals: sha256(bytes) },
      ],
    }],
  };
  await privateWrite(join(root, "suite.json"), suite);
  await privateWrite(join(root, "source-provenance.json"), {
    kind: "synthetic-long-source-fixture",
    source: suite.tasks[0].source,
    lines: lines.length,
    controllingClauseByteOffset: bytes.indexOf(Buffer.from(`Clause 2: ${quote}`)),
    agentInputs: ["source-only/agreement-archive.txt"],
    controllerOnly: ["suite.json", "source-provenance.json"],
    inferenceCalls: 0,
    note: "No source/output/token/tool/task limit is configured. Do not copy controller files or generator code into the agent guest.",
  });
  return { suite, suitePath: join(root, "suite.json"), source, bytes: bytes.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--output");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--output <NEW-controller-only-directory> is required");
  const prepared = await prepareLongSource(process.argv[index + 1]);
  console.log(JSON.stringify({ suite: prepared.suitePath, source: prepared.source, bytes: prepared.bytes, inferenceCalls: 0 }));
}
