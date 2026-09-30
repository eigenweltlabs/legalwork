import {afterEach,expect,test} from "bun:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {parseEigenweltEntitlements} from "./eigenwelt-auth.js";
import {writeEigenweltConnection} from "./eigenwelt-connection-store.js";
import {eigenweltUsageRequest} from "./eigenwelt-usage.js";
import type {ServerConfig} from "./types.js";
const previousPlatformUrl = process.env.EIGENWELT_PLATFORM_URL;
const previousRuntimeDb = process.env.LEGALWORK_RUNTIME_DB;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
  if (previousPlatformUrl === undefined) delete process.env.EIGENWELT_PLATFORM_URL;
  else process.env.EIGENWELT_PLATFORM_URL = previousPlatformUrl;
  if (previousRuntimeDb === undefined) delete process.env.LEGALWORK_RUNTIME_DB;
  else process.env.LEGALWORK_RUNTIME_DB = previousRuntimeDb;
});

async function signedInFirm(): Promise<ServerConfig> {
  const root = await mkdtemp(join(tmpdir(), "legalwork-eigenwelt-refresh-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  await writeEigenweltConnection(config, {
    entitlements: parseEigenweltEntitlements({
      plan: "plus",
      subscriptionStatus: "active",
      features: ["premium_models"],
      seats: 1,
      usage: { window: "week", allowanceCents: 693, remainingCents: 693 },
    }),
    account: { userId: "user_1", userName: null, userEmail: "anna@kanzlei.de", orgId: "org_1", orgName: "Kanzlei Berg" },
    platformToken: "access-token",
    refreshToken: "refresh-token",
    // Expired, so the next read tries to refresh.
    accessTokenExpiresAt: Date.now() + 3_600_000,
  });
  return config;
}


test("forwards the account credential only to the fixed platform and preserves the body",async()=>{
 const config=await signedInFirm();process.env.EIGENWELT_PLATFORM_URL="https://platform.test";
 const original=globalThis.fetch;let sent:RequestInit|undefined,url="";
 globalThis.fetch=Object.assign(async(input:RequestInfo|URL,init?:RequestInit)=>{url=String(input);sent=init;return Response.json({ok:true});},{preconnect:original.preconnect});
 try {
  const action={action:"request",kind:"temporary",amountCents:3000,reason:"Deadline"};
  expect(await eigenweltUsageRequest(config,action)).toEqual({ok:true});
  expect(url).toBe("https://platform.test/api/usage-control");
  expect(new Headers(sent?.headers).get("Authorization")).toBe("Bearer access-token");
  expect(JSON.parse(String(sent?.body))).toEqual(action);
 }finally{globalThis.fetch=original;}
});
test("propagates denied administration without reporting success",async()=>{
 const config=await signedInFirm();const original=globalThis.fetch;
 globalThis.fetch=Object.assign(async()=>Response.json({error:"admin_required"},{status:403}),{preconnect:original.preconnect});
 try {await expect(eigenweltUsageRequest(config,{action:"checkout",amountCents:3000})).rejects.toMatchObject({status:403});}
 finally{globalThis.fetch=original;}
});
