import {
  emptyToolPermissionsModel,
  parseToolPermissions,
  type ToolPermissionsModel,
} from "./tool-permissions-config";

export type ToolPermissionsState = {
  /** UI model currently shown (may be an optimistic edit while saving). */
  model: ToolPermissionsModel;
  /** Raw permission record as last loaded/saved; source of truth for reverts. */
  loadedPermission: Record<string, unknown>;
  loading: boolean;
  saving: boolean;
  status: string | null;
  error: string | null;
};

export type ToolPermissionsAction =
  | { type: "reset" }
  | { type: "loadStart" }
  | { type: "loadSuccess"; permission: Record<string, unknown> }
  | { type: "loadError"; message: string }
  | { type: "loadDone" }
  | { type: "edit"; model: ToolPermissionsModel }
  | { type: "notice"; status: string | null }
  | { type: "saveStart"; status: string | null }
  | { type: "saveSuccess"; permission: Record<string, unknown>; status: string | null }
  | { type: "saveError"; message: string };

export const initialToolPermissionsState: ToolPermissionsState = {
  model: emptyToolPermissionsModel(),
  loadedPermission: {},
  loading: false,
  saving: false,
  status: null,
  error: null,
};

export function toolPermissionsReducer(
  state: ToolPermissionsState,
  action: ToolPermissionsAction,
): ToolPermissionsState {
  switch (action.type) {
    case "reset":
      return initialToolPermissionsState;
    case "loadStart":
      return { ...state, loading: true, status: null, error: null };
    case "loadSuccess":
      return {
        ...state,
        loadedPermission: action.permission,
        model: parseToolPermissions(action.permission),
        error: null,
      };
    case "loadError":
      return {
        ...state,
        loadedPermission: {},
        model: emptyToolPermissionsModel(),
        error: action.message,
      };
    case "loadDone":
      return { ...state, loading: false };
    case "edit":
      return { ...state, model: action.model, status: null, error: null };
    case "notice":
      return { ...state, status: action.status, error: null };
    case "saveStart":
      return { ...state, saving: true, status: action.status, error: null };
    case "saveSuccess":
      return {
        ...state,
        saving: false,
        loadedPermission: action.permission,
        model: parseToolPermissions(action.permission),
        status: action.status,
      };
    case "saveError":
      // Revert the optimistic edit back to the last known persisted state.
      return {
        ...state,
        saving: false,
        model: parseToolPermissions(state.loadedPermission),
        status: null,
        error: action.message,
      };
  }
}
