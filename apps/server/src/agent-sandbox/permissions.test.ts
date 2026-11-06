import { expect, test } from "bun:test";
import { permissionAction, permissionPatternMatches, type NativePermissionRule } from "./permissions.js";

test("specific shell rules override their earlier wildcard fallback", () => {
  const permissions: NativePermissionRule[] = [{ action: "*", resource: "*", effect: "allow" }, { action: "shell", resource: "*", effect: "ask" }, { action: "shell", resource: "git *", effect: "allow" }, { action: "shell", resource: "rm *", effect: "deny" }];
  expect(permissionAction(permissions, "bash", "git status")).toBe("allow");
  expect(permissionAction(permissions, "bash", "rm secrets")).toBe("deny");
  expect(permissionAction(permissions, "bash", "python script.py")).toBe("ask");
  expect(permissionAction(permissions, "edit", "/workspace/result.docx")).toBe("allow");
});

test("a blanket internet block wins over earlier tool wildcards", () => {
  expect(permissionAction([{ action: "*", resource: "*", effect: "allow" }, { action: "webfetch", resource: "*", effect: "deny" }], "webfetch", "https://example.com/")).toBe("deny");
  expect(permissionAction([{ action: "webfetch", resource: "*", effect: "deny" }, { action: "webfetch", resource: "https://example.com/*", effect: "ask" }], "webfetch", "https://example.com/report")).toBe("ask");
});

test("malformed policy fails closed", () => {
  for (const invalid of [null, ["allow"], 3, "alow", [{ action: "shell", resource: "*", effect: "alow" }]]) {
    expect(Reflect.apply(permissionAction, undefined, [invalid, "bash", "python script.py"])).toBe("deny");
  }
});

test("matching follows the pinned engine's Windows and shell-prefix behavior", () => {
  expect(permissionPatternMatches("C:\\Matters\\File.txt", "c:/matters/*", true)).toBe(true);
  expect(permissionPatternMatches("git", "git *")).toBe(true);
  expect(permissionPatternMatches("git status\nrm file", "git status")).toBe(false);
});
