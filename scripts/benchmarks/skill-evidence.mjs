// Controller-only evidence for exact skill/resource invocations. Never inspect
// generated code strings as proof that an engine tool actually executed.
import { createHash } from "node:crypto";

const digest = text => createHash("sha256").update(text).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function successful(call) {
  return call.state?.status === "completed" && !call.state.error && call.state.metadata?.error !== true
    && typeof call.messageID === "string" && call.messageID.length > 0
    && typeof (call.callID ?? call.id) === "string" && (call.callID ?? call.id).length > 0
    && (call.protocol === "legacy-v1" ? typeof call.state.output === "string" && call.state.output.length > 0
      : call.protocol === "native-v2" && Array.isArray(call.state.content) && call.state.content.length > 0);
}

function envelope(result) {
  if (result?.output !== undefined) {
    if (typeof result.output === "object") return result.output;
    try { return JSON.parse(result.output); } catch { return null; }
  }
  const text = typeof result?.content === "string" ? result.content
    : Array.isArray(result?.content) ? result.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
  try { return JSON.parse(text); } catch { return null; }
}

function invocations(summary, context) {
  return summary.tools.filter(successful).flatMap(call => {
    const identity = { messageID: call.messageID, callID: call.callID ?? call.id, protocol: call.protocol };
    if (["legalwork_skill_load", "legalwork_skill_read"].includes(call.tool)) {
      const result = envelope(call.state);
      if (result?.ok !== true || result.error) return [];
      return [{ ...identity, tool: call.tool, input: call.state.input, result: result.payload, path: "direct" }];
    }
    if (call.protocol !== "native-v2" || call.tool !== "execute" || !Array.isArray(call.state.metadata?.toolCalls)) return [];
    // These first-party tools register without a namespace. Upstream's exact
    // Code Mode qualifiedName is therefore the same as the public tool name.
    return call.state.metadata.toolCalls.filter(child => ["legalwork_skill_load", "legalwork_skill_read"].includes(child.tool)
      && child.status === "completed" && child.error === undefined).flatMap(child => (context.toolExecutions ?? [])
      .filter(event => event.phase === "after" && event.status === "completed" && !event.error && event.result?.metadata?.error !== true
        && typeof event.observerInstance === "string" && event.observerInstance.length > 0 && Number.isSafeInteger(event.sequence) && event.sequence > 0
        && (context.ownedSessionIDs ?? []).includes(event.sessionID) && event.sessionID === call.sessionID && event.messageID === call.messageID
        && (event.callID ?? event.id) === (call.callID ?? call.id) && (event.toolID ?? event.tool) === child.tool
        && canonical(event.input) === canonical(child.input))
      .flatMap(event => {
        const result = envelope(event.result);
        if (result?.ok !== true || result.error) return [];
        return [{ ...identity, tool: child.tool, input: event.input, result: result.payload, path: "code-mode-observed-child",
          observer: { instance: event.observerInstance, sequence: event.sequence, recordSha256: event.recordSha256, sessionID: event.sessionID, pairing: event.pairing } }];
      }));
  });
}

export function evaluateSkillResourceExecution(assertion, summary, context = {}) {
  if (typeof assertion.name !== "string" || !assertion.name || typeof assertion.resourcePath !== "string"
    || !assertion.resourcePath.startsWith("resources/") || assertion.resourcePath.split("/").includes("..")
    || !Array.isArray(assertion.files) || assertion.files.length !== 2
    || !assertion.files.some(file => file.path === "SKILL.md") || !assertion.files.some(file => file.path === assertion.resourcePath)
    || assertion.files.some(file => !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
    || !Number.isSafeInteger(assertion.resourceCharacters) || !Number.isSafeInteger(assertion.tail?.start) || !Number.isSafeInteger(assertion.tail?.end)
    || assertion.tail.start < 24000 || assertion.tail.end <= assertion.tail.start || assertion.tail.end > assertion.resourceCharacters || !/^[a-f0-9]{64}$/.test(assertion.tail.sha256)) {
    throw new Error("Exact skill/resource identities and complete installed-file hashes are required");
  }
  const receipts = (context.skillInstallations ?? []).filter(receipt => receipt.name === assertion.name && receipt.scope === "global"
    && receipt.method === "actual-installed-file-bytes" && typeof receipt.directory === "string" && receipt.directory.startsWith("/")
    && Number.isFinite(Date.parse(receipt.verifiedAt)) && Array.isArray(receipt.files));
  const installed = receipts.length === 1 && receipts[0].files.length === assertion.files.length && assertion.files.every(expected =>
    receipts[0].files.filter(file => file.path === expected.path && file.bytes === expected.bytes && file.sha256 === expected.sha256).length === 1);
  const calls = invocations(summary, context);
  const loads = calls.filter(call => call.tool === "legalwork_skill_load" && call.input?.name === assertion.name
    && Array.isArray(call.result?.chain) && call.result.chain.some(entry => entry.name === assertion.name));
  const reads = calls.filter(call => call.tool === "legalwork_skill_read" && call.input?.name === assertion.name
    && call.input?.path === assertion.resourcePath && (call.input.offset === undefined || Number.isSafeInteger(call.input.offset) && call.input.offset >= 0)
    && call.result?.path === assertion.resourcePath && typeof call.result.content === "string" && call.result.content.length > 0);
  const continued = !assertion.requireContinuation || reads.some(call => call.input.offset > 0);
  // A completed callback can still return {ok:false}. Require the actual
  // successful service content and its source tail, never an inferred page.
  const tailReads = reads.filter(call => {
    const offset = call.input.offset ?? 0;
    return offset <= assertion.tail.start && offset + call.result.content.length >= assertion.tail.end
      && call.result.totalCharacters === assertion.resourceCharacters
      && digest(call.result.content.slice(assertion.tail.start - offset, assertion.tail.end - offset)) === assertion.tail.sha256;
  });
  const identity = call => ({ tool: call.tool, input: call.input, messageID: call.messageID, callID: call.callID, protocol: call.protocol, path: call.path, ...(call.observer ? { observer: call.observer } : {}) });
  return { passed: installed && loads.length > 0 && reads.length > 0 && continued && tailReads.length > 0, evidence: {
    expectedSkill: assertion.name, expectedResource: assertion.resourcePath, installedBytesMatch: installed,
    installationReceipts: receipts, completedLoads: loads.map(identity), completedReads: reads.map(identity), completedTailReads: tailReads.map(identity), continuationObserved: continued,
    note: "Code Mode child metadata alone is insufficient: exact owned observer results must prove service success and the actual source tail digest. Complete raw journal records remain in controller evidence; substantive artifact assertions are separate.",
  } };
}
