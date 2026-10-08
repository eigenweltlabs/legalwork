import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const capability = "com.apple.developer.usernotifications.communication";

function output(command, args, input) {
  const result = spawnSync(command, args, { input, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function selectNotificationSigning(profile, identifier, identities, now = Date.now()) {
  const entitlements = profile.entitlements;
  const team = entitlements["com.apple.developer.team-identifier"];
  const expires = Date.parse(profile.expires);
  if (!Number.isFinite(expires) || expires <= now || !team
    || entitlements[capability] !== true
    || entitlements["com.apple.application-identifier"] !== `${team}.${identifier}`) return null;
  const identity = profile.certificates.find(certificate => identities.includes(certificate));
  return identity ? { identity, team } : null;
}

/** Use an already provisioned dev identity; never add restricted entitlements to ad-hoc code. */
export function findNotificationSigning(identifier) {
  const explicit = process.env.LEGALWORK_MAC_PROVISIONING_PROFILE?.trim();
  const directories = [
    join(homedir(), "Library/Developer/Xcode/UserData/Provisioning Profiles"),
    join(homedir(), "Library/MobileDevice/Provisioning Profiles"),
  ];
  const paths = explicit ? [explicit] : directories.flatMap(directory => existsSync(directory)
    ? readdirSync(directory).filter(name => name.endsWith(".provisionprofile")).map(name => join(directory, name)) : []);
  if (!paths.length) return null;
  const identities = Array.from(output("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"])
    .matchAll(/\b[A-F0-9]{40}\b/g), match => match[0]);
  for (const path of paths) {
    try {
      const xml = output("/usr/bin/security", ["cms", "-D", "-i", path]);
      const extract = (key, format) => output("/usr/bin/plutil", ["-extract", key, format, "-o", "-", "-"], xml);
      const profile = {
        entitlements: JSON.parse(extract("Entitlements", "json")),
        expires: extract("ExpirationDate", "raw").trim(),
        certificates: Array.from(extract("DeveloperCertificates", "xml1").matchAll(/<data>([\s\S]*?)<\/data>/g),
          match => createHash("sha1").update(Buffer.from(match[1], "base64")).digest("hex").toUpperCase()),
      };
      const signing = selectNotificationSigning(profile, identifier, identities);
      if (signing) return { ...signing, path, fingerprint: createHash("sha256").update(xml).digest("hex") };
    } catch (error) {
      if (explicit) throw error;
    }
  }
  if (explicit) throw new Error(`The selected provisioning profile must grant Communication Notifications for ${identifier}, be unexpired, and match an installed signing identity.`);
  return null;
}
