import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openSqliteReadonly } from "../dist/managed-opencode-db.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("Node reads a cleanly closed WAL history without changing its database", async () => {
  assert.equal(process.versions.bun, undefined, "Exercise the development Node runtime");
  const directory = await mkdtemp(join(tmpdir(), "legalwork-node-history-"));
  const filename = join(directory, "engine.db");
  const digest = async () => createHash("sha256").update(await readFile(filename)).digest("hex");
  try {
    const writer = new DatabaseSync(filename);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE history (id TEXT PRIMARY KEY, content TEXT); INSERT INTO history VALUES ('held', 'Keep this complete history');");
    writer.close();
    const before = await digest();
    const reader = await openSqliteReadonly(filename);
    try {
      assert.deepEqual(reader.all("SELECT * FROM history").map(row => ({ ...row })), [{ id: "held", content: "Keep this complete history" }]);
      assert.deepEqual([...reader.iterate("SELECT content FROM history WHERE id=?", ["held"])].map(row => ({ ...row })), [{ content: "Keep this complete history" }]);
      assert.throws(() => reader.run("INSERT INTO history VALUES (?, ?)", ["unauthorized", "must not persist"]), /readonly|read-only/i);
    } finally { reader.close(); }
    assert.equal(await digest(), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the built Node CLI imports, authenticates and restarts on its released port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-node-dev-"));
  const workspace = join(directory, "matter");
  await mkdir(workspace);
  await writeFile(join(directory, "model-catalog-settings.json"), JSON.stringify({ onlineUpdatesEnabled: false }));
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  Object.assign(env, {
    HOME: directory, USERPROFILE: directory,
    XDG_CONFIG_HOME: join(directory, "config"), XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
    LEGALWORK_RUNTIME_DB: join(directory, "runtime.sqlite"), LEGALWORK_MANAGE_OPENCODE: "0",
    LEGALWORK_TOKEN_STORE: join(directory, "tokens.json"), LEGALWORK_STORAGE_STORE: join(directory, "storage.json"),
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  });
  let port = 0;
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      const child = spawn(process.execPath, [cli, "--host", "127.0.0.1", "--port", String(port),
        "--workspace", workspace, "--config", join(directory, "server.json"),
        "--token", "node-dev-fixture-client", "--host-token", "node-dev-fixture-owner", "--approval", "auto"],
      { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", bytes => { output += bytes; });
      child.stderr.on("data", bytes => { output += bytes; });
      const exited = once(child, "exit");
      try {
        let baseURL;
        // Process setup watchdog only; this fixture never starts a model or engine.
        const deadline = Date.now() + 30_000;
        while (!baseURL) {
          baseURL = /LegalWork server listening on (http:\/\/[^\s]+)/.exec(output)?.[1];
          if (child.exitCode !== null || Date.now() >= deadline) throw new Error(output || "Node CLI did not listen");
          if (!baseURL) await delay(10);
        }
        const actualPort = Number(new URL(baseURL).port);
        if (iteration > 0) assert.equal(actualPort, port, "The previous listener must be released");
        port = actualPort;
        assert.equal((await fetch(baseURL + "/health")).status, 200);
        assert.equal((await fetch(baseURL + "/workspaces")).status, 401);
        const response = await fetch(baseURL + "/workspaces", { headers: { authorization: "Bearer node-dev-fixture-client" } });
        assert.equal(response.status, 200);
        assert.ok((await response.json()).items.some(item => item.path === workspace));
        child.kill("SIGTERM");
        const [code, signal] = await exited;
        assert.equal(code, 0, output);
        assert.equal(signal, null, output);
      } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
