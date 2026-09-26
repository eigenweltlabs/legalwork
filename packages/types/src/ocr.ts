export type OcrApiType = "chat-completions" | "mistral-ocr" | "paddleocr";

export type OcrServerInput = {
  kind: OcrApiType;
  authentication: "api-key" | "none";
  label: string;
  endpoint: string;
  model: string;
  apiKey?: string;
  languages: string[] | null;
};

export type OcrSettingsView = {
  defaultEngineId: string;
  readOnly: boolean;
  installerAvailable: boolean;
  installation: { engineId: string; stage: "runtime" | "dependencies" | "models" | "checking" | "complete" | "failed" | "cancelled" } | null;
  engines: Array<{
    id: string;
    label: string;
    kind: "local" | OcrApiType;
    authentication?: "api-key" | "none";
    model: string;
    endpoint?: string;
    languages: string[] | null;
    keyConfigured: boolean;
    status: "ready" | "not-installed" | "unsupported" | "missing-key";
  }>;
};
