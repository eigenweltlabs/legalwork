import type { CustomProviderApiType } from "./store";
import { t } from "@/i18n";

/**
 * A one-click starting point for a local model server. Picking a template
 * pre-fills the custom provider form (Base URL, name, API type) for that
 * runtime; the user then fetches models and connects. All local runtimes speak
 * the OpenAI /v1/chat/completions spec, so they route through
 * `@ai-sdk/openai-compatible` with no API key.
 */
export type LocalRuntimeTemplate = {
  /** Stable template key (also the suggested provider id / name slug). */
  id: string;
  label: string;
  /** Display name prefilled into the form. */
  name: string;
  /** Base URL prefilled into the form. */
  baseURL: string;
  /** Base URL placeholder shown when the field is blank. */
  placeholder: string;
  apiType: CustomProviderApiType;
  /** Shown under the picker when this template is active. */
  note: string;
  /**
   * True when the opencode engine already auto-detects this runtime on the
   * default host (its built-in `loadLocal` probes the endpoint and lists
   * installed models live). Adding it manually is optional and, on the default
   * host, replaces that live list — the picker shows a heads-up.
   */
  autoDetected?: boolean;
};

/**
 * Built per call, not once at import: `t()` reads the current language, so a
 * module-level constant would freeze these notes in whatever language loaded first.
 */
export const localRuntimeTemplates = (): LocalRuntimeTemplate[] => [
  {
    id: "llamacpp",
    label: "llama.cpp",
    name: "llama.cpp",
    baseURL: "http://localhost:8080/v1",
    placeholder: "http://localhost:8080/v1",
    apiType: "chat",
    note: t("local_templates.llamacpp_hint"),
  },
  {
    id: "vllm",
    label: "vLLM",
    name: "vLLM",
    baseURL: "http://localhost:8000/v1",
    placeholder: "http://localhost:8000/v1",
    apiType: "chat",
    note: t("local_templates.vllm_note"),
  },
  {
    id: "localai",
    label: "LocalAI",
    name: "LocalAI",
    baseURL: "http://localhost:8080/v1",
    placeholder: "http://localhost:8080/v1",
    apiType: "chat",
    note: t("local_templates.localai_note"),
  },
  {
    id: "ollama",
    label: "Ollama",
    name: "Ollama",
    baseURL: "http://localhost:11434/v1",
    placeholder: "http://localhost:11434/v1",
    apiType: "chat",
    autoDetected: true,
    note: t("local_templates.ollama_note"),
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    name: "LM Studio",
    baseURL: "http://localhost:1234/v1",
    placeholder: "http://localhost:1234/v1",
    apiType: "chat",
    autoDetected: true,
    note: t("local_templates.lmstudio_note"),
  },
];

/** Turn a free-text provider name into a stable lowercase provider id. */
export function slugifyProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "custom-provider";
}

/**
 * The display name to use after picking a template. We replace the current
 * value only when it's blank or still a template default, so a name the user
 * typed themselves is preserved when switching between templates.
 */
export function resolveTemplateName(
  currentName: string,
  template: LocalRuntimeTemplate,
  templates: LocalRuntimeTemplate[] = localRuntimeTemplates(),
): string {
  const trimmed = currentName.trim();
  const isTemplateName = templates.some((candidate) => candidate.name === trimmed);
  return !trimmed || isTemplateName ? template.name : currentName;
}
