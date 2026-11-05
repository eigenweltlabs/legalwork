import { canonical } from "./tool-journal.mjs";

const v1FailureSource = {
  commit: "16747470f976aca3d362ad730bcd3fe82ecc2c9a",
  ordinary: "packages/opencode/src/session/tools.ts:100-119",
  commandSubtask: "packages/opencode/src/session/prompt.ts:264-290,367-403",
};
const nativeAbortSource = {
  commit: "68bc26b7da1990ce10ffecfbc1e09eb13aa5d824",
  path: "packages/core/src/tool.ts:119-150;tool/runtime.ts:33-37;session/model-request.ts:378-399;session/runner/step.ts:133-155,267-279",
};
const nativeAbortMessages = new Set(["The user declined this tool call", "Tool execution interrupted"]);
const observerIdentity = record => canonical([record.observerInstance, record.sequence, record.recordSha256 ?? null]);
const httpSourceReceipt = "e6e96fdb2b3961c44b87b6ad67e3c9f4c05cbfedb3231b435d0a644574a62a3f";
function httpDisplayGroup(input) {
  if (typeof input?.url !== "string" || typeof input.method !== "string") return null;
  try {
    const url = new URL(input.url);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return { method: input.method.toUpperCase(), url: url.href };
  } catch { return null; }
}

/** Complete as exposed is distinct from complete raw return values. Never
 * manufacture an AFTER for a denied/cancelled call or a Code Mode extension. */
export function toolExecutionCoverage(summary, records, ownedSessionIDs, identityMapping = []) {
  const owned = new Set(ownedSessionIDs), usedAfter = new Set(), usedBefore = new Set();
  const missing = [], matched = [], unavailableFailureReturns = [];
  function consume(call, tool, input, source, expectedStatus = call.state?.status) {
    if (!["completed", "error"].includes(expectedStatus)) {
      missing.push({ tool, source, status: expectedStatus, reason: "Persisted invocation is not terminal" });
      return;
    }
    const mapped = identityMapping.filter(item => item.qualifiedName === tool);
    const httpGroup = call.protocol === "native-v2" && call.tool === "execute"
      && source === "code-mode-child-qualified-name" && tool === "fetch" ? httpDisplayGroup(input) : null;
    const effective = httpGroup ? "legalwork_raw_http" : mapped.length === 1 ? mapped[0].id : tool;
    // Pinned V1 command-subtask hooks use part.id while history persists a
    // separate part.callID ULID. This alternate identity is task-only.
    const legacyCommandPart = call.protocol === "legacy-v1" && tool === "task" && typeof call.id === "string";
    const sameCall = record => owned.has(record.sessionID) && record.sessionID === call.sessionID
      && (record.id === (call.callID ?? call.id) || legacyCommandPart && record.id === call.id)
      && record.tool === effective && (httpGroup ? canonical(httpDisplayGroup(record.input)) === canonical(httpGroup)
        : canonical(record.input) === canonical(input))
      && (record.messageID === call.messageID || call.protocol === "legacy-v1" && record.messageID === undefined);
    const candidates = records.map((record, index) => ({ record, index })).filter(({ record }) => sameCall(record));
    const after = candidates.find(({ record, index }) => !usedAfter.has(index) && record.phase === "after"
      && record.status === expectedStatus && (record.status === "completed" && record.result !== undefined
        || record.status === "error" && record.error !== undefined));
    const identity = { sessionID: call.sessionID, messageID: call.messageID, callID: call.callID ?? call.id, tool, source };
    const mappedIdentity = record => legacyCommandPart && record.id === call.id && call.callID !== call.id
      ? { observedCallID: record.id, persistedPartID: call.id, identitySource: "v1.18.29-command-subtask-hook-uses-part-id" } : {};
    if (after) {
      usedAfter.add(after.index);
      matched.push({ ...identity, observerInstance: after.record.observerInstance, sequence: after.record.sequence,
        status: after.record.status, pairing: after.record.pairing, ...mappedIdentity(after.record),
        ...(httpGroup ? { effectiveTool: effective, displayGroup: httpGroup, sourceReceiptSha256: httpSourceReceipt,
          identitySource: "source-pinned-codemode-fetch-to-private-native-http-transport",
          privatePayloadAvailability: "complete-input-and-result-retained-in-original-journal-not-public-progress",
          extensionCallID: null } : {}),
        rowIdentity: httpGroup ? "same-display-group-status-multiset-not-unique-extension-id"
          : after.record.pairing === "duplicate-concurrent-key-duration-unknown"
          ? "same-key-status-multiset-not-unique-child-id" : "exact-observed-key" });
      return;
    }
    const before = candidates.find(({ record, index }) => !usedBefore.has(index) && record.phase === "before"
      && typeof record.observerInstance === "string" && record.observerInstance.length > 0
      && Number.isSafeInteger(record.sequence) && record.sequence > 0);
    const afterCandidates = candidates.filter(({ record }) => record.phase === "after");
    const knownUnavailableAfter = ({ record }) => record.status === "unavailable"
      && record.resultAvailability === "v1-after-hook-provided-no-value" && record.result === undefined && record.error === undefined;
    const exposedV1Failure = call.protocol === "legacy-v1" && source === "persisted-tool" && expectedStatus === "error"
      && typeof call.state.error === "string" && call.state.error.length > 0 && Object.hasOwn(call.state, "input")
      && before && afterCandidates.every(knownUnavailableAfter);
    if (exposedV1Failure) {
      usedBefore.add(before.index);
      for (const row of afterCandidates) usedAfter.add(row.index);
      unavailableFailureReturns.push({ ...identity, ...mappedIdentity(before.record), protocol: "legacy-v1",
        evidenceKind: "engine-reported-terminal-failure-with-exact-observed-before", persistedState: call.state,
        before: { observerInstance: before.record.observerInstance, sequence: before.record.sequence,
          recordSha256: before.record.recordSha256, identity: observerIdentity(before.record) },
        observedUnavailableAfter: afterCandidates.map(({ record }) => ({ observerInstance: record.observerInstance,
          sequence: record.sequence, recordSha256: record.recordSha256, resultAvailability: record.resultAvailability })),
        rawReturnAvailable: false, durationMs: null, errorStage: "not-exposed", stackAvailability: "only-the-verbatim-engine-api-error-is-available",
        source: { commit: v1FailureSource.commit, path: legacyCommandPart && before.record.id === call.id && call.callID !== call.id ? v1FailureSource.commandSubtask : v1FailureSource.ordinary },
        note: "V1 has no guaranteed finally/after on thrown/denied/cancelled execution. This proves the reported terminal failure, not the stage of failure or a nonexistent returned value. Raw history and journal remain unchanged." });
      return;
    }
    // Native declines deliberately tunnel as defects, and interruption is not
    // a Tool.Error. Both settle in persisted history without an execute.after
    // value. Keep that absence explicit; never apply this to ordinary errors.
    const nativeAbort = call.protocol === "native-v2" && expectedStatus === "error"
      && call.state?.status === "error" && call.state.error?.type === "aborted"
      && nativeAbortMessages.has(call.state.error.message)
      && owned.has(call.sessionID) && typeof call.messageID === "string" && call.messageID.length > 0;
    const nativeIdentity = record => record.sessionID === call.sessionID && record.messageID === call.messageID
      && record.id === (call.callID ?? call.id) && record.tool === effective;
    const child = source === "code-mode-child-qualified-name";
    const childEntries = call.state?.metadata?.toolCalls?.filter(entry => entry.tool === tool && entry.status === "error") ?? [];
    const childWithoutInput = child && input === undefined;
    const nativeCandidates = records.map((record, index) => ({ record, index })).filter(({ record }) => nativeIdentity(record)
      && (childWithoutInput || canonical(record.input) === canonical(input)));
    const nativeBefore = nativeCandidates.filter(({ record, index }) => record.phase === "before" && !usedBefore.has(index)
      && typeof record.observerInstance === "string" && record.observerInstance.length > 0
      && Number.isSafeInteger(record.sequence) && record.sequence > 0);
    const nativeAfters = records.filter(record => nativeIdentity(record) && record.phase === "after");
    if (nativeAbort && !httpGroup && nativeBefore.length === 1 && nativeAfters.length === 0
      && (!child || mapped.length === 1 && identityMapping.filter(item => item.id === effective).length === 1 && childEntries.length === 1)
      && (child || Object.hasOwn(call.state, "input"))) {
      const { record, index } = nativeBefore[0]; usedBefore.add(index);
      unavailableFailureReturns.push({ ...identity, protocol: "native-v2",
        evidenceKind: "engine-reported-known-abort-with-exact-observed-before", persistedState: call.state,
        before: { observerInstance: record.observerInstance, sequence: record.sequence,
          recordSha256: record.recordSha256, identity: observerIdentity(record) },
        rawReturnAvailable: false, durationMs: null, errorStage: "native-decline-or-interruption-no-return",
        stackAvailability: "only-the-verbatim-engine-api-error-is-available", source: nativeAbortSource,
        ...(childWithoutInput ? { inputAvailability: "absent-from-interrupted-child-metadata;original-before-retained",
          identitySource: "unique-authoritative-catalog-child-and-exact-parent-context" } : {}),
        note: "No native AFTER, returned payload, finish timestamp or duration is synthesized. Full original BEFORE and terminal history remain unchanged." });
      return;
    }
    missing.push({ ...identity, input, status: expectedStatus,
      reason: "No exact authoritative AFTER or eligible source-backed V1 failure/native known abort; missing success, unknown lifecycle, status conflict, absent BEFORE, or extension output stays incomplete." });
  }
  for (const call of summary.tools) {
    if (!["completed", "error"].includes(call.state?.status)) {
      missing.push({ tool: call.tool, callID: call.callID ?? call.id, reason: "Persisted tool has not reached a terminal state" });
      continue;
    }
    consume(call, call.tool, call.state.input, "persisted-tool");
    if (call.protocol === "native-v2" && call.tool === "execute") {
      for (const child of call.state.metadata?.toolCalls ?? []) consume(call, child.tool, child.input, "code-mode-child-qualified-name", child.status);
    }
  }
  const completeAsExposed = missing.length === 0;
  return { contractVersion: 2, complete: completeAsExposed, completeAsExposed,
    fullRawReturnCoverage: completeAsExposed && unavailableFailureReturns.length === 0,
    matched, unavailableFailureReturns, missing,
    unmatchedObservedAfter: records.filter((record, index) => record.phase === "after" && owned.has(record.sessionID) && !usedAfter.has(index)),
    note: "Successful calls require full matching private after values. Only exact BEFORE plus source-backed V1 terminal failure or known native persisted abort may count as complete-as-exposed without a raw return. Native success and ordinary error after requirements remain strict. Qualified MCP names require authoritative catalog mapping; extension boundaries are not guessed." };
}

export function reconcileToolTrace(trace, coverage) {
  const accounted = new Set(coverage.unavailableFailureReturns.map(failure => failure.before.identity));
  const rawPendingBefore = trace.pendingBefore ?? [];
  const unaccountedPendingBefore = rawPendingBefore.filter(record => !accounted.has(observerIdentity(record)));
  return { contractVersion: 2, completeAsExposed: trace.captureIntegrityVerified === true && coverage.completeAsExposed === true
      && (trace.afterWithoutBefore ?? []).length === 0 && unaccountedPendingBefore.length === 0,
    fullRawReturnCoverage: trace.captureIntegrityVerified === true && trace.complete === true && coverage.fullRawReturnCoverage === true,
    captureIntegrityVerified: trace.captureIntegrityVerified === true,
    rawJournalLifecycleComplete: trace.complete === true, rawPendingBefore,
    accountedEngineReportedFailures: coverage.unavailableFailureReturns,
    unaccountedPendingBefore, afterWithoutBefore: trace.afterWithoutBefore ?? [],
    note: "The verified raw journal and pending counts are preserved. Source-backed failed V1 executions and known native aborts are reconciled only for lifecycle-as-exposed coverage; no AFTER/result/duration is fabricated." };
}
