// Run with Bun from the repository root. Only disposable files are registered.
import { mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer } from "../src/server";

const root = await mkdtemp(join(tmpdir(), "legalwork-document-validation-"));
for (const key of ["LEGALWORK_STORAGE_STORE", "LEGALWORK_TOKEN_STORE", "LEGALWORK_RUNTIME_DB", "LEGALWORK_ENV_STORE", "LEGALWORK_DATA_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"])
  process.env[key] = join(root, key);
for (const name of ["Agreement.docx", "Precedent.docx"])
  await copyFile(resolve("apps/app/scripts/fixtures/legal-review.docx"), join(root, name));
const server = await startServer({
  host: "127.0.0.1", port: 5175, token: "document-validation-client", hostToken: "document-validation-owner",
  configPath: join(root, "config.json"), approval: { mode: "auto", timeoutMs: 1000 },
  corsOrigins: ["http://localhost:5174", "http://127.0.0.1:5174"],
  workspaces: [{ id: "document-validation", name: "Document validation", path: root, preset: "default", workspaceType: "local" }],
  authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
});
console.log(JSON.stringify({ root, port: server.port }));
