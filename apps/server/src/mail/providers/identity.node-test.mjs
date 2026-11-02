import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverMailIdentity } from './identity.js';
import { GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES } from '../provider-config.js';
const gmail={provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-secret',scopes:GMAIL_MAIL_SCOPES};
const graph={provider:'graph',applicationType:'desktop',pkceMethod:'S256',clientId:'11111111-2222-3333-4444-555555555555',tenantId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',registeredRedirectUri:'http://localhost/mail/callback',scopes:GRAPH_MAIL_SCOPES};
test('Node Google canonical subject comes from userinfo with profile consistency',async()=>{
 const result=await discoverMailIdentity({settings:gmail,accessToken:'synthetic-access',grantedScopes:GMAIL_MAIL_SCOPES,fetch:async(url,options)=>{
  assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-access');
  return Response.json(url.includes('userinfo')?{sub:'synthetic-sub',email:'a@example.test',email_verified:true}:{emailAddress:'A@example.test'});
 }});assert.equal(result.providerSubject,'synthetic-sub');assert.equal(result.authority,'https://accounts.google.com');assert.equal(result.tenantId,null);
});
test('Node Graph identity is bound to API verified tenant, not UPN',async()=>{
 const result=await discoverMailIdentity({settings:graph,accessToken:'synthetic-access',grantedScopes:['User.Read'],fetch:async(url)=>Response.json(url.includes('/organization')?{value:[{id:graph.tenantId}]}:{id:graph.clientId,mail:'a@example.test',userPrincipalName:'different@example.test'})});
 assert.equal(result.tenantId,graph.tenantId);assert.equal(result.providerSubject,graph.clientId);assert.equal(result.email,'a@example.test');
});
test('Node mismatch and ignored-abort deadline produce no identity',async()=>{
 await assert.rejects(discoverMailIdentity({settings:gmail,accessToken:'synthetic-access',grantedScopes:GMAIL_MAIL_SCOPES,fetch:async(url)=>Response.json(url.includes('userinfo')?{sub:'s',email:'a@example.test',email_verified:true}:{emailAddress:'b@example.test'})}),/identity_mismatch/);
 await assert.rejects(discoverMailIdentity({settings:gmail,accessToken:'synthetic-access',grantedScopes:GMAIL_MAIL_SCOPES,timeoutMs:10,fetch:async()=>new Promise(()=>{})}),/timeout/);
});
