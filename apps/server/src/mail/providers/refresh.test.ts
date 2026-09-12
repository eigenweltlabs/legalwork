import {linkTestModules} from '../../../../../scripts/mail/link-test-modules.mjs';
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, copyFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from "../provider-config.js";
import type { MailOAuthSettings, OAuthFetch } from "./oauth.js";
import { refreshMailOAuth, MailRefreshError, type MailRefreshErrorCode } from "./refresh.js";
const gmail: MailOAuthSettings = { provider: "gmail", applicationType: "desktop", clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic-secret", scopes: GMAIL_MAIL_SCOPES, pkceMethod: "S256" };
const graph: MailOAuthSettings = { provider: "graph", applicationType: "desktop", clientId: "11111111-2222-3333-4444-555555555555", tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", scopes: GRAPH_MAIL_SCOPES, pkceMethod: "S256", registeredRedirectUri: "http://localhost/mail/callback" };
const success = { access_token: "synthetic-access", token_type: "Bearer", expires_in: 3600 };
const call = (fetch: OAuthFetch, settings: MailOAuthSettings = gmail, options: { signal?: AbortSignal; timeoutMs?: number } = {}) => refreshMailOAuth({ settings, refreshToken: "synthetic-old", fetch, ...options });
async function failure(fetch: OAuthFetch): Promise<MailRefreshError> {
 try { await call(fetch); throw new Error("expected rejection"); } catch(error) { if (!(error instanceof MailRefreshError)) throw error; return error; }
}
test("Google omission preserves; Graph replacement is explicit; endpoint/body contract", async () => {
 for (const settings of [gmail,graph]) {
  const result=await call(async(url, options)=>{
   expect(url).toBe(settings.provider === "gmail" ? "https://oauth2.googleapis.com/token" : `https://login.microsoftonline.com/${settings.tenantId}/oauth2/v2.0/token`);
   expect(url).not.toContain("synthetic-old");expect(options.redirect).toBe("error");expect(options.method).toBe("POST");
   if(typeof options.body!=="string")throw new Error("expected form body");const body=new URLSearchParams(options.body);
   expect(body.get("grant_type")).toBe("refresh_token");expect(body.get("refresh_token")).toBe("synthetic-old");expect(body.has("scope")).toBe(false);
   expect(body.get("client_secret")).toBe(settings.provider === "gmail" ? "synthetic-secret" : null);
   return Response.json({...success,...(settings.provider==="graph"?{refresh_token:"synthetic-new"}:{})});
  },settings);
  expect(result.refreshToken).toEqual(settings.provider==="gmail"?{action:"preserve"}:{action:"replace",value:"synthetic-new"});expect(result.grantedScopes).toBeNull();expect(result.unverifiedIdToken).toBeNull();
 }
});
test("either provider can preserve or replace; response permissions remain explicit",async()=>{
 const replaced=await call(async()=>Response.json({...success,refresh_token:"synthetic-new",scope:"a b a",id_token:"unverified"}));
 expect(replaced.refreshToken).toEqual({action:"replace",value:"synthetic-new"});expect(replaced.grantedScopes).toEqual(["a","b"]);expect(replaced.unverifiedIdToken).toBe("unverified");
 const preserved=await call(async()=>Response.json(success),graph);expect(preserved.refreshToken).toEqual({action:"preserve"});
 expect(preserved.expiresAt).toBeGreaterThan(Date.now());expect(preserved.expiresAt).toBeLessThanOrEqual(Date.now()+3600000);
});
test("allowlisted errors distinguish reconsent, configuration and retry without reflecting provider data",async()=>{
 const cases: [string, MailRefreshErrorCode][] = [["invalid_grant","reconsent_required"],["interaction_required","reconsent_required"],["consent_required","reconsent_required"],["login_required","reconsent_required"],["invalid_client","client_rejected"],["unauthorized_client","client_rejected"],["temporarily_unavailable","transient"],["server_error","transient"],["synthetic-secret","request_rejected"]];
 for(const [providerCode,expected] of cases){
  const error=await failure(async()=>Response.json({error:providerCode,error_description:"synthetic-old",access_token:"synthetic-access"},{status:400}));
  expect(error.code).toBe(expected);expect(error.retryable).toBe(expected==="transient");expect(JSON.stringify(error)+error.stack).not.toContain("synthetic-");
 }
});
test("429, 408 and 5xx ignore raw bodies and expose bounded safe retry timing",async()=>{
 for(const status of [429,408,500,503]){
  const error=await failure(async()=>new Response("synthetic-secret",{status,headers:{"Retry-After":"123"}}));
  expect(error.code).toBe(status===429?"rate_limited":"transient");expect(error.retryAfterMs).toBe(123000);expect(error.retryable).toBe(true);
 }
 for(const value of ["-1","1.2","Infinity","9".repeat(130),"synthetic-secret"]){expect((await failure(async()=>new Response(null,{status:429,headers:{"Retry-After":value}}))).retryAfterMs).toBeNull();}
 const date=new Date(Date.now()+60000).toUTCString();const error=await failure(async()=>new Response(null,{status:503,headers:{"Retry-After":date}}));
 expect(error.retryAfterMs).toBeGreaterThan(58000);expect(error.retryAfterMs).toBeLessThanOrEqual(60000);
});
test("reject malformed token type, expiry and optional tokens; never overwrite credential on partial failure",async()=>{
 for(const patch of [{token_type:"Basic"},{expires_in:0},{expires_in:"3600"},{expires_in:604801},{access_token:""},{refresh_token:null},{refresh_token:""},{scope:42},{id_token:""},{error:"invalid_grant"}]){
  await expect(call(async()=>Response.json({...success,...patch}))).rejects.toThrow("response_invalid");
 }
 for(const response of [new Response("{" ,{headers:{"content-type":"application/json"}}),new Response("<html>synthetic-secret</html>"),Response.json({error:"invalid_grant"},{status:302})]){
  const error=await failure(async()=>response);expect(error.retryable).toBe(false);expect(error.message).not.toContain("synthetic-secret");
 }
});
test("stream bytes are capped on success and provider errors; stream failures are redacted",async()=>{
 for(const status of [200,400])await expect(call(async()=>new Response('"'+"x".repeat(65536)+'"',{status,headers:{"content-type":"application/json"}}))).rejects.toThrow("response_invalid");
 const error=await failure(async()=>{throw new Error("synthetic-secret");});expect(error.code).toBe("transient");expect(error.message).not.toContain("synthetic-secret");
});
test("deadline and cancellation stop waiting even when fetch/body ignores abort; no automatic retries",async()=>{
 let calls=0;await expect(call(async()=>{calls++;return new Promise(()=>{});},gmail,{timeoutMs:10})).rejects.toThrow("timeout");expect(calls).toBe(1);
 await expect(call(async()=>new Response(new ReadableStream({start(){}}),{headers:{"content-type":"application/json"}}),gmail,{timeoutMs:10})).rejects.toThrow("timeout");
 const controller=new AbortController();const pending=call(async()=>new Promise(()=>{}),gmail,{signal:controller.signal});controller.abort();await expect(pending).rejects.toThrow("cancelled");
 await expect(call(async()=>{throw new Error("must not fetch");},gmail,{signal:controller.signal})).rejects.toThrow("cancelled");
});
test("invalid installed-app/tenant/credentials reject before HTTP",async()=>{
 let calls=0;const fetch:OAuthFetch=async()=>{calls++;return Response.json(success);};
 await expect(refreshMailOAuth({settings:gmail,refreshToken:"",fetch})).rejects.toThrow("configuration_invalid");
 await expect(call(fetch,{...gmail,clientSecret:""})).rejects.toThrow("configuration_invalid");
 await expect(call(fetch,{...graph,tenantId:"common"})).rejects.toThrow("configuration_invalid");
 await expect(call(fetch,gmail,{timeoutMs:0})).rejects.toThrow("configuration_invalid");expect(calls).toBe(0);
});
test("compiled refresh module passes actual Node tests",async()=>{
 const node=Bun.which("node");if(!node)throw new Error("Node required");
 const server=fileURLToPath(new URL("../../../",import.meta.url));const directory=await mkdtemp(join(tmpdir(),"legalwork-refresh-node-"));
 try {
  await writeFile(join(directory,"package.json"),'{"type":"module"}');await linkTestModules(join(server,"node_modules"),join(directory,"node_modules"));
  execFileSync("pnpm",["exec","tsc","--outDir",directory,"--rootDir","src","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext","--strict","--skipLibCheck","--types","bun-types,node","src/mail/providers/refresh.ts"],{cwd:server,timeout:30000,stdio:"pipe"});
  const path=join(directory,"mail/providers/refresh.node-test.mjs");await copyFile(fileURLToPath(new URL("./refresh.node-test.mjs",import.meta.url)),path);
  const output=execFileSync(node,["--test",path],{encoding:"utf8",timeout:15000,stdio:"pipe"});expect(output).toContain("tests 3");expect(output).toContain("fail 0");
 }finally{await rm(directory,{recursive:true,force:true});}
},45000);
