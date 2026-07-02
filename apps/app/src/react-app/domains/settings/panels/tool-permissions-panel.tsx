/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type {
  LegalworkServerCapabilities,
  LegalworkServerClient,
  LegalworkServerStatus,
} from "../../../../app/lib/legalwork-server";
import { safeStringify } from "../../../../app/utils";
import {
  applyPermissionPatch,
  applyQuickToggle,
  MANAGED_PERMISSION_TOOLS,
  quickToggleChecked,
  readPermissionRecord,
  serializeToolPermissionsPatch,
  type ManagedPermissionTool,
  type PermissionAction,
  type QuickPermissionToggle,
  type ToolPermissionsModel,
} from "./tool-permissions-config";
import {
  initialToolPermissionsState,
  toolPermissionsReducer,
} from "./tool-permissions-panel-state";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";

export type ToolPermissionsPanelProps = {
  legalworkServerClient: LegalworkServerClient | null;
  legalworkServerStatus: LegalworkServerStatus;
  legalworkServerCapabilities: LegalworkServerCapabilities | null;
  runtimeWorkspaceId: string | null;
  onConfigUpdated: () => void;
};

const QUICK_TOGGLES: QuickPermissionToggle[] = [
  "ask_before_edit",
  "ask_before_shell",
  "block_internet",
];

type PermissionLabels = { title: string; description: string };

// Static t() keys per entry — the i18n audit forbids dynamically built keys.
function quickToggleLabels(toggle: QuickPermissionToggle): PermissionLabels {
  switch (toggle) {
    case "ask_before_edit":
      return {
        title: t("tool_permissions.ask_before_edit"),
        description: t("tool_permissions.ask_before_edit_desc"),
      };
    case "ask_before_shell":
      return {
        title: t("tool_permissions.ask_before_shell"),
        description: t("tool_permissions.ask_before_shell_desc"),
      };
    case "block_internet":
      return {
        title: t("tool_permissions.block_internet"),
        description: t("tool_permissions.block_internet_desc"),
      };
  }
}

function toolLabels(tool: ManagedPermissionTool): PermissionLabels {
  switch (tool) {
    case "edit":
      return {
        title: t("tool_permissions.tool_edit"),
        description: t("tool_permissions.tool_edit_desc"),
      };
    case "bash":
      return {
        title: t("tool_permissions.tool_bash"),
        description: t("tool_permissions.tool_bash_desc"),
      };
    case "webfetch":
      return {
        title: t("tool_permissions.tool_webfetch"),
        description: t("tool_permissions.tool_webfetch_desc"),
      };
    case "doom_loop":
      return {
        title: t("tool_permissions.tool_doom_loop"),
        description: t("tool_permissions.tool_doom_loop_desc"),
      };
  }
}

type PermissionActionItem = { value: PermissionAction; label: string };

function actionItems(): PermissionActionItem[] {
  return [
    { value: "allow", label: t("tool_permissions.action_allow") },
    { value: "ask", label: t("tool_permissions.action_ask") },
    { value: "deny", label: t("tool_permissions.action_deny") },
  ];
}

type ActionSelectProps = {
  value: PermissionAction | null;
  ariaLabel: string;
  disabled: boolean;
  onChange: (action: PermissionAction) => void;
};

function ActionSelect(props: ActionSelectProps) {
  const items = actionItems();
  return (
    <div className="w-36 max-w-full shrink-0">
      <Select
        value={props.value}
        items={items}
        onValueChange={(value) => {
          if (value && value !== props.value) props.onChange(value);
        }}
        disabled={props.disabled}
      >
        <SelectTrigger className="w-full" aria-label={props.ariaLabel}>
          <SelectValue placeholder={t("tool_permissions.action_not_set")} />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

type PermissionRowProps = {
  title: string;
  description: string;
  children: ReactNode;
};

function PermissionRow(props: PermissionRowProps) {
  return (
    <div className="flex flex-row items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3">
      <div className="min-w-0 flex flex-col gap-1">
        <span className="text-sm font-medium text-dls-text">{props.title}</span>
        <span className="text-xs text-muted-foreground">{props.description}</span>
      </div>
      {props.children}
    </div>
  );
}

export function ToolPermissionsPanel(props: ToolPermissionsPanelProps) {
  const [state, dispatch] = useReducer(toolPermissionsReducer, initialToolPermissionsState);
  const [rulePatternDraft, setRulePatternDraft] = useState("");
  const [ruleActionDraft, setRuleActionDraft] = useState<PermissionAction>("ask");

  const legalworkServerReady = props.legalworkServerStatus === "connected";
  const legalworkServerWorkspaceReady = Boolean(props.runtimeWorkspaceId);
  const canReadConfig =
    legalworkServerReady &&
    legalworkServerWorkspaceReady &&
    (props.legalworkServerCapabilities?.config?.read ?? false);
  const canWriteConfig =
    legalworkServerReady &&
    legalworkServerWorkspaceReady &&
    (props.legalworkServerCapabilities?.config?.write ?? false);

  const accessHint = useMemo(() => {
    if (!legalworkServerReady) return t("context_panel.server_disconnected");
    if (!legalworkServerWorkspaceReady) return t("context_panel.no_server_workspace");
    if (!canReadConfig) return t("context_panel.config_access_unavailable");
    if (!canWriteConfig) return t("context_panel.config_read_only");
    return null;
  }, [canReadConfig, canWriteConfig, legalworkServerReady, legalworkServerWorkspaceReady]);

  useEffect(() => {
    const legalworkClient = props.legalworkServerClient;
    const legalworkWorkspaceId = props.runtimeWorkspaceId;

    if (!legalworkClient || !legalworkWorkspaceId || !canReadConfig) {
      dispatch({ type: "reset" });
      return;
    }

    let cancelled = false;
    dispatch({ type: "loadStart" });

    void (async () => {
      try {
        const response = await legalworkClient.getConfig(legalworkWorkspaceId);
        if (cancelled) return;
        dispatch({ type: "loadSuccess", permission: readPermissionRecord(response.opencode) });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        dispatch({ type: "loadError", message });
      } finally {
        if (!cancelled) dispatch({ type: "loadDone" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canReadConfig, props.legalworkServerClient, props.runtimeWorkspaceId]);

  const persistModel = useCallback(async (nextModel: ToolPermissionsModel) => {
    const legalworkClient = props.legalworkServerClient;
    const legalworkWorkspaceId = props.runtimeWorkspaceId;
    dispatch({ type: "edit", model: nextModel });
    if (!legalworkClient || !legalworkWorkspaceId || !canWriteConfig) {
      dispatch({ type: "saveError", message: t("tool_permissions.write_required") });
      return;
    }

    const patch = serializeToolPermissionsPatch(nextModel, state.loadedPermission);
    dispatch({ type: "saveStart", status: t("tool_permissions.saving") });
    try {
      await legalworkClient.patchConfig(legalworkWorkspaceId, {
        opencode: { permission: patch },
      });
      dispatch({
        type: "saveSuccess",
        permission: applyPermissionPatch(state.loadedPermission, patch),
        status: t("tool_permissions.updated"),
      });
      props.onConfigUpdated();
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      dispatch({ type: "saveError", message });
    }
  }, [canWriteConfig, props.legalworkServerClient, props.onConfigUpdated, props.runtimeWorkspaceId, state.loadedPermission]);

  const setToolAction = useCallback((tool: ManagedPermissionTool, action: PermissionAction) => {
    const nextModel = { ...state.model, [tool]: { ...state.model[tool], action } };
    void persistModel(nextModel);
  }, [persistModel, state.model]);

  const setBashRuleAction = useCallback((pattern: string, action: PermissionAction) => {
    const nextModel = {
      ...state.model,
      bash: {
        ...state.model.bash,
        rules: state.model.bash.rules.map((rule) =>
          rule.pattern === pattern ? { ...rule, action } : rule,
        ),
      },
    };
    void persistModel(nextModel);
  }, [persistModel, state.model]);

  const removeBashRule = useCallback((pattern: string) => {
    const nextModel = {
      ...state.model,
      bash: {
        ...state.model.bash,
        rules: state.model.bash.rules.filter((rule) => rule.pattern !== pattern),
      },
    };
    void persistModel(nextModel);
  }, [persistModel, state.model]);

  const addBashRule = useCallback(() => {
    const pattern = rulePatternDraft.trim();
    if (!pattern) return;
    if (pattern === "*") {
      dispatch({ type: "notice", status: t("tool_permissions.rule_wildcard_reserved") });
      return;
    }
    if (state.model.bash.rules.some((rule) => rule.pattern === pattern)) {
      dispatch({ type: "notice", status: t("tool_permissions.rule_exists") });
      return;
    }
    const nextModel = {
      ...state.model,
      bash: {
        // Rules need an explicit "*" fallback; default to the current
        // effective behavior (allow) when no shell default is set yet.
        action: state.model.bash.action ?? "allow",
        rules: [...state.model.bash.rules, { pattern, action: ruleActionDraft }],
      },
    };
    setRulePatternDraft("");
    void persistModel(nextModel);
  }, [persistModel, ruleActionDraft, rulePatternDraft, state.model]);

  const busy = state.loading || state.saving;

  return (
    <LayoutSectionItem className="gap-6">
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>
          {t("tool_permissions.title")}
        </LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {t("tool_permissions.desc")}
        </LayoutSectionItemDescription>
      </LayoutSectionItemHeader>

      {!canReadConfig ? (
        <SettingsNotice>
          {accessHint ?? t("tool_permissions.no_access")}
        </SettingsNotice>
      ) : (
        <>
          {/* Quick safety toggles */}
          <div className="flex flex-col gap-2">
            {QUICK_TOGGLES.map((toggle) => (
              <PermissionRow
                key={toggle}
                title={quickToggleLabels(toggle).title}
                description={quickToggleLabels(toggle).description}
              >
                <Switch
                  aria-label={quickToggleLabels(toggle).title}
                  checked={quickToggleChecked(state.model, toggle)}
                  disabled={busy || !canWriteConfig}
                  onCheckedChange={(checked) => {
                    void persistModel(applyQuickToggle(state.model, toggle, checked));
                  }}
                />
              </PermissionRow>
            ))}
          </div>

          {/* Per-tool actions */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-dls-text">
                {t("tool_permissions.advanced_title")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("tool_permissions.advanced_desc")}
              </span>
            </div>
            {MANAGED_PERMISSION_TOOLS.map((tool) => (
              <PermissionRow
                key={tool}
                title={toolLabels(tool).title}
                description={toolLabels(tool).description}
              >
                <ActionSelect
                  value={state.model[tool].action}
                  ariaLabel={toolLabels(tool).title}
                  disabled={busy || !canWriteConfig}
                  onChange={(action) => setToolAction(tool, action)}
                />
              </PermissionRow>
            ))}
          </div>

          {/* Shell command pattern rules */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-dls-text">
                {t("tool_permissions.bash_rules_title")}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("tool_permissions.bash_rules_desc")}
              </span>
            </div>
            {state.model.bash.rules.map((rule) => (
              <div
                key={rule.pattern}
                className="flex flex-row items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
              >
                <span className="min-w-0 truncate font-mono text-xs text-dls-text">
                  {rule.pattern}
                </span>
                <div className="flex shrink-0 items-center gap-2">
                  <ActionSelect
                    value={rule.action}
                    ariaLabel={t("tool_permissions.rule_action_label", undefined, { pattern: rule.pattern })}
                    disabled={busy || !canWriteConfig}
                    onChange={(action) => setBashRuleAction(rule.pattern, action)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeBashRule(rule.pattern)}
                    disabled={busy || !canWriteConfig}
                    aria-label={t("tool_permissions.remove_rule", undefined, { pattern: rule.pattern })}
                  >
                    <X size={14} />
                  </Button>
                </div>
              </div>
            ))}
            <div className="flex flex-row items-center gap-2">
              <Input
                value={rulePatternDraft}
                onChange={(event) => setRulePatternDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addBashRule();
                  }
                }}
                placeholder={t("tool_permissions.pattern_placeholder")}
                aria-label={t("tool_permissions.pattern_placeholder")}
                disabled={busy || !canWriteConfig}
                className="font-mono"
              />
              <ActionSelect
                value={ruleActionDraft}
                ariaLabel={t("tool_permissions.add_rule")}
                disabled={busy || !canWriteConfig}
                onChange={setRuleActionDraft}
              />
              <Button
                onClick={addBashRule}
                disabled={busy || !canWriteConfig || !rulePatternDraft.trim()}
              >
                <Plus className="size-4" />
                {t("tool_permissions.add_rule")}
              </Button>
            </div>
          </div>

          {/* Status / error */}
          {state.status ? (
            <SettingsNotice>{state.status}</SettingsNotice>
          ) : null}
          {state.error ? (
            <SettingsNotice tone="error">{state.error}</SettingsNotice>
          ) : null}
        </>
      )}
    </LayoutSectionItem>
  );
}
