import { readMessages } from "./_util.mjs";
import assert from "node:assert/strict";

import {
  findFreePort,
  makeClient,
  parseArgs,
  spawnOpencodeServe,
  waitForHealthy,
} from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();

const port = await findFreePort();
const server = await spawnOpencodeServe({
  directory,
  port,
});

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  await waitForHealthy(client);

  const before = (await client.session.list({ limit: 20 })).data;
  assert.ok(Array.isArray(before));

  const created = await client.session.create({ location: { directory: server?.cwd ?? directory }, title: "LegalWork test session" });
  assert.ok(typeof created.id === "string");
  assert.equal(created.title, "LegalWork test session");

  const after = (await client.session.list({ limit: 20 })).data;
  assert.ok(after.some((s) => s.id === created.id));

  const messages = await readMessages(client, created.id);
  assert.ok(Array.isArray(messages));

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: server.baseUrl,
      created: { id: created.id, title: created.title },
      listCount: after.length,
      messagesCount: messages.length,
    }),
  );
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ ok: false, error: message, stderr: server.getStderr() }));
  process.exitCode = 1;
} finally {
  await server.close();
}
