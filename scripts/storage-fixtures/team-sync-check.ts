/** Optional cross-repository check, launched by model-api's storage integration
 * suite. Uses real platform routes/Postgres and a disposable MinIO bucket. */
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "../../apps/server/node_modules/@aws-sdk/client-s3";
import { startServer } from "../../apps/server/src/server.js";
import { writeEigenweltConnection } from "../../apps/server/src/eigenwelt-connection-store.js";
import { LegalWorkStorageTools } from "../../apps/server/src/opencode-plugins/legalwork-storage-tools.js";
import type { ServerConfig } from "../../apps/server/src/types.js";

const platformUrl = process.env.EIGENWELT_PLATFORM_URL;
const adminToken = process.env.STORAGE_TEST_ADMIN_TOKEN;
const memberToken = process.env.STORAGE_TEST_MEMBER_TOKEN;
const orgId = process.env.STORAGE_TEST_ORG_ID;
assert(platformUrl && adminToken && memberToken && orgId, "Launch through the platform integration suite.");
const temporary = await mkdtemp(join(tmpdir(), "legalwork-team-e2e-"));
const bucket = `team-sync-${crypto.randomUUID()}`;
const endpoint = process.env.STORAGE_TEST_S3_ENDPOINT ?? "http://127.0.0.1:19290";
const accessKeyId = process.env.STORAGE_TEST_S3_ACCESS_KEY ?? "legalwork";
const secretAccessKey = process.env.STORAGE_TEST_S3_SECRET_KEY ?? "fixture-password";
const s3 = new S3Client({
  endpoint,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId, secretAccessKey },
});
for (const key of [
  "LEGALWORK_STORAGE_STORE",
  "LEGALWORK_TOKEN_STORE",
  "LEGALWORK_RUNTIME_DB",
  "LEGALWORK_ENV_STORE",
  "LEGALWORK_DATA_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
])
  process.env[key] = join(temporary, key);
const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  token: "e2e-client",
  hostToken: "e2e-owner",
  configPath: join(temporary, "config.json"),
  approval: { mode: "auto", timeoutMs: 1000 },
  corsOrigins: ["*"],
  workspaces: ["admin", "member"].map((id) => ({
    id,
    name: id,
    path: join(temporary, id),
    preset: "default",
    workspaceType: "local",
  })),
  authorizedRoots: [temporary],
  readOnly: false,
  startedAt: Date.now(),
  tokenSource: "cli",
  hostTokenSource: "cli",
  logFormat: "pretty",
  logRequests: false,
};
for (const workspace of config.workspaces) await mkdir(workspace.path, { recursive: true });
await s3.send(new CreateBucketCommand({ Bucket: bucket }));
const app = await startServer(config);
const url = `http://127.0.0.1:${app.port}`;
process.env.LEGALWORK_SERVER_URL = url;
process.env.LEGALWORK_SERVER_TOKEN = config.token;
async function api(workspace: string, method: string, suffix: string, body?: unknown) {
  const response = await fetch(`${url}/workspace/${workspace}/storage${suffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "x-legalwork-host-token": config.hostToken,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response;
}
try {
  for (const [workspace, token] of [
    ["admin", adminToken],
    ["member", memberToken],
  ])
    await writeEigenweltConnection(config, workspace, {
      platformToken: token,
      account: { userId: workspace, orgId, orgName: "Test Firm", userEmail: null, userName: null },
    });
  const input = {
    name: "Team fixture",
    config: {
      kind: "s3",
      endpoint,
      bucket,
      region: "us-east-1",
      forcePathStyle: true,
      prefix: "",
      accessKeyId,
    },
    secrets: { secretAccessKey, requestHeaders: "X-Return-Missing-Metadata: true\nX-Api-Key: fixture-header-secret" },
  };
  assert.equal((await api("admin", "POST", "/team", input)).status, 201);
  assert.equal((await api("member", "POST", "/team", input)).status, 403);
  const roots = await (await api("member", "GET", "/roots")).json();
  assert.equal(roots.roots.length, 1);
  const connectionId: string = roots.roots[0].id;
  assert(connectionId.startsWith("team:"));
  assert.equal((await api("member", "POST", `/${connectionId}/installation`, { installed: false })).status, 409);
  const { tool } = await LegalWorkStorageTools();
  const context = { directory: join(temporary, "member") };
  const connected = JSON.parse(await tool.storage_list_connections.execute({}, context));
  assert.equal(connected.connections[0].connection_id, connectionId);
  const source = { connection_id: connectionId, path: "Nested/Agreement.txt" };
  const written = JSON.parse(
    await tool.storage_write_file.execute({ ...source, mode: "create", content: "Shared draft" }, context),
  );
  assert.equal(written.result.ok, true);
  const found = JSON.parse(
    await tool.storage_search_filenames.execute({ query: "agreement", connection_ids: [connectionId] }, context),
  );
  assert(JSON.stringify(found).includes("Nested/Agreement.txt"));
  const read = JSON.parse(await tool.storage_read_file.execute(source, context));
  assert.equal(read.text, "Shared draft");
  const settings = await (await api("admin", "GET", "")).json();
  assert.equal(settings.connections[0].team.version, 1);
  assert(!JSON.stringify(settings).includes(secretAccessKey));
  assert(!JSON.stringify(settings).includes("fixture-header-secret"));
  assert(settings.connections[0].configuredSecrets.includes("requestHeaders"));
  const updated = await api("admin", "PUT", `/${connectionId}?version=1`, {
    ...input,
    name: "Updated by admin",
    secrets: {},
    readOnly: true,
  });
  assert.equal(updated.status, 200);
  // An independent member's existing lease expires without a manual install.
  await new Promise((resolve) => setTimeout(resolve, 30_100));
  const changed = await (await api("member", "GET", "/roots")).json();
  assert.equal(changed.roots[0].name, "Updated by admin");
  assert.equal(changed.roots[0].writable, false);
  const denied = JSON.parse(
    await tool.storage_write_file.execute({ ...source, mode: "create", content: "Must not overwrite" }, context),
  );
  assert.equal(denied.ok, false);
  assert.equal((await api("member", "DELETE", `/${connectionId}?version=2`)).status, 403);
  assert.equal((await api("admin", "DELETE", `/${connectionId}?version=2`)).status, 200);
  // Simulate a fresh device after removal: no inherited connector survives.
  await writeEigenweltConnection(config, "member", { platformToken: null, account: null });
  assert.equal((await (await api("member", "GET", "/roots")).json()).roots.length, 0);
  await writeEigenweltConnection(config, "member", {
    platformToken: memberToken,
    account: { userId: "member", orgId, orgName: "Test Firm", userEmail: null, userName: null },
  });
  assert.equal((await (await api("member", "GET", "/roots")).json()).roots.length, 0);
  // Optional catalog entries are available to members only after local opt-in.
  assert.equal((await api("admin", "POST", "/team", { ...input, teamInstallation: "optional" })).status, 201);
  const optionalCatalog = await (await api("admin", "GET", "")).json();
  const optionalId: string = optionalCatalog.connections[0].id;
  assert.equal(JSON.parse(await tool.storage_list_connections.execute({}, context)).connections.length, 0);
  assert.equal((await api("member", "POST", `/${optionalId}/installation`, { installed: true })).status, 200);
  const optionalSource = { ...source, connection_id: optionalId };
  assert.equal(JSON.parse(await tool.storage_read_file.execute(optionalSource, context)).text, "Shared draft");
  assert(
    JSON.stringify(
      JSON.parse(
        await tool.storage_search_filenames.execute({ query: "agreement", connection_ids: [optionalId] }, context),
      ),
    ).includes("Nested/Agreement.txt"),
  );
  assert.equal((await api("member", "POST", `/${optionalId}/installation`, { installed: false })).status, 200);
  assert.equal(JSON.parse(await tool.storage_list_connections.execute({}, context)).connections.length, 0);
  assert.equal(JSON.parse(await tool.storage_read_file.execute(optionalSource, context)).ok, false);
  assert.equal((await api("member", "POST", `/${optionalId}/filename-search`, { query: "agreement" })).status, 409);
  // Publishing an existing local connection keeps it installed for its owner.
  const localConnection = await (await api("admin", "POST", "", { ...input, name: "Promoted fixture" })).json();
  assert.equal(
    (await api("admin", "POST", "/team", { localId: localConnection.connection.id, teamInstallation: "optional" }))
      .status,
    201,
  );
  const promotedCatalog = await (await api("admin", "GET", "")).json();
  assert(!promotedCatalog.connections.some((item: { id: string }) => item.id === localConnection.connection.id));
  assert.equal(
    promotedCatalog.connections.find((item: { name: string }) => item.name === "Promoted fixture").team.installed,
    true,
  );
  const local = await readFile(process.env.LEGALWORK_STORAGE_STORE!, "utf8").catch(() => "[]");
  assert(!local.includes(secretAccessKey));
  console.log(
    "PASS: app admin create/update/delete -> encrypted team settings, automatic/optional installation, local promotion, real S3 agent list/search/read/write with signed custom headers, read-only rules, sign-out and removal.",
  );
} finally {
  await app.stop();
  const objects = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  if (objects.Contents?.length)
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.Contents.map(({ Key }) => ({ Key })) },
      }),
    );
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  s3.destroy();
  await rm(temporary, { recursive: true, force: true });
}
