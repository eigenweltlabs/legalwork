import assert from "node:assert/strict";
import { findFreePort, makeClient, parseArgs, spawnOpencodeServe, waitForHealthy } from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const directory = args.get("dir") ?? process.cwd();
const server = await spawnOpencodeServe({ directory, port: await findFreePort() });
try {
  const client = makeClient({ baseUrl: server.baseUrl });
  await waitForHealthy(client);
  const location = { directory: server.cwd };
  await client.model.list({ location });
  const agents = (await client.agent.list({ location })).data;
  const agent = agents.find(item => item.mode !== "subagent" && !item.hidden)?.id;
  assert.ok(agent, "No primary native agent is available");
  const session = await client.session.create({ location, agent, title: "LegalWork permission test",
    permissions: [{ action: "shell", resource: "*", effect: "ask" }] });
  let finished = false, shellError;
  const shell = client.session.shell({ sessionID: session.id, command: "pwd" }).catch(error => {
    shellError = error instanceof Error ? error.message : String(error);
  }).finally(() => { finished = true; });
  let pending = [];
  const deadline = Date.now() + 10000;
  while (!pending.length && !finished && Date.now() < deadline) {
    pending = await client.permission.list({ sessionID: session.id });
    if (!pending.length) await new Promise(resolve => setTimeout(resolve, 50));
  }
  const request = pending[0];
  if (!request) {
    await client.session.interrupt({ sessionID: session.id });
    await shell;
    assert.notEqual(args.get("require"), "true", `No shell permission request observed: ${shellError ?? "no pending request"}`);
  } else {
    assert.equal(request.action, "shell");
    await client.permission.reply({ sessionID: session.id, requestID: request.id, decision: "once" });
    await shell;
    assert.equal(shellError, undefined);
    assert.equal((await client.permission.list({ sessionID: session.id })).length, 0);
  }
  console.log(JSON.stringify({ ok: true, permissionAsked: Boolean(request), sessionId: session.id, agent, ...(shellError ? { shellError } : {}) }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), stderr: server.getStderr() }));
  process.exitCode = 1;
} finally { await server.close(); }
