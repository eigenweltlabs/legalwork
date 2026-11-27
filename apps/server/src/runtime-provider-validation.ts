/** Validate native provider definitions without discarding a user's connection.
 * Legacy records are handled by the versioned upgrade, before normal runtime.
 */
import { ConfigProvider } from "@opencode/schema/config/provider";
import { Schema } from "effect";

/** Decode every saved native provider; a malformed one fails closed and is left in place. */
export function validateRuntimeProviders(
  providers: Record<string, unknown>,
): Record<string, typeof ConfigProvider.Info.Type> {
  const valid: Record<string, typeof ConfigProvider.Info.Type> = {};
  for (const [id, block] of Object.entries(providers)) {
    try { valid[id] = Schema.decodeUnknownSync(ConfigProvider.Info)(block, { onExcessProperty: "error" }); }
    catch { throw new Error(`Saved provider "${id}" has invalid native settings. Correct or restore it; LegalWork has not removed the connection.`); }
  }
  return valid;
}
