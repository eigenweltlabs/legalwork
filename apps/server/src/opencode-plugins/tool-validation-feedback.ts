import { z } from "zod";

type Definition = { description: string; schema?: z.ZodType; source?: unknown };
const issuesSchema = z.array(z.object({
  code: z.string(), path: z.array(z.union([z.string(), z.number()])), message: z.string(),
  minimum: z.number().optional(), maximum: z.number().optional(), inclusive: z.boolean().optional(),
  expected: z.string().optional(), values: z.array(z.unknown()).optional(),
})).min(1);
const rpcError = z.object({ code: z.literal(-32602), message: z.string() });
export type ToolDefinition = { description: string; jsonSchema?: Parameters<typeof z.fromJSONSchema>[0]; parameters?: unknown };

function isZodSchema(value: unknown): value is z.ZodType {
  return value !== null && typeof value === "object" && "safeParse" in value && typeof value.safeParse === "function";
}

function rejectsInput(issue: z.infer<typeof issuesSchema>[number], input: unknown) {
  let value = input;
  for (const segment of issue.path) value = value !== null && typeof value === "object" ? Reflect.get(value, String(segment)) : undefined;
  const size = typeof value === "number" ? value : typeof value === "string" || Array.isArray(value) ? value.length : undefined;
  if (issue.code === "too_small" && issue.minimum !== undefined && size !== undefined) return issue.inclusive === false ? size <= issue.minimum : size < issue.minimum;
  if (issue.code === "too_big" && issue.maximum !== undefined && size !== undefined) return issue.inclusive === false ? size >= issue.maximum : size > issue.maximum;
  if (issue.code === "invalid_value" && issue.values) return !issue.values.some(allowed => Object.is(allowed, value));
  if (issue.code === "invalid_type" && issue.expected) {
    if (["string", "number", "boolean", "bigint"].includes(issue.expected)) return typeof value !== issue.expected;
    if (issue.expected === "array") return !Array.isArray(value);
    if (issue.expected === "object") return value === null || typeof value !== "object" || Array.isArray(value);
    if (issue.expected === "int") return !Number.isInteger(value);
  }
  return false;
}

function parameterError(tool: string, error: string) {
  const native = `The ${tool} tool was called with invalid arguments:`;
  if (error.startsWith(native)) return error.slice(native.length).trim();
  const v2 = `Invalid arguments for tool "${tool}":`;
  if (error.startsWith(v2)) return error.slice(v2.length).trim();
  if (error.startsWith("MCP error -32602:")) return error.slice("MCP error -32602:".length).trim();
  try {
    const parsed = rpcError.safeParse(JSON.parse(error));
    if (parsed.success) return parsed.data.message;
  } catch { /* Other operational errors are not argument validation. */ }
}

/** The runtime supplies the schemas; validation results, not generic error
 * wording, decide whether a failed call qualifies for correction guidance. */
export function toolValidationFeedback() {
  const definitions = new Map<string, Definition>();
  const feedback = {
    definition: async ({ toolID }: { toolID: string }, output: ToolDefinition) => {
      const previous = definitions.get(toolID);
      const source = output.jsonSchema ?? output.parameters;
      if (previous && previous.source === source && previous.description === output.description) return;
      let schema: z.ZodType | undefined;
      try {
        if (isZodSchema(output.parameters)) schema = output.parameters;
        else if (output.jsonSchema !== undefined) schema = z.fromJSONSchema(output.jsonSchema);
      }
      catch { /* Unsupported schema features must never break tool discovery. */ }
      definitions.set(toolID, { description: output.description, schema, source });
    },
    failure: (tool: string, input: unknown, error: string) => {
      const definition = definitions.get(tool);
      const canonical = parameterError(tool, error);
      let issues: z.infer<typeof issuesSchema> | undefined;
      try {
        const parsed = issuesSchema.safeParse(JSON.parse(error));
        if (parsed.success) issues = parsed.data;
      } catch { /* Native and MCP canonical errors need not be JSON. */ }
      const validation = definition?.schema?.safeParse(input);
      // A service-response parse error is not bad model input. Check the input
      // itself; the engine can omit constraints from its advertised schema.
      const rejected = issues?.filter(issue => rejectsInput(issue, input));
      if (!canonical && (!issues || (validation?.success !== false && !rejected?.length))) return;
      const detail = validation && !validation.success
        ? validation.error.issues.map(issue => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ")
        : rejected?.length ? rejected.map(issue => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ") : canonical;
      return [detail, definition?.description.slice(0, 1200), "Use the current tool definition and real values from the task. Correct the rejected fields; do not invent missing identifiers or paths."].filter(Boolean).join("\n");
    },
    result: async ({ tool, args }: { tool: string; args?: unknown }, output: { isError?: boolean; content?: { type: string; text?: string }[] }) => {
      if (!output.isError) return;
      const text = output.content?.filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
      if (!text) return;
      const detail = feedback.failure(tool, args, text);
      // The pinned engine otherwise reports MCP isError results as completed.
      // Promote only confirmed argument validation, never a generic remote
      // failure or content that merely mentions validation.
      if (detail !== undefined) throw new Error(`The ${tool} tool was called with invalid arguments: ${detail}`);
    },
  };
  return feedback;
}
