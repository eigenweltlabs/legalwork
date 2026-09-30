import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { languageSchema, OcrError } from "./types.js";

const identity = { id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), label: z.string().trim().min(1).max(120) };
export function isLoopbackOcrEndpoint(value: string): boolean {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname); }
  catch { return false; }
}
export const localEngineSchema = z.strictObject({
  ...identity, kind: z.literal("local"), model: z.enum(["pp-ocrv6-small", "paddleocr-vl-1.6"]),
});
export const serverEngineSchema = z.strictObject({
  ...identity, kind: z.enum(["chat-completions", "mistral-ocr", "paddleocr"]), model: z.string().trim().min(1).max(200),
  /** Full endpoint, not a provider base URL. HTTPS, or loopback HTTP for self-hosted services. */
  endpoint: z.url().refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackOcrEndpoint(value)));
  }, "Use HTTPS (or loopback HTTP), without URL credentials, query parameters, or fragments"),
  /** Identifier for an injected secret resolver. Never the API key itself. */
  apiKeyRef: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/).nullable(),
  languages: z.array(languageSchema).min(1).max(200).nullable().default(null),
  maxTokens: z.number().int().min(256).max(16384).default(8192),
}).refine((engine) => engine.apiKeyRef !== null || isLoopbackOcrEndpoint(engine.endpoint), "Authentication is required for remote endpoints");
export const settingsSchema = z.strictObject({
  version: z.literal(1),
  defaultEngineId: identity.id,
  pageTimeoutMs: z.number().int().min(1).max(600000).default(120000),
  engines: z.array(z.discriminatedUnion("kind", [localEngineSchema, serverEngineSchema])).min(1).max(32),
}).superRefine((settings, context) => {
  const ids = settings.engines.map((engine) => engine.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate OCR engine ID" });
  if (!ids.includes(settings.defaultEngineId)) context.addIssue({ code: "custom", message: "Default OCR engine does not exist" });
});
export type OcrSettings = z.infer<typeof settingsSchema>;
export type LocalEngineSettings = z.infer<typeof localEngineSchema>;
export type ServerEngineSettings = z.infer<typeof serverEngineSchema>;

export function defaultOcrSettings(): OcrSettings {
  return settingsSchema.parse({ version: 1, defaultEngineId: "local-fast", engines: [
    { id: "local-fast", label: "Fast · Local", kind: "local", model: "pp-ocrv6-small" },
    { id: "local-quality", label: "Higher quality · Local", kind: "local", model: "paddleocr-vl-1.6" },
  ] });
}

/** No secrets in this file. The embedding host owns API-key storage and access control. */
export class OcrSettingsStore {
  constructor(readonly path: string) {}
  async read(): Promise<OcrSettings> {
    try { return settingsSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return defaultOcrSettings();
      throw new OcrError("invalid-input", "The saved OCR configuration could not be read.");
    }
  }
  async write(input: OcrSettings): Promise<void> {
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) throw new OcrError("invalid-input", "Invalid OCR configuration.");
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
}
