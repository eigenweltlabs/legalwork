import { Plugin } from "@opencode/plugin";
import { nativeProviderRequest } from "./native-provider-request.js";
/**
 * LegalWork Anthropic Tool Schema Plugin
 *
 * The Anthropic Messages API rejects tool input schemas that use `anyOf`,
 * `oneOf`, or `allOf` at the top level:
 *
 *   tools.N.custom.input_schema: input_schema does not support oneOf, allOf,
 *   or anyOf at the top level
 *
 * Some MCP servers expose such schemas (e.g. PostHog's
 * `file-download-batch-exports-create` uses a top-level `anyOf`), and the
 * bundled OpenCode engine forwards them unchanged, so a single bad tool breaks
 * every chat turn for the whole session.
 *
 * The native model HTTP request hook rewrites Anthropic requests at dispatch
 * without changing MCP schemas for other providers or replacing global fetch. Requests are detected via the
 * `anthropic-version` header, which @ai-sdk/anthropic always sets. Top-level
 * combinators are merged into a flat object schema; nested combinators are
 * untouched (Anthropic only rejects them at the top level).
 */

const COMBINATOR_KEYS = ["anyOf", "oneOf", "allOf"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function flattenTopLevelCombinators(schema: Record<string, unknown>): Record<string, unknown> {
  const key = COMBINATOR_KEYS.find((k) => Array.isArray(schema[k]));
  if (!key) return schema;
  const rawVariants = schema[key];
  if (!Array.isArray(rawVariants)) return schema;

  const variants = rawVariants.filter(isRecord).map(flattenTopLevelCombinators);
  const properties: Record<string, unknown> = isRecord(schema.properties) ? { ...schema.properties } : {};
  const variantRequired: string[][] = [];
  for (const variant of variants) {
    if (isRecord(variant.properties)) {
      for (const [name, property] of Object.entries(variant.properties)) {
        if (!(name in properties)) properties[name] = property;
      }
    }
    variantRequired.push(stringList(variant.required));
  }

  const baseRequired = stringList(schema.required);
  const mergedRequired =
    key === "allOf"
      ? [...new Set([...baseRequired, ...variantRequired.flat()])]
      : [
          ...new Set([
            ...baseRequired,
            ...(variantRequired[0] ?? []).filter((name) => variantRequired.every((set) => set.includes(name))),
          ]),
        ];

  const result: Record<string, unknown> = { ...schema, type: "object", properties };
  for (const combinator of COMBINATOR_KEYS) delete result[combinator];
  const required = mergedRequired.filter((name) => name in properties);
  if (required.length) result.required = required;
  else delete result.required;

  if (key !== "allOf" && variantRequired.some((set) => set.length)) {
    const hint = variantRequired.map((set) => `(${set.length ? set.join(", ") : "none"})`).join(" or ");
    const description = typeof schema.description === "string" && schema.description ? `${schema.description}\n` : "";
    result.description = `${description}Provide fields matching exactly one input variant; variant required fields: ${hint}.`;
  }
  return result;
}

/** Returns the sanitized JSON body, or null when nothing needed rewriting. */
function sanitizeAnthropicBody(body: string): string | null {
  if (!body.includes("input_schema")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) return null;

  let changed = false;
  const tools = parsed.tools.map((tool) => {
    if (!isRecord(tool) || !isRecord(tool.input_schema)) return tool;
    const sanitized = flattenTopLevelCombinators(tool.input_schema);
    if (sanitized === tool.input_schema) return tool;
    changed = true;
    return { ...tool, input_schema: sanitized };
  });
  if (!changed) return null;
  return JSON.stringify({ ...parsed, tools });
}

export default Plugin.define({id:"legalwork.anthropic.tool-schema",async setup(ctx){
  await ctx.session.hook("http.request",async event=>{
    if(!event.request.headers.has("anthropic-version"))return;
    event.request=await nativeProviderRequest(event.request,sanitizeAnthropicBody);
  });
}});
