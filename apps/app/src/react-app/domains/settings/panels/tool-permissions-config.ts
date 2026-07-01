/**
 * Pure config <-> UI-model logic for the Tool permissions panel.
 *
 * opencode's `permission` config maps tool names to either a plain action
 * ("allow" | "ask" | "deny") or an object of glob-pattern -> action rules
 * (with "*" acting as the fallback). This module parses both forms into a
 * UI model and serializes the model back into a minimal permission patch.
 *
 * The panel only manages the tools listed in MANAGED_PERMISSION_TOOLS.
 * `permission.external_directory` is owned by the Authorized Folders feature
 * and any unknown permission keys are never included in the patch, so the
 * server-side merge leaves them untouched.
 */

export type PermissionAction = "allow" | "ask" | "deny";

export const MANAGED_PERMISSION_TOOLS = ["edit", "bash", "webfetch", "doom_loop"] as const;
export type ManagedPermissionTool = (typeof MANAGED_PERMISSION_TOOLS)[number];

export type PermissionRule = {
  pattern: string;
  action: PermissionAction;
};

export type ToolPermissionSetting = {
  /** Explicit default action for the tool, or null when not configured. */
  action: PermissionAction | null;
  /** Glob-pattern rules from the object form. Only bash rules are editable in the UI. */
  rules: PermissionRule[];
};

export type ToolPermissionsModel = Record<ManagedPermissionTool, ToolPermissionSetting>;

export type QuickPermissionToggle = "ask_before_edit" | "ask_before_shell" | "block_internet";

export function isPermissionAction(value: unknown): value is PermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function emptyToolPermissionsModel(): ToolPermissionsModel {
  return {
    edit: { action: null, rules: [] },
    bash: { action: null, rules: [] },
    webfetch: { action: null, rules: [] },
    doom_loop: { action: null, rules: [] },
  };
}

/** Extract the raw `permission` record from an opencode config object. */
export function readPermissionRecord(opencode: Record<string, unknown>): Record<string, unknown> {
  return isRecord(opencode.permission) ? opencode.permission : {};
}

function parseToolSetting(value: unknown): ToolPermissionSetting {
  if (isPermissionAction(value)) return { action: value, rules: [] };
  if (isRecord(value)) {
    let action: PermissionAction | null = null;
    const rules: PermissionRule[] = [];
    for (const [pattern, ruleAction] of Object.entries(value)) {
      if (!isPermissionAction(ruleAction)) continue;
      if (pattern === "*") action = ruleAction;
      else rules.push({ pattern, action: ruleAction });
    }
    return { action, rules };
  }
  return { action: null, rules: [] };
}

/** Parse a raw permission record into the UI model, handling both string and object forms. */
export function parseToolPermissions(permission: Record<string, unknown>): ToolPermissionsModel {
  const model = emptyToolPermissionsModel();
  for (const tool of MANAGED_PERMISSION_TOOLS) {
    model[tool] = parseToolSetting(permission[tool]);
  }
  return model;
}

function serializeToolSetting(setting: ToolPermissionSetting): PermissionAction | Record<string, PermissionAction> | null {
  const entries: Record<string, PermissionAction> = {};
  for (const rule of setting.rules) {
    if (rule.pattern && rule.pattern !== "*") entries[rule.pattern] = rule.action;
  }
  if (Object.keys(entries).length) {
    if (setting.action) entries["*"] = setting.action;
    return entries;
  }
  return setting.action;
}

/**
 * Build the `permission` patch for the managed tools only. A tool serializes
 * to the minimal form: plain action string when it has no pattern rules, the
 * object form (with a "*" fallback for its default action) when it does, and
 * `null` (= remove) when it is unset but was present in the loaded config.
 * `external_directory` and unknown keys are never included.
 */
export function serializeToolPermissionsPatch(
  model: ToolPermissionsModel,
  loadedPermission: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const tool of MANAGED_PERMISSION_TOOLS) {
    const serialized = serializeToolSetting(model[tool]);
    if (serialized !== null) patch[tool] = serialized;
    else if (Object.prototype.hasOwnProperty.call(loadedPermission, tool)) patch[tool] = null;
  }
  return patch;
}

/**
 * Mirror of the server-side patch merge: keys in the patch override the
 * loaded permission record and `null` removes a key, everything else
 * (external_directory, unknown keys) is preserved verbatim.
 */
export function applyPermissionPatch(
  loadedPermission: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...loadedPermission, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
  }
  return next;
}

/** Whether a quick safety toggle should render as switched on for the model. */
export function quickToggleChecked(model: ToolPermissionsModel, toggle: QuickPermissionToggle): boolean {
  switch (toggle) {
    case "ask_before_edit":
      return model.edit.action === "ask" || model.edit.action === "deny";
    case "ask_before_shell":
      return model.bash.action === "ask" || model.bash.action === "deny";
    case "block_internet":
      return model.webfetch.action === "deny";
  }
}

/** Apply a quick safety toggle, returning the updated model. */
export function applyQuickToggle(
  model: ToolPermissionsModel,
  toggle: QuickPermissionToggle,
  checked: boolean,
): ToolPermissionsModel {
  switch (toggle) {
    case "ask_before_edit":
      return { ...model, edit: { ...model.edit, action: checked ? "ask" : "allow" } };
    case "ask_before_shell":
      return { ...model, bash: { ...model.bash, action: checked ? "ask" : "allow" } };
    case "block_internet":
      return { ...model, webfetch: { ...model.webfetch, action: checked ? "deny" : "allow" } };
  }
}
