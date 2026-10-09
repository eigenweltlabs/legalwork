#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function validateSignPathConfig(env) {
  const required = [
    "SIGNPATH_API_TOKEN",
    "SIGNPATH_ORGANIZATION_ID",
    "SIGNPATH_PROJECT_SLUG",
    "SIGNPATH_SIGNING_POLICY_SLUG",
    "SIGNPATH_ARTIFACT_CONFIGURATION_SLUG",
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing Windows SignPath configuration: ${missing.join(", ")}`);
  const expectedPolicy = env.SIGNPATH_TEST === "true" ? "test-signing" : "release-signing";
  if (env.SIGNPATH_SIGNING_POLICY_SLUG !== expectedPolicy) {
    throw new Error(`Expected SignPath policy ${expectedPolicy}; test certificates must never be published to the release or alpha feed.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    validateSignPathConfig(process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
