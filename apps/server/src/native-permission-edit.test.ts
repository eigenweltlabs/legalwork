import { expect, test } from "bun:test";
import { mergeNativeToolPermissionRules, nativeToolPermissionUpdatesSchema } from "./native-permission-edit.js";

test("native per-action edits retain wildcard precedence and unrelated rules, and can explicitly remove an action", () => {
  const current = nativeToolPermissionUpdatesSchema.parse({ "*": [{ action: "*", resource: "*", effect: "ask" }], shell: [{ action: "shell", resource: "rm *", effect: "deny" }], custom: [{ action: "custom", resource: "case", effect: "deny" }] });
  const rules = Object.values(current).flatMap(value => value ?? []);
  const updated = mergeNativeToolPermissionRules(rules, nativeToolPermissionUpdatesSchema.parse({ shell: [{ action: "shell", resource: "git status", effect: "allow" }] }));
  expect(updated).toEqual([{ action: "*", resource: "*", effect: "ask" }, { action: "shell", resource: "git status", effect: "allow" }, { action: "custom", resource: "case", effect: "deny" }]);
  expect(mergeNativeToolPermissionRules(updated, { shell: null })).toEqual([{ action: "*", resource: "*", effect: "ask" }, { action: "custom", resource: "case", effect: "deny" }]);
  expect(rules[1]).toEqual({ action: "shell", resource: "rm *", effect: "deny" });
});

test("native tool edits reject folder globalization, mismatched actions and legacy string effects", () => {
  for (const updates of [{ external_directory: [{ action: "external_directory", resource: "/case/*", effect: "allow" }] }, { read: [{ action: "edit", resource: "*", effect: "allow" }] }, { shell: "allow" }]) {
    expect(nativeToolPermissionUpdatesSchema.safeParse(updates).success).toBe(false);
  }
});
