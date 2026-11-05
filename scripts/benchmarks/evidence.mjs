import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, readlink, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { evaluateOfficeExecution, evaluateSavedOfficeArtifact } from "./office-evidence.mjs";
import { evaluateSkillResourceExecution } from "./skill-evidence.mjs";
import { evaluateLongMcpExecution } from "./long-mcp-evidence.mjs";
import { evaluateBrowserRegisterExecution } from "./browser-register-evidence.mjs";
import { evaluateDelegationExecution } from "./delegation-evidence.mjs";

export async function privateWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value, null, 2)}\n`); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }

export function inside(root, path) {
  const candidate = resolve(root, path);
  const difference = relative(resolve(root), candidate);
  if (isAbsolute(path) || difference === ".." || difference.startsWith(`..${sep}`)) throw new Error(`Artifact path escapes fixture directory: ${path}`);
  return candidate;
}

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export async function fingerprint(path) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

export async function fingerprintTree(root) {
  const entries = [];
  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isSymbolicLink()) entries.push({ path: relative(root, path), symlink: await readlink(path) });
      else if (entry.isFile()) entries.push({ path: relative(root, path), ...await fingerprint(path) });
    }
  }
  await walk(root);
  return { sha256: sha256(JSON.stringify(entries)), entries };
}

export function summarizeMessages(entries) {
  const totals={input:0,output:0,reasoning:0,cacheRead:0,cacheWrite:0};
  const seen=new Set();const messages=[];const auxiliary=[];const tools=[];const nativeRecords=[];
  let reportedEngineCost=0;let costMessages=0;
  for(const entry of entries) {
    const native=typeof entry.type==="string" && !entry.info;
    const info=native ? entry:entry.info ?? {};
    const requestedSessionID=entry.benchmarkRequestedSessionID??info.sessionID;
    const messageKey=JSON.stringify([requestedSessionID??null,info.id]);
    if(info.id && seen.has(messageKey))throw new Error(`Duplicate message snapshot: ${info.id}`);
    if(info.id)seen.add(messageKey);
    if(native)nativeRecords.push(entry);
    const assistant=native ? info.type==="assistant":info.role==="assistant";
    const compaction=native && info.type==="compaction";
    if(assistant || compaction) {
      const tokens=info.tokens ?? {};
      for(const [target,value] of Object.entries({input:tokens.input,output:tokens.output,reasoning:tokens.reasoning,cacheRead:tokens.cache?.read,cacheWrite:tokens.cache?.write}))if(typeof value==="number" && Number.isFinite(value))totals[target]+=value;
      if(typeof info.cost==="number" && Number.isFinite(info.cost)){reportedEngineCost+=info.cost;costMessages++;}
      const result={id:info.id,type:native ? info.type:info.role,parentID:info.parentID,sessionID:requestedSessionID,modelID:native ? info.model?.id:info.modelID,providerID:native ? info.model?.providerID:info.providerID,variant:native ? info.model?.variant:info.variant,agent:info.agent,finish:info.finish,error:info.error,time:info.time,cost:info.cost,tokens:info.tokens};
      (assistant ? messages:auxiliary).push(result);
    }
    for(const part of (native ? entry.content:entry.parts) ?? []) {
      if(part.type!=="tool")continue;
      tools.push(native ? {...part,sessionID:requestedSessionID,messageID:info.id,tool:part.name,callID:part.id,state:{...part.state,...(part.state.content ? {output:part.state.content.filter(item=>item.type==="text").map(item=>item.text).join("\n")}: {})},protocol:"native-v2"}:{sessionID:requestedSessionID,messageID:info.id,...part,protocol:"legacy-v1"});
    }
  }
  const all=[...messages,...auxiliary];
  return {assistantMessages:messages,auxiliaryModelMessages:auxiliary,tools,totals,reportedEngineCost:costMessages ? reportedEngineCost:null,engineCostCurrency:nativeRecords.length ? "USD-declared-by-native-MoneyUSD":"unspecified-by-engine",missingTokenMessages:all.filter(message=>!message.tokens).map(message=>message.id),errors:all.filter(message=>message.error).map(message=>({messageID:message.id,error:message.error})),nativeHistory:{messageTypes:[...new Set(nativeRecords.map(entry=>entry.type))],syntheticReminderIDs:nativeRecords.filter(entry=>entry.type==="synthetic" && entry.metadata?.legalworkSystemReminder).map(entry=>entry.id),promptMetadata:nativeRecords.filter(entry=>entry.type==="user" && entry.metadata?.legalworkPrompt).map(entry=>({id:entry.id,metadata:entry.metadata}))}};
}

export async function evaluateAssertions(assertions, directory, messages, ui, context = {}) {
  const results = [];
  const rootSummary = summarizeMessages(messages);
  for (const assertion of assertions) {
    let passed = false;
    let evidence;
    try {
      if(assertion.scope && !["root","subtree"].includes(assertion.scope))throw new Error("Unknown explicit assertion scope");
      if(assertion.scope==="subtree" && !Array.isArray(context.subtreeMessages))throw new Error("Explicit subtree criterion requires the exact collected owned subtree");
      const summary=assertion.scope==="subtree" ? summarizeMessages(context.subtreeMessages):rootSummary;
      if (assertion.type === "artifact.exists") {
        const file = inside(directory, assertion.path);
        passed = (await stat(file)).isFile();
        evidence = await fingerprint(file);
      } else if (assertion.type === "artifact.sha256") {
        evidence = await fingerprint(inside(directory, assertion.path));
        passed = evidence.sha256 === assertion.equals;
      } else if (assertion.type === "artifact.text") {
        const text = await readFile(inside(directory, assertion.path), "utf8");
        passed = assertion.includes.every(value => text.includes(value));
        evidence = { chars: text.length, missing: assertion.includes.filter(value => !text.includes(value)) };
      } else if (assertion.type === "artifact.json") {
        const actual = await readJson(inside(directory, assertion.path));
        const normalized = (key, value) => assertion.normalizers?.[key] === "ltd-suffix-period" && typeof value === "string" ? value.replace(/\bLtd\.$/, "Ltd") : value;
        const mismatches = Object.entries(assertion.equals).filter(([key, expected]) => JSON.stringify(normalized(key, actual[key])) !== JSON.stringify(normalized(key, expected)));
        passed = mismatches.length === 0;
        evidence = { mismatches, artifact: assertion.path, ...(assertion.normalizers ? { explicitNormalizers: assertion.normalizers } : {}) };
      } else if (assertion.type === "artifact.document_text") {
        const { extractFullArtifact } = await import("./artifacts.mjs");
        const artifact = await extractFullArtifact(inside(directory, assertion.path));
        const missing = assertion.includes.filter(value => !artifact.text.includes(value));
        passed = missing.length === 0;
        evidence = { chars: artifact.text.length, missing, limitations: artifact.limitations };
      } else if (assertion.type === "artifact.word_redline") {
        const { extractFullArtifact } = await import("./artifacts.mjs");
        const artifact = await extractFullArtifact(inside(directory, assertion.path));
        const document = artifact.xml?.["word/document.xml"] ?? "";
        const revisionText = type => [...document.matchAll(new RegExp(`<w:${type}\\b[\\s\\S]*?<\\/w:${type}>`, "g"))].map(match => match[0].replace(/<[^>]+>/g, "")).join("\n");
        const deleted = revisionText("del");
        const inserted = revisionText("ins");
        passed = deleted.includes(assertion.deleted) && inserted.includes(assertion.inserted);
        evidence = { deleted, inserted, source: "word/document.xml" };
      } else if (assertion.type === "capability.tool") {
        const calls = summary.tools.filter(tool => assertion.names.includes(tool.tool) && tool.state?.status === "completed");
        passed = calls.length > 0;
        evidence = calls.map(tool => ({ id: tool.id, tool: tool.tool, callID: tool.callID }));
      } else if (["artifact.office_xlsx","artifact.office_pptx"].includes(assertion.type)) {
        ({passed,evidence}=await evaluateSavedOfficeArtifact(assertion,directory));
      } else if (assertion.type === "capability.office") {
        ({passed,evidence}=evaluateOfficeExecution(assertion,summary,context));
      } else if (assertion.type === "capability.skill_resource") {
        ({ passed, evidence } = evaluateSkillResourceExecution(assertion, summary, context));
      } else if (assertion.type === "capability.mcp_tool") {
        ({ passed, evidence } = evaluateLongMcpExecution(assertion, summary));
      } else if (assertion.type === "capability.browser_register") {
        ({ passed, evidence } = evaluateBrowserRegisterExecution(assertion, summary, context));
      } else if (assertion.type === "capability.delegation") {
        ({ passed, evidence } = evaluateDelegationExecution(assertion, summary, context));
      } else if (assertion.type === "agent.no_error") {
        passed = summary.errors.length === 0 && summary.assistantMessages.length > 0;
        evidence = summary.errors;
      } else if (assertion.type === "ui.document_open") {
        if(!context.workspace || !context.workspaceID)throw new Error("Exact UI artifact assertion requires the actual workspace path and identity");
        const files = ui?.openFiles ?? [];
        const expected=inside(context.executionDirectory ?? directory,assertion.path);
        const matches=files.filter(file=>typeof file.path==="string" && file.workspaceId===context.workspaceID && resolve(context.workspace,file.path)===expected);
        passed = matches.length>0;
        evidence = {expected,workspaceID:context.workspaceID,matches,openFiles:files};
      } else throw new Error(`Unknown assertion type: ${assertion.type}`);
    } catch (error) { evidence = { error: String(error) }; }
    results.push({ id: assertion.id, passed, evidence });
  }
  return results;
}

export function compareRuns(baseline, candidate) {
  const incomparable = [];
  for (const [label, run] of [["baseline", baseline], ["candidate", candidate]]) {
    if (!run.finishedAt || run.evidenceComplete !== true || !run.items?.length) incomparable.push(`${label}: incomplete real-run evidence`);
    if (run.validity?.startsWith("inconclusive")) incomparable.push(`${label}: ${run.validity}`);
    if (run.kind !== "real-electron-real-engine-regression") incomparable.push(`${label}: not a real Electron/engine run`);
    if (run.items?.some(item => !item.identity || !item.assertions?.length)) incomparable.push(`${label}: missing task identity/assertions`);
    if (!run.preflight?.build?.serverTreeSha256 || !run.preflight?.git?.head) incomparable.push(`${label}: missing actual source/build identity`);
  }
  if (baseline.identity?.suiteSha256 !== candidate.identity?.suiteSha256 || !baseline.identity?.suiteSha256) incomparable.push("suite/prompt/fixture definitions differ or are unrecorded");
  if (JSON.stringify(baseline.identity?.model) !== JSON.stringify(candidate.identity?.model) || !baseline.identity?.model) incomparable.push("model/provider/variant assignment differs or is unrecorded");
  if (JSON.stringify(baseline.settings) !== JSON.stringify(candidate.settings)) incomparable.push("harness settings differ");
  if (baseline.preflight?.catalog?.skillContentsSha256 !== candidate.preflight?.catalog?.skillContentsSha256 && !candidate.comparisonPolicy?.allowedChanges?.includes("skill-catalog")) incomparable.push("skill catalog changed without an explicitly reviewed comparison policy");
  if (incomparable.length) return { state: "incomparable", passed: false, reasons: incomparable, regressions: [] };
  if (!baseline.items.some(item => item.status === "completed" && item.assertions.some(assertion => assertion.passed))) return { state: "inconclusive", passed: false, reasons: ["No successful baseline outcomes establish a regression reference"], regressions: [] };
  const byId = new Map(candidate.items.map(item => [item.id, item]));
  const regressions = [];
  for (const before of baseline.items) {
    const after = byId.get(before.id);
    if (!after) { regressions.push({ task: before.id, reason: "missing-task" }); continue; }
    if (JSON.stringify(before.identity) !== JSON.stringify(after.identity)) { regressions.push({ task: before.id, reason: "task-input-or-model-changed" }); continue; }
    const verdicts = new Map(after.assertions.map(assertion => [assertion.id, assertion.passed]));
    for (const assertion of before.assertions) {
      if (assertion.passed && verdicts.get(assertion.id) !== true) regressions.push({ task: before.id, assertion: assertion.id, reason: verdicts.has(assertion.id) ? "lost-pass" : "missing-assertion" });
    }
    if (after.status !== "completed") regressions.push({ task: before.id, reason: after.status });
  }
  const pending = [...new Set([...(baseline.coverage?.pending ?? []), ...(candidate.coverage?.pending ?? [])])];
  const nonBlindTasks = [...new Set([...baseline.items, ...candidate.items].filter(item => item.evaluation?.blinding === "non-blind").map(item => item.id))];
  return { state: regressions.length ? "regression-observed" : pending.length ? "partial-coverage" : "matched-observed-outcomes", passed: regressions.length === 0 && pending.length === 0, comparedOutcomesPassed: regressions.length === 0, pendingCoverage: pending, nonBlindTasks, regressions, caveat: "Matched observed outcomes; repeated real-model trials are required to estimate reliability. Non-blind tasks do not establish blind legal quality. A pass count alone cannot establish parity." };
}
