import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { orgPolicyIssues, parseOrgPolicyEntries, type OrgPolicyScope } from "@legalwork/types/org-policy";

import { eigenweltPlatformUrl } from "./eigenwelt-auth.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import {
  appliedOrgPolicy,
  onOrgPolicyChange,
  orgPolicySecret,
  readOrgPolicyView,
  releaseOrgPolicyKey,
  requireOrgPolicyAllows,
  requireOrgPolicyUnmanaged,
  resetOrgPolicyRuntimeForTests,
  scheduleOrgPolicySync,
} from "./org-policy.js";
import type { ServerConfig } from "./types.js";

const realFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  while (cleanups.length) await cleanups.pop()?.();
});

const kanzlei = { userId: "user_anna", userName: "Anna", userEmail: "anna@kanzlei.test", orgId: "org_kanzlei", orgName: "Kanzlei" };

type Platform = { revision: number; entries: Record<string, unknown>; secrets?: Record<string, string>; orgId?: string };

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-org-policy-"));
  const config = { configPath: join(dir, "server.json"), workspaces: [] } as unknown as ServerConfig;
  cleanups.push(async () => {
    resetOrgPolicyRuntimeForTests(config);
    await rm(dir, { recursive: true, force: true });
  });
  const platform: Platform = { revision: 0, entries: {} };
  const requests: Array<{ url: string; etag: string | null; authorization: string | null }> = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, etag: headers.get("if-none-match"), authorization: headers.get("authorization") });
      if (url.endsWith("/api/desktop/policy/secrets")) {
        return Response.json({ schemaVersion: 1, revision: platform.revision, secrets: platform.secrets ?? {} });
      }
      if (url.endsWith("/api/desktop/policy")) {
        if (headers.get("if-none-match") === `"${platform.revision}"`) return new Response(null, { status: 304 });
        return Response.json({
          schemaVersion: 1,
          orgId: platform.orgId ?? kanzlei.orgId,
          orgName: "Kanzlei",
          revision: platform.revision,
          role: "member",
          updatedAt: null,
          entries: platform.entries,
        });
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: realFetch.preconnect },
  );
  const signIn = (account = kanzlei) =>
    writeEigenweltConnection(config, { platformToken: "tok_anna", platformURL: eigenweltPlatformUrl(), account });
  const signOut = () => writeEigenweltConnection(config, { platformToken: null, account: null, platformURL: null });
  return { config, platform, requests, signIn, signOut };
}

describe("the firm's policy", () => {
  test("only valid entries of known keys are kept, in the modes they allow, and enforced sharing can only be off", () => {
    const entries = parseOrgPolicyEntries({
      branding: { mode: "enforced", value: { appName: "Kanzlei Work" } },
      "updates.autoCheck": { mode: "enforced", value: "yes" },
      "updates.channel": { mode: "default", value: "stable" },
      "privacy.shareAnonymousUsage": { mode: "enforced", value: true },
      "connectors.allowCustom": { mode: "default", value: false },
      "future.setting": { mode: "enforced", value: 1 },
    });
    expect(entries).toEqual({ branding: { mode: "enforced", value: { appName: "Kanzlei Work" } } });
    expect(orgPolicyIssues({ "updates.autoDownload": { mode: "enforced", value: true } })).toEqual([
      "Enforcing automatic downloads also needs automatic update checks enforced on",
    ]);
  });

  test("while signed in enforced settings are locked; defaults can be taken back", async () => {
    const { config, platform, signIn } = await setup();
    await signIn();
    platform.revision = 3;
    platform.entries = {
      branding: { mode: "enforced", value: { appName: "Kanzlei Work" } },
      language: { mode: "default", value: "de" },
      "connectors.allowCustom": { mode: "enforced", value: false },
    };
    await scheduleOrgPolicySync(config, { force: true });

    const view = await readOrgPolicyView(config);
    expect(view).toMatchObject({ state: "active", orgName: "Kanzlei", role: "member", revision: 3 });
    expect(view.entries.branding).toEqual({ mode: "enforced", value: { appName: "Kanzlei Work" }, locked: true, released: false });
    expect(view.entries.language?.locked).toBe(false);

    await expect(releaseOrgPolicyKey(config, "branding")).rejects.toMatchObject({ status: 403, code: "org_policy_locked" });
    await expect(requireOrgPolicyUnmanaged(config, "branding")).rejects.toMatchObject({ code: "org_policy_managed" });
    await expect(requireOrgPolicyAllows(config, "connectors.allowCustom")).rejects.toMatchObject({ code: "org_policy_disallowed" });

    await releaseOrgPolicyKey(config, "language");
    expect(await appliedOrgPolicy(config, "language")).toBeNull();
    await requireOrgPolicyUnmanaged(config, "language");
  });

  test("after sign-out everything stays and can be taken back; signing in again restores the enforced ones", async () => {
    const { config, platform, requests, signIn, signOut } = await setup();
    await signIn();
    platform.revision = 5;
    platform.entries = {
      branding: { mode: "enforced", value: { appName: "Kanzlei Work" } },
      language: { mode: "default", value: "de" },
    };
    await scheduleOrgPolicySync(config, { force: true });
    await signOut();
    await scheduleOrgPolicySync(config, { force: true });

    expect((await readOrgPolicyView(config)).state).toBe("lapsed");
    expect(await appliedOrgPolicy(config, "branding")).toEqual({ mode: "enforced", value: { appName: "Kanzlei Work" }, locked: false });
    await releaseOrgPolicyKey(config, "branding");
    await releaseOrgPolicyKey(config, "language");
    expect(await appliedOrgPolicy(config, "branding")).toBeNull();

    await signIn();
    await scheduleOrgPolicySync(config, { force: true });
    expect(requests.at(-1)).toMatchObject({ etag: '"5"', authorization: "Bearer tok_anna" });
    const view = await readOrgPolicyView(config);
    expect(view.state).toBe("active");
    expect(view.entries.branding).toMatchObject({ locked: true, released: false });
    // A default the member changed stays theirs.
    expect(view.entries.language).toMatchObject({ released: true });
    expect(view.restored?.count).toBe(1);
  });

  test("a change for the engine is announced, also when signing out unlocks it", async () => {
    const { config, platform, signIn, signOut } = await setup();
    const heard: Array<Set<OrgPolicyScope>> = [];
    cleanups.push(onOrgPolicyChange(config, (scopes) => heard.push(scopes)));
    await signIn();
    platform.revision = 1;
    platform.entries = { "tools.permissions": { mode: "enforced", value: { bash: "ask" } } };
    await scheduleOrgPolicySync(config, { force: true });
    expect(heard.at(-1)?.has("engine")).toBe(true);

    await signOut();
    await scheduleOrgPolicySync(config, { force: true });
    expect(heard.at(-1)?.has("engine")).toBe(true);
  });

  test("the firm's keys are only available while signed in", async () => {
    const { config, platform, signIn, signOut } = await setup();
    await signIn();
    platform.revision = 1;
    platform.secrets = { "chat:org-anthropic-1": "sk-firm" };
    platform.entries = {
      "ai.chat.providers": {
        mode: "enforced",
        value: [{ id: "org-anthropic-1", name: "Claude", source: { type: "catalog", provider: "anthropic" }, models: "all", key: { by: "firm", secretRef: "chat:org-anthropic-1" } }],
      },
    };
    await scheduleOrgPolicySync(config, { force: true });
    expect(await orgPolicySecret(config, "chat:org-anthropic-1")).toBe("sk-firm");

    await signOut();
    await scheduleOrgPolicySync(config, { force: true });
    expect(await orgPolicySecret(config, "chat:org-anthropic-1")).toBeNull();
  });

  test("a policy from another firm replaces the previous one", async () => {
    const { config, platform, signIn } = await setup();
    await signIn();
    platform.revision = 2;
    platform.entries = { language: { mode: "default", value: "de" } };
    await scheduleOrgPolicySync(config, { force: true });
    await releaseOrgPolicyKey(config, "language");

    await signIn({ ...kanzlei, orgId: "org_other", orgName: "Other" });
    platform.orgId = "org_other";
    platform.entries = { language: { mode: "enforced", value: "en" } };
    await scheduleOrgPolicySync(config, { force: true });
    expect((await readOrgPolicyView(config)).entries.language).toEqual({ mode: "enforced", value: "en", locked: true, released: false });
  });
});
