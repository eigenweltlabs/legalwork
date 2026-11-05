import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileReviewedBudgetLedger } from "./budget-guard.mjs";
import { approvedHistoricalReconciliation, sha256, verifyBudgetReconciliation } from "./budget-reconciliation.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));

export async function runReviewedReconciliation(argv) {
  const values = {};
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--apply" && !apply) { apply = true; continue; }
    if (!["--receipt", "--review", "--ledger", "--output", "--expected-ledger-sha256"].includes(name)
      || values[name] !== undefined || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error("Unknown, duplicate or incomplete reconciliation option");
    }
    values[name] = argv[++index];
  }
  for (const name of ["--receipt", "--review", "--ledger", "--output"]) {
    if (!isAbsolute(values[name] ?? "")) throw new Error("Absolute receipt, review, ledger and output paths are required");
  }
  if (apply && !/^[a-f0-9]{64}$/.test(values["--expected-ledger-sha256"] ?? "")) throw new Error("Apply requires the reviewed quiescent ledger SHA256");
  const output = resolve(values["--output"]);
  const relation = relative(repository, output);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) throw new Error("Keep accounting receipts outside Git");
  // Reserve a new receipt before an apply. Existing receipts are never overwritten.
  const file = await open(output, "wx", 0o600);
  try {
    const evidence = await verifyBudgetReconciliation({ receiptPath: values["--receipt"], reviewPath: values["--review"] });
    const result = await reconcileReviewedBudgetLedger({ ledgerPath: values["--ledger"], evidence, apply,
      expectedLedgerSha256: values["--expected-ledger-sha256"] });
    const receipt = { createdAt: new Date().toISOString(), approvedEvidence: approvedHistoricalReconciliation,
      sourceSha256: Object.fromEntries(await Promise.all(["budget-guard.mjs", "budget-reconciliation.mjs", "budget-reconcile.mjs"]
        .map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))]))),
      ledgerAfterSha256: result.ledgerAfterSha256, result };
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
    await file.writeFile(bytes); await file.sync();
    const parent = await open(dirname(output), "r");
    try { await parent.sync(); } finally { await parent.close(); }
    return { path: output, sha256: sha256(bytes), ...result };
  } finally { await file.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runReviewedReconciliation(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`Reviewed reconciliation failed; no key or inference request was made. ${error.message}\n`); process.exitCode = 1; }
}
