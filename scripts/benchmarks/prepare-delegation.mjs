// Freeze on the controller; transfer only source-only files to a clean guest.
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { privateWrite, sha256 } from "./evidence.mjs";

export async function prepareDelegation(output) {
  const root = resolve(output);
  await mkdir(root, { mode: 0o700 });
  const noticeQuote = "The renewal notice period is 45 calendar days before the current term ends, replacing the notice periods in MASTER-2025 section 4 and AMENDMENT-2025-A section 2.";
  const dataQuote = "For liability arising from a personal-data security incident, the aggregate cap is twice the fees paid or payable in the preceding twelve months; this specific cap prevails over the general liability cap.";
  const sources = {
    "master-agreement.txt": `SYNTHETIC CONTRACT PACK — no real client or personal data.
MASTER-2025. Signed by Nordfeld Synthetic Operations GmbH (Customer) and Alpenstern Synthetic Services GmbH (Supplier) on 2025-01-10.
Section 1. The services term ends on 2026-12-31 and renews for a further twelve months unless either party gives valid timely non-renewal notice.
Section 4. Non-renewal requires 90 calendar days' notice. Notices must be delivered by registered post.
Section 8. General aggregate liability is capped at EUR 100,000. Neither party is liable for indirect or consequential loss. The cap and exclusion do not apply to wilful misconduct.
Section 11. A later signed amendment prevails over an earlier signed amendment and this agreement to the extent of an inconsistency. The data processing addendum prevails on personal-data obligations and their specific liability allocation. Terms not expressly amended remain in force.
`,
    "amendment-a.txt": `SYNTHETIC CONTRACT PACK.
AMENDMENT-2025-A. Signed by both parties on 2025-05-06, effective that day.
Section 2. Replace MASTER-2025 section 4's notice period with 60 calendar days. The delivery method is unchanged.
Section 3. Replace MASTER-2025 section 8's EUR 100,000 general aggregate cap with the fees paid or payable in the preceding twelve months. The exclusion of indirect or consequential loss and the wilful-misconduct exception remain unchanged.
Section 5. All other terms remain unchanged.
`,
    "amendment-b.txt": `SYNTHETIC CONTRACT PACK.
AMENDMENT-2026-B. Signed by both parties on 2026-01-08, effective that day.
Section 2. ${noticeQuote}
Section 3. A non-renewal notice may also be sent by email to notices@alpenstern.example. It must be received at that address no later than 17:00 Europe/Berlin on the last permitted notice day. Registered post remains an alternative. The current term still ends on 2026-12-31.
Section 4. This amendment does not change AMENDMENT-2025-A section 3 or DPA-2025 section 9. All other terms remain unchanged.
`,
    "data-processing-addendum.txt": `SYNTHETIC CONTRACT PACK.
DPA-2025. Signed by both parties on 2025-05-06, effective that day.
Section 6. The Supplier must notify the Customer of a personal-data security incident without undue delay and in any event within 24 hours after awareness, and provide reasonable investigation and remediation cooperation. This is a contractual supplier-to-customer deadline, not a statement of any statutory reporting deadline.
Section 9. ${dataQuote} The wilful-misconduct exception remains uncapped. The master agreement's indirect/consequential-loss exclusion remains unchanged. No other category is made uncapped by this addendum.
`,
    "business-instruction.txt": `SYNTHETIC BUSINESS INSTRUCTION.
INSTRUCTION-2026-11-15. Assessment date: 2026-11-15. The Customer wants to prevent the next automatic renewal and has not yet served a non-renewal notice.
Section 2. Fees paid or payable in the relevant preceding twelve months total EUR 240,000. Assume that fee figure applies to both contractual cap calculations; do not substitute the total lifetime contract value.
Section 3. The team proposes sending email notice on 2026-11-17. No waiver or deadline extension has been agreed. Assume the designated mailbox operates normally; flag the receipt requirement rather than assuming a send timestamp proves receipt.
Section 4. For planning, assess EUR 500,000 of otherwise recoverable direct loss from a personal-data security incident with no wilful misconduct. Do not assume that this planning amount is an admission or that all loss is legally recoverable.
Section 5. Save an integrated decision memo and a compact decision record. Do not send any notice or contact either party.
`,
  };
  const files = [];
  for (const [name, text] of Object.entries(sources)) {
    const bytes = Buffer.from(text), path = join(root, "source-only", name);
    await privateWrite(path, bytes);
    files.push({ name, path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const expected = {
    as_of: "2026-11-15", notice_days: 45, notice_deadline: "2026-11-16", proposed_notice_is_timely: false,
    email_recipient: "notices@alpenstern.example", receipt_cutoff_local: "17:00 Europe/Berlin",
    ordinary_cap_eur: 240000, data_incident_cap_eur: 480000, planning_loss_above_data_cap_eur: 20000,
    incident_notification_hours: 24, uncapped_exception: "wilful misconduct",
    controlling_notice: "AMENDMENT-2026-B section 2", controlling_general_cap: "AMENDMENT-2025-A section 3",
    controlling_data_cap: "DPA-2025 section 9", notice_quote: noticeQuote, data_cap_quote: dataQuote,
  };
  const suite = {
    id: "legalwork-delegated-contract-decision-paired-ui-deny-v1",
    model: { providerID: "benchmark", modelID: "Eigenwelt Europe Gemini", backendModel: "gemini-3.8-flash", variant: "medium" },
    interactionPolicy: { mode: "scripted-external-directory-decline", expectedPermissions: [], expectedForms: [], outsideTaskFolder: "reject", otherRequests: "hold" },
    catalogPolicy: "record-and-lock-observed",
    coverage: { implemented: ["controller-only paired delegation fixture and actual distinct-child criterion"],
      pending: ["real Electron/model delegation in both isolated arms", "Claude legal case", "Harvey and lifecycle/context acceptance rows"] },
    tasks: [{ id: "delegated-contract-decision", source: { kind: "synthetic", files: files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) },
      copyFiles: files.map(file => ({ from: file.path, to: file.name })),
      prompt: "Review the supplied synthetic contract pack as of the dated business instruction. Have two independent delegated reviewers work separately: one on renewal and valid notice timing, the other on liability and personal-data obligations. Then integrate their findings into board-note.md, with exact document/section citations, supported calculations, the practical decision required now, and any assumptions. Use only the supplied sources. Save decision.json with these keys: as_of (ISO date), notice_days, notice_deadline (ISO date), proposed_notice_is_timely (boolean), email_recipient, receipt_cutoff_local, ordinary_cap_eur, data_incident_cap_eur, planning_loss_above_data_cap_eur, incident_notification_hours, uncapped_exception, controlling_notice, controlling_general_cap, controlling_data_cap, notice_quote (the complete operative notice-period sentence), data_cap_quote (the complete operative specific-cap sentence). The controlling fields should use the exact document ID followed by its section number. Explain how the later instruments affect the earlier ones and distinguish contractual reporting from statutory obligations. Do not change the sources, send notices or contact anyone. Report the saved artifacts when complete.",
      artifacts: ["board-note.md", "decision.json"],
      assertions: [
        { id: "completed-without-owned-model-error", type: "agent.no_error", scope: "subtree" },
        { id: "two-distinct-completed-delegated-reviews", type: "capability.delegation", scope: "subtree", minimumDirectChildren: 2 },
        { id: "integrated-decision-facts-calculations-and-exact-operative-quotes", type: "artifact.json", path: "decision.json", equals: expected },
        { id: "integrated-memo-controlling-citations-and-exception", type: "artifact.text", path: "board-note.md",
          includes: ["AMENDMENT-2026-B", "section 2", "AMENDMENT-2025-A", "section 3", "DPA-2025", "section 9", "wilful misconduct"] },
        ...files.map(file => ({ id: `unchanged-${file.name}`, type: "artifact.sha256", path: file.name, equals: file.sha256 })),
      ],
    }],
  };
  // These ordinary numeric/date facts are controller assertions, never guest
  // fixtures. The evaluator is not a substitute for a cited legal review.
  await privateWrite(join(root, "suite.json"), suite);
  await privateWrite(join(root, "source-provenance.json"), { kind: "synthetic-two-workstream-contract-pack", sourceFiles: files,
    agentInputs: files.map(file => `source-only/${file.name}`), controllerOnly: ["suite.json", "source-provenance.json", "generator and assertion code"],
    legalReviewRequired: ["independent child findings address distinct workstreams", "memo reconciles chronology and specific/general caps",
      "receipt by cutoff, untimely proposal, unchanged indirect-loss exclusion, wilful exception and contractual-not-statutory deadline are explained",
      "planning loss is qualified; no notice was sent"],
    status: "prepared-not-real-agent-executed", modelCalls: 0 });
  return { root, suite, suitePath: join(root, "suite.json"), files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--output");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--output <NEW-controller-only-directory> is required");
  const prepared = await prepareDelegation(process.argv[index + 1]);
  console.log(JSON.stringify({ suite: prepared.suitePath, sourceFiles: prepared.files.length, modelCalls: 0 }));
}
