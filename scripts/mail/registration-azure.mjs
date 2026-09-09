#!/usr/bin/env bun
import { execFileSync } from "node:child_process";

const graphId = "00000003-0000-0000-c000-000000000000";
const redirect = "http://localhost/mail/callback";
const marker = "Legalwork Mail development registration; managed by registration-azure.mjs v1";
const scopes = ["openid", "profile", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"];
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function az(args) {
  return JSON.parse(execFileSync("az", [...args, "--only-show-errors", "--output", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

export function provision(args, command = az) {
  const apply = args.includes("--apply");
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") continue;
    if (!["--tenant", "--name"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Usage: --tenant TENANT_GUID --name legalwork-mail-dev-NAME [--apply]");
    if (values.has(args[i])) throw new Error("Duplicate argument");
    values.set(args[i], args[++i]);
  }
  const tenant = values.get("--tenant");
  const name = values.get("--name");
  if (!guid.test(tenant ?? "") || !/^legalwork-mail-dev-[a-z0-9-]{1,50}$/.test(name ?? "")) throw new Error("Explicit tenant GUID and dedicated legalwork-mail-dev-* name required");
  const account = command(["account", "show", "--query", "{tenantId:tenantId,state:state}"]);
  if (account.tenantId?.toLowerCase() !== tenant.toLowerCase() || account.state !== "Enabled") throw new Error("Active Azure tenant differs or account disabled; select the approved tenant outside this script");
  const apps = command(["ad", "app", "list", "--display-name", name, "--query", "[].{id:id,appId:appId,displayName:displayName,description:description}"]);
  const exact = apps.filter((app) => app.displayName === name);
  if (exact.length > 1 || (exact.length === 1 && exact[0].description !== marker)) throw new Error("Name collision: refusing to adopt or modify an existing registration");
  const graph = command(["ad", "sp", "show", "--id", graphId, "--query", "oauth2PermissionScopes[].{id:id,value:value,isEnabled:isEnabled}"]);
  const permissions = scopes.map((scope) => {
    const matches = graph.filter((item) => item.value === scope && item.isEnabled === true && guid.test(item.id));
    if (matches.length !== 1) throw new Error(`Cannot resolve delegated Graph scope ${scope}`);
    return { id: matches[0].id, type: "Scope" };
  });
  const required = [{ resourceAppId: graphId, resourceAccess: permissions }];
  const query = "{id:id,appId:appId,displayName:displayName,description:description,signInAudience:signInAudience,publicClient:publicClient,web:web,spa:spa,requiredResourceAccess:requiredResourceAccess,passwordCredentialCount:length(passwordCredentials),keyCredentialCount:length(keyCredentials),isFallbackPublicClient:isFallbackPublicClient}";
  function verify(id) {
    const app = command(["ad", "app", "show", "--id", id, "--query", query]);
    const actual = app.requiredResourceAccess ?? [];
    const actualPermissions = actual[0]?.resourceAccess ?? [];
    if (app.description !== marker || app.displayName !== name || app.signInAudience !== "AzureADMyOrg"
      || app.publicClient?.redirectUris?.length !== 1 || app.publicClient.redirectUris[0] !== redirect
      || (app.web?.redirectUris?.length ?? 0) || (app.spa?.redirectUris?.length ?? 0)
      || app.passwordCredentialCount !== 0 || app.keyCredentialCount !== 0
      || app.isFallbackPublicClient === true || actual.length !== 1 || actual[0].resourceAppId !== graphId
      || actualPermissions.length !== permissions.length
      || !permissions.every((wanted) => actualPermissions.some((item) => item.id === wanted.id && item.type === "Scope"))) {
      throw new Error(`Registration read-back mismatch; no automatic repair or deletion. Inspect object ${id}`);
    }
    return { objectId: app.id, clientId: app.appId };
  }
  if (exact.length === 1) return { status: "existing_verified", ...verify(exact[0].id), authorization: "not_checked" };
  if (!apply) return { status: "dry_run", action: "create_new", name, tenantId: tenant, redirect, delegatedScopes: scopes, authorization: "not_checked" };
  // az ad app create does not expose description. Use Graph's supported JSON
  // creation surface so the ownership marker is atomic with the new application.
  const created = command(["rest", "--method", "post", "--url", "https://graph.microsoft.com/v1.0/applications",
    "--headers", "Content-Type=application/json", "--body", JSON.stringify({
      displayName: name, description: marker, signInAudience: "AzureADMyOrg",
      publicClient: { redirectUris: [redirect] }, isFallbackPublicClient: false,
      requiredResourceAccess: required,
    }), "--query", "{id:id,appId:appId}"]);
  // No update, service-principal creation, consent grant, credential creation, or login.
  return { status: "created_verified", ...verify(created.id), authorization: "not_checked" };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(provision(process.argv.slice(2)), null, 2)); }
  catch (error) {
    // Child-process errors can contain provider response data. Do not print them.
    console.error(error instanceof Error && !("status" in error) ? error.message : "Azure CLI failed; registration may have been created. Inspect the dedicated name before retrying.");
    process.exitCode = 1;
  }
}
