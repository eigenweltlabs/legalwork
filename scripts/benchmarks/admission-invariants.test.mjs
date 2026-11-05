import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTaskSession, selectedModelEvidence, primaryMessageIntegrity, providerWireIntegrity, nativeModelCatalogEvidence, assertNativeModelCatalogUnchanged, observeNativeModelCatalog } from "./admission-invariants.mjs";
const model={providerID:"benchmark",modelID:"Gemini",backendModel:"gemini-3.8-flash",variant:"medium"};
const nativeCatalog = () => ({ source: "legalwork-native-public-model-list", complete: true, models: [{
  id: "Gemini", modelID: "Gemini", providerID: "benchmark", name: "Gemini Flash", enabled: true, status: "active",
  capabilities: { tools: true, input: ["text"], output: ["text"] }, time: { released: 0 }, cost: [],
  limit: { context: 1048576, output: 65536 }, settings: { reasoningEffort: "medium", options: { includeUsage: true } }, body: {},
  variants: [{ id: "low", settings: { reasoningEffort: "low" } }, { id: "medium", settings: { reasoningEffort: "medium" }, body: {} }],
  legalwork: { defaultVariantID: "medium" },
}] });
const nativeContext = catalog => ({ protocol: "native-v2", nativeCatalog: catalog });

test("native default accepts only the complete catalog's equal configured base, with raw IDs and capacity preserved", () => {
  const catalog = nativeCatalog(), actual = { id: "Gemini", providerID: "benchmark", variant: "default" };
  const selected = selectedModelEvidence({ model: actual }, model, nativeContext(catalog));
  assert.equal(selected.actual.variant, "default");
  assert.equal(selected.effectiveVariant.configuredDefaultVariantID, "medium");
  assert.equal(selected.effectiveVariant.actualEffectiveSha256, selected.effectiveVariant.expectedEffectiveSha256);
  assert.equal(selected.effectiveVariant.actualWireStillRequired, true);
  assert.equal(catalog.models[0].limit.output, 65536);
  const missingSelection = selectedModelEvidence({}, model, nativeContext(catalog));
  assert.equal(missingSelection.available, false); assert.equal(missingSelection.selectionNotExposed, true);
  const check = primaryMessageIntegrity([{ id: "m", modelID: "Gemini", providerID: "benchmark", variant: "default" }], model, nativeContext(catalog));
  assert.deepEqual(check.invalid, []); assert.equal(check.effectiveVariants[0].actualVariantID, "default");
  assert.equal(nativeModelCatalogEvidence(catalog, model).model.limit.context, 1048576);
});

test("wrong model/provider, absent or ambiguous catalog, missing default intent and unknown variants fail closed", () => {
  const actual = { id: "Gemini", providerID: "benchmark", variant: "default" };
  for (const mutate of [
    value => { value.source = "guessed-models"; }, value => { value.complete = false; }, value => { value.models = []; },
    value => { value.models.push(structuredClone(value.models[0])); }, value => { value.models[0].providerID = "other"; },
    value => { value.models[0].id = "other"; }, value => { delete value.models[0].variants; },
    value => { delete value.models[0].legalwork; }, value => { value.models[0].legalwork.defaultVariantID = null; },
    value => { value.models[0].legalwork.defaultVariantID = "low"; },
    value => { value.models[0].variants.push({ id: "medium", settings: {} }); },
  ]) {
    const catalog = nativeCatalog(); mutate(catalog);
    assert.throws(() => selectedModelEvidence({ model: actual }, model, nativeContext(catalog)));
  }
  assert.throws(() => selectedModelEvidence({ model: actual }, model, nativeContext(undefined)), /catalog/);
  for (const wrong of [{ ...actual, providerID: "other" }, { ...actual, id: "other" }, { ...actual, variant: "unknown" }])
    assert.throws(() => selectedModelEvidence({ model: wrong }, model, nativeContext(nativeCatalog())));
  assert.equal(primaryMessageIntegrity([{ ...actual, modelID: "other", id: "m" }], model, nativeContext(nativeCatalog())).invalid.length, 1);
});

test("default equivalence compares every nested setting, body and header rather than just reasoning or a display label", () => {
  const actual = { id: "Gemini", providerID: "benchmark", variant: "default" };
  for (const mutate of [
    value => { value.models[0].settings.reasoningEffort = "low"; },
    value => { value.models[0].variants[1].settings.options = { includeUsage: false }; },
    value => { value.models[0].variants[1].settings.temperature = 0.9; },
    value => { value.models[0].variants[1].body = { reasoning: { effort: "low" } }; },
    value => { value.models[0].body = { extra: [1, 2] }; value.models[0].variants[1].body = { extra: [2, 1] }; },
    value => { value.models[0].variants[1].headers = { "X-Reasoning": "high" }; },
    value => { value.models[0].headers = { "X-Reasoning": "medium" }; value.models[0].variants[1].headers = { "x-reasoning": "high" }; },
    value => { value.models[0].variants[1].options = { temperature: 0.2 }; },
    value => { value.models[0].options = { temperature: 0.2 }; },
    value => { value.models[0].variants[1].settings.newEmptyObject = {}; },
  ]) {
    const catalog = nativeCatalog(); mutate(catalog);
    assert.throws(() => selectedModelEvidence({ model: actual }, model, nativeContext(catalog)));
  }
  const catalog = nativeCatalog(); catalog.models[0].headers = { "X-Reasoning": "medium" };
  catalog.models[0].variants[1].headers = { "x-reasoning": "medium" };
  assert.equal(selectedModelEvidence({ model: actual }, model, nativeContext(catalog)).effectiveVariant.exactExposedOverlaysEquivalent, true);
});

test("fresh catalog identity rejects changed complete records and independent actual wires still reject wrong reasoning", () => {
  const before = nativeCatalog(), after = structuredClone(before);
  assert.equal(assertNativeModelCatalogUnchanged(before, after, model).completeExposedRecordUnchanged, true);
  for (const mutate of [
    value => { value.models[0].settings.options.includeUsage = false; },
    value => { value.models[0].body = { alternate: true }; },
    value => { value.models[0].headers = { extra: "changed" }; },
    value => { value.models[0].limit.output = 32000; },
    value => { value.models[0].variants[0].settings.reasoningEffort = "high"; },
  ]) {
    const changed = nativeCatalog(); mutate(changed);
    assert.throws(() => assertNativeModelCatalogUnchanged(before, changed, model), /changed/);
  }
  const wrongWire = { id: "r", model: "Gemini", actualBackend: { verifiedMapping: true, model: "gemini-3.8-flash" },
    generationSettings: { reasoning_effort: "low" }, requestContext: { sessionID: "main", verifiedKind: "primary" } };
  assert.equal(providerWireIntegrity([wrongWire], model, ["main"], []).mainModelSettingsConsistent, false);
  assert.equal(providerWireIntegrity([], model, ["main"], []).mainModelSettingsConsistent, false);
});

test("each native admission/terminal catalog read is a fresh exact-location HTTP observation", async () => {
  const paths = [], first = nativeCatalog(), second = structuredClone(first);
  second.models[0].settings.options.includeUsage = false;
  const driver = { engine: async path => { paths.push(path); return { data: (paths.length === 1 ? first : second).models }; } };
  const before = await observeNativeModelCatalog(driver, "/task folder"), after = await observeNativeModelCatalog(driver, "/task folder");
  assert.deepEqual(paths, ["/api/model?location%5Bdirectory%5D=%2Ftask+folder", "/api/model?location%5Bdirectory%5D=%2Ftask+folder"]);
  assert.throws(() => assertNativeModelCatalogUnchanged(before, after, model), /changed/);
  await assert.rejects(observeNativeModelCatalog({ engine: async () => ({ data: null }) }, "/task"), /Complete/);
  await assert.rejects(observeNativeModelCatalog(driver, ""), /location/);
});

test("an enabled composer on an old chat never satisfies task session ownership",()=>{
  assert.equal(assertTaskSession({route:"/workspace/w/session/fresh"},"fresh","before-send"),true);
  assert.throws(()=>assertTaskSession({route:"/workspace/w/session/old",actions:[{id:"composer.send",disabled:false}]},"fresh","before-send"),/lost UI scope/);
  assert.throws(()=>assertTaskSession({route:"/workspace/w/session/fresh"},"other","after-send"),/lost UI scope/);
});

test("native selected/message wrong variant fails while missing V1 metadata remains honestly absent",()=>{
  assert.equal(selectedModelEvidence({},model).available,false);
  assert.throws(()=>selectedModelEvidence({model:{providerID:"benchmark",id:"Gemini",variant:"low"}},model),/differs/);
  assert.equal(primaryMessageIntegrity([{id:"v1",providerID:"benchmark",modelID:"Gemini"}],model).variantMissingMessageIDs[0],"v1");
  assert.equal(primaryMessageIntegrity([{providerID:"benchmark",modelID:"Gemini",variant:"low"}],model).invalid.length,1);
});

test("primary wires enforce medium without forcing known child/title variants or guessing missing roles",()=>{
  const trace={id:"r",model:"Gemini",actualBackend:{verifiedMapping:true,model:"gemini-3.8-flash"},generationSettings:{reasoning_effort:"medium"},requestContext:{sessionID:"main",verifiedKind:"primary"}};
  assert.equal(providerWireIntegrity([trace],model,["main"],[]).state,"primary-contract-proven");
  const child={...trace,id:"child",model:"Claude",generationSettings:{reasoning_effort:"high"},requestContext:{sessionID:"child"},actualBackend:{verifiedMapping:true,model:"claude-sonnet"}};
  assert.equal(providerWireIntegrity([trace,child],model,["main"],["child"]).state,"primary-contract-proven");
  const unknownTitle={...child,requestContext:{sessionID:"main"}};
  assert.equal(providerWireIntegrity([trace,unknownTitle],model,["main"],[]).state,"inconclusive-attribution-or-backend");
  const verifiedTitle={...unknownTitle,requestContext:{sessionID:"main",verifiedKind:"title"}};
  assert.equal(providerWireIntegrity([trace,verifiedTitle],model,["main"],[]).state,"primary-contract-proven");
  const wrong={...trace,generationSettings:{reasoning_effort:"low"},requestContext:{sessionID:"main",verifiedKind:"primary"}};
  assert.equal(providerWireIntegrity([wrong],model,["main"],[]).state,"primary-contract-mismatch");
});

test("matching headerless or root-session-only wires do not fabricate primary roles or controlled performance",()=>{
  const trace={id:"headerless",model:"Gemini",actualBackend:{verifiedMapping:true,model:"gemini-3.8-flash"},generationSettings:{reasoning_effort:"medium"}};
  for(const requestContext of [undefined,{sessionID:"main"}]) {
    const result=providerWireIntegrity([{...trace,requestContext}],model,["main"],[]);
    assert.equal(result.state,"main-settings-observed-role-unattributed");
    assert.equal(result.mainModelSettingsConsistent,true);
    assert.equal(result.controlledPerformanceState,"inconclusive-role-attribution");
    assert.equal(result.roleAttributionComplete,false);
    assert.deepEqual(result.positivelyAttributedPrimaryRequestIDs,[]);
  }
  const primary={...trace,id:"primary",requestContext:{sessionID:"main",verifiedKind:"primary"}};
  const title={...trace,id:"title",requestContext:{sessionID:"main",verifiedKind:"title"}};
  const proven=providerWireIntegrity([primary,title],model,["main"],[]);
  assert.equal(proven.state,"primary-contract-proven");
  assert.equal(proven.roleAttributionComplete,true);
  assert.equal(proven.controlledPerformanceState,"model-contracts-and-role-inventory-observed");
  const mixed=providerWireIntegrity([primary,trace],model,["main"],[]);
  assert.equal(mixed.state,"primary-contract-proven");
  assert.equal(mixed.controlledPerformanceState,"inconclusive-role-attribution");
});

test("empty or descendant-only captures cannot prove a primary model contract",()=>{
  assert.equal(providerWireIntegrity([],model,["main"],[]).state,"inconclusive-no-primary-wire-evidence");
  const child={id:"child",model:"Claude",actualBackend:{verifiedMapping:true,model:"claude-sonnet"},generationSettings:{reasoning_effort:"high"},requestContext:{sessionID:"child"}};
  const result=providerWireIntegrity([child],model,["main"],["child"]);
  assert.equal(result.state,"inconclusive-no-primary-wire-evidence");
  assert.deepEqual(result.primaryEvidenceRequestIDs,[]);
});
