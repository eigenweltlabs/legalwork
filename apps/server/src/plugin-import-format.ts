import { z } from "zod";
import { ApiError } from "./errors.js";

const pluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
// Versioned local rules: a package never chooses a schema to download or execute.
const manifest = z.object({
  $schema: z.literal(pluginSchema), name: z.string().min(1).max(64).regex(/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/),
  version: z.string().optional(), description: z.string().optional(),
  author: z.object({ name: z.string().optional(), email: z.string().optional(), url: z.string().optional() }).strict().optional(),
  homepage: z.string().optional(), repository: z.string().optional(), license: z.string().optional(),
  keywords: z.array(z.string()).optional(), extensions: z.unknown().optional(),
});
const endpoint = z.string().min(1).refine(value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !value.includes("${"); } catch { return false; } });
const scopes = z.array(z.string().refine(value => Boolean(value.trim())));
const oauth = {
  client: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("provided"), clientId: z.string().min(1), tokenEndpointAuthMethod: z.enum(["none", "client_secret_basic", "client_secret_post", "private_key_jwt"]).optional() }).strict(),
    z.object({ mode: z.literal("dcr") }).strict(), z.object({ mode: z.literal("cimd") }).strict(),
  ]).optional(),
  authorizationUrl: endpoint.optional(), tokenUrl: endpoint.optional(), registrationUrl: endpoint.optional(), authorizationServerBase: endpoint.optional(), resource: endpoint.optional(),
  baseScopes: scopes.optional(), defaultScopes: scopes.optional(), oidcEnabled: z.boolean().optional(), oidcConfigurationUrl: endpoint.optional(), oidcUserinfoEndpoint: endpoint.optional(), oidcScopesSupported: scopes.optional(),
};
// The portable core schema is closed. OpenAI additionally documents this auth
// profile in mcp.json; validate it before checking what our runtime can preserve.
const extensions = z.object({ "com.openai": z.object({ auth: z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("oauth"), ...oauth }).strict(), z.object({ type: z.literal("mixed"), ...oauth }).strict(),
  z.object({ type: z.literal("api_key"), headerScheme: z.enum(["bearer", "basic", "custom_header"]), headerName: z.string().optional() }).strict(),
]) }).strict() }).strict().optional();
const remote = { url: endpoint, headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), z.string().refine(value => !/[\r\n]/.test(value))).optional(), extensions };
const entry = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio"), command: z.string().min(1).refine(value => !value.includes("${")), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).refine(value => !Object.hasOwn(value, "PLUGIN_ROOT") && !Object.hasOwn(value, "PLUGIN_DATA")).optional(), cwd: z.string().regex(/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/).optional() }).strict(),
  z.object({ type: z.literal("streamable-http"), ...remote }).strict(),
  z.object({ type: z.literal("sse"), ...remote }).strict(),
]);
export function validatePortableManifest(value: Record<string, unknown>, warnings: string[]) {
  const result = manifest.safeParse(value);
  if (!result.success) throw new ApiError(400, "unsupported_plugin_format", "This portable plugin has an invalid manifest or an unsupported schema version. LegalWork supports Agent Plugins 1.0.0.");
  for (const key of Object.keys(value)) if (!Object.hasOwn(manifest.shape, key)) warnings.push(`Portable plugin field “${key}” is not supported and will be ignored.`);
  return result.data;
}
export function validatePortableMcp(value: Record<string, unknown>): Record<string, unknown> {
  if (value.$schema !== mcpSchema || !value.mcpServers || typeof value.mcpServers !== "object" || Array.isArray(value.mcpServers) || Object.keys(value).some(key => !["$schema", "mcpServers"].includes(key))) throw new ApiError(400, "invalid_portable_mcp", "The portable connector configuration must declare Agent Plugins 1.0.0, an mcpServers object, and no unknown top-level fields.");
  return Object.fromEntries(Object.entries(value.mcpServers));
}
export function portableEntryError(value: Record<string, unknown>): string | undefined {
  return entry.safeParse(value).success ? undefined : "This connector does not follow the Agent Plugins 1.0.0 schema for its declared transport. Correct its command, arguments, environment, working directory or HTTP configuration before importing.";
}
