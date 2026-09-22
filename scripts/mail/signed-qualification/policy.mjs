import assert from 'node:assert/strict';
export function signatureIdentity(text) {
  assert(!text.includes('Signature=adhoc'),'Ad-hoc signatures do not qualify');
  const team=text.match(/^TeamIdentifier=(.+)$/m)?.[1];
  const identifier=text.match(/^Identifier=(.+)$/m)?.[1];
  assert(team&&team!=='not set','Developer ID team missing');
  assert.equal(identifier,'com.eigenweltlabs.legalwork');
  assert.match(text,/Authority=Developer ID Application:/);
  return {team,identifier};
}
export function assertUpdated(result, {targetVersion,arch}) {
  assert.equal(result.passed,true);assert.equal(result.version,targetVersion);assert.equal(result.arch,arch);
  for(const field of ['keychainReopened','draftRetained','queuedActionRetained','originalRetained']) assert.equal(result[field],true,field);
}
