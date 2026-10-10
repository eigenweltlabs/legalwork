/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useReducer, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { captureAnalyticsEvent } from "@/app/lib/analytics";
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
import { cn } from "@/lib/utils";
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
  parseToolPermissions,
  QUICK_TOGGLE_TOOLS,
  quickToggleChecked,
  readPermissionRecord,
  serializeToolPermissionsPatch,
  withFirmPermissions,
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
import { SandboxStatus } from "./sandbox-status";
import { changeOrgPolicySetting, useOrgPolicy } from "../../connections/org-policy";
import { OrgPolicyNote } from "../../connections/org-policy-ui";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";

/** What the admin set among the tools here: of these, the firm may set editing files and computer commands. */
const FIRM_TOOLS_TEXT = {
  edit: "org_policy.set_tools_edit",
  bash: "org_policy.set_tools_bash",
  both: "org_policy.set_tools_edit_bash",
};

export type ToolPermissionsPanelProps = {
  legalworkServerClient: LegalworkServerClient | null;
  legalworkServerStatus: LegalworkServerStatus;
  legalworkServerCapabilities: LegalworkServerCapabilities | null;
  runtimeWorkspaceId: string | null;
  onConfigUpdated: () => void;
  /**
   * "full" (default) is the settings screen. "quick" is the onboarding step:
   * the three safety switches only, under the step's own heading — the
   * per-tool and pattern rules would push the step's action off-screen, and
   * they stay one click away in Settings.
   */
  variant?: "full" | "quick";
  /** Overrides the settings row padding (the onboarding cover is flush). */
  className?: string;
};

const QUICK_TOGGLES: QuickPermissionToggle[] = [
  "ask_before_edit",
  "ask_before_shell",
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
    <div className="flex flex-row items-center justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0 flex flex-col gap-0.5">
        <span className="text-base font-medium text-ink">{props.title}</span>
        <span className="text-sm text-subtext">{props.description}</span>
      </div>
      {props.children}
    </div>
  );
}

// Grouped-card wrapper for a set of rows (hairline dividers between them).
function PermissionGroup({ children }: { children: ReactNode }) {
  return (
    <div className="divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xs">
      {children}
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

  // The firm's rules show over the member's own while they apply; changing a
  // tool the firm manages takes them back first (asking after sign-out).
  const firm = useOrgPolicy("tools.permissions");
  // By tool name: the firm sets only some of the tools listed here.
  const firmRules: Partial<Record<string, unknown>> | undefined = firm?.value;
  const model = useMemo(
    () => (firm ? parseToolPermissions(withFirmPermissions(state.loadedPermission, firm)) : state.model),
    [firm, state.loadedPermission, state.model],
  );
  const firmManages = (tool: ManagedPermissionTool) => firmRules?.[tool] !== undefined;
  const lockedTool = (tool: ManagedPermissionTool) => firm?.locked === true && firmManages(tool);
  const firmTools = firmManages("edit") ? (firmManages("bash") ? "both" : "edit") : firmManages("bash") ? "bash" : null;

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

  const commit = useCallback((tools: ManagedPermissionTool[], nextModel: ToolPermissionsModel) => {
    if (tools.some((tool) => firmRules?.[tool] !== undefined)) {
      void changeOrgPolicySetting("tools.permissions", () => persistModel(nextModel));
      return;
    }
    // Only the member's own tools change: the firm's keep the member's values underneath.
    const own = parseToolPermissions(state.loadedPermission);
    const next = { ...nextModel };
    for (const tool of MANAGED_PERMISSION_TOOLS) if (firmRules?.[tool] !== undefined) next[tool] = own[tool];
    void persistModel(next);
  }, [firmRules, persistModel, state.loadedPermission]);

  const setToolAction = useCallback((tool: ManagedPermissionTool, action: PermissionAction) => {
    captureAnalyticsEvent("tool_permission_changed", { tool, action });
    const nextModel = { ...model, [tool]: { ...model[tool], action } };
    commit([tool], nextModel);
  }, [commit, model]);

  const setBashRuleAction = useCallback((pattern: string, action: PermissionAction) => {
    const nextModel = {
      ...model,
      bash: {
        ...model.bash,
        rules: model.bash.rules.map((rule) =>
          rule.pattern === pattern ? { ...rule, action } : rule,
        ),
      },
    };
    commit(["bash"], nextModel);
  }, [commit, model]);

  const removeBashRule = useCallback((pattern: string) => {
    const nextModel = {
      ...model,
      bash: {
        ...model.bash,
        rules: model.bash.rules.filter((rule) => rule.pattern !== pattern),
      },
    };
    commit(["bash"], nextModel);
  }, [commit, model]);

  const addBashRule = useCallback(() => {
    const pattern = rulePatternDraft.trim();
    if (!pattern) return;
    if (pattern === "*") {
      dispatch({ type: "notice", status: t("tool_permissions.rule_wildcard_reserved") });
      return;
    }
    if (model.bash.rules.some((rule) => rule.pattern === pattern)) {
      dispatch({ type: "notice", status: t("tool_permissions.rule_exists") });
      return;
    }
    const nextModel = {
      ...model,
      bash: {
        // Rules need an explicit "*" fallback; default to the current
        // effective behavior (allow) when no command default is set yet.
        action: model.bash.action ?? "allow",
        rules: [...model.bash.rules, { pattern, action: ruleActionDraft }],
      },
    };
    setRulePatternDraft("");
    commit(["bash"], nextModel);
  }, [commit, model, ruleActionDraft, rulePatternDraft]);

  const busy = state.loading || state.saving;
  const quick = props.variant === "quick";

  return (
    <LayoutSectionItem className={cn("gap-6", props.className)}>
      {!quick && props.legalworkServerClient && legalworkServerReady ? <SandboxStatus client={props.legalworkServerClient} canWrite={canWriteConfig} /> : null}
      {quick ? null : (
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>
            {t("tool_permissions.title")}
          </LayoutSectionItemTitle>
          <LayoutSectionItemDescription>
            {t("tool_permissions.desc")}
          </LayoutSectionItemDescription>
          {firmTools ? <OrgPolicyNote policyKey="tools.permissions" locked={FIRM_TOOLS_TEXT[firmTools]} /> : null}
        </LayoutSectionItemHeader>
      )}

      {!canReadConfig ? (
        <SettingsNotice>
          {accessHint ?? t("tool_permissions.no_access")}
        </SettingsNotice>
      ) : (
        <>
          {/* Quick safety toggles */}
          <PermissionGroup>
            {QUICK_TOGGLES.map((toggle) => (
              <PermissionRow
                key={toggle}
                title={quickToggleLabels(toggle).title}
                description={quickToggleLabels(toggle).description}
              >
                <Switch
                  aria-label={quickToggleLabels(toggle).title}
                  checked={quickToggleChecked(model, toggle)}
                  disabled={busy || !canWriteConfig || lockedTool(QUICK_TOGGLE_TOOLS[toggle])}
                  onCheckedChange={(checked) => {
                    captureAnalyticsEvent("quick_permission_toggled", { toggle, enabled: checked });
                    commit([QUICK_TOGGLE_TOOLS[toggle]], applyQuickToggle(model, toggle, checked));
                  }}
                />
              </PermissionRow>
            ))}
          </PermissionGroup>

          {quick ? null : (
            <>
            {/* Per-tool actions */}
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-0.5 px-1">
                <span className="text-base font-medium text-ink">
                  {t("tool_permissions.advanced_title")}
                </span>
                <span className="text-sm text-subtext">
                  {t("tool_permissions.advanced_desc")}
                </span>
              </div>
              <PermissionGroup>
                {MANAGED_PERMISSION_TOOLS.map((tool) => (
                  <PermissionRow
                    key={tool}
                    title={toolLabels(tool).title}
                    description={toolLabels(tool).description}
                  >
                    <ActionSelect
                      value={model[tool].action}
                      ariaLabel={toolLabels(tool).title}
                      disabled={busy || !canWriteConfig || lockedTool(tool)}
                      onChange={(action) => setToolAction(tool, action)}
                    />
                  </PermissionRow>
                ))}
              </PermissionGroup>
            </div>

            {/* Computer command pattern rules */}
            <div className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-0.5 px-1">
                <span className="text-base font-medium text-ink">
                  {t("tool_permissions.bash_rules_title")}
                </span>
                <span className="text-sm text-subtext">
                  {t("tool_permissions.bash_rules_desc")}
                </span>
              </div>
              {model.bash.rules.length > 0 ? (
                <PermissionGroup>
                  {model.bash.rules.map((rule) => (
                    <div
                      key={rule.pattern}
                      className="flex flex-row items-center justify-between gap-3 px-4 py-3.5"
                    >
                      <span className="min-w-0 truncate font-mono text-sm text-ink">
                        {rule.pattern}
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <ActionSelect
                          value={rule.action}
                          ariaLabel={t("tool_permissions.rule_action_label", undefined, { pattern: rule.pattern })}
                          disabled={busy || !canWriteConfig || lockedTool("bash")}
                          onChange={(action) => setBashRuleAction(rule.pattern, action)}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeBashRule(rule.pattern)}
                          disabled={busy || !canWriteConfig || lockedTool("bash")}
                          aria-label={t("tool_permissions.remove_rule", undefined, { pattern: rule.pattern })}
                        >
                          <X size={14} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </PermissionGroup>
              ) : null}
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
                  disabled={busy || !canWriteConfig || lockedTool("bash")}
                  className="font-mono"
                />
                <ActionSelect
                  value={ruleActionDraft}
                  ariaLabel={t("tool_permissions.add_rule")}
                  disabled={busy || !canWriteConfig || lockedTool("bash")}
                  onChange={setRuleActionDraft}
                />
                <Button
                  onClick={addBashRule}
                  disabled={busy || !canWriteConfig || lockedTool("bash") || !rulePatternDraft.trim()}
                >
                  <Plus className="size-4" />
                  {t("tool_permissions.add_rule")}
                </Button>
              </div>
            </div>
            </>
          )}

          {/* Status / error. The status line ("Saving…", "Permissions
              updated.") is settings-only: on the onboarding step the switch
              itself already shows the new state. Errors always surface. */}
          {!quick && state.status ? (
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
