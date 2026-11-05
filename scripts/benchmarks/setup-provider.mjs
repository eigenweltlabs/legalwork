// Configure only the isolated benchmark profile using LegalWork's normal API.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { discoverElectron, createDriver } from "./electron-runner.mjs";
import { privateWrite, readJson } from "./evidence.mjs";
import { detectEngineProtocol } from "./engine-evidence.mjs";

/** Preserve the production mapper's complete model and generation settings.
 * The native branch uses the production migration adapter, not a second mapper. */
export function benchmarkProviderConfiguration({ modelID, model, capture, migrateProvider }) {
  const provider = { npm: "@ai-sdk/openai-compatible", name: "Migration benchmark", options: { baseURL: `${capture.baseURL}/v1`, apiKey: capture.localToken }, models: { [modelID]: model } };
  if (!migrateProvider) return { opencode: { provider: { benchmark: provider }, agent: { legalwork: { model: `benchmark/${modelID}` } } } };
  return { opencode: { providers: { benchmark: migrateProvider(provider) }, agents: { legalwork: { model: `benchmark/${modelID}` } } } };
}

export async function configureBenchmarkProvider({ root, repository, modelID = "Eigenwelt Europe Gemini", providerReadyTimeoutMs = 30_000, environment }) {
  if (!(providerReadyTimeoutMs > 0)) throw new Error("providerReadyTimeoutMs must be positive; this setup watchdog never constrains model execution");
  const capture = await readJson(join(root, "capture-connection.json"));
  const health = await fetch(`${capture.baseURL}/health`, { headers: { authorization: `Bearer ${capture.localToken}` } }).then(response => response.json());
  if (!health.ok || !health.budgetGuardOperational || health.budgetEvidence?.frozen) throw new Error("Operational budget/capture proxy required before configuring the test provider");
  const response = await fetch("https://platform.eigenweltlabs.com/api/public/models");
  if (!response.ok) throw new Error(`Public production model manifest HTTP ${response.status}`);
  const manifest = await response.json();
  const { parseManifestModels } = await import(pathToFileURL(resolve(repository, "apps/server/dist/eigenwelt-paid-manifest.js")).href);
  const { buildEigenweltModelsMap } = await import(pathToFileURL(resolve(repository, "apps/server/dist/eigenwelt-auth.js")).href);
  const models = buildEigenweltModelsMap(parseManifestModels(manifest.models));
  if (!models[modelID]) throw new Error("The production mapper does not expose the requested model");
  const connection = environment ? await environment.discover() : await discoverElectron(join(root, "electron"), join(root, "workspace"));
  const driver = createDriver(connection, join(root, `provider-setup-${Date.now()}`));
  const native = (await detectEngineProtocol(driver, connection.workspace.path)).id === "native-v2";
  const migrateProvider = native ? (await import(pathToFileURL(resolve(repository, "apps/server/dist/native-opencode-config.js")).href)).nativeProvider : undefined;
  // The controller's capture listener and the guest's reverse-forward listener
  // may use different ports. Only the verified guest endpoint belongs in the
  // engine configuration; health/traces continue using the host endpoint.
  if (environment && typeof environment.providerCapture !== "function") throw new Error("Remote provider setup requires an explicit verified guest capture transport");
  const providerCapture = environment ? await environment.providerCapture(capture) : capture;
  const body = benchmarkProviderConfiguration({ modelID, model: models[modelID], capture: providerCapture, migrateProvider });
  const contract = native ? body.opencode.providers.benchmark.models[modelID] : models[modelID];
  await privateWrite(join(root, "provider-model-contract.json"), { source: "https://platform.eigenweltlabs.com/api/public/models", timestamp: new Date().toISOString(), runtimeKind: native ? "released-v2-server" : "released-v1-server", modelID, model: models[modelID], runtimeModel: contract, note: "Complete production manifest mapping and, for native v2, production nativeProvider conversion. Only provider transport credential/base URL use the guarded local proxy. No inference or model selection UI bypass." });
  const patch = await fetch(`${connection.base}/workspace/${connection.workspace.id}/config`, { method: "PATCH", headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!patch.ok) throw new Error(`Isolated provider configuration HTTP ${patch.status}; no inference was attempted`);
  if (native) {
    // model.list activates this trusted location's native configuration/catalog.
    // Retain the authoritative model after reload; no synthetic prompt is used.
    const started = performance.now();
    const { benchmarkModelTransportFingerprint } = await import(pathToFileURL(resolve(repository, "apps/server/dist/benchmarks/model-transport.js")).href);
    const expectedTransport = benchmarkModelTransportFingerprint(`${providerCapture.baseURL}/v1`, providerCapture.localToken);
    let observed;
    let attestation;
    do {
      const catalog = await driver.engine(`/api/model?${new URLSearchParams({ "location[directory]": connection.workspace.path })}`);
      observed = catalog.data?.find(model => model.providerID === "benchmark" && model.id === modelID);
      // Verify this generation sees the current guarded transport, not a stale
      // model with the same ID from before the configuration watcher reload.
      if (observed) {
        try { attestation = await driver.modelTransport(modelID); }
        catch (error) { if (error.code !== "benchmark_model_unavailable") throw error; }
        if (attestation?.providerID === "benchmark" && attestation.modelID === modelID && attestation.algorithm === "sha256" && attestation.fingerprint === expectedTransport) break;
      }
      observed = undefined;
      if (performance.now() - started >= providerReadyTimeoutMs) throw new Error("Configured native benchmark model is not available before the explicit setup watchdog; no inference was attempted. Resolve project approval/configuration and run setup again.");
      await delay(100);
    } while (!observed);
    await privateWrite(join(root, "provider-native-catalog.json"), { observed, transportAttestation: attestation, source: "sanitized-native-model-list-and-host-transport-attestation", timestamp: new Date().toISOString(), readiness: { providerReadyTimeoutMs, pollIntervalMs: 100, elapsedMs: performance.now() - started, reason: "Only bounds observing a configuration reload before inference; never cancels or limits agent execution." } });
  }
  return { configured: true, providerID: "benchmark", modelID, runtimeKind: native ? "released-v2-server" : "released-v1-server", limits: contract.limit, inferenceCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const root = option("--root"), repository = option("--repo");
  if (!root || !repository) throw new Error("--root and --repo are required");
  const environmentPath=option("--environment");
  const environment=environmentPath ? await (await import("./packaged-environment.mjs")).createPackagedEnvironment(environmentPath):undefined;
  console.log(JSON.stringify(await configureBenchmarkProvider({ root, repository, environment, modelID: option("--model"), providerReadyTimeoutMs: Number(option("--provider-ready-timeout-ms") ?? 30_000) })));
}
