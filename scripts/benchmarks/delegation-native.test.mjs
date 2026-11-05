// Zero-inference opt-in: actual released native process + loopback fake provider.
// This proves public shapes/helper plumbing, not product isolation or legal quality.
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { detectEngineProtocol, observeSessionActivity } from "./engine-evidence.mjs";
import { summarizeMessages, sha256 } from "./evidence.mjs";
import { evaluateDelegationExecution } from "./delegation-evidence.mjs";
import { toolExecutionCoverage } from "./tool-coverage.mjs";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test("actual native subagent returns bind two real child sessions and complete public AFTERs", { skip: !binary, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-native-delegation-"));
  await Promise.all(["workspace", "home", "config", "data", "state", "cache", "observer"].map(name => mkdir(join(root, name))));
  const wire = [], journal = join(root, "tool-events.jsonl");
  let primaryRounds = 0;
  const provider = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks)), raw = JSON.stringify(body);
      wire.push({ path: request.url, body });
      const primary = body.tools?.some(tool => tool.function?.name === "subagent");
      const child = raw.includes("DELEGATION_FIXTURE_CHILD_ONE") ? "one" : raw.includes("DELEGATION_FIXTURE_CHILD_TWO") ? "two" : null;
      let message = { role: "assistant", content: child ? `Completed independent fixture review ${child}.` : "Fixture synthesis complete." };
      let finish_reason = "stop";
      if (primary && !child && primaryRounds++ === 0) {
        message = { role: "assistant", content: null, tool_calls: ["ONE", "TWO"].map((label, index) => ({ index,
          id: `delegation_fixture_${index}`, type: "function", function: { name: "subagent", arguments: JSON.stringify({
            agent: "general", description: `Fixture independent ${label}`, prompt: `DELEGATION_FIXTURE_CHILD_${label}: Return a substantive independent fixture response.`,
          }) } })) };
        finish_reason = "tool_calls";
      }
      const completion = { id: `fixture-${randomUUID()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
        model: body.model, choices: [{ index: 0, delta: message, finish_reason }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  const portProbe = net.createServer(); portProbe.listen(0, "127.0.0.1"); await once(portProbe, "listening");
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  await writeFile(join(root, "observer", "index.js"), `import{appendFile}from'node:fs/promises';export default{id:'benchmark.delegation-shapes',async setup(ctx){let sequence=0;const registrations=[];for(const phase of ['before','after'])registrations.push(await ctx.tool.hook('execute.'+phase,async event=>{await appendFile(${JSON.stringify(journal)},JSON.stringify({...event,observerInstance:'actual-native-fixture',sequence:++sequence,phase,status:phase==='after'?(event.error?'error':'completed'):'running'})+'\\n')}));return async()=>{for(const registration of registrations.reverse())await registration.dispose()}}};`);
  const password = randomUUID(), workspace = join(root, "workspace"), base = `http://127.0.0.1:${port}`;
  const engine = spawn(resolve(binary), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: workspace,
    env: { PATH: process.env.PATH, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), OPENCODE_CONFIG_DIR: join(root, "config"),
      OPENCODE_DB: join(root, "engine.db"), OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_FFF: "true", OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", warming: false,
        plugins: [join(root, "observer")], model: "fixture/fixture", permissions: [{ action: "subagent", resource: "general", effect: "allow" }],
        policies: [{ action: "provider.use", resource: "*", effect: "deny" }, { action: "provider.use", resource: "fixture", effect: "allow" }],
        providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic-local-only" },
          models: { fixture: { limit: { context: 128000, output: 4096 }, capabilities: { tools: true } } } } } }) }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; engine.stdout.on("data", chunk => { logs += chunk; }); engine.stderr.on("data", chunk => { logs += chunk; });
  const exited = once(engine, "exit");
  const api = [];
  const request = async (path, body) => {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: {
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const raw = await response.text(); api.push({ path, body, status: response.status, raw });
    if (!response.ok) throw new Error(`Fixture API HTTP ${response.status}: ${raw}`);
    return raw ? JSON.parse(raw) : null;
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try { if ((await request("/api/info")).version?.startsWith("2.")) break; } catch (error) { if (attempt >= 100 || engine.exitCode !== null) throw error; }
      await delay(50);
    }
    const query = new URLSearchParams({ "location[directory]": workspace });
    await request(`/api/model?${query}`);
    const parent = (await request("/api/session", { location: { directory: workspace }, model: { providerID: "fixture", id: "fixture" }, title: "Delegation shape fixture" })).data;
    await request(`/api/session/${parent.id}/prompt`, { text: "DELEGATION_FIXTURE_ROOT: perform the deterministic interface protocol." });
    await request(`/api/experimental/session/${parent.id}/wait`, {});
    const protocol = await detectEngineProtocol({ engine: request }, workspace);
    const rootMessages = await protocol.messages(parent.id), children = await protocol.sessions(parent.id);
    assert.equal(children.length, 2);
    const messages = [...rootMessages], sessionTree = [{ requestedParentID: null, session: await protocol.session(parent.id) }];
    for (const child of children) {
      assert.equal(child.parentID, parent.id);
      messages.push(...await protocol.messages(child.id)); sessionTree.push({ requestedParentID: parent.id, session: child });
    }
    const ownedSessionIDs = [parent.id, ...children.map(child => child.id)], subtreeActivity = await observeSessionActivity(protocol, ownedSessionIDs);
    const records = (await readFile(journal, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 4);
    assert.deepEqual(records.map(record => record.sequence), [1, 2, 3, 4]);
    const summary = summarizeMessages(messages), coverage = toolExecutionCoverage(summary, records, ownedSessionIDs);
    assert.equal(coverage.completeAsExposed, true, JSON.stringify(coverage.missing));
    const context = { engineProtocol: protocol.id, rootSessionID: parent.id, ownedSessionIDs, sessionTree, subtreeMessages: messages,
      subtreeActivity, toolExecutions: records, toolTraceCompleteness: { captureIntegrityVerified: true, completeAsExposed: coverage.completeAsExposed } };
    const result = evaluateDelegationExecution({ scope: "subtree", minimumDirectChildren: 2 }, summary, context);
    assert.equal(result.passed, true, JSON.stringify(result));
    const negativeControls = [];
    for (const [name, mutate] of [
      ["missing-actual-successful-after", copy => { copy.toolExecutions = copy.toolExecutions.filter(record => record !== copy.toolExecutions.findLast(record => record.phase === "after")); }],
      ["foreign-public-parent", copy => { copy.sessionTree[2].session.parentID = "foreign"; }],
      ["same-returned-child-twice", copy => { const afters = copy.toolExecutions.filter(record => record.phase === "after"); afters[1].result.output.sessionID = afters[0].result.output.sessionID; afters[1].result.metadata.sessionID = afters[0].result.metadata.sessionID; }],
    ]) {
      const copy = structuredClone(context); mutate(copy); let passed = false;
      try { passed = evaluateDelegationExecution({ scope: "subtree", minimumDirectChildren: 2 }, summary, copy).passed; } catch { /* Expected fail-closed identity rejection. */ }
      assert.equal(passed, false); negativeControls.push({ name, mutatedEvidenceRejected: true, originalEvidenceUnchanged: true });
    }
    await writeFile(join(root, "public-evidence.json"), JSON.stringify({ api, wire, sessionTree, messages, records, coverage, result, negativeControls }, null, 2));
    const bytes = await readFile(join(root, "public-evidence.json"));
    const binaryHash = createHash("sha256"); for await (const chunk of createReadStream(resolve(binary))) binaryHash.update(chunk);
    await writeFile(join(root, "receipt.json"), JSON.stringify({ kind: "actual-native-delegation-shape-zero-inference", evidenceBytes: bytes.length,
      evidenceSha256: sha256(bytes), engine: { path: resolve(binary), sha256: binaryHash.digest("hex"), version: protocol.version, pid: engine.pid },
      distinctChildren: children.length, successfulActualAfterValues: records.filter(record => record.phase === "after").length,
      journalSha256: sha256(await readFile(journal)), sourceSha256: sha256(await readFile(new URL(import.meta.url))), negativeControls,
      paidModelCalls: 0, providerRequests: wire.length, provider: "loopback deterministic fixture", privacyIsolationProof: false,
      productionRecorderAcceptance: false, capture: "awaited fixture-local public hooks; exact four sequences and complete observed call coverage verified",
      legalQualityProof: false }, null, 2));
    console.log(`ACTUAL_NATIVE_DELEGATION_RECEIPT ${join(root, "receipt.json")}`);
  } finally {
    engine.kill("SIGTERM"); await exited;
    await new Promise(resolve => provider.close(resolve));
    await writeFile(join(root, "engine.log"), logs);
    await writeFile(join(root, "provider-api.partial.json"), JSON.stringify({ api, wire }, null, 2));
  }
});
