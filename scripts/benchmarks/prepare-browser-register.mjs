import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { privateWrite } from "./private-write.mjs";
import { REGISTER_URL, registerRows, registerEntity, registerAgreement, registerAsOf, makeRegisterPdf } from "./browser-register-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export async function prepareBrowserRegister(output) {
  const root = resolve(output); await mkdir(root, { mode: 0o700 });
  const files = [];
  for (const row of registerRows) {
    const bytes = await makeRegisterPdf(row); await privateWrite(join(root, "site-documents", `${row.id}.pdf`), bytes);
    files.push({ rowID: row.id, bytes: bytes.length, sha256: hash(bytes), filename: `${row.id}-executed-storage-amendment.pdf` });
  }
  await privateWrite(join(root, "site-source.json"), registerRows);
  const selected = registerRows.find(row => row.id === "REG-2026-27"), document = files.find(file => file.rowID === selected.id);
  const suite = {
    id: "legalwork-browser-register-v1",
    model: { providerID: "benchmark", modelID: "Eigenwelt Europe Gemini", backendModel: "gemini-3.8-flash", variant: "medium" },
    interactionPolicy: { mode: "autonomous", expectedPermissions: [], expectedForms: [] },
    coverage: { implemented: ["synthetic register with real filters, signed chronology, attachment and substantive assertions"], pending: ["actual both-engine Electron/model execution", "separate denied-navigation policy test"] },
    tasks: [{ id: "browser-register-operative-amendment", source: { kind: "synthetic-browser-register", url: REGISTER_URL, documents: files },
      browserFixture: { directory: root, url: REGISTER_URL },
      prompt: `Use LegalWork's built-in browser to visit ${REGISTER_URL}. Filter the register for ${registerEntity}, ${registerAgreement}, executed documents and documents in force on ${registerAsOf}. Open the latest executed amendment effective on that date and download its attachment using the browser. Keep the original browser download and save an unchanged byte-for-byte copy as browser-source.pdf in the task folder. Read the attachment and save browser-review.json with keys: entity, agreement, as_of (ISO date), controlling_record (exact register ID), signed_date (ISO date), effective_date (ISO date), notice_days (integer), annual_increase_cap_percent (number), cap_exception_quote (the complete exact sentence in clause 3, without its label), attachment_sha256 (SHA256 of the complete original PDF). Distinguish unsigned drafts, a later signed amendment that is not yet effective, and a similarly named company. Use only this website and its attachments. Report the saved files when complete.`,
      artifacts: ["browser-source.pdf", "browser-review.json"],
      assertions: [
        { id: "completed-without-engine-error", type: "agent.no_error", scope: "subtree" },
        { id: "full-original-browser-download", type: "artifact.sha256", path: "browser-source.pdf", equals: document.sha256 },
        { id: "operative-amendment-and-exact-exception", type: "artifact.json", path: "browser-review.json", equals: { entity: registerEntity, agreement: registerAgreement, as_of: registerAsOf, controlling_record: selected.id, signed_date: selected.signed, effective_date: selected.effective, notice_days: selected.notice, annual_increase_cap_percent: selected.cap, cap_exception_quote: selected.exception, attachment_sha256: document.sha256 } },
        { id: "actual-owned-browser-filter-select-download", type: "capability.browser_register", scope: "subtree", url: REGISTER_URL, entity: registerEntity, agreement: registerAgreement, asOf: registerAsOf, rowID: selected.id, filename: document.filename, bytes: document.bytes, sha256: document.sha256 },
      ],
    }],
  };
  await privateWrite(join(root, "suite.json"), suite);
  await privateWrite(join(root, "source-provenance.json"), { kind: "synthetic-browser-register", documents: files, guestFiles: [],
    guestAccess: ["ordinary website and attachment responses", "task prompt"], controllerOnly: ["generator/server code", "suite and expectations", "request/response traces", "site-source.json and site-documents"],
    deterministicPDFMetadata: "2026-10-24T00:00:00Z", inferenceCalls: 0, status: "prepared-not-real-agent-executed",
    note: "No tool/output/token/task cap is introduced. The separate blocked-navigation test remains unimplemented and must not be claimed as covered." });
  return { root, suite, suitePath: join(root, "suite.json"), documents: files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--output");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--output <NEW-controller-only-directory> is required");
  const result = await prepareBrowserRegister(process.argv[index + 1]);
  console.log(JSON.stringify({ suite: result.suitePath, documents: result.documents, inferenceCalls: 0 }));
}
