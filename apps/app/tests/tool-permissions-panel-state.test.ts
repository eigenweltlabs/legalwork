import { describe, expect, test } from "bun:test";

import {
  applyPermissionPatch,
  parseToolPermissions,
} from "../src/react-app/domains/settings/panels/tool-permissions-config";
import {
  initialToolPermissionsState,
  toolPermissionsReducer,
  type ToolPermissionsState,
} from "../src/react-app/domains/settings/panels/tool-permissions-panel-state";

const loadedPermission = {
  edit: "ask",
  bash: { "git *": "allow", "*": "ask" },
  external_directory: { "/tmp/shared": "allow" },
};

function loadedState(): ToolPermissionsState {
  let state = toolPermissionsReducer(initialToolPermissionsState, { type: "loadStart" });
  state = toolPermissionsReducer(state, { type: "loadSuccess", permission: loadedPermission });
  return toolPermissionsReducer(state, { type: "loadDone" });
}

describe("toolPermissionsReducer", () => {
  test("load lifecycle populates the model from config", () => {
    let state = toolPermissionsReducer(initialToolPermissionsState, { type: "loadStart" });
    expect(state.loading).toBe(true);

    state = toolPermissionsReducer(state, { type: "loadSuccess", permission: loadedPermission });
    expect(state.model.edit.action).toBe("ask");
    expect(state.model.bash.action).toBe("ask");
    expect(state.model.bash.rules).toEqual([{ pattern: "git *", action: "allow" }]);
    expect(state.loadedPermission).toEqual(loadedPermission);

    state = toolPermissionsReducer(state, { type: "loadDone" });
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  test("loadError clears the model and surfaces the message", () => {
    let state = loadedState();
    state = toolPermissionsReducer(state, { type: "loadError", message: "boom" });
    expect(state.error).toBe("boom");
    expect(state.loadedPermission).toEqual({});
    expect(state.model.edit.action).toBeNull();
  });

  test("edit swaps the model and clears stale notices", () => {
    let state = loadedState();
    state = toolPermissionsReducer(state, { type: "notice", status: "heads up" });
    expect(state.status).toBe("heads up");

    const nextModel = { ...state.model, edit: { action: null, rules: [] } };
    state = toolPermissionsReducer(state, { type: "edit", model: nextModel });
    expect(state.model.edit.action).toBeNull();
    expect(state.status).toBeNull();
  });

  test("saveSuccess commits the applied patch as the new loaded state", () => {
    let state = loadedState();
    const nextModel = { ...state.model, webfetch: { action: "deny" as const, rules: [] } };
    state = toolPermissionsReducer(state, { type: "edit", model: nextModel });
    state = toolPermissionsReducer(state, { type: "saveStart", status: "saving" });
    expect(state.saving).toBe(true);
    expect(state.status).toBe("saving");

    const applied = applyPermissionPatch(state.loadedPermission, { webfetch: "deny" });
    state = toolPermissionsReducer(state, { type: "saveSuccess", permission: applied, status: "saved" });
    expect(state.saving).toBe(false);
    expect(state.status).toBe("saved");
    expect(state.loadedPermission).toEqual({ ...loadedPermission, webfetch: "deny" });
    expect(state.model).toEqual(parseToolPermissions(applied));
  });

  test("saveError reverts the optimistic edit to the loaded permission", () => {
    let state = loadedState();
    const nextModel = { ...state.model, edit: { action: "deny" as const, rules: [] } };
    state = toolPermissionsReducer(state, { type: "edit", model: nextModel });
    state = toolPermissionsReducer(state, { type: "saveStart", status: "saving" });
    state = toolPermissionsReducer(state, { type: "saveError", message: "offline" });

    expect(state.saving).toBe(false);
    expect(state.error).toBe("offline");
    expect(state.status).toBeNull();
    expect(state.model.edit.action).toBe("ask");
  });

  test("reset returns to the initial state", () => {
    const state = toolPermissionsReducer(loadedState(), { type: "reset" });
    expect(state).toEqual(initialToolPermissionsState);
  });
});
