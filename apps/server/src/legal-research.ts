import { createHash } from "node:crypto";
import { legalResearchProviders, researchDatabaseSetupSchema } from "./native-shared-values.js";
import { ApiError } from "./errors.js";
import { browserPasswords } from "./browser-passwords.js";
import type { ServerConfig } from "./types.js";

export function parseResearchDatabaseSetup(raw: unknown) {
  const parsed = researchDatabaseSetupSchema.safeParse(raw);
  if (!parsed.success) throw new ApiError(400, "invalid_research_database", "Choose a database, country and saved login, or enter its name and HTTPS research and sign-in addresses.");
  const input = parsed.data;
  if ("providerId" in input) {
    const provider = legalResearchProviders.find(item => item.id === input.providerId);
    if (!provider) throw new ApiError(400, "unknown_research_database", "Choose a database from the catalogue or add another database.");
    if (provider.loginUrl && input.loginUrl) throw new ApiError(400, "research_login_override", "Use the preset sign-in website, or add a custom database for a different sign-in flow.");
    // User-pasted sign-in links often carry ephemeral OAuth state. Keep only their vault origin.
    const loginUrl = provider.loginUrl ?? (input.loginUrl ? new URL(input.loginUrl).origin : null);
    if (!loginUrl) throw new ApiError(400, "research_login_required", "Enter this database's current sign-in website before saving a login.");
    return { id: provider.id, name: provider.name, researchUrl: provider.researchUrl, loginUrl, country: input.country, passwordId: input.passwordId };
  }
  const researchUrl = new URL(input.researchUrl).href;
  // The same custom website has one owned integration across retries and renames.
  const id = `custom-${createHash("sha256").update(researchUrl).digest("hex").slice(0,24)}`;
  return { id, ...input, researchUrl, loginUrl: new URL(input.loginUrl).origin };
}

/** Country presets only supply website metadata. Saving a login never installs a skill. */
export async function configureResearchDatabase(config: ServerConfig, raw: unknown) {
  const connection = parseResearchDatabaseSetup(raw);
  return browserPasswords(config).connect(connection.passwordId, connection.loginUrl, {
    name: connection.name, url: connection.researchUrl, providerId: connection.id, country: connection.country,
  });
}
