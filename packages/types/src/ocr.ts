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
  /** Absent on older servers. Layout is shared by all OCR providers, not a selectable OCR engine. */
  layout?: { model: string; bytes: number; status: "ready" | "not-installed" };
  engines: Array<{
    id: string;
    label: string;
    kind: "local" | OcrApiType;
    authentication?: "api-key" | "none";
    model: string;
    endpoint?: string;
    languages: string[] | null;
    keyConfigured: boolean;
    /** Set by the firm's policy: not editable here. Older servers omit it. */
    managed?: boolean;
    status: "ready" | "not-installed" | "unsupported" | "missing-key";
  }>;
};
