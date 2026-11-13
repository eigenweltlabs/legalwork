import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { ApiError } from "./errors.js";

type NativeConfiguration = typeof Config.Info.Type;
export type NativeMcpDefinition = NonNullable<NonNullable<NativeConfiguration["mcp"]>["servers"]>[string];

/** Normal engine settings have exactly the native shape. */
export function nativeMcpDefinition(value: Record<string, unknown>): NativeMcpDefinition {
  try {
    const decoded = Schema.decodeUnknownSync(Config.Info)({ mcp: { servers: { definition: value } } }, { onExcessProperty: "error" });
    const definition = decoded.mcp?.servers?.definition;
    if (!definition) throw new Error("Missing connector definition");
    return definition;
  } catch { throw new ApiError(400, "invalid_mcp_config", "Use native OpenCode connector settings."); }
}

/** The LegalWork connector form is an app command, with named UI controls.
 * Convert those controls once at its API boundary, before merging saved native
 * fields; this is not a legacy engine-configuration reader. */
export function connectorCommandFields(value: Record<string, unknown>): Record<string, unknown> {
  const { enabled, timeout, oauth, ...fields } = value;
  if (enabled !== undefined && typeof enabled !== "boolean") throw new ApiError(400, "invalid_mcp_config", "Connector enablement must be a boolean.");
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 0)) throw new ApiError(400, "invalid_mcp_config", "Connector timeout must be a non-negative number.");
  if (oauth !== undefined && oauth !== false && (!oauth || typeof oauth !== "object" || Array.isArray(oauth))) throw new ApiError(400, "invalid_mcp_config", "Connector sign-in settings must be an object or false.");
  const authentication = oauth && typeof oauth === "object" ? Object.fromEntries(Object.entries(oauth)) : undefined;
  if (authentication && Object.keys(authentication).some(key => !["clientId", "clientSecret", "scope", "callbackPort", "redirectUri"].includes(key))) throw new ApiError(400, "invalid_mcp_config", "Use the connector form's named sign-in fields.");
  return { ...fields,
    ...(enabled === undefined ? {} : { disabled: !enabled }),
    ...(timeout === undefined ? {} : { timeout: { startup: timeout, catalog: timeout, execution: timeout } }),
    ...(oauth === undefined ? {} : { oauth: oauth === false ? false : Object.fromEntries(Object.entries({ client_id: authentication?.clientId, client_secret: authentication?.clientSecret, scope: authentication?.scope, callback_port: authentication?.callbackPort, redirect_uri: authentication?.redirectUri }).filter(([, item]) => item !== undefined)) }),
  };
}
