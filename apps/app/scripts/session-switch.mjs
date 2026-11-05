import { readMessages, messageText } from "./_util.mjs";
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
const server = await spawnOpencodeServe({ directory, port });

const results = {
  ok: true,
  baseUrl: server.baseUrl,
  directory: server.cwd,
  steps: [],
};

function step(name, fn) {
  results.steps.push({ name, status: "running" });
  const idx = results.steps.length - 1;

  return Promise.resolve()
    .then(fn)
    .then((data) => {
      results.steps[idx] = { name, status: "ok", data };
    })
    .catch((e) => {
      results.ok = false;
      results.steps[idx] = {
        name,
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      };
      throw e;
    });
}

function extractLastText(messages) {
  return [...messages].reverse().map(messageText).find(Boolean) ?? null;
}

try {
  const client = makeClient({ baseUrl: server.baseUrl, directory: server.cwd });
  await waitForHealthy(client);

  let sessionA;
  let sessionB;

  await step("session.create A", async () => {
    sessionA = await client.session.create({ location: { directory: server?.cwd ?? directory }, title: "LegalWork session A" });
    assert.ok(sessionA?.id);
    return { id: sessionA.id };
  });

  await step("session.create B", async () => {
    sessionB = await client.session.create({ location: { directory: server?.cwd ?? directory }, title: "LegalWork session B" });
    assert.ok(sessionB?.id);
    return { id: sessionB.id };
  });

  await step("session.prompt A", async () => {
    await client.session.synthetic({
      sessionID: sessionA.id,
      resume: false,
      text: "Hello from session A",
    });
    return { sessionID: sessionA.id };
  });

  await step("session.prompt B", async () => {
    await client.session.synthetic({
      sessionID: sessionB.id,
      resume: false,
      text: "Hello from session B",
    });
    return { sessionID: sessionB.id };
  });

  await step("session.messages A", async () => {
    const messages = await client.session.inbox.list({ sessionID: sessionA.id });
    assert.ok(Array.isArray(messages));
    assert.ok(!messages.some(message => messageText(message).includes("session B")));
    const text = extractLastText(messages);
    assert.ok(text && text.includes("session A"));
    return { count: messages.length };
  });

  await step("session.messages B", async () => {
    const messages = await client.session.inbox.list({ sessionID: sessionB.id });
    assert.ok(Array.isArray(messages));
    assert.ok(!messages.some(message => messageText(message).includes("session A")));
    const text = extractLastText(messages);
    assert.ok(text && text.includes("session B"));
    return { count: messages.length };
  });

  await step("session.messages switch", async () => {
    const [messagesA, messagesB] = await Promise.all([
      client.session.inbox.list({ sessionID: sessionA.id }),
      client.session.inbox.list({ sessionID: sessionB.id }),
    ]);

    const textA = extractLastText(messagesA);
    const textB = extractLastText(messagesB);

    assert.ok(textA && textA.includes("session A"));
    assert.ok(textB && textB.includes("session B"));

    return { aCount: messagesA.length, bCount: messagesB.length };
  });

  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  results.ok = false;
  results.error = message;
  results.stderr = server.getStderr();
  results.stdout = server.getStdout?.() ?? "";
  results.serverExit = server.getExitInfo?.() ?? null;
  console.error(JSON.stringify(results, null, 2));
  process.exitCode = 1;
} finally {
  await server.close();
}
