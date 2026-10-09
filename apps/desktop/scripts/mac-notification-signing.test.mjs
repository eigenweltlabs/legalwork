import assert from "node:assert/strict";
import { test } from "node:test";
import { selectNotificationSigning } from "./mac-notification-signing.mjs";

const identifier = "com.example.app.dev";
const profile = {
  expires: "2030-01-01T00:00:00Z",
  entitlements: {
    "com.apple.developer.team-identifier": "TEAM",
    "com.apple.application-identifier": `TEAM.${identifier}`,
    "com.apple.developer.usernotifications.communication": true,
  },
  certificates: ["CERTIFICATE"],
};
const now = Date.parse("2026-01-01T00:00:00Z");
test("requires the capability, correct bundle, an unexpired profile and a matching private key", () => {
  const select = (candidate, bundle = identifier, identities = ["CERTIFICATE"]) => selectNotificationSigning(candidate, bundle, identities, now);
  assert.deepEqual(select(profile), { identity: "CERTIFICATE", team: "TEAM" });
  assert.equal(select(profile, "com.example.app"), null);
  assert.equal(select(profile, identifier, []), null);
  assert.equal(select({ ...profile, expires: "2025-01-01" }), null);
  assert.equal(select({ ...profile, expires: "invalid" }), null);
  assert.equal(select({ ...profile, entitlements: { ...profile.entitlements, "com.apple.developer.usernotifications.communication": false } }), null);
});
