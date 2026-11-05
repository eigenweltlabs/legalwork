import { createHash } from "node:crypto";

// Audited with a read-only production /model/info request on 2026-10-24.
// Amounts are the gateway's EUR prices, despite LiteLLM naming some fields USD.
// Each bound retains the model's complete natural input/output capacity.
export const budgetRateManifest = {
  version: 1,
  verifiedAt: "2026-10-24",
  currency: "EUR",
  scope: "gateway-metered-model-requests",
  sources: [
    "https://api.eigenweltlabs.com/model/info",
    "https://platform.eigenweltlabs.com/api/public/models",
    "https://github.com/eigenweltlabs/model-api/tree/252c627",
  ],
  models: Object.fromEntries([
    ["Gemini", {
      inputTokens: 1_048_576,
      outputTokens: 65_536,
      inputMicrosPerMillion: 1_550_000,
      // Take the largest positive output tariff (priority), plus the
      // separately published reasoning tariff. This deliberately overbooks.
      outputMicrosPerMillion: 10_500_000,
      deployments: ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"],
      notes: "Ordinary input/cache/output: EUR 1.55/0.40/6.65 per million. Bound includes 6.75 priority output + 3.75 reasoning.",
    }],
    ["Claude Sonnet", {
      inputTokens: 1_000_000,
      outputTokens: 128_000,
      // The 1h cache-write tariff is higher than ordinary uncached input.
      inputMicrosPerMillion: 4_400_000,
      outputMicrosPerMillion: 10_950_000,
      deployments: ["claude-sonnet-5-5 (Bedrock)", "claude-sonnet-5.5 (OpenRouter)"],
      notes: "Ordinary input/cache/output: EUR 2.95/0.50/10.95 per million; bound uses EUR 4.40 input for 1h cache writes.",
    }],
    ["Claude Opus", {
      inputTokens: 1_000_000,
      outputTokens: 128_000,
      inputMicrosPerMillion: 8_800_000,
      outputMicrosPerMillion: 21_650_000,
      deployments: ["claude-opus-5-5 (Bedrock)", "claude-opus-5.5 (OpenRouter)"],
      notes: "Ordinary input/cache/output: EUR 5.60/0.50/21.65 per million; bound uses EUR 8.80 input for 1h cache writes.",
    }],
  ].flatMap(([name, rate]) => ["Europe", "US"].map(region => [`Eigenwelt ${region} ${name}`, rate]))),
};

export const budgetRateManifestSha256 = createHash("sha256")
  .update(JSON.stringify(budgetRateManifest)).digest("hex");

// Public deployment identifiers only. The alias may fall back to an older
// Flash model; benchmarks must distinguish the actual deployment from its label.
export const auditedGatewayDeployments = {
  "29e13e7f-6939-406a-a5a6-1e2a9acb75db": { alias: "Eigenwelt Europe Gemini", model: "gemini-3.8-flash", order: 1 },
  "d70bb2c7-0adb-49a8-a33b-7480ae1ac540": { alias: "Eigenwelt Europe Gemini", model: "gemini-3.7-flash", order: 2 },
  "c76e0069-c7be-42b9-9c27-dd66a635dfd7": { alias: "Eigenwelt Europe Gemini", model: "gemini-3.6-flash", order: 3 },
  "0306d4d1-6546-479e-9b63-1845ce4ed075": { alias: "Eigenwelt Europe Claude Sonnet", model: "claude-sonnet-5.5", transport: "bedrock", order: 1 },
  "ea926a29-2ab7-47da-b9c4-02d41427a90d": { alias: "Eigenwelt Europe Claude Sonnet", model: "claude-sonnet-5.5", transport: "openrouter", order: 2 },
  "66ce3c7d-dc70-4ce4-92aa-7f864ade2af1": { alias: "Eigenwelt Europe Claude Opus", model: "claude-opus-5.5", transport: "bedrock", order: 1 },
  "19c3579e-45b1-406a-8ab6-fc51bbd80c53": { alias: "Eigenwelt Europe Claude Opus", model: "claude-opus-5.5", transport: "openrouter", order: 2 },
};

export const auditedGatewayDeploymentsSha256 = createHash("sha256")
  .update(JSON.stringify(auditedGatewayDeployments)).digest("hex");
