const MODEL_WORD_LABELS = new Map([
  ["deepseek", "DeepSeek"],
  ["openai", "OpenAI"],
  ["gpt", "GPT"],
  ["glm", "GLM"],
  ["oss", "OSS"],
]);

/** A readable fallback for API IDs; the original ID remains the request identity. */
export function modelDisplayName(id: string, name?: string): string {
  const displayName = name?.trim();
  if (displayName && displayName !== id) return displayName;

  const modelSlug = id.split("/").filter(Boolean).pop() || id;
  return modelSlug.split(/[-_\s]+/).filter(Boolean).map(word => {
    const label = MODEL_WORD_LABELS.get(word.toLowerCase());
    if (label) return label;
    if (/^\d+[bmk]$/i.test(word)) return word.toUpperCase();
    if (/^o\d/.test(word)) return word;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(" ") || id;
}
