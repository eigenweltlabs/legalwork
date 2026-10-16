import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import snapshot from "../contract.json";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const schema = z.record(z.string(), z.unknown());
const parameterSchema = z.object({ name: z.string(), in: z.enum(["path", "query", "header"]),
  required: z.boolean().optional(), description: z.string().optional(), schema: schema.default({ type: "string" }),
  style: z.string().optional(), explode: z.boolean().optional() });
const operationSchema = z.object({ operationId: z.string(), summary: z.string().optional(), description: z.string().optional(),
  parameters: z.array(parameterSchema).default([]),
  requestBody: z.object({ required: z.boolean().optional(), content: z.record(z.string(), z.object({ schema: schema.optional() })) }).optional(),
});
const documentSchema = z.object({ openapi: z.string(), info: z.object({ version: z.string() }),
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.object({ schemas: z.record(z.string(), schema) }),
});
export const specification = documentSchema.parse(snapshot);
export type Parameter = z.infer<typeof parameterSchema>;
export type Operation = ReturnType<typeof buildOperations>[number];
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);

/** JAX-RS templates in the published spec contain nested braces and omit some id parameters. */
export function pathParameters(path: string) {
  return Array.from(path.matchAll(/\{(\w+)(?::((?:[^{}]|\{\d+(?:,\d*)?\})+))?\}/g), (match) => ({
    template: match[0], name: match[1], pattern: match[2],
  }));
}

function normalize(value: unknown, inherited = new Set<string>()): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item, inherited));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["discriminator", "example", "xml", "externalDocs"].includes(key)) continue;
    if (key === "$ref" && typeof item === "string") result[key] = item.replace("#/components/schemas/", "#/$defs/");
    else if (key === "allOf" && Array.isArray(item)) {
      // A subtype inherits its base fields, not its base's discriminator union (which refers back to it).
      result[key] = item.map((part) => {
        if (!isRecord(part) || typeof part.$ref !== "string") return normalize(part, inherited);
        const name = part.$ref.replace("#/components/schemas/", "");
        const base = specification.components.schemas[name];
        if (!base || inherited.has(name)) return normalize(part, inherited);
        const { oneOf: _union, discriminator: _discriminator, ...fields } = base;
        return normalize(fields, new Set([...inherited, name]));
      });
    } else result[key] = normalize(item, inherited);
  }
  return result;
}

const definitions: Record<string, unknown> = Object.fromEntries(Object.entries(specification.components.schemas)
  .map(([name, value]) => [name, normalize(value)]));
// The spec supplies discriminator mappings rather than const tags on the inherited subtypes.
for (const value of Object.values(specification.components.schemas)) {
  if (!isRecord(value.discriminator) || typeof value.discriminator.propertyName !== "string" || !isRecord(value.discriminator.mapping)) continue;
  for (const [tag, reference] of Object.entries(value.discriminator.mapping)) {
    if (typeof reference !== "string") continue;
    const name = reference.replace("#/components/schemas/", "");
    const target = definitions[name];
    if (isRecord(target)) target.allOf = [...(Array.isArray(target.allOf) ? target.allOf : []),
      { type: "object", properties: { [value.discriminator.propertyName]: { const: tag } } }];
  }
}

function referencedDefinitions(value: unknown, found = new Set<string>()): Record<string, unknown> {
  if (Array.isArray(value)) for (const item of value) referencedDefinitions(item, found);
  else if (isRecord(value)) {
    if (typeof value.$ref === "string") {
      const name = value.$ref.replace("#/$defs/", "");
      if (!found.has(name)) { found.add(name); referencedDefinitions(definitions[name], found); }
    }
    for (const item of Object.values(value)) referencedDefinitions(item, found);
  }
  return Object.fromEntries(Array.from(found, (name) => [name, definitions[name]]));
}

export function buildOperations() {
  const result = [];
  for (const [path, entries] of Object.entries(specification.paths)) for (const [method, value] of Object.entries(entries)) {
    if (!methods.has(method) || path.startsWith("/auth/")) continue;
    const parsed = operationSchema.parse(value);
    const parameters = [...z.array(parameterSchema).parse(entries.parameters ?? []), ...parsed.parameters];
    for (const field of pathParameters(path)) if (!parameters.some((p) => p.in === "path" && p.name === field.name)) {
      parameters.push({ name: field.name, in: "path", required: true, schema: field.pattern?.includes("0-9a-fA-F")
        ? { type: "string", format: "uuid" } : { type: "string", minLength: 1, ...(field.pattern === "\\d+" ? { pattern: "^\\d+$" } : {}) } });
    }
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const parameter of parameters) {
      properties[parameter.name] = normalize({ ...parameter.schema, ...(parameter.description ? { description: parameter.description } : {}) });
      if (parameter.in === "path" || parameter.required) required.push(parameter.name);
    }
    const contentTypes = Object.keys(parsed.requestBody?.content ?? {});
    const contentType = contentTypes.includes("application/json") ? "application/json" : contentTypes[0];
    if (contentType) {
      const bodySchema = parsed.requestBody?.content[contentType]?.schema ?? { type: "string" };
      properties.body = normalize(bodySchema);
      if (contentType === "application/offset+octet-stream") properties.body = { type: "string", format: "byte", maxLength: Math.ceil(10 * 1024 * 1024 / 3) * 4, description: "Base64-encoded TUS chunk (maximum 10 MB)." };
      if (contentType === "multipart/form-data" && isRecord(properties.body)) {
        const fields = properties.body.properties;
        if (isRecord(fields)) fields.file = { type: "string", minLength: 1, description: "Path to an existing file within the MCP file root (maximum 50 MB)." };
      }
      if (parsed.requestBody?.required) required.push("body");
    }
    if (parsed.operationId === "downloadDocument") {
      properties.saveTo = { type: "string", minLength: 1, description: "New destination file within the MCP file root. Existing files are never overwritten." };
      required.push("saveTo");
    }
    const inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false; $defs: Record<string, unknown> } = { type: "object", properties, required, additionalProperties: false,
      $defs: referencedDefinitions(properties) };
    const validate = ajv.compile(inputSchema);
    const name = `actaport_${parsed.operationId.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`;
    result.push({ name, operationId: parsed.operationId, path, method: method.toUpperCase(), parameters, contentType,
      summary: parsed.summary ?? parsed.operationId,
      description: (parsed.description ?? "").replace(/<[^>]*>/g, "").trim(),
      readOnly: ["get", "head", "options"].includes(method), inputSchema, validate });
  }
  if (new Set(result.map((operation) => operation.name)).size !== result.length) throw new Error("Duplicate Actaport tool names.");
  return result;
}
