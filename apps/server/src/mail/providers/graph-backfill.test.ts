import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { startServer } from "../../server.js";
import { LocalMailService } from "../service.js";
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, symlinkSync, copyFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("Graph acceptance runs in encrypted Node with no live requests", async () => {
    const out = mkdtempSync(join(tmpdir(), "legalwork-graph-")), server = resolve(import.meta.dir, "../../..");
    const envNames = ["LEGALWORK_ENV_STORE", "LEGALWORK_TOKEN_STORE", "XDG_DATA_HOME"], saved = new Map(envNames.map(name => [name, process.env[name]]));
    for (const name of envNames)
        process.env[name] = join(out, name);
    try {
        const compile = spawnSync("pnpm", ["exec", "tsc", "--outDir", out, "--rootDir", "src", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--strict", "--skipLibCheck", "--types", "bun-types,node", "src/mail/runtime/worker.ts", "src/mail/runtime/client.ts", "src/mail/service.ts"], { cwd: server, encoding: "utf8", timeout: 30000 });
        if (compile.status !== 0)
            throw Error(compile.stdout + compile.stderr);
        writeFileSync(join(out, "package.json"), '{"type":"module"}');
        symlinkSync(realpathSync(join(server, "node_modules")), join(out, "node_modules"), "dir");
        const target = join(out, "mail/providers/graph-backfill.node-test.mjs");
        copyFileSync(join(import.meta.dir, "graph-backfill.node-test.mjs"), target);
        const result = spawnSync("node", ["--test", target], { encoding: "utf8", timeout: 60000 });
        if (result.status !== 0)
            throw Error(result.stdout + result.stderr);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("fail 0");
        const key = randomBytes(32), databasePath = join(out, "http.sqlite"), worker = join(out, "mail/runtime/worker.js");
        const settings = { provider: "graph", clientId: "11111111-1111-4111-8111-111111111111", tenantId: "22222222-2222-4222-8222-222222222222", applicationType: "desktop", pkceMethod: "S256", registeredRedirectUri: "http://localhost/mail/callback", scopes: ["openid", "profile", "offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"] } satisfies import("./oauth.js").MailOAuthSettings;
        const seed = spawnSync("node", ["--input-type=module", "--eval", `
 import {openEncryptedMailDatabase} from ${JSON.stringify(pathToFileURL(join(out, "mail/storage/database.js")).href)};
 import {migrateMailSchema} from ${JSON.stringify(pathToFileURL(join(out, "mail/storage/schema.js")).href)};
 import {MailRepository} from ${JSON.stringify(pathToFileURL(join(out, "mail/storage/repository.js")).href)};
 import {MailCredentialRepository} from ${JSON.stringify(pathToFileURL(join(out, "mail/storage/credentials.js")).href)};
 const db=await openEncryptedMailDatabase({path:${JSON.stringify(databasePath)},key:Buffer.from(${JSON.stringify(key.toString("base64"))},'base64')});migrateMailSchema(db);
 new MailRepository(db,'owner').createAccount({id:'a',provider:'graph',displayName:'Synthetic Graph'});
 new MailCredentialRepository(db,'owner').connect('a',{provider:'graph',clientId:'11111111-1111-4111-8111-111111111111',authority:'https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0',providerSubject:'33333333-3333-4333-8333-333333333333'},null,{accessToken:'synthetic',expiresAt:Date.now()+3600000,grantedScopes:['Mail.ReadWrite'],refreshToken:{action:'clear'}});db.close();`], { encoding: "utf8" });
        if (seed.status !== 0)
            throw Error(seed.stdout + seed.stderr);
        const bootstrap = join(out, "http-worker.mjs");
        writeFileSync(bootstrap, `globalThis.fetch=async(input,init)=>{if(!String(input).startsWith('https://graph.microsoft.com/v1.0/me/')||init.headers.Prefer!=='IdType="ImmutableId"')throw Error('Unexpected provider request');return Response.json({value:[]});};await import(${JSON.stringify(pathToFileURL(worker).href)});`);
        const service = new LocalMailService({ ownerId: "owner", databasePath, loadKey: async () => Buffer.from(key), entryPoint: bootstrap, executable: { kind: "node", path: Bun.which("node")! }, loadProviderSettings: async () => settings });
        const running = await startServer({ host: "127.0.0.1", port: 0, token: "synthetic-collaborator", hostToken: "synthetic-host", configPath: join(out, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false }, { mail: service });
        const base = `http://127.0.0.1:${running.port}/mail/v1`, headers = { "x-legalwork-host-token": "synthetic-host" };
        try {
            expect((await fetch(`${base}/accounts/a/sync/start`, { method: "POST" })).status).toBe(401);
            expect((await fetch(`${base}/unlock`, { method: "POST", headers })).status).toBe(200);
            expect((await fetch(`${base}/accounts/a/sync/start`, { method: "POST", headers })).status).toBe(200);
            let state = "";
            for (let i = 0; i < 100; i++) {
                const response = await fetch(`${base}/accounts/a/sync`, { headers });
                const value = await response.json();
                expect(value.provider).toBe("graph");
                state = value.state;
                if (state === "complete")
                    break;
                await Bun.sleep(10);
            }
            expect(state).toBe("complete");
            expect((await fetch(`${base}/accounts/a/sync/pause`, { method: "POST", headers })).status).toBe(200);
            expect((await fetch(`${base}/accounts/a/disconnect`, { method: "POST", headers })).status).toBe(200);
            expect((await fetch(`${base}/accounts/a/sync`, { headers })).status).toBe(423);
        }
        finally {
            await running.stop();
            await service.stop();
            key.fill(0);
        }
    }
    finally {
        for (const name of envNames) {
            const value = saved.get(name);
            if (value === undefined)
                delete process.env[name];
            else
                process.env[name] = value;
        }
        rmSync(out, { recursive: true, force: true });
    }
}, 95000);
