import { afterEach, describe, expect, test } from "bun:test";
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
import { orgPolicyEngineDir } from "./org-policy-engine.js";
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
      research: { type: "remote", url: "https://research.example.com/mcp", oauth: false, headers: { "X-Api-Key": "firm-key" }, enabled: true },
      box: { type: "remote", url: "https://box.example.com/mcp", enabled: true, oauth: { clientId: "client-1", scope: "root_readonly" } },
    });
    expect([...(await firmHubConnectorNames(config))].sort()).toEqual(["box", "docs", "research"]);
    expect((await readFirmHubView(config)).items.find((item) => item.id === "mcp-own")?.connector).toEqual({
      serverName: "docs", url: "https://docs.example.com/mcp", access: "member", keyName: "Authorization", hasOwnKey: false,
    });

    // The member's own key, kept on this computer.
    await setFirmHubMemberKey(config, "mcp-own", "Bearer own-key");
    expect((await firmHubConnectorBlocks(config)).docs).toEqual({
      type: "remote", url: "https://docs.example.com/mcp", enabled: true, oauth: false, headers: { Authorization: "Bearer own-key" },
    });
    await expect(setFirmHubMemberKey(config, "mcp-firm", "nope")).rejects.toMatchObject({ code: "firm_hub_item_not_found" });

    // The same hub again changes nothing.
    await sync();
    expect(changes).toEqual(["app+engine", "app+engine"]);
  });

  test("a firm without the hub in its plan has none on this computer", async () => {
    const { config, hub, signIn, sync } = await setup();
    hub.plan = false;
    await signIn();
    await sync();
    expect(await readFirmHubView(config)).toEqual({ connected: false, items: [] });
  });
});
