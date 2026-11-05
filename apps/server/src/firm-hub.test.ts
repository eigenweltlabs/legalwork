import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eigenweltPlatformUrl } from "./eigenwelt-auth.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import {
  firmHubConnectorBlocks,
  firmHubConnectorNames,
  firmHubPromptSets,
  firmHubSkills,
  onFirmHubChange,
  readFirmHubSkill,
  readFirmHubView,
  resetFirmHubRuntimeForTests,
  scheduleFirmHubSync,
  setFirmHubAdded,
  setFirmHubMemberKey,
} from "./firm-hub.js";
import { Config } from "@opencode/schema/config";
import { Schema } from "effect";
import { buildOrgPolicyEngineLayer, orgPolicyEngineDir } from "./org-policy-engine.js";
import type { ServerConfig } from "./types.js";

const realFetch = globalThis.fetch;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  while (cleanups.length) await cleanups.pop()?.();
});

type Item = {
  id: string;
  kind: string;
  name: string;
  version: number;
  installation?: "automatic" | "optional";
  payload: unknown;
  secret?: string;
};

const kanzlei = { userId: "user_anna", userName: "Anna", userEmail: "anna@kanzlei.test", orgId: "org_kanzlei", orgName: "Kanzlei" };
const skillFiles = (name: string, body = "Cite like the firm does.") => ({
  files: [{ path: "SKILL.md", contentBase64: Buffer.from(`---\nname: ${name}\ndescription: ${name}\n---\n${body}`).toString("base64") }],
});
const remote = (key: string, access: unknown) => ({ key, mcp: { type: "remote", url: `https://${key}.example.com/mcp`, enabled: true }, access });

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-firm-hub-"));
  const config = { configPath: join(dir, "server.json"), workspaces: [] } as unknown as ServerConfig;
  cleanups.push(async () => {
    resetFirmHubRuntimeForTests(config);
    await rm(dir, { recursive: true, force: true });
  });
  const hub: { items: Item[]; plan: boolean } = { items: [], plan: true };
  const fetched: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      fetched.push(url.pathname + url.search);
      if (!hub.plan) return new Response("subscription feature admin_hub required", { status: 403 });
      if (url.pathname === "/api/hub" && url.searchParams.get("all") === "1") {
        return Response.json({
          items: hub.items.map(({ payload: _payload, secret, ...item }) => ({
            ...item, description: "", createdByUserId: "user_admin", updatedAt: "2026-10-08T10:00:00.000Z",
            hasSecret: secret !== undefined, canAccessSecret: secret !== undefined,
          })),
        });
      }
      const match = /^\/api\/hub\/([^/]+)(\/secret)?$/.exec(url.pathname);
      const item = hub.items.find((each) => each.id === match?.[1]);
      if (!item) return new Response("not found", { status: 404 });
      if (match?.[2]) return item.secret ? Response.json({ secret: item.secret }) : new Response("no key", { status: 404 });
      return Response.json({ ...item, payload: item.payload });
    },
    { preconnect: realFetch.preconnect },
  );
  const signIn = () => writeEigenweltConnection(config, { platformToken: "tok_anna", platformURL: eigenweltPlatformUrl(), account: kanzlei });
  const signOut = () => writeEigenweltConnection(config, { platformToken: null, account: null, platformURL: null });
  const sync = () => scheduleFirmHubSync(config, { force: true });
  const skillDir = (name: string) => join(orgPolicyEngineDir(config), "skills", name);
  return { config, hub, fetched, signIn, signOut, sync, skillDir };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

describe("the firm's Knowledge Hub", () => {
  test("installs what everyone gets, offers the rest, and takes it all away on sign-out", async () => {
    const { config, hub, signIn, signOut, sync, skillDir } = await setup();
    hub.items = [
      { id: "skill-1", kind: "skill", name: "citation-style", version: 1, installation: "automatic", payload: skillFiles("citation-style") },
      { id: "flow-1", kind: "workflow", name: "contract-review", version: 1, installation: "optional", payload: skillFiles("contract-review") },
      { id: "set-1", kind: "review_set", name: "Lease review", version: 2, installation: "automatic", payload: { set: { name: "Lease review" } } },
      { id: "plug-1", kind: "plugin", name: "tools", version: 1, installation: "automatic", payload: { spec: "tools" } },
    ];
    await signIn();
    await sync();

    expect(await readFile(join(skillDir("citation-style"), "SKILL.md"), "utf8")).toContain("Cite like the firm does.");
    expect(await exists(skillDir("contract-review"))).toBe(false);
    // Members read it, file by file, and nothing outside it.
    expect(await readFirmHubSkill(config, "citation-style")).toMatchObject({ kind: "skill", path: "SKILL.md", files: ["SKILL.md"] });
    expect((await readFirmHubSkill(config, "citation-style")).content).toContain("Cite like the firm does.");
    await expect(readFirmHubSkill(config, "citation-style", "../catalog.json")).rejects.toMatchObject({ code: "invalid_hub_path" });
    await expect(readFirmHubSkill(config, "contract-review")).rejects.toMatchObject({ code: "firm_hub_item_not_found" });
    expect((await firmHubSkills(config)).map((skill) => [skill.name, skill.firm])).toEqual([["citation-style", "automatic"]]);
    expect(await firmHubPromptSets(config)).toEqual([{ id: "set-1", version: 2, payload: { set: { name: "Lease review" } } }]);
    // Engine plugins are no firm's to hand out.
    expect((await readFirmHubView(config)).items.map((item) => [item.id, item.installation, item.added])).toEqual([
      ["skill-1", "automatic", false],
      ["flow-1", "optional", false],
      ["set-1", "automatic", false],
    ]);

    // The member adds what is offered, but cannot remove what everyone gets.
    await setFirmHubAdded(config, "flow-1", true);
    expect((await firmHubSkills(config)).find((skill) => skill.name === "contract-review")).toMatchObject({ kind: "workflow", firm: "optional" });
    await expect(setFirmHubAdded(config, "skill-1", false)).rejects.toMatchObject({ code: "firm_hub_installed_for_everyone" });

    // A change on the platform arrives; what the admin removed goes.
    hub.items = hub.items
      .filter((item) => item.id !== "set-1")
      .map((item) => (item.id === "skill-1" ? { ...item, version: 2, payload: skillFiles("citation-style", "New rules.") } : item));
    await sync();
    expect(await readFile(join(skillDir("citation-style"), "SKILL.md"), "utf8")).toContain("New rules.");
    expect(await firmHubPromptSets(config)).toEqual([]);

    await signOut();
    await sync();
    expect(await exists(skillDir("citation-style"))).toBe(false);
    expect(await readFirmHubView(config)).toEqual({ connected: false, items: [] });
    // What the member added is theirs again on the next sign-in.
    await signIn();
    await sync();
    expect((await readFirmHubView(config)).items.find((item) => item.id === "flow-1")?.added).toBe(true);
  });

  test("runs a connector with the firm's key, the member's own, or the member's own sign-in", async () => {
    const { config, hub, signIn, sync } = await setup();
    hub.items = [
      {
        id: "mcp-firm", kind: "mcp", name: "research", version: 1, installation: "automatic",
        payload: remote("research", { by: "firm", name: "X-Api-Key" }),
        secret: JSON.stringify({ type: "remote", url: "https://research.example.com/mcp", oauth: false, headers: { "X-Api-Key": "firm-key" } }),
      },
      { id: "mcp-own", kind: "mcp", name: "docs", version: 1, installation: "automatic", payload: remote("docs", { by: "member", name: "Authorization" }) },
      { id: "mcp-app", kind: "mcp", name: "box", version: 1, installation: "automatic", payload: remote("box", { by: "oauth", client: { id: "client-1", scope: "root_readonly" } }) },
    ];
    await signIn();
    const changes: string[] = [];
    onFirmHubChange(config, (each) => changes.push([...each].sort().join("+")));
    await sync();

    expect(changes).toEqual(["app+engine"]);
    expect(await firmHubConnectorBlocks(config)).toEqual({
      research: { type: "remote", url: "https://research.example.com/mcp", oauth: false, headers: { "X-Api-Key": "firm-key" }, disabled: false },
      box: { type: "remote", url: "https://box.example.com/mcp", disabled: false, oauth: { client_id: "client-1", scope: "root_readonly" } },
    });
    expect([...(await firmHubConnectorNames(config))].sort()).toEqual(["box", "docs", "research"]);
    expect((await readFirmHubView(config)).items.find((item) => item.id === "mcp-own")?.connector).toEqual({
      serverName: "docs", url: "https://docs.example.com/mcp", access: "member", keyName: "Authorization", hasOwnKey: false,
    });

    // The member's own key, kept on this computer.
    await setFirmHubMemberKey(config, "mcp-own", "Bearer own-key");
    expect((await firmHubConnectorBlocks(config)).docs).toEqual({
      type: "remote", url: "https://docs.example.com/mcp", disabled: false, oauth: false, headers: { Authorization: "Bearer own-key" },
    });
    await expect(setFirmHubMemberKey(config, "mcp-firm", "nope")).rejects.toMatchObject({ code: "firm_hub_item_not_found" });

    // Exercise the strict startup boundary that previously stopped the backend.
    const layer = await buildOrgPolicyEngineLayer(config, { permissions: [] });
    expect(() => Schema.decodeUnknownSync(Config.Info)(layer, { onExcessProperty: "error" })).not.toThrow();

    // The same hub again changes nothing.
    await sync();
    expect(changes).toEqual(["app+engine", "app+engine"]);
  });

  test("normalizes shared credentials and skips malformed connectors at the startup boundary", async () => {
    const { config, hub, signIn, sync } = await setup();
    hub.items = [
      { id: "legacy-app", kind: "mcp", name: "legacy", version: 1, installation: "automatic",
        payload: remote("legacy", { by: "firm" }),
        secret: JSON.stringify({ type: "remote", url: "https://legacy.example.com/mcp", enabled: true, timeout: 5000,
          oauth: { clientId: "client-1", clientSecret: "synthetic-private-secret", callbackPort: 19876 } }) },
      { id: "native-app", kind: "mcp", name: "native", version: 1, installation: "automatic",
        payload: remote("native", { by: "firm" }),
        secret: JSON.stringify({ type: "remote", url: "https://native.example.com/mcp",
          oauth: { client_id: "native-client", client_secret: "synthetic-native-secret" } }) },
      { id: "public", kind: "mcp", name: "public", version: 1, installation: "automatic", payload: remote("public", { by: "none" }) },
      { id: "local", kind: "mcp", name: "local", version: 1, installation: "automatic",
        payload: { key: "local", mcp: { type: "local", command: ["synthetic-mcp"], enabled: true }, access: { by: "member", name: "API_KEY" } } },
      { id: "malformed", kind: "mcp", name: "broken", version: 1, installation: "automatic",
        payload: remote("broken", { by: "firm" }),
        secret: JSON.stringify({ type: "remote", url: "https://broken.example.com/mcp", unsupported: "synthetic-secret-never-log" }) },
    ];
    await signIn();
    await sync();
    await setFirmHubMemberKey(config, "local", "synthetic-local-key");
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const layer = await buildOrgPolicyEngineLayer(config, { permissions: [] });
      const native = Schema.decodeUnknownSync(Config.Info)(layer, { onExcessProperty: "error" });
      expect(Object.keys(native.mcp?.servers ?? {}).sort()).toEqual(["legacy", "local", "native", "public"]);
      expect(native.mcp?.servers?.legacy).toEqual({ type: "remote", url: "https://legacy.example.com/mcp", disabled: false,
        timeout: { startup: 5000, catalog: 5000, execution: 5000 },
        oauth: { client_id: "client-1", client_secret: "synthetic-private-secret", callback_port: 19876 } });
      expect(native.mcp?.servers?.native).toMatchObject({ oauth: { client_id: "native-client", client_secret: "synthetic-native-secret" } });
      expect(native.mcp?.servers?.local).toEqual({ type: "local", command: ["synthetic-mcp"], disabled: false, environment: { API_KEY: "synthetic-local-key" } });
      expect(warning).toHaveBeenCalledWith("[firm-hub] Connector malformed has invalid settings and was not loaded.");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("synthetic-secret-never-log");
    } finally { warning.mockRestore(); }
  });

  test("a firm without the hub in its plan has none on this computer", async () => {
    const { config, hub, signIn, sync } = await setup();
    hub.plan = false;
    await signIn();
    await sync();
    expect(await readFirmHubView(config)).toEqual({ connected: false, items: [] });
  });
});
