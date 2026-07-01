import { describe, expect, test } from "bun:test";

import {
  applyPermissionPatch,
  applyQuickToggle,
  emptyToolPermissionsModel,
  parseToolPermissions,
  quickToggleChecked,
  readPermissionRecord,
  serializeToolPermissionsPatch,
  type ToolPermissionsModel,
} from "../src/react-app/domains/settings/panels/tool-permissions-config";

describe("parseToolPermissions", () => {
  test("parses plain string actions", () => {
    const model = parseToolPermissions({
      edit: "ask",
      webfetch: "deny",
      doom_loop: "allow",
    });
    expect(model.edit).toEqual({ action: "ask", rules: [] });
    expect(model.webfetch).toEqual({ action: "deny", rules: [] });
    expect(model.doom_loop).toEqual({ action: "allow", rules: [] });
    expect(model.bash).toEqual({ action: null, rules: [] });
  });

  test("parses the object form with a wildcard fallback and pattern rules", () => {
    const model = parseToolPermissions({
      bash: { "git *": "allow", "rm *": "deny", "*": "ask" },
    });
    expect(model.bash.action).toBe("ask");
    expect(model.bash.rules).toEqual([
      { pattern: "git *", action: "allow" },
      { pattern: "rm *", action: "deny" },
    ]);
  });

  test("parses the object form without a wildcard entry", () => {
    const model = parseToolPermissions({ bash: { "git *": "allow" } });
    expect(model.bash.action).toBeNull();
    expect(model.bash.rules).toEqual([{ pattern: "git *", action: "allow" }]);
  });

  test("ignores invalid values", () => {
    const model = parseToolPermissions({
      edit: "sometimes",
      bash: { "git *": "yes", "npm *": "ask" },
      webfetch: 42,
      doom_loop: ["ask"],
    });
    expect(model.edit).toEqual({ action: null, rules: [] });
    expect(model.bash.rules).toEqual([{ pattern: "npm *", action: "ask" }]);
    expect(model.webfetch).toEqual({ action: null, rules: [] });
    expect(model.doom_loop).toEqual({ action: null, rules: [] });
  });

  test("readPermissionRecord tolerates missing or invalid permission keys", () => {
    expect(readPermissionRecord({})).toEqual({});
    expect(readPermissionRecord({ permission: "allow" })).toEqual({});
    expect(readPermissionRecord({ permission: { edit: "ask" } })).toEqual({ edit: "ask" });
  });
});

describe("serializeToolPermissionsPatch", () => {
  test("writes the minimal string form when a tool has no rules", () => {
    const model = emptyToolPermissionsModel();
    model.edit = { action: "ask", rules: [] };
    expect(serializeToolPermissionsPatch(model, {})).toEqual({ edit: "ask" });
  });

  test("writes the object form with a wildcard fallback when bash has rules", () => {
    const model = emptyToolPermissionsModel();
    model.bash = {
      action: "ask",
      rules: [{ pattern: "git *", action: "allow" }],
    };
    expect(serializeToolPermissionsPatch(model, {})).toEqual({
      bash: { "git *": "allow", "*": "ask" },
    });
  });

  test("omits the wildcard entry when no default action is set", () => {
    const model = emptyToolPermissionsModel();
    model.bash = { action: null, rules: [{ pattern: "git *", action: "allow" }] };
    expect(serializeToolPermissionsPatch(model, {})).toEqual({
      bash: { "git *": "allow" },
    });
  });

  test("never includes external_directory or unknown permission keys", () => {
    const loaded = {
      external_directory: { "/tmp/shared": "allow" },
      future_tool: "deny",
      edit: "ask",
    };
    const model = parseToolPermissions(loaded);
    const patch = serializeToolPermissionsPatch(model, loaded);
    expect(patch).toEqual({ edit: "ask" });
    expect(Object.prototype.hasOwnProperty.call(patch, "external_directory")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(patch, "future_tool")).toBe(false);
  });

  test("emits null to remove a managed key that was previously configured", () => {
    const loaded = { bash: { "git *": "allow" } };
    const model = parseToolPermissions(loaded);
    model.bash = { action: null, rules: [] };
    expect(serializeToolPermissionsPatch(model, loaded)).toEqual({ bash: null });
  });

  test("omits managed keys that are unset and were never configured", () => {
    const model = emptyToolPermissionsModel();
    expect(serializeToolPermissionsPatch(model, {})).toEqual({});
  });

  test("round-trips both permission forms through parse and serialize", () => {
    const loaded = {
      edit: "deny",
      bash: { "git status": "allow", "*": "ask" },
      webfetch: "allow",
    };
    const model = parseToolPermissions(loaded);
    const patch = serializeToolPermissionsPatch(model, loaded);
    expect(patch).toEqual({
      edit: "deny",
      bash: { "git status": "allow", "*": "ask" },
      webfetch: "allow",
    });
    expect(parseToolPermissions(applyPermissionPatch(loaded, patch))).toEqual(model);
  });
});

describe("applyPermissionPatch", () => {
  test("applies values, removes null keys, and preserves everything else", () => {
    const loaded = {
      edit: "allow",
      bash: { "git *": "allow" },
      external_directory: { "/tmp/shared": "allow" },
      future_tool: "deny",
    };
    const next = applyPermissionPatch(loaded, { edit: "ask", bash: null });
    expect(next).toEqual({
      edit: "ask",
      external_directory: { "/tmp/shared": "allow" },
      future_tool: "deny",
    });
    // The loaded record is not mutated.
    expect(loaded.bash).toEqual({ "git *": "allow" });
  });
});

describe("quick toggles", () => {
  const checkedModel = (edit: "ask" | "allow", bash: "ask" | "allow", webfetch: "deny" | "allow"): ToolPermissionsModel => {
    const model = emptyToolPermissionsModel();
    model.edit.action = edit;
    model.bash.action = bash;
    model.webfetch.action = webfetch;
    return model;
  };

  test("derives checked state from the model", () => {
    const strict = checkedModel("ask", "ask", "deny");
    expect(quickToggleChecked(strict, "ask_before_edit")).toBe(true);
    expect(quickToggleChecked(strict, "ask_before_shell")).toBe(true);
    expect(quickToggleChecked(strict, "block_internet")).toBe(true);

    const relaxed = checkedModel("allow", "allow", "allow");
    expect(quickToggleChecked(relaxed, "ask_before_edit")).toBe(false);
    expect(quickToggleChecked(relaxed, "ask_before_shell")).toBe(false);
    expect(quickToggleChecked(relaxed, "block_internet")).toBe(false);
  });

  test("deny also reads as checked for the ask toggles", () => {
    const model = emptyToolPermissionsModel();
    model.edit.action = "deny";
    expect(quickToggleChecked(model, "ask_before_edit")).toBe(true);
  });

  test("toggle mapping round-trips through the model and config", () => {
    let model = emptyToolPermissionsModel();
    for (const toggle of ["ask_before_edit", "ask_before_shell", "block_internet"] as const) {
      model = applyQuickToggle(model, toggle, true);
      expect(quickToggleChecked(model, toggle)).toBe(true);
      model = applyQuickToggle(model, toggle, false);
      expect(quickToggleChecked(model, toggle)).toBe(false);
    }
    expect(serializeToolPermissionsPatch(applyQuickToggle(model, "block_internet", true), {})).toEqual({
      edit: "allow",
      bash: "allow",
      webfetch: "deny",
    });
  });

  test("toggling shell keeps existing bash pattern rules", () => {
    const model = parseToolPermissions({ bash: { "git *": "allow", "*": "allow" } });
    const next = applyQuickToggle(model, "ask_before_shell", true);
    expect(next.bash.action).toBe("ask");
    expect(next.bash.rules).toEqual([{ pattern: "git *", action: "allow" }]);
    expect(serializeToolPermissionsPatch(next, { bash: { "git *": "allow", "*": "allow" } })).toEqual({
      bash: { "git *": "allow", "*": "ask" },
    });
  });
});
