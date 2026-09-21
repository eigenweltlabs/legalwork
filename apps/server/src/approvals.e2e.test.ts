import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEmbeddedServer } from "./embedded.js";
import type { ApprovalRequest } from "./types.js";

test("embedded manual mode gates client writes and keeps approval decisions host-only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "legalwork-host-approval-"));
  const originalDataDir = process.env.LEGALWORK_DATA_DIR;
  const originalApprovalMode = process.env.LEGALWORK_APPROVAL_MODE;
  process.env.LEGALWORK_DATA_DIR = join(directory, "data");
  delete process.env.LEGALWORK_APPROVAL_MODE;
  const configPath = join(directory, "server.json");
  await writeFile(configPath, JSON.stringify({ approval: { mode: "manual", timeoutMs: 2000 } }));
  let decision: "allow" | "deny" = "deny";
  const requests: ApprovalRequest[] = [];
  const clientApprovalStatuses: number[] = [];
  const server = await startEmbeddedServer({
    host: "127.0.0.1",
    port: 0,
    configPath,
    workspaces: [join(directory, "workspace")],
    token: "client-token",
    hostToken: "host-token",
    defaultApprovalMode: "auto",
    logRequests: false,
    wordAddin: false,
    requestHostApproval: async (request) => {
      requests.push(request);
      const headers = { Authorization: "Bearer client-token", "Content-Type": "application/json" };
      clientApprovalStatuses.push((await fetch(`${server.url}/approvals`, { headers })).status);
      clientApprovalStatuses.push((await fetch(`${server.url}/approvals/${request.id}`, {
        method: "POST", headers, body: JSON.stringify({ reply: "allow" }),
      })).status);
      return decision;
    },
  });
  try {
    expect(server.config.approval.mode).toBe("manual");
    const workspace = server.config.workspaces[0];
    const skillPath = join(workspace.path, ".opencode", "skills", "approval-test", "SKILL.md");
    const write = () => fetch(`${server.url}/workspace/${workspace.id}/skills`, {
      method: "POST",
      headers: { Authorization: "Bearer client-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "approval-test", description: "Approval test", content: "Only after approval." }),
    });
    expect((await write()).status).toBe(403);
    expect(await readFile(skillPath, "utf8").catch(() => null)).toBeNull();
    decision = "allow";
    expect((await write()).status).toBe(200);
    expect(await readFile(skillPath, "utf8")).toContain("Only after approval.");
    expect(requests).toHaveLength(2);
    expect(clientApprovalStatuses).toEqual([401, 401, 401, 401]);
    expect(requests[0]).toMatchObject({
      action: "skills.upsert", paths: [skillPath], actor: { type: "remote", scope: "collaborator" },
    });
    const pending = await fetch(`${server.url}/approvals`, { headers: { "X-LegalWork-Host-Token": "host-token" } });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({ items: [] });
  } finally {
    await server.stop();
    if (originalDataDir === undefined) delete process.env.LEGALWORK_DATA_DIR;
    else process.env.LEGALWORK_DATA_DIR = originalDataDir;
    if (originalApprovalMode === undefined) delete process.env.LEGALWORK_APPROVAL_MODE;
    else process.env.LEGALWORK_APPROVAL_MODE = originalApprovalMode;
    await rm(directory, { recursive: true, force: true });
  }
});
