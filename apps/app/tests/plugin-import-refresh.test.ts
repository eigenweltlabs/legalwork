import { expect, test } from "bun:test";
import type { PluginImportPreview, PluginImportRequest } from "@legalwork/types/plugin-import";
import { LegalworkServerError } from "../src/app/lib/legalwork-server";
import { installReviewedPluginImport } from "../src/react-app/domains/settings/pages/plugin-import-dialog";

const reviewed: PluginImportPreview = {
  id: "discord", name: "discord", version: null, description: null, format: "connectors", root: ".", digest: "source",
  fileCount: 1, bytes: 100, components: [{ type: "mcp", name: "discord", installedName: "discord-imported" }], warnings: [],
  readiness: "setup", validationId: "expired",
  connectors: [{ name: "discord", installedName: "discord-imported", status: "setup", code: "inputs", message: "Enter a token after importing." }],
};
const request: PluginImportRequest = { source: { provider: "claude", path: "/source/discord" }, scope: "global", acknowledgePartial: true };
const expired = () => new LegalworkServerError(409, "connector_review_expired", "The connector review expired. Check the import again.");

function fixture(fresh = { ...reviewed, validationId: "fresh" }, failure: Error = expired(), alwaysFail = false) {
  const installs: PluginImportRequest[] = [];
  const previews: PluginImportRequest[] = [];
  const updates: PluginImportPreview[][] = [];
  const store = {
    async installPluginImport(value: PluginImportRequest) { installs.push(value); if (installs.length === 1 || alwaysFail) throw failure; return fresh; },
    async previewPluginImports(value: PluginImportRequest) { previews.push(value); return [fresh]; },
  };
  return { installs, previews, updates, store, run: () => installReviewedPluginImport(store, request, reviewed, items => updates.push(items)) };
}

test("expired review refreshes and imports with its fresh server token without another click", async () => {
  const flow = fixture();
  expect((await flow.run())?.validationId).toBe("fresh");
  expect(flow.installs.map(item => item.validationId)).toEqual(["expired", "fresh"]);
  expect(flow.installs[1]).toMatchObject({ ...request, root: ".", digest: "source" });
  expect(flow.previews).toEqual([{ ...request, root: ".", recheck: true }]);
  expect(flow.updates).toHaveLength(1);
});

test("a successful import does not fetch a redundant preview", async () => {
  let checks = 0;
  const result = await installReviewedPluginImport({ installPluginImport: async () => reviewed, previewPluginImports: async () => { checks++; return []; } }, request, reviewed, () => {});
  expect(result).toBe(reviewed);
  expect(checks).toBe(0);
});

test("workflow conversion survives an expired review without falling back to ordinary skills", async () => {
  const options = { ...request, asWorkflow: true, workflowSkillsOnly: true, convertPluginSkills: true, workflowSkillPaths: ["skills/review/SKILL.md"] };
  const converted: PluginImportPreview = { ...reviewed, format: "claude", components: [{ type: "skill", name: "review", installedName: "workflow-assistant-review" }, ...reviewed.components] };
  const received: PluginImportRequest[] = [];
  const result = await installReviewedPluginImport({
    installPluginImport: async value => { received.push(value); if (received.length === 1) throw expired(); return { ...converted, validationId: "fresh" }; },
    previewPluginImports: async value => { expect(value).toMatchObject({ ...options, root: converted.root, recheck: true }); return [{ ...converted, validationId: "fresh" }]; },
  }, options, converted, () => {});
  expect(result?.components).toEqual(converted.components);
  expect(received).toHaveLength(2);
  for (const value of received) expect(value).toMatchObject(options);
});

test("changed source, permissions, setup or losses refresh the review without installing unseen changes", async () => {
  for (const change of [
    { digest: "changed-source" },
    { components: [...reviewed.components, { type: "skill", name: "new", installedName: "new" }] } satisfies Partial<PluginImportPreview>,
    { warnings: ["Automatic hooks will not run."] },
    { readiness: "unsupported", components: [] } satisfies Partial<PluginImportPreview>,
    { connectors: [{ ...reviewed.connectors![0]!, code: "scope_change", message: "The provider requests different permissions." }] },
    { requirements: [{ kind: "dependency", name: "helper", code: "missing", required: true, status: "blocked", message: "Install the helper first." }] } satisfies Partial<PluginImportPreview>,
  ]) {
    const flow = fixture({ ...reviewed, validationId: "fresh", ...change });
    expect(await flow.run()).toBeNull();
    expect(flow.installs).toHaveLength(1);
    expect(flow.updates[0]?.[0]).toMatchObject(change);
  }
});

test("source changes fetch the new review and keep the new content for review", async () => {
  const flow = fixture({ ...reviewed, digest: "changed-source", validationId: "fresh" }, new LegalworkServerError(409, "plugin_preview_changed", "Preview again."));
  expect(await flow.run()).toBeNull();
  expect(flow.previews).toHaveLength(1);
  expect(flow.installs).toHaveLength(1);
});

test("repeated invalidation is bounded and leaves a fresh review without surfacing expiry", async () => {
  const flow = fixture(undefined, expired(), true);
  expect(await flow.run()).toBeNull();
  expect(flow.installs).toHaveLength(2);
  expect(flow.previews).toHaveLength(2);
});

test("unrelated installation failures and refresh failures remain actionable and are not retried", async () => {
  const failure = new LegalworkServerError(403, "permission_denied", "Your administrator disabled custom connectors.");
  const flow = fixture(undefined, failure);
  await expect(flow.run()).rejects.toBe(failure);
  expect(flow.previews).toHaveLength(0);
  const unavailable = new Error("Server unavailable");
  await expect(installReviewedPluginImport({ installPluginImport: async () => { throw expired(); }, previewPluginImports: async () => { throw unavailable; } }, request, reviewed, () => {})).rejects.toBe(unavailable);
});
