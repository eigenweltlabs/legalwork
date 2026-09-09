import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, copyFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from "../provider-config.js";
import type { MailOAuthSettings, OAuthFetch } from "./oauth.js";
import { discoverMailIdentity, MailIdentityError } from "./identity.js";
const gmail: MailOAuthSettings = { provider: "gmail", applicationType: "desktop", clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic-secret", scopes: GMAIL_MAIL_SCOPES, pkceMethod: "S256" };
const graph: MailOAuthSettings = { provider: "graph", applicationType: "desktop", clientId: "11111111-2222-3333-4444-555555555555", tenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", scopes: GRAPH_MAIL_SCOPES, pkceMethod: "S256", registeredRedirectUri: "http://localhost/mail/callback" };
const user = {sub:"stable-sub",email:"a@example.test",email_verified:true};
const profile = {emailAddress:"a@example.test"};
const graphUser = {id:"11111111-2222-3333-4444-555555555555",mail:"a@example.test",displayName:"Person",userPrincipalName:"different@example.test"};
const org = {value:[{id:"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}]};
const call = (fetch: OAuthFetch, settings: MailOAuthSettings = gmail, options: {signal?: AbortSignal;timeoutMs?:number;grantedScopes?:readonly string[]|null} = {}) => discoverMailIdentity({settings,accessToken:"synthetic-access",grantedScopes:settings.scopes,fetch,...options});
const responses = (first: unknown, second: unknown): OAuthFetch => {let count=0;return async()=>Response.json(count++===0?first:second);};
test("Google fixed endpoint and header contract uses stable subject with matching verified email",async()=>{
 const urls:string[]=[];const result=await call(async(url,options)=>{
  urls.push(url);expect(options.method).toBe("GET");expect(options.redirect).toBe("error");expect(new Headers(options.headers).get("Authorization")).toBe("Bearer synthetic-access");expect(url).not.toContain("synthetic-access");
  return Response.json(urls.length===1?user:{emailAddress:"A@example.test"});
 });expect(urls).toEqual(["https://openidconnect.googleapis.com/v1/userinfo","https://gmail.googleapis.com/gmail/v1/users/me/profile"]);
 expect(result).toEqual({provider:"gmail",authority:"https://accounts.google.com",providerSubject:"stable-sub",tenantId:null,email:"A@example.test",displayName:null});
});
test("Google missing/unverified identities or differing aliases fail closed",async()=>{
 for(const first of [{...user,sub:""},{...user,email_verified:false},{...user,email_verified:"true"},{...user,email:"a@example.test\n"},{...user,sub:"x".repeat(256)}])await expect(call(responses(first,profile))).rejects.toThrow("response_invalid");
 for(const emailAddress of ["b@example.test","a+alias@example.test","a@googlemail.com"]){await expect(call(responses(user,{emailAddress}))).rejects.toThrow("identity_mismatch");}
 await expect(call(responses(user,{emailAddress:null}))).rejects.toThrow("response_invalid");
});
test("Graph verifies exact tenant before stable directory ID, allowing legitimately different UPN",async()=>{
 const urls:string[]=[];const result=await call(async(url)=>{urls.push(url);return Response.json(url.includes("/organization")?org:graphUser);},graph);
 expect(urls).toEqual(["https://graph.microsoft.com/v1.0/organization?$select=id","https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName"]);
 expect(result).toEqual({provider:"graph",authority:"https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0",tenantId:org.value[0].id,providerSubject:graphUser.id,email:"a@example.test",displayName:"Person"});
});
test("Graph foreign tenant, ambiguous organizations, missing mailbox or mutable IDs fail",async()=>{
 let calls=0;await expect(call(async()=>{calls++;return Response.json({value:[{id:graphUser.id}]});},graph)).rejects.toThrow("identity_mismatch");expect(calls).toBe(1);
 for(const first of [{value:[]},{value:[...org.value,...org.value]},{value:[{id:"common"}]},{...org,"@odata.nextLink":"https://evil.test"}])await expect(call(responses(first,graphUser),graph)).rejects.toThrow("response_invalid");
 for(const second of [{...graphUser,id:"a@example.test"},{...graphUser,mail:null},{...graphUser,mail:""},{...graphUser,displayName:"x".repeat(1025)}])await expect(call(responses(org,second),graph)).rejects.toThrow("response_invalid");
});
test("actual grants required; Google documented email alias accepted; requested config never substitutes",async()=>{
 for(const grantedScopes of [null,[],["openid","email"],["https://www.googleapis.com/auth/gmail.modify"]])await expect(call(responses(user,profile),gmail,{grantedScopes})).rejects.toThrow("scope_unverified");
 expect((await call(responses(user,profile),gmail,{grantedScopes:["openid","https://www.googleapis.com/auth/userinfo.email","https://www.googleapis.com/auth/gmail.modify"]})).provider).toBe("gmail");
 await expect(call(responses(org,graphUser),graph,{grantedScopes:["Mail.ReadWrite"]})).rejects.toThrow("scope_unverified");
 expect((await call(responses(org,graphUser),graph,{grantedScopes:["https://graph.microsoft.com/User.Read"]})).provider).toBe("graph");
});
test("provider/network failures redact every raw field and disallow redirects",async()=>{
 for(const status of [302,400,401,403,429,500]){
  try{await call(async()=>new Response("synthetic-secret",{status}));throw new Error("expected error");}
  catch(error){if(!(error instanceof MailIdentityError))throw error;expect(error.code).toBe(status===401?"unauthorized":status===403?"forbidden":status===429||status===500?"transient":"response_invalid");expect(error.message+JSON.stringify(error)).not.toContain("synthetic-secret");}
 }
 await expect(call(async()=>{throw new Error("synthetic-secret");})).rejects.toThrow("mail_identity_transient");
 await expect(call(async()=>Response.json({...user,error:{message:"synthetic-secret"}}))).rejects.toThrow("response_invalid");
});
test("bounded JSON, total deadline, cancellation and late response cleanup",async()=>{
 await expect(call(async()=>new Response('"'+"x".repeat(65536)+'"',{headers:{"content-type":"application/json"}}))).rejects.toThrow("response_invalid");
 await expect(call(async()=>new Promise(()=>{}),gmail,{timeoutMs:10})).rejects.toThrow("timeout");
 await expect(call(async()=>new Response(new ReadableStream({start(){}}),{headers:{"content-type":"application/json"}}),gmail,{timeoutMs:10})).rejects.toThrow("timeout");
 const controller=new AbortController();const pending=call(async()=>new Promise(()=>{}),gmail,{signal:controller.signal});controller.abort();await expect(pending).rejects.toThrow("cancelled");
 let called=false;await expect(call(async()=>{called=true;return Response.json(user);},gmail,{signal:controller.signal})).rejects.toThrow("cancelled");expect(called).toBe(false);
 let resolve:(response:Response)=>void=()=>{};let cancelled=false;const late=call(async()=>new Promise(r=>{resolve=r;}),gmail,{timeoutMs:10});await expect(late).rejects.toThrow("timeout");
 resolve(new Response(new ReadableStream({cancel(){cancelled=true;}})));await new Promise(r=>setTimeout(r,0));expect(cancelled).toBe(true);
});
test("compiled identity module passes actual Node tests",async()=>{
 const node=Bun.which("node");if(!node)throw new Error("Node required");
 const server=fileURLToPath(new URL("../../../",import.meta.url));const directory=await mkdtemp(join(tmpdir(),"legalwork-identity-node-"));
 try {
  await writeFile(join(directory,"package.json"),'{"type":"module"}');await symlink(join(server,"node_modules"),join(directory,"node_modules"));
  execFileSync("pnpm",["exec","tsc","--outDir",directory,"--rootDir","src","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext","--strict","--skipLibCheck","--types","bun-types,node","src/mail/providers/identity.ts"],{cwd:server,timeout:30000,stdio:"pipe"});
  const path=join(directory,"mail/providers/identity.node-test.mjs");await copyFile(fileURLToPath(new URL("./identity.node-test.mjs",import.meta.url)),path);
  const output=execFileSync(node,["--test",path],{encoding:"utf8",timeout:15000,stdio:"pipe"});expect(output).toContain("tests 3");expect(output).toContain("fail 0");
 }finally{await rm(directory,{recursive:true,force:true});}
},45000);
