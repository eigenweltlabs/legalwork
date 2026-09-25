import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { startServer } from "./server.js";
import { parseEigenweltEntitlements } from "./eigenwelt-auth.js";
import { writeEigenweltConnection } from "./eigenwelt-connection-store.js";
import { writeCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import { SystemOneResponseSchema, SystemOneProviderSchema } from "./systemone-schema.js";
import type { ServerConfig } from "./types.js";

let dir: string;
let server: Awaited<ReturnType<typeof startServer>>;
let platform: ReturnType<typeof Bun.serve>;
let config: ServerConfig;
let base: string;
let viewer: string;
let enabled = true;
let available = true;
let platformStatus = 200;
let catalogStatus = 200;
let catalogNames = ["jev-latest", "jev-preview"];
const sent: Array<{ authorization: string | null; model: string }> = [];
const priorEnv = { ...process.env };
const request = {
  state: "The item is red.",
  questions: { red: { type: "noul", instructions: "Is it red?" } },
};
const selection = { providerId: "local-jev", model: "jev-latest" };
const call = (
  method: string,
  path: string,
  body?: unknown,
  token: string | null = config.token,
) =>
  fetch(`${base}/systemone${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "legalwork-systemone-"));
  for (const key of [
    "LEGALWORK_RUNTIME_DB",
    "LEGALWORK_TOKEN_STORE",
    "LEGALWORK_ENV_STORE",
    "LEGALWORK_DATA_DIR",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ])
    process.env[key] = join(dir, key);
  config = {
    host: "127.0.0.1",
    port: 0,
    token: "systemone-client",
    hostToken: "systemone-host",
    configPath: join(dir, "config.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws",
        name: "Test",
        path: dir,
        preset: "default",
        workspaceType: "local",
      },
    ],
    authorizedRoots: [dir],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  platform = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/desktop/systemone") {
        expect(req.headers.get("authorization")).toBe("Bearer platform-token");
        if (platformStatus !== 200)
          return new Response("outage", { status: platformStatus });
        return Response.json({
          enabled,
          available,
          baseURL: platform.url.origin,
          model: "EigenJev",
          questionTypes: ["noul", "choice", "score"],
          region: "EU",
        });
      }
      if (path === "/v1/models") {
        expect(req.headers.get("authorization")).toBe("Bearer custom-secret");
        if (catalogStatus !== 200) return new Response("private error body", {status:catalogStatus});
        return Response.json({models:catalogNames.map(name => ({name,description:`Description of ${name}`,release_date:"2026-09-01"}))});
      }
      if (path === "/v1/systemone") {
        const body = z
          .object({
            model: z.string(),
            questions: z.record(z.string(), z.unknown()),
          })
          .parse(await req.json());
        sent.push({
          authorization: req.headers.get("authorization"),
          model: body.model,
        });
        return Response.json({
          model: "openjev-0.1",
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [
              id,
              { type: "noul", noul: 0.9 },
            ]),
          ),
          usage: { input_tokens: 5, output_tokens: 0 },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  process.env.EIGENWELT_PLATFORM_URL = platform.url.origin;
  server = await startServer(config);
  base = `http://127.0.0.1:${server.port}`;
  const issued = await fetch(`${base}/tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-legalwork-host-token": config.hostToken,
    },
    body: JSON.stringify({ scope: "viewer", label: "SystemOne viewer" }),
  });
  viewer = z.object({ token: z.string() }).parse(await issued.json()).token;
});
afterAll(async () => {
  await server?.stop();
  platform?.stop(true);
  await rm(dir, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (!(key in priorEnv)) delete process.env[key];
  Object.assign(process.env, priorEnv);
});

test("auth and scope are enforced, malformed requests cannot execute", async () => {
  expect((await call("GET", "/settings", undefined, null)).status).toBe(401);
  expect((await call("POST", "", { request }, viewer)).status).toBe(403);
  expect((await call("PUT", "/providers", {}, viewer)).status).toBe(403);
  expect(
    (await call("POST", "", { request: { state: "x", questions: {} } })).status,
  ).toBe(400);
  expect(sent).toHaveLength(0);
});

test("custom providers persist private credentials, run with the selected model and never fall back", async () => {
  const provider = {
    id: selection.providerId,
    name: "Local JEV",
    models: [{ id: selection.model, name: selection.model, questionTypes: ["noul"] }],
    endpoint: `${platform.url.origin}/v1/systemone`,
    apiKey: "custom-secret",
    enabled: true,
  };
  expect((await call("PUT", "/providers", provider)).status).toBe(200);
  const settings = await (await call("GET", "/settings")).text();
  expect(settings).toContain("Local JEV");
  expect(settings).not.toContain("custom-secret");
  expect(settings).not.toContain('"apiKey"');
  expect((await stat(join(dir, "systemone.json"))).mode & 0o777).toBe(0o600);
  expect((await call("PUT", "/selection", selection)).status).toBe(200);
  const result = await call("POST", "", { request });
  expect(result.status).toBe(200);
  expect(SystemOneResponseSchema.parse(await result.json()).model).toBe(
    "openjev-0.1",
  );
  expect(sent.at(-1)).toEqual({
    authorization: "Bearer custom-secret",
    model: "jev-latest",
  });
  expect(
    (
      await call("PUT", "/providers", {
        ...provider,
        apiKey: undefined,
        endpoint: "https://other.test/v1/systemone",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("PUT", "/providers", {
        ...provider,
        apiKey: undefined,
        name: "Renamed",
      })
    ).status,
  ).toBe(200);
  expect((await call("POST", "/test", selection)).status).toBe(200);
  expect(
    (await call("POST", "", { request: { ...request, model: "other" } }))
      .status,
  ).toBe(422);
  expect(
    (await call("PUT", "/providers", { ...provider, enabled: false })).status,
  ).toBe(200);
  expect((await call("POST", "", { request })).status).toBe(409);
  expect((await call("DELETE", "/providers/local-jev")).status).toBe(200);
  const count = sent.length;
  expect((await call("POST", "", { request })).status).toBe(409);
  expect(
    JSON.parse(await readFile(join(dir, "systemone.json"), "utf8")).selection,
  ).toEqual(selection);
  expect(sent).toHaveLength(count);
});

test("managed EigenJev reuses the subscription key and denies disabled, unavailable, offline and signed-out calls", async () => {
  await writeEigenweltConnection(config, {
    platformURL: platform.url.origin,
    platformToken: "platform-token",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    account: {
      userId: "user-test",
      userName: null,
      userEmail: null,
      orgId: "org-test",
      orgName: "Test Firm",
    },
    entitlements: parseEigenweltEntitlements({
      plan: "plus",
      subscriptionStatus: "active",
      features: ["premium_models"],
      seats: 1,
    }),
  });
  await writeCachedEigenweltPaidManifest(config, {
    baseURL: "https://paid-gateway.test/v1",
    apiKey: "existing-subscription-key",
    models: [],
  });
  expect(
    (
      await call("PUT", "/selection", {
        providerId: "eigenwelt",
        model: "EigenJev",
      })
    ).status,
  ).toBe(200);
  const result = await call("POST", "", { request });
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    model: "openjev-0.1",
    requestedModel: "EigenJev",
    providerId: "eigenwelt",
  });
  expect(sent.at(-1)).toEqual({
    authorization: "Bearer existing-subscription-key",
    model: "EigenJev",
  });
  const count = sent.length;
  enabled = false;
  expect((await call("POST", "", { request })).status).toBe(409);
  enabled = true;
  available = false;
  expect((await call("POST", "", { request })).status).toBe(409);
  available = true;
  platformStatus = 503;
  expect((await call("POST", "", { request })).status).toBe(409);
  platformStatus = 200;
  await writeEigenweltConnection(config, {
    entitlements: null,
    account: null,
    platformToken: null,
    refreshToken: null,
  });
  expect((await call("POST", "", { request })).status).toBe(409);
  expect(sent).toHaveLength(count);
  expect((await call("DELETE", "/providers/eigenwelt")).status).toBe(400);
});


test("one provider discovers aliases and executes multiple models with the same key", async () => {
  const provider = { id: "typesafe", name: "TypeSafe JEV", endpoint: `${platform.url.origin}/v1/systemone`, apiKey: "custom-secret", enabled: true, models: [] };
  expect((await call("PUT", "/providers", provider)).status).toBe(200);
  const read = async () => z.object({providers:z.array(SystemOneProviderSchema)}).parse(await (await call("GET", "/settings")).json()).providers.find(p => p.id === provider.id)!;
  expect((await read()).models.map(m=>m.id)).toEqual(["jev-latest","jev-preview"]);
  for (const model of catalogNames) {
    expect((await call("POST", "", {providerId:provider.id,request:{...request,model}})).status).toBe(200);
    expect(sent.at(-1)).toEqual({model,authorization:"Bearer custom-secret"});
  }
  expect((await call("PUT", "/selection", {providerId:provider.id,model:"jev-preview"})).status).toBe(200);
  expect((await call("POST", "", {request})).status).toBe(200);
  expect(sent.at(-1)?.model).toBe("jev-preview");
  catalogNames=["jev-latest"];
  expect((await call("POST", "", {request})).status).toBe(422);
  catalogNames=["jev-latest","jev-preview"];
  catalogStatus=503;
  expect((await read()).status).toBe("unavailable");
  expect((await read()).models).toEqual([]);
  const count=sent.length;
  expect((await call("POST", "", {request})).status).toBe(422);
  expect(sent).toHaveLength(count);
  // Explicit version pins remain usable even without a listing endpoint.
  expect((await call("PUT", "/providers", {...provider,models:[{id:"jev-1.13.0",name:"Pinned JEV",questionTypes:["noul"]}]})).status).toBe(200);
  expect((await call("POST", "", {providerId:provider.id,request:{...request,model:"jev-1.13.0"}})).status).toBe(200);
  expect((await read()).modelsError).not.toContain("private error body");
  catalogStatus=401;
  expect((await read()).status).toBe("disconnected");
  catalogStatus=200;
});

test("legacy one-model connections migrate without changing credentials, IDs or selection",async()=>{
  const legacy={id:"old-connection",name:"Old provider",endpoint:`${platform.url.origin}/v1/systemone`,apiKey:"custom-secret",enabled:true,model:"jev-1.12.0",questionTypes:["noul"]};
  const selected={providerId:legacy.id,model:legacy.model};
  await writeFile(join(dir,"systemone.json"),JSON.stringify({providers:[legacy],selection:selected}),{mode:0o600});
  const response=await (await call("GET","/settings")).json();
  const settings=z.object({providers:z.array(SystemOneProviderSchema),selection:z.object({providerId:z.string(),model:z.string()})}).parse(response);
  expect(settings.selection).toEqual(selected);
  const provider=settings.providers.find(p=>p.id===legacy.id)!;
  expect(provider.models.map(m=>m.id)).toEqual(["jev-latest","jev-preview","jev-1.12.0"]);
  expect(JSON.stringify(response)).not.toContain("custom-secret");
  expect((await call("POST","",{request})).status).toBe(200);
  expect(sent.at(-1)).toEqual({model:"jev-1.12.0",authorization:"Bearer custom-secret"});
  // A normal edit writes the new format, retaining the key and the selected version.
  expect((await call("PUT","/providers",{...provider,models:provider.models.filter(m=>m.source==="configured"),name:"Renamed"})).status).toBe(200);
  const stored=JSON.parse(await readFile(join(dir,"systemone.json"),"utf8"));
  expect(stored.providers[0].model).toBeUndefined();
  expect(stored.providers[0].models[0].id).toBe(legacy.model);
  expect(stored.providers[0].apiKey).toBe(legacy.apiKey);
  expect(stored.selection).toEqual(selected);
});
