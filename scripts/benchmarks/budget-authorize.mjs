import { open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyReviewedBudgetCeiling } from "./budget-guard.mjs";
import { approvedBudgetCeilingAuthorizationSha256, verifyBudgetCeilingAuthorization } from "./budget-ceiling.mjs";
import { sha256 } from "./budget-reconciliation.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));

export async function runReviewedBudgetAuthorization(argv) {
  const values = {};
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === "--apply" && !apply) { apply = true; continue; }
    if (!["--authorization", "--ledger", "--output", "--backup", "--expected-ledger-sha256"].includes(name)
      || values[name] !== undefined || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error("Unknown, duplicate or incomplete budget authorization option");
    }
    values[name] = argv[++index];
  }
  for (const name of ["--authorization", "--ledger", "--output"]) {
    if (!isAbsolute(values[name] ?? "")) throw new Error("Absolute authorization, ledger and output paths are required");
  }
  if (apply && !/^[a-f0-9]{64}$/.test(values["--expected-ledger-sha256"] ?? "")) throw new Error("Apply requires the reviewed quiescent ledger SHA256");
  if (apply && !isAbsolute(values["--backup"] ?? "")) throw new Error("Apply requires a new absolute private backup path");
  const output = resolve(values["--output"]);
  const relation = relative(repository, output);
  if (relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))) throw new Error("Keep authorization receipts outside Git");
  const file = await open(output, "wx", 0o600);
  try {
    const evidence = await verifyBudgetCeilingAuthorization({ authorizationPath: values["--authorization"] });
    const result = await applyReviewedBudgetCeiling({ ledgerPath: values["--ledger"], evidence, apply,
      expectedLedgerSha256: values["--expected-ledger-sha256"], backupPath: values["--backup"] });
    const receipt = { createdAt: new Date().toISOString(), authorizationSha256: approvedBudgetCeilingAuthorizationSha256,
      sourceSha256: Object.fromEntries(await Promise.all(["budget-guard.mjs", "budget-ceiling.mjs", "budget-authorize.mjs", "budget-scope.mjs", "budget-reconciliation.mjs"]
        .map(async name => [name, sha256(await readFile(new URL(name, import.meta.url)))]))), result };
    const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
    await file.writeFile(bytes); await file.sync();
    const parent = await open(dirname(output), "r");
    try { await parent.sync(); } finally { await parent.close(); }
    return { path: output, sha256: sha256(bytes), ...result };
  } finally { await file.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runReviewedBudgetAuthorization(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`Budget authorization operation failed; no model or cloud request was made. ${error.message}\n`); process.exitCode = 1; }
}
