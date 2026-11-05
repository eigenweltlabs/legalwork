// Controller-only public-session and full tool-return evidence. Never sent to an agent.
import { createHash } from "node:crypto";
import { canonical } from "./tool-journal.mjs";
import { observeSessionActivity } from "./engine-evidence.mjs";

const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const identity = entry => entry.benchmarkRequestedSessionID ?? entry.info?.sessionID ?? entry.sessionID;
const assistant = entry => entry.type === "assistant" || entry.info?.role === "assistant";
const info = entry => entry.info ?? entry;
const text = entry => (entry.content ?? entry.parts ?? [])
  .filter(part => part.type === "text").map(part => part.text ?? "").join("\n");

// Called only after apparent settlement. A child can finish between an earlier
// history read and activity snapshot; reread the entire owned tree, then check
// activity again. Raw responses and each refreshed snapshot remain evidence.
export async function refreshDelegationTree(protocol, rootSessionID) {
  const root = await protocol.session(rootSessionID);
  if (root.id !== rootSessionID) throw new Error("Refreshed public root identity conflicts.");
  const sessionTree = [{ requestedParentID: null, session: root }], owned = new Set([rootSessionID]);
  const messages = await protocol.messages(rootSessionID);
  async function visit(parentID) {
    for (const child of await protocol.sessions(parentID)) {
      if (!child.id || owned.has(child.id) || child.parentID !== parentID)
        throw new Error("Refreshed public tree contains a duplicate or conflicting child.");
      owned.add(child.id); sessionTree.push({ requestedParentID: parentID, session: child });
      messages.push(...await protocol.messages(child.id));
      await visit(child.id);
    }
  }
  await visit(rootSessionID);
  const ownedSessionIDs = [...owned];
  return { sessionTree, messages, ownedSessionIDs, activity: await observeSessionActivity(protocol, ownedSessionIDs) };
}

function returnedChild(protocol, result, rootID) {
  if (!result || typeof result !== "object" || result.error || result.metadata?.error === true) return null;
  if (protocol === "native-v2") {
    const output = result.output;
    if (!output || typeof output !== "object" || typeof output.sessionID !== "string"
      || !["completed", "running"].includes(output.status) || typeof output.output !== "string"
      || result.metadata?.sessionID !== output.sessionID || result.metadata.status !== output.status) return null;
    return { id: output.sessionID, status: output.status, source: "native-subagent-output-and-metadata" };
  }
  if (typeof result.output !== "string" || result.metadata?.parentSessionId !== rootID) return null;
  const match = result.output.match(/^<task id="([^"\n]+)" state="(completed|running)">\n/);
  if (!match || result.metadata?.sessionId !== match[1]) return null;
  return { id: match[1], status: match[2], source: "v1-task-metadata-and-engine-rendered-envelope" };
}

/** A name/count or model-written ID is insufficient. The runner supplies its
 * exact public list rows, scoped histories, terminal activity and verified AFTERs. */
export function evaluateDelegationExecution(assertion, summary, context = {}) {
  if (assertion.scope !== "subtree") throw new Error("Delegation requires explicit owned-subtree assertion scope.");
  if (!Number.isSafeInteger(assertion.minimumDirectChildren) || assertion.minimumDirectChildren < 2)
    throw new Error("Delegation requires an explicit minimum of at least two distinct direct children.");
  const protocol = context.engineProtocol;
  if (!["legacy-v1", "native-v2"].includes(protocol) || !context.rootSessionID)
    throw new Error("Exact released protocol and owned root session are required.");
  const rootID = context.rootSessionID, owned = new Set(context.ownedSessionIDs ?? []);
  if (!owned.has(rootID) || owned.size !== context.ownedSessionIDs?.length
    || !Array.isArray(context.sessionTree) || !Array.isArray(context.subtreeMessages)
    || context.toolTraceCompleteness?.captureIntegrityVerified !== true
    || context.toolTraceCompleteness?.completeAsExposed !== true)
    throw new Error("A complete verified owned tree, public histories and tool trace are required.");
  const rows = new Map();
  for (const row of context.sessionTree) {
    const session = row.session;
    if (!session?.id || rows.has(session.id) || !owned.has(session.id))
      throw new Error("Duplicate or foreign public session row.");
    if (session.id === rootID) {
      if (row.requestedParentID !== null || session.parentID != null) throw new Error("The created root identity conflicts.");
    } else if (session.parentID !== row.requestedParentID || !owned.has(row.requestedParentID)) {
      throw new Error("Public child identity conflicts with the exact requested parent.");
    }
    rows.set(session.id, row);
  }
  if (rows.size !== owned.size || !rows.has(rootID)) throw new Error("Missing exact owned session rows.");
  for (const id of owned) {
    const visited = new Set(); let current = id;
    while (current !== rootID) {
      if (visited.has(current) || !rows.has(current)) throw new Error("The public session tree is cyclic or disconnected.");
      visited.add(current); current = rows.get(current).requestedParentID;
    }
  }
  const activity = context.subtreeActivity;
  if (!activity || !Array.isArray(activity.unsettledSessionIDs) || activity.unsettledSessionIDs.length
    || !activity.active || typeof activity.active !== "object" || !activity.inboxBySessionID
    || Object.keys(activity.inboxBySessionID).length !== owned.size
    || [...owned].some(id => !Array.isArray(activity.inboxBySessionID[id]) || activity.inboxBySessionID[id].length
      || (protocol === "native-v2" ? activity.active[id]?.type === "running" : ["busy", "retry"].includes(activity.active[id]?.type))))
    throw new Error("The exact owned subtree has not authoritatively settled.");
  for (const entry of context.subtreeMessages) {
    const id = identity(entry), explicit = entry.info?.sessionID ?? entry.sessionID;
    if (!owned.has(id) || explicit !== undefined && explicit !== id)
      throw new Error("A history response conflicts with its exact requested session.");
  }
  const tool = protocol === "native-v2" ? "subagent" : "task";
  const used = new Set(), proven = new Map(), rejected = [];
  for (const call of summary.tools) {
    if (call.sessionID !== rootID || call.protocol !== protocol || call.tool !== tool || call.state?.status !== "completed"
      || typeof call.messageID !== "string" || !call.messageID || typeof (call.callID ?? call.id) !== "string"
      || !Object.hasOwn(call.state, "input")) continue;
    const events = (context.toolExecutions ?? []).filter(event => event.phase === "after" && event.status === "completed"
      && !event.error && event.sessionID === rootID && (event.toolID ?? event.tool) === tool
      && ((event.callID ?? event.id) === (call.callID ?? call.id)
        || protocol === "legacy-v1" && (event.callID ?? event.id) === call.id)
      && (event.messageID === call.messageID || protocol === "legacy-v1" && event.messageID === undefined)
      && canonical(event.input) === canonical(call.state.input)
      && typeof event.observerInstance === "string" && event.observerInstance.length > 0
      && Number.isSafeInteger(event.sequence) && event.sequence > 0 && event.result !== undefined);
    if (events.length !== 1) { rejected.push({ reason: "Missing or ambiguous exact successful AFTER", callSha256: digest(call.callID ?? call.id) }); continue; }
    const event = events[0], key = canonical([event.observerInstance, event.sequence]);
    if (used.has(key)) { rejected.push({ reason: "One AFTER cannot establish two invocations" }); continue; }
    used.add(key);
    const returned = returnedChild(protocol, event.result, rootID);
    if (!returned || rows.get(returned.id)?.requestedParentID !== rootID) {
      rejected.push({ reason: "Actual return does not identify an exact direct child" }); continue;
    }
    const entries = context.subtreeMessages.filter(entry => identity(entry) === returned.id && assistant(entry));
    const last = entries.at(-1);
    const completion = last && info(last).time?.completed;
    const completedAt = typeof completion === "number" ? completion : Date.parse(completion);
    if (!last || typeof info(last).id !== "string" || !info(last).id || !Number.isFinite(completedAt) || info(last).error || !text(last).trim()
      || ["failed", "interrupted"].includes(rows.get(returned.id).session.outcome)) {
      rejected.push({ childID: returned.id, reason: "Child lacks a completed substantive assistant response" }); continue;
    }
    // Resuming the same child never creates another independent reviewer.
    const evidence = { childID: returned.id, parentID: rootID, returnStatus: returned.status, returnIdentitySource: returned.source,
      actualAfter: { observerInstance: event.observerInstance, sequence: event.sequence, recordSha256: event.recordSha256,
        callSha256: digest(call.callID ?? call.id), pairing: event.pairing, elapsedMs: event.elapsedMs ?? null },
      childAssistantMessages: entries.length, terminalMessageID: info(last).id,
      terminalTextSha256: createHash("sha256").update(text(last)).digest("hex"),
      actualModels: entries.map(entry => ({ messageID: info(entry).id, providerID: info(entry).model?.providerID ?? info(entry).providerID,
        modelID: info(entry).model?.id ?? info(entry).modelID, variant: info(entry).model?.variant ?? info(entry).variant ?? null })) };
    if (!proven.has(returned.id)) proven.set(returned.id, evidence);
  }
  return { passed: proven.size >= assertion.minimumDirectChildren,
    evidence: { minimumDirectChildren: assertion.minimumDirectChildren, distinctProvenDirectChildren: [...proven.values()], rejected,
      source: "public-parent-linked-child-sessions+scoped-full-history+exact-successful-public-tool-AFTER",
      limitations: ["V1 public hooks omit messageID; exact owned session/call/input remain required.",
        "Child model choices and execution order remain natural. This criterion does not grade legal substance or prove simultaneous execution.",
        "A background return proves admission only; independent terminal child history and settled activity are also required."] } };
}
