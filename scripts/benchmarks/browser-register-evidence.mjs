// Controller-only grading. An answer, generated code or Code Mode metadata alone
// cannot establish that a browser action or download actually completed.
import { createHash } from "node:crypto";
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
const browserTool = name => typeof name === "string" && (name.startsWith("browser.") || name.startsWith("legalwork_browser_"));

export function browserDownloadKey(candidate) {
  return createHash("sha256").update(canonical([candidate.sessionID, candidate.messageID, candidate.callID, candidate.tool,
    candidate.observer.instance, candidate.observer.sequence, candidate.observer.recordSha256, candidate.file.id, candidate.file.path])).digest("hex");
}

function valueOf(result) {
  if (typeof result === "string") { try { return valueOf(JSON.parse(result)); } catch { return null; } }
  if (!result || typeof result !== "object" || result.error || result.isError || result.ok === false || result.metadata?.error === true) return null;
  if (result.output !== undefined) return valueOf(result.output);
  if (result.result !== undefined) return valueOf(result.result);
  if (result.content && !result.url && !result.tab && !result.downloads && !result.files) {
    const text = typeof result.content === "string" ? result.content : Array.isArray(result.content)
      ? result.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
    return valueOf(text);
  }
  return result;
}

function observedBrowserCalls(summary, context) {
  const calls = [];
  const mapping = context.toolIdentityMapping ?? [];
  function nativeIdentity(qualifiedName) {
    const matches = mapping.filter(item => item.qualifiedName === qualifiedName);
    return matches.length === 1 && typeof matches[0].id === "string" && matches[0].id
      && mapping.filter(item => item.id === matches[0].id).length === 1 ? matches[0] : null;
  }
  for (const parent of summary.tools) {
    if (parent.state?.status !== "completed" || parent.state.error || parent.state.metadata?.error === true
      || typeof parent.messageID !== "string" || !(context.ownedSessionIDs ?? []).includes(parent.sessionID)) continue;
    const identity = parent.callID ?? parent.id;
    if (typeof identity !== "string" || !identity) continue;
    let children = [];
    if (parent.protocol === "native-v2" && parent.tool === "execute") {
      children = (parent.state.metadata?.toolCalls ?? []).filter(child => child.status === "completed" && child.error === undefined && browserTool(child.tool))
        .flatMap(child => { const mapped = nativeIdentity(child.tool); return mapped ? [{ ...child, observedTool: mapped.id }] : []; });
    } else if (parent.protocol === "native-v2") {
      const mapped = mapping.filter(item => item.id === parent.tool && browserTool(item.qualifiedName));
      if (mapped.length === 1 && nativeIdentity(mapped[0].qualifiedName)) children = [{ tool: mapped[0].qualifiedName, observedTool: mapped[0].id, input: parent.state.input }];
    } else if (parent.protocol === "legacy-v1" && browserTool(parent.tool)) {
      children = [{ tool: parent.tool, observedTool: parent.tool, input: parent.state.input }];
    }
    for (const child of children) {
      for (const event of context.toolExecutions ?? []) {
        // The pinned V1 public AFTER hook omits messageID. Bind that absence
        // only through one exact owned persisted key; never invent a raw ID.
        const legacyMissingMessage = parent.protocol === "legacy-v1" && event.messageID === undefined;
        const uniquelyBoundLegacy = legacyMissingMessage && summary.tools.filter(call => call.protocol === "legacy-v1"
          && call.sessionID === parent.sessionID && (call.callID ?? call.id) === identity && call.tool === child.tool
          && canonical(call.state?.input) === canonical(child.input)).length === 1;
        if (event.phase !== "after" || event.status !== "completed" || event.error
          || event.sessionID !== parent.sessionID || !(event.messageID === parent.messageID || uniquelyBoundLegacy)
          || (event.callID ?? event.id) !== identity || (event.toolID ?? event.tool) !== child.observedTool
          || canonical(event.input) !== canonical(child.input)
          || typeof event.observerInstance !== "string" || !event.observerInstance
          || !Number.isSafeInteger(event.sequence) || event.sequence <= 0 || !/^[a-f0-9]{64}$/.test(event.recordSha256)) continue;
        const value = valueOf(event.result);
        const returnedTab = value?.tab?.id ?? value?.tab_id ?? value?.tabId ?? (typeof value?.id === "string" && value.id.startsWith("tab_") ? value.id : undefined);
        if (value && !(event.input?.tabID && returnedTab && event.input.tabID !== returnedTab)) calls.push({ tool: child.tool, input: event.input, value, sessionID: parent.sessionID,
          messageID: parent.messageID, callID: identity,
          observer: { instance: event.observerInstance, sequence: event.sequence, recordSha256: event.recordSha256,
            rawMessageID: event.messageID ?? null,
            messageBinding: legacyMissingMessage ? "unique-owned-call-tool-input-v1-public-hook-omits-messageID" : "exact-messageID",
            rawToolID: event.toolID ?? event.tool, qualifiedTool: child.tool } });
      }
    }
  }
  return calls;
}

const tabOf = call => call.input?.tabID ?? call.value.tab?.id ?? call.value.tab_id ?? call.value.tabId
  ?? (call.tool === "browser.tabs.open" ? call.value.id : undefined);
const urlOf = call => call.value.tab?.url ?? call.value.url ?? call.value.snapshot?.url;
function filtered(url, assertion) {
  try {
    const parsed = new URL(url), base = new URL(assertion.url);
    return parsed.origin === base.origin && parsed.pathname === "/register"
      && parsed.searchParams.get("entity") === assertion.entity && parsed.searchParams.get("agreement") === assertion.agreement
      && parsed.searchParams.get("status") === "executed" && parsed.searchParams.get("as_of") === assertion.asOf;
  } catch { return false; }
}

export function evaluateBrowserRegisterExecution(assertion, summary, context = {}) {
  const base = new URL(assertion.url);
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.pathname !== "/register"
    || !/^REG-\d{4}-\d{2}$/.test(assertion.rowID) || typeof assertion.filename !== "string" || !assertion.filename.endsWith(".pdf")
    || !Number.isSafeInteger(assertion.bytes) || assertion.bytes <= 0 || !/^[a-f0-9]{64}$/.test(assertion.sha256)) throw new Error("Exact synthetic site and complete document identity are required");
  const calls = observedBrowserCalls(summary, context);
  const requests = context.browserRegisterRequests;
  if (!Array.isArray(requests) || typeof context.browserFixtureInstanceID !== "string"
    || !context.browserFixtureInstanceID || requests.some(record => record.fixtureInstanceID !== context.browserFixtureInstanceID)) {
    return { passed: false, evidence: { error: "One exact arm-owned controller fixture instance and real request receipts are required", observedBrowserCalls: calls.length } };
  }
  const usable = requests.filter(record => record.method === "GET" && record.status === 200 && record.deliveryCompleted === true);
  const filterRequests = usable.filter(record => record.path === "/register" && record.query?.entity === assertion.entity
    && record.query?.agreement === assertion.agreement && record.query?.status === "executed" && record.query?.as_of === assertion.asOf
    && Array.isArray(record.selectedRows) && record.selectedRows.includes(assertion.rowID));
  const selectedRequests = usable.filter(record => record.path === `/record/${assertion.rowID}` && record.rowID === assertion.rowID);
  const downloadRequests = usable.filter(record => record.path === `/attachment/${assertion.rowID}.pdf`
    && record.rowID === assertion.rowID && record.responseBytes === assertion.bytes && record.responseSha256 === assertion.sha256 && record.mime === "application/pdf");
  const openings = calls.filter(call => ["browser.tabs.open", "legalwork_browser_open_url"].includes(call.tool)
    && typeof tabOf(call) === "string" && typeof urlOf(call) === "string" && urlOf(call).startsWith(`${base.origin}/`));
  const completed = [];
  for (const opening of openings) {
    const tabID = tabOf(opening);
    const connections = calls.filter(call => call.sessionID === opening.sessionID
      && ["legalwork_browser_open_url", "legalwork_browser_connect"].includes(call.tool) && tabOf(call) === tabID && typeof call.value.browser_url === "string");
    const capabilities = new Set(connections.map(call => call.value.browser_url));
    const attached = calls.filter(call => call.sessionID === opening.sessionID && (tabOf(call) === tabID
      || capabilities.has(call.input?.browser_url)));
    const filterObserved = attached.some(call => filtered(urlOf(call), assertion));
    const selectionObserved = attached.some(call => urlOf(call) === `${base.origin}/record/${assertion.rowID}`);
    // LegalWork extensions publish only a completed, successfully saved download.
    const extensionDownloads = attached.flatMap(call => (call.value.downloads ?? []).filter(file =>
      file.state === "completed" && !file.error && file.transferRequired !== true && typeof file.id === "string"
      && file.name === assertion.filename && file.receivedBytes === assertion.bytes && file.totalBytes === assertion.bytes
      && typeof file.path === "string" && file.path.length > 0).map(file => ({ call, file })));
    // Native files.list proves completion; files.get proves the same file was
    // transferred, with its complete identity and saved path, in this same tab.
    const listed = attached.filter(call => call.tool === "browser.files.list").flatMap(call => (call.value.files ?? [])
      .filter(file => file.state === "completed" && file.name === assertion.filename && file.bytes === assertion.bytes)
      .map(file => ({ call, file })));
    const nativeDownloads = attached.filter(call => call.tool === "browser.files.get").flatMap(call => (call.value.files ?? [])
      .filter(file => typeof file.path === "string" && file.path.length > 0 && file.name === assertion.filename && file.bytes === assertion.bytes
        && file.id === call.input?.fileID && listed.some(prior => prior.file.id === file.id
          && prior.call.observer.instance === call.observer.instance && prior.call.observer.sequence < call.observer.sequence))
      .map(file => ({ call, file })));
    if (filterObserved && selectionObserved) completed.push(...extensionDownloads, ...nativeDownloads);
  }
  const identity = call => ({ tool: call.tool, sessionID: call.sessionID, messageID: call.messageID, callID: call.callID, tabID: tabOf(call), observer: call.observer });
  const candidates = completed.map(({ call, file }) => ({ ...identity(call), file }));
  const verified = candidates.flatMap(candidate => (context.browserDownloadReceipts ?? []).filter(receipt => {
    if (receipt.key !== browserDownloadKey(candidate) || receipt.sourcePath !== candidate.file.path
      || receipt.method !== "actual-app-uid-no-follow-file-bytes" || receipt.acquisition?.uid !== receipt.acquisition?.expectedUID
      || !(receipt.acquisition?.uid > 0) || receipt.acquisition?.regularFile !== true || receipt.acquisition?.noSymlinks !== true
      || !["workspace-downloads", "native-browser-temp"].includes(receipt.acquisition?.scope) || typeof receipt.contentBase64 !== "string") return false;
    const bytes = Buffer.from(receipt.contentBase64, "base64");
    return bytes.toString("base64") === receipt.contentBase64 && bytes.length === assertion.bytes
      && createHash("sha256").update(bytes).digest("hex") === assertion.sha256;
  }).map(receipt => ({ ...candidate, collectionKey: receipt.key, collectedFile: receipt.collectedFile, actualSha256: assertion.sha256, actualBytes: assertion.bytes })));
  return { passed: filterRequests.length > 0 && selectedRequests.length > 0 && downloadRequests.length > 0 && verified.length > 0,
    evidence: { filterRequests: filterRequests.map(record => record.id), selectedRequests: selectedRequests.map(record => record.id),
      fullAttachmentRequests: downloadRequests.map(record => record.id), observedBrowserCalls: calls.map(identity),
      completedOwnedDownloads: candidates, verifiedActualDownloadBytes: verified,
      note: "Requires real owned AFTER results, observed filtered/selected pages, completed download/transfer and a scoped app-UID read of that exact returned path's complete post-task bytes. This does not invent a historical download-time hash. Hashing a separate copied artifact is insufficient; artifact and legal analysis are additional assertions." } };
}
