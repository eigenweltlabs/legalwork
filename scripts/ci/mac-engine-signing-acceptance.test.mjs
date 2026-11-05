import { test } from "node:test";
import assert from "node:assert/strict";
import { macSigningIdentity, macTargets, parseKeychainSearchList, validateMacAcceptanceManifest } from "./mac-engine-signing-acceptance.mjs";

test("native keychain paths preserve spaces and quoted entries without shell splitting", () => {
  assert.deepEqual(parseKeychainSearchList('    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/private/owned signing/identity.keychain-db"\n'), ["/Users/runner/Library/Keychains/login.keychain-db", "/private/owned signing/identity.keychain-db"]);
});
for (const text of ['"relative.keychain"', '"/private/one\\ntwo"', '/unquoted/keychain', 'null']) test(`native keychain paths reject ${JSON.stringify(text)}`, () => {
  assert.throws(() => parseKeychainSearchList(text));
});

const hash = "a".repeat(64);
function fixture() {
  return { schemaVersion: 1, kind: "signed-mac-engine-acceptance-not-adopted", recipeSha256: hash, signer: { ...macSigningIdentity },
    archive: { filename: "engines.tgz", bytes: 123, sha256: hash },
    builds: macTargets.map(target => ({ target, directory: `build-${target}/artifact`, provenanceSha256: hash,
      files: Object.fromEntries(["LICENSE", "NOTICE", "SHA256SUMS", "opencode", "provenance.json"].map(name => [name, { bytes: 1, mode: name === "opencode" ? 0o755 : 0o644, sha256: hash }])) })) };
}
test("acceptance retains the complete three-Mac matrix and exact independent public identity", () => {
  assert.equal(macSigningIdentity.teamId, "9VTQ834B95");
  assert.equal(macSigningIdentity.identitySha1, "5eccdbc844b673d12b8528f6b8ea5f41f6d4e4a6");
  assert.equal(macSigningIdentity.certificateSha256, "dec87895435a1392571678dfd71a8ebeea873a7e3602b372de65dd217a79a228");
  validateMacAcceptanceManifest(fixture(), hash);
});
for (const [name, change] of [
  ["foreign signer", value => { value.signer.teamId = "OTHERTEAM1"; }],
  ["unrelated recipe", value => { value.recipeSha256 = "b".repeat(64); }],
  ["missing Intel baseline", value => { value.builds.pop(); }],
  ["duplicate target", value => { value.builds[1] = structuredClone(value.builds[0]); }],
  ["escaping artifact path", value => { value.builds[0].directory = "../outside"; }],
  ["malformed archive digest", value => { value.archive.sha256 = "unbound"; }],
  ["unexpected artifact file", value => { value.builds[0].files["identity.p12"] = value.builds[0].files.LICENSE; }],
  ["nonexecutable engine", value => { value.builds[0].files.opencode.mode = 0o644; }],
  ["implicit adoption", value => { value.kind = "production-adopted"; }],
]) test(`acceptance rejects ${name} before extraction or native commands`, () => {
  const value = fixture(); change(value); assert.throws(() => validateMacAcceptanceManifest(value, hash));
});
