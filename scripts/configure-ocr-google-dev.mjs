// Run with Bun after starting the isolated OCR platform, Gateway and desktop.
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ocrDevEnvironment } from "./dev-electron-ocr.mjs";
import { readEigenweltConnection, writeEigenweltConnection } from "../apps/server/src/eigenwelt-connection-store.ts";
import { writeCachedEigenweltPaidManifest } from "../apps/server/src/eigenwelt-paid-manifest.ts";

const env = ocrDevEnvironment({ ...process.env, LEGALWORK_OCR_DEV_ROOT: join(homedir(), ".legalwork/ocr-google-dev") });
Object.assign(process.env, env, { EIGENWELT_PLATFORM_URL: "http://127.0.0.1:3017" });
const directory = process.env.OCR_DEV_DIRECTORY ?? join(homedir(), ".config/eigenwelt-ocr-dev");
const input = JSON.parse(await readFile(join(directory, "desktop-google-dev.json"), "utf8"));
if (input.platformURL !== "http://127.0.0.1:3017" || input.baseURL !== "http://127.0.0.1:8093/v1"
    || input.account.orgId !== "org_synthetic_ocr_dev") throw new Error("Use the isolated synthetic Google OCR fixture.");
const config = { configPath: env.LEGALWORK_SERVER_CONFIG };
const previous = await readEigenweltConnection(config);
if (previous.account && previous.account.orgId !== input.account.orgId) throw new Error("This OCR profile already has another account. Its connection was preserved.");
await writeEigenweltConnection(config, { platformURL: input.platformURL, platformToken: input.platformToken,
  refreshToken: input.refreshToken, accessTokenExpiresAt: input.accessTokenExpiresAt, account: input.account });
await writeCachedEigenweltPaidManifest(config, { baseURL: input.baseURL, apiKey: input.apiKey, models: [] });
const profile = env.LEGALWORK_ELECTRON_USERDATA;
const state = JSON.parse(await readFile(join(profile, "legalwork-server-state.json"), "utf8"));
const credentials = JSON.parse(await readFile(join(profile, "legalwork-server-tokens.json"), "utf8")).workspaces[""];
const base = `http://127.0.0.1:${state.preferredPort}`;
async function api(route, body, method = "POST") {
  const response = await fetch(base + route, { method, headers: { authorization: `Bearer ${credentials.clientToken}`,
    "x-legalwork-host-token": credentials.hostToken, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(150_000) });
  if (!response.ok) throw new Error(`Google OCR Dev ${route} returned HTTP ${response.status}.`);
  await response.body?.cancel();
}
await api("/ocr/engines/cloud-google-eu/test", {});
await api("/ocr/default", { engineId: "cloud-google-eu" }, "PUT");
await writeFile(join(directory, "legalwork-google-ready.json"), JSON.stringify({ base, providerId: "cloud-google-eu", samplePassed: true }) + "\n", { mode: 0o600 });
console.log("Google OCR EU sample passed and is selected in the isolated LegalWork OCR Dev profile.");
