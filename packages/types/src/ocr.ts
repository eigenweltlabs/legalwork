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
  autoDownload?: boolean;
  autoDownloadLocked?: boolean;
  readOnly: boolean;
  installerAvailable: boolean;
  installation: { engineId: string; stage: "runtime" | "dependencies" | "models" | "checking" | "complete" | "failed" | "cancelled";
    /** Current file transfer; omitted for setup stages and older servers. */
    download?: { received: number; total: number };
  } | null;
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
    /** Maximum download for the engine itself; shared models may already exist. */
    downloadBytes?: number;
    /** One of the firm's engines: whose key it uses. Older servers omit it. */
    firmKey?: "firm" | "member";
    status: "ready" | "not-installed" | "unsupported" | "missing-key";
  }>;
};
