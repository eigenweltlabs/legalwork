import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { findFreePort, makeClient, parseArgs, readMessages, spawnOpencodeServe, waitForHealthy } from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();
const server = await spawnOpencodeServe({ directory, port: await findFreePort() });
try {
  const client = makeClient({ baseUrl: server.baseUrl });
  await waitForHealthy(client);
  const path = resolve(server.cwd, args.get("path") ?? "README.md");
  const content = await readFile(path);
  const uri = `data:text/plain;base64,${content.toString("base64")}`;
  const session = await client.session.create({ location: { directory: server.cwd }, title: "LegalWork mention test" });
  await assert.rejects(() => client.session.prompt({ sessionID: session.id, text: "Invalid mention", resume: false, files: [{ path }] }));
  const admission = await client.session.prompt({ sessionID: session.id, text: `@${basename(path)}`, resume: false, files: [{ uri, name: basename(path) }] });
  const messages = await client.session.inbox.list({ sessionID: session.id });
  const saved = messages.find(message => message.id === admission.id);
  assert.equal(saved?.type, "user");
  assert.equal(saved.payload.text, `@${basename(path)}`);
  assert.equal(saved.payload.files?.[0]?.name, basename(path));
  assert.equal((await readMessages(client, session.id)).length, 0);
  console.log(JSON.stringify({ ok: true, sessionId: session.id, filename: basename(path), bytes: content.length }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), stderr: server.getStderr() }));
  process.exitCode = 1;
} finally { await server.close(); }
