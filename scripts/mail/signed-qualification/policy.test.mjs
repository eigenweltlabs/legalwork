import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signatureIdentity,assertUpdated} from './policy.mjs';
const signed='Identifier=com.eigenweltlabs.legalwork\nAuthority=Developer ID Application: Synthetic\nTeamIdentifier=TESTTEAM\n';
test('requires Developer ID distribution identity, never ad-hoc or another bundle',()=>{
  assert.deepEqual(signatureIdentity(signed),{team:'TESTTEAM',identifier:'com.eigenweltlabs.legalwork'});
  for(const value of [signed+'Signature=adhoc',signed.replace('com.eigenweltlabs.legalwork','foreign'),signed.replace('TESTTEAM','not set'),signed.replace('Developer ID Application:','Apple Development:')])assert.throws(()=>signatureIdentity(value));
});
test('a download or old-process exit cannot be mistaken for a retained-data update',()=>{
  const config={targetVersion:'0.0.2',arch:'arm64'};
  const result={passed:true,version:'0.0.2',arch:'arm64',keychainReopened:true,draftRetained:true,queuedActionRetained:true,originalRetained:true};
  assertUpdated(result,config);
  for(const change of [{version:'0.0.1'},{arch:'x64'},{keychainReopened:false},{queuedActionRetained:false},{passed:false}])assert.throws(()=>assertUpdated({...result,...change},config));
});
