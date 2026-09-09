import { expect, test } from "bun:test";
import { provision } from "./registration-azure.mjs";
const tenant = "11111111-2222-3333-4444-555555555555";
const args = ["--tenant", tenant, "--name", "legalwork-mail-dev-test"];
const graphId = "00000003-0000-0000-c000-000000000000";
const scopeData = ["openid", "profile", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"].map((value, i) => ({ value, id: `00000000-0000-0000-0000-00000000000${i}`, isEnabled: true }));
function fixture(options = {}) {
  const calls = [];
  let exists = options.exists ?? false;
  const app = {
    id: tenant, appId: tenant, displayName: "legalwork-mail-dev-test",
    description: "Legalwork Mail development registration; managed by registration-azure.mjs v1",
    signInAudience: "AzureADMyOrg", publicClient: { redirectUris: ["http://localhost/mail/callback"] },
    passwordCredentialCount: 0, keyCredentialCount: 0, isFallbackPublicClient: false,
    requiredResourceAccess: [{ resourceAppId: graphId, resourceAccess: scopeData.map((scope) => ({ id: scope.id, type: "Scope" })) }],
    ...options.app,
  };
  return { calls, command(commandArgs) {
    calls.push(commandArgs);
    const key = commandArgs.slice(0, 3).join(" ");
    if (commandArgs[0] === "account") return { tenantId: options.wrongTenant ? graphId : tenant, state: "Enabled" };
    if (key === "ad app list") return exists ? [app] : [];
    if (key === "ad sp show") return scopeData;
    if (key === "ad app show") return app;
    if (commandArgs[0] === "rest" && commandArgs.includes("post")) { exists = true; return { id: tenant, appId: tenant }; }
    throw new Error("Unexpected command");
  } };
}
test("default dry-run issues reads only", () => {
  const mock = fixture();
  expect(provision(args, mock.command).status).toBe("dry_run");
  expect(mock.calls.some((call) => call[0] === "rest")).toBe(false);
});
test("tenant mismatch fails before Graph lookup", () => {
  const mock = fixture({ wrongTenant: true });
  expect(() => provision([...args, "--apply"], mock.command)).toThrow("tenant differs");
  expect(mock.calls).toHaveLength(1);
});
test("apply creates only once, verifies, and reruns idempotently", () => {
  const mock = fixture();
  expect(provision([...args, "--apply"], mock.command).status).toBe("created_verified");
  expect(provision([...args, "--apply"], mock.command).status).toBe("existing_verified");
  const creates = mock.calls.filter((call) => call[0] === "rest");
  expect(creates).toHaveLength(1);
  expect(creates[0]).toContain("https://graph.microsoft.com/v1.0/applications");
  const body = JSON.parse(creates[0][creates[0].indexOf("--body") + 1]);
  expect(body.publicClient.redirectUris).toEqual(["http://localhost/mail/callback"]);
  expect(body.description).toBe("Legalwork Mail development registration; managed by registration-azure.mjs v1");
  expect(body.signInAudience).toBe("AzureADMyOrg");
  expect(body.isFallbackPublicClient).toBe(false);
  expect(body.passwordCredentials).toBeUndefined();
  expect(body.requiredResourceAccess[0].resourceAccess).toHaveLength(6);
});
test("unmanaged collision cannot be adopted", () => {
  const mock = fixture({ exists: true, app: { description: "existing Workspace app" } });
  expect(() => provision([...args, "--apply"], mock.command)).toThrow("Name collision");
  expect(mock.calls.some((call) => call[0] === "rest")).toBe(false);
});
test("read-back drift fails without repair", () => {
  for (const app of [{ passwordCredentialCount: 1 }, { signInAudience: "AzureADandPersonalMicrosoftAccount" }, { publicClient: { redirectUris: ["https://example.com"] } }]) {
    const mock = fixture({ exists: true, app });
    expect(() => provision([...args, "--apply"], mock.command)).toThrow("read-back mismatch");
    expect(mock.calls.some((call) => call.includes("update"))).toBe(false);
  }
});
test("rejects missing explicit config and unknown flags before CLI", () => {
  for (const input of [[], [...args, "--force"], ["--tenant", "common", "--name", "old-app"]]) {
    const mock = fixture();
    expect(() => provision(input, mock.command)).toThrow();
    expect(mock.calls).toHaveLength(0);
  }
});
