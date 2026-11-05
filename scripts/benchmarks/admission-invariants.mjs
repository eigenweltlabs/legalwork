export function sessionFromUI(ui) {
  const value = /\/session\/([^/?#]+)/.exec(ui?.route ?? "")?.[1];
  return value ? decodeURIComponent(value) : null;
}

export function assertTaskSession(ui, expected, phase) {
  if (!expected || sessionFromUI(ui) !== expected) throw new Error(`Exact newly created task session lost UI scope ${phase}; no other chat may be used as task evidence`);
  return true;
}

export function selectedModelEvidence(session, pinned, context = {}) {
  const actual = session?.model;
  if (!actual || typeof actual !== "object") {
    const configuredDefault = context.protocol === "native-v2"
      ? nativeVariantEvidence({ id: pinned.modelID, providerID: pinned.providerID }, pinned, context.nativeCatalog) : undefined;
    return { available: false, ...(configuredDefault ? { configuredDefault, selectionNotExposed: true } : {}), reason: "This engine session API does not expose its selected model/variant; complete provider wire remains mandatory evidence." };
  }
  if (context.protocol === "native-v2") return { available: true, actual, variantAvailable: actual.variant !== undefined,
    effectiveVariant: nativeVariantEvidence(actual, pinned, context.nativeCatalog) };
  const modelID = actual.id ?? actual.modelID;
  if (modelID !== pinned.modelID || actual.providerID !== pinned.providerID || pinned.variant && actual.variant !== undefined && actual.variant !== pinned.variant) throw new Error("Actual selected native model/variant differs from pinned primary contract before admission");
  return { available: true, actual, variantAvailable: actual.variant !== undefined };
}

export function primaryMessageIntegrity(messages, pinned, context = {}) {
  const effectiveVariants = [], invalid = messages.filter(message => {
    if (context.protocol === "native-v2") {
      try { effectiveVariants.push({ messageID: message.id, ...nativeVariantEvidence({ id: message.modelID, providerID: message.providerID, variant: message.variant }, pinned, context.nativeCatalog) }); return false; }
      catch (error) { effectiveVariants.push({ messageID: message.id, error: String(error) }); return true; }
    }
    return message.modelID !== pinned.modelID || message.providerID !== pinned.providerID || pinned.variant && message.variant !== undefined && message.variant !== pinned.variant;
  });
  return { invalid, effectiveVariants, variantMissingMessageIDs: messages.filter(message => message.variant === undefined).map(message => message.id), expected: pinned, note: "Missing metadata is not fabricated. Native default equivalence requires exact complete public catalog overlays plus server default intent; actual primary wire settings independently remain mandatory." };
}

export function providerWireIntegrity(traces, pinned, rootSessionIDs, descendantIDs) {
  const roots = new Set(rootSessionIDs), children = new Set(descendantIDs);
  const expectedReasoning = pinned.variant;
  const requests = traces.map(trace => {
    const sessionID = trace.requestContext?.sessionID ?? null;
    const sessionScope = roots.has(sessionID) ? "root" : children.has(sessionID) ? "descendant" : "unknown";
    // Session headers do not distinguish native title/compaction/main calls.
    // Use only a positive read-only observer kind if separately captured.
    const kind = trace.requestContext?.verifiedKind ?? "unattributed";
    const primary = sessionScope === "root" && kind === "primary";
    const effort = trace.generationSettings?.reasoning_effort ?? trace.generationSettings?.reasoning?.effort ?? null;
    const backendKnown = trace.actualBackend?.verifiedMapping === true;
    const agreesWithMain = backendKnown && trace.actualBackend.model === pinned.backendModel && trace.model === pinned.modelID && (!expectedReasoning || effort === expectedReasoning);
    return { requestId: trace.id, sessionID, sessionScope, kind, primary, intendedModel: trace.model, actualBackend: trace.actualBackend, reasoningEffort: effort, backendKnown, agreesWithMain };
  });
  const wrongPrimary = requests.filter(request => request.primary && !request.agreesWithMain);
  const unresolved = requests.filter(request => !request.backendKnown || !request.primary && request.sessionScope !== "descendant" && request.kind === "unattributed" && !request.agreesWithMain);
  const primaryEvidence = requests.filter(request => request.primary || request.kind === "unattributed" && request.sessionScope !== "descendant");
  const attributedPrimary = requests.filter(request => request.primary);
  const roleUnknown = requests.filter(request => request.sessionScope === "unknown" || request.sessionScope === "root" && request.kind === "unattributed");
  const mainModelSettingsConsistent = primaryEvidence.length > 0 && wrongPrimary.length === 0 && unresolved.length === 0;
  const state = wrongPrimary.length ? "primary-contract-mismatch" : unresolved.length ? "inconclusive-attribution-or-backend" : !primaryEvidence.length ? "inconclusive-no-primary-wire-evidence" : attributedPrimary.length ? "primary-contract-proven" : "main-settings-observed-role-unattributed";
  return { primaryEvidenceRequestIDs: primaryEvidence.map(request => request.requestId), positivelyAttributedPrimaryRequestIDs: attributedPrimary.map(request => request.requestId), requests, expectedPrimary: pinned, wrongPrimary, unresolved, mainModelSettingsConsistent, roleAttributionComplete: roleUnknown.length === 0, roleUnknownRequestIDs: roleUnknown.map(request => request.requestId), state, controlledPerformanceState: !mainModelSettingsConsistent ? state : roleUnknown.length ? "inconclusive-role-attribution" : "model-contracts-and-role-inventory-observed", proof: attributedPrimary.length ? "positive-observer-kind-plus-complete-wire" : "all-captured-potential-primary-wires-match-but-primary-role-is-not-attributed", note: "Matching complete wire settings do not establish request roles. Child/title/auxiliary choices are observed, never forced to the primary variant. Legal artifact outcomes remain separate from controlled performance attribution." };
}
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonical } from "./tool-journal.mjs";

const catalogSource = "legalwork-native-public-model-list";
const overlayKeys = ["settings", "headers", "body"];
const modelKeys = new Set(["id", "modelID", "providerID", "canonical", "family", "name", "compatibility", "package", ...overlayKeys,
  "capabilities", "variants", "time", "cost", "status", "enabled", "limit", "legalwork"]);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

function json(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(json);
  return record(value) && Object.values(value).every(json);
}
function overlays(value, label) {
  for (const key of overlayKeys) {
    if (value[key] === undefined) continue;
    if (!record(value[key]) || !json(value[key]) || key === "headers" && Object.values(value[key]).some(item => typeof item !== "string"))
      throw new Error(`Invalid complete native ${label} ${key} overlay`);
  }
}
function headers(value) {
  if (value === undefined) return undefined;
  const normalized = {};
  for (const [name, item] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (Object.hasOwn(normalized, key) && normalized[key] !== item) throw new Error("Ambiguous native header overlay");
    Object.defineProperty(normalized, key, { value: item, enumerable: true, configurable: true });
  }
  return normalized;
}
// Pinned core/provider.ts:231-270: records merge recursively, arrays/scalars
// replace; headers merge case-insensitively. Compare every exposed field,
// including unknown nested provider settings, without interpreting their names.
function merge(base, overlay) {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overlay)])].map(key => {
    const left = base[key], right = overlay[key];
    return [key, right === undefined ? left : record(left) && record(right) ? merge(left, right) : right];
  }));
}
function effective(model, variant) {
  return Object.fromEntries(overlayKeys.filter(key => model[key] !== undefined || variant?.[key] !== undefined)
    .map(key => [key, key === "headers" ? merge(headers(model[key]), headers(variant?.[key])) : merge(model[key], variant?.[key])]));
}

/** The source marker is supplied only by the controller's fresh native HTTP
 * read. LegalWork's defaultVariantID is authoritative server metadata computed
 * before secret transport fields are removed; no hidden values are guessed. */
export function nativeModelCatalogEvidence(catalog, pinned) {
  if (catalog?.source !== catalogSource || catalog.complete !== true || !Array.isArray(catalog.models))
    throw new Error("Complete authoritative native public model catalog required");
  const matches = catalog.models.filter(model => model?.providerID === pinned.providerID && model?.id === pinned.modelID);
  if (matches.length !== 1) throw new Error("Exact unique native provider/model catalog record required");
  const model = matches[0];
  if (!json(model) || Object.keys(model).some(key => !modelKeys.has(key)) || typeof model.modelID !== "string" || !model.modelID
    || ["id", "modelID", "providerID", "name", "capabilities", "variants", "time", "cost", "status", "enabled", "limit", "settings", "body", "legalwork"].some(key => !Object.hasOwn(model, key))
    || typeof model.name !== "string" || model.enabled !== true || !record(model.capabilities) || !record(model.time)
    || typeof model.capabilities.tools !== "boolean" || !Array.isArray(model.capabilities.input) || !Array.isArray(model.capabilities.output)
    || !Number.isFinite(model.time.released) || !["alpha", "beta", "deprecated", "active"].includes(model.status)
    || !Array.isArray(model.cost) || !record(model.limit) || !Number.isInteger(model.limit.context) || !Number.isInteger(model.limit.output)
    || !Array.isArray(model.variants) || !record(model.legalwork) || Object.keys(model.legalwork).some(key => key !== "defaultVariantID")
    || !(model.legalwork.defaultVariantID === null || typeof model.legalwork.defaultVariantID === "string"))
    throw new Error("Unknown or incomplete native public model record");
  overlays(model, "model");
  const ids = new Set();
  for (const variant of model.variants) {
    if (!record(variant) || typeof variant.id !== "string" || !variant.id || ids.has(variant.id)
      || Object.keys(variant).some(key => !["id", ...overlayKeys].includes(key))) throw new Error("Unknown or duplicate native variant record");
    ids.add(variant.id); overlays(variant, "variant");
  }
  const expected = pinned.variant === undefined || pinned.variant === "default" ? undefined : model.variants.find(item => item.id === pinned.variant);
  if (pinned.variant !== undefined && pinned.variant !== "default" && !expected) throw new Error("Pinned native variant is absent from the complete catalog");
  return { source: catalogSource, model, modelSha256: digest(model), expectedEffective: effective(model, expected),
    expectedVariant: pinned.variant ?? null, configuredDefaultVariantID: model.legalwork.defaultVariantID,
    privateTransportFields: "Not exposed or reconstructed. Configured default intent is the server's projection metadata; actual provider wires remain separately mandatory." };
}

export function assertNativeModelCatalogUnchanged(before, after, pinned) {
  const initial = nativeModelCatalogEvidence(before, pinned), current = nativeModelCatalogEvidence(after, pinned);
  if (initial.modelSha256 !== current.modelSha256) throw new Error("Complete native public model catalog record changed during the benchmark");
  return { modelSha256: current.modelSha256, completeExposedRecordUnchanged: true };
}

/** Bypass the protocol's readiness cache for each admission and terminal
 * observation. The driver retains the complete HTTP request and response. */
export async function observeNativeModelCatalog(driver, directory) {
  if (typeof directory !== "string" || !directory) throw new Error("Exact native model-catalog location required");
  const response = await driver.engine(`/api/model?${new URLSearchParams({ "location[directory]": directory })}`);
  if (!Array.isArray(response?.data)) throw new Error("Complete native public model response required");
  return { source: catalogSource, complete: true, models: response.data };
}

function nativeVariantEvidence(actual, pinned, catalog) {
  const evidence = nativeModelCatalogEvidence(catalog, pinned);
  const modelID = actual?.id ?? actual?.modelID;
  if (actual?.providerID !== pinned.providerID || modelID !== pinned.modelID) throw new Error("Native provider/model differs from pinned primary contract");
  const variantID = actual.variant;
  if (variantID !== undefined && typeof variantID !== "string") throw new Error("Invalid native variant identity");
  const isDefault = variantID === undefined || variantID === "default";
  const variant = isDefault ? undefined : evidence.model.variants.find(item => item.id === variantID);
  if (!isDefault && !variant) throw new Error("Actual native variant is absent from the complete catalog");
  if (isDefault && pinned.variant !== undefined && pinned.variant !== "default" && evidence.configuredDefaultVariantID !== pinned.variant)
    throw new Error("Native default intent does not identify the pinned named variant");
  const actualEffective = effective(evidence.model, variant);
  if (!isDeepStrictEqual(actualEffective, evidence.expectedEffective)) throw new Error("Native effective settings/headers/body differ from the pinned variant");
  return { actualVariantID: variantID ?? null, expectedVariantID: pinned.variant ?? null, modelSha256: evidence.modelSha256,
    configuredDefaultVariantID: evidence.configuredDefaultVariantID, actualEffectiveSha256: digest(actualEffective),
    expectedEffectiveSha256: digest(evidence.expectedEffective), exactExposedOverlaysEquivalent: true,
    identity: isDefault ? "native-default-resolves-to-verified-configured-base" : "native-named-variant",
    privateTransportFields: evidence.privateTransportFields, actualWireStillRequired: true };
}

