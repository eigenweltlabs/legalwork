/** @jsxImportSource react */
// Application-wide agent builder, surfaced in the Workflows settings view
// (EIG-61). Authored agents are single markdown files in the global opencode
// config dir (`~/.config/opencode/agents/<name>.md`): the engine merges that
// dir into every local workspace's config, so an agent saved here is available
// everywhere — same model as global skills, plugins, and integrations.
//
// Files are read/written/deleted through the desktop bridge (opencodeAgent*
// IPC, the same pattern as the global opencode command files), and the engine
// is reloaded after save/delete so the composer's agent picker refreshes.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Edit2, Loader2, Trash2 } from "lucide-react";

import type { Client } from "@/app/types";
import { unwrap } from "@/app/lib/opencode";
import {
  opencodeAgentDelete,
  opencodeAgentList,
  opencodeAgentWrite,
} from "@/app/lib/desktop";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import {
  getConnectedProviderItems,
  useProviderListQuery,
} from "@/react-app/infra/provider-list-query";
import {
  AGENT_PERMISSION_KEYS,
  AGENT_TOOL_KEYS,
  agentBadgeKind,
  agentFilePath,
  agentFormFromDefinition,
  agentFormToDefinition,
  emptyAgentForm,
  isAgentToolEnabled,
  parseAgentMarkdown,
  serializeAgentMarkdown,
  setAgentPermission,
  toggleAgentTool,
  validateAgentForm,
  type AgentDefinition,
  type AgentFormState,
  type AgentMode,
  type AgentPermissionAction,
  type AgentPermissionKey,
  type AgentToolKey,
} from "../agent-markdown";

const ledgerRowClass =
  "group relative flex items-start gap-4 py-4 pl-5 pr-3 transition-colors hover:bg-dls-hover/60";
const typeTagClass = "shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-dls-secondary/70";
const rowIconBtnClass =
  "inline-flex size-8 items-center justify-center rounded-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-40";
const inputClass =
  "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-sm text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.25)]";

const TOOL_LABELS: Record<AgentToolKey, () => string> = {
  read: () => t("agents.tool_read"),
  write: () => t("agents.tool_write"),
  edit: () => t("agents.tool_edit"),
  patch: () => t("agents.tool_patch"),
  bash: () => t("agents.tool_bash"),
  webfetch: () => t("agents.tool_webfetch"),
};

const PERMISSION_LABELS: Record<AgentPermissionKey, () => string> = {
  edit: () => t("agents.permission_edit"),
  bash: () => t("agents.permission_bash"),
  webfetch: () => t("agents.permission_webfetch"),
};

const MODE_LABELS: Record<AgentMode, () => string> = {
  primary: () => t("agents.mode_primary"),
  subagent: () => t("agents.mode_subagent"),
  all: () => t("agents.mode_all"),
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type AgentEntry = {
  name: string;
  definition: AgentDefinition;
};

type EditorState = {
  isNew: boolean;
  form: AgentFormState;
  saving: boolean;
  error: string | null;
};

/** Everything the section needs from the settings route. */
export type WorkflowAgentsHost = {
  opencodeClient: Client | null;
  opencodeBaseUrl: string;
  workspaceRoot: string;
  /** Reloads the workspace engine so saved agent files reach the agent picker. */
  onReloadEngine: () => Promise<boolean>;
};

export type WorkflowAgentsSectionProps = {
  busy: boolean;
  host: WorkflowAgentsHost;
  /** The workflows view's search box also filters this section. */
  searchQuery: string;
  /** Bumped by the workflows view's refresh button. */
  refreshToken: number;
  /** Set by the add flow ("Agent"/"Subagent" choice); opens the builder preset to it. */
  createMode: AgentMode | null;
  onCreateModeHandled: () => void;
};

export function WorkflowAgentsSection(props: WorkflowAgentsSectionProps) {
  const { host, createMode, onCreateModeHandled } = props;
  const [entries, setEntries] = useState<AgentEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Built-in engine agents (build, plan, ...) so a new agent cannot shadow one.
  const [engineNames, setEngineNames] = useState<ReadonlySet<string>>(new Set());

  const providerList = useProviderListQuery({
    client: host.opencodeClient,
    baseUrl: host.opencodeBaseUrl,
    directory: host.workspaceRoot,
  });
  const modelGroups = useMemo(
    () =>
      getConnectedProviderItems(providerList.data).map((provider) => ({
        label: provider.name,
        options: Object.entries(provider.models).map(([id, model]) => ({
          value: `${provider.id}/${id}`,
          label: model.name,
        })),
      })),
    [providerList.data],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const files = await opencodeAgentList();
      setEntries(
        files.map((file) => ({
          name: file.name,
          definition: parseAgentMarkdown(file.content),
        })),
      );
    } catch (error) {
      setListError(formatError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, props.refreshToken]);

  useEffect(() => {
    const client = host.opencodeClient;
    if (!client) return;
    let cancelled = false;
    void client.app
      .agents()
      .then((result) => {
        if (cancelled) return;
        setEngineNames(new Set(unwrap(result).map((agent) => agent.name)));
      })
      .catch(() => {
        // Reserved-name checks degrade gracefully when the engine is offline.
      });
    return () => {
      cancelled = true;
    };
  }, [host.opencodeClient]);

  const existingNames = useMemo(() => {
    const names = new Set(engineNames);
    for (const entry of entries) names.add(entry.name);
    return names;
  }, [engineNames, entries]);

  useEffect(() => {
    if (!createMode) return;
    setEditor({
      isNew: true,
      form: { ...emptyAgentForm(), mode: createMode },
      saving: false,
      error: null,
    });
    onCreateModeHandled();
  }, [createMode, onCreateModeHandled]);

  const filteredEntries = useMemo(() => {
    const query = props.searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(query) ||
        entry.definition.description.toLowerCase().includes(query),
    );
  }, [entries, props.searchQuery]);

  const openEdit = useCallback((entry: AgentEntry) => {
    setEditor({
      isNew: false,
      form: agentFormFromDefinition(entry.name, entry.definition),
      saving: false,
      error: null,
    });
  }, []);

  const updateForm = useCallback((update: Partial<AgentFormState>) => {
    setEditor((current) =>
      current ? { ...current, form: { ...current.form, ...update } } : current,
    );
  }, []);

  const saveEditor = useCallback(async () => {
    if (!editor || editor.saving) return;
    const errors = validateAgentForm(editor.form, {
      isNew: editor.isNew,
      existingNames,
    });
    const firstError = errors.name ?? errors.temperature ?? errors.prompt;
    if (firstError) {
      setEditor({ ...editor, error: firstError });
      return;
    }
    setEditor({ ...editor, saving: true, error: null });
    try {
      const name = editor.form.name.trim();
      const content = serializeAgentMarkdown(agentFormToDefinition(editor.form));
      const result = await opencodeAgentWrite({ name, content });
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || t("common.something_went_wrong"));
      }
      setEditor(null);
      toast.success(editor.isNew ? t("agents.created") : t("agents.saved"));
      await host.onReloadEngine();
      await refresh();
    } catch (error) {
      const message = formatError(error);
      setEditor((current) => (current ? { ...current, saving: false, error: message } : current));
    }
  }, [editor, existingNames, host, refresh]);

  const deleteAgent = useCallback(async () => {
    const target = deleteTarget;
    if (!target || deleting) return;
    setDeleting(true);
    try {
      const result = await opencodeAgentDelete({ name: target.name });
      if (!result.ok) {
        throw new Error(result.stderr || result.stdout || t("common.something_went_wrong"));
      }
      setDeleteTarget(null);
      toast.success(t("agents.deleted"));
      await host.onReloadEngine();
      await refresh();
    } catch (error) {
      toast.error(formatError(error));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, host, refresh]);

  const form = editor?.form ?? null;
  const selectedModelKnown =
    !form?.model || modelGroups.some((group) => group.options.some((option) => option.value === form.model));
  const modeItems = useMemo(() => {
    const modes: AgentMode[] =
      form && form.mode === "all" ? ["primary", "subagent", "all"] : ["primary", "subagent"];
    return modes.map((mode) => ({ value: mode, label: MODE_LABELS[mode]() }));
  }, [form]);
  const permissionOptions = useMemo(
    () => [
      { value: "", label: t("agents.approval_default") },
      { value: "allow", label: t("agents.approval_allow") },
      { value: "ask", label: t("agents.approval_ask") },
      { value: "deny", label: t("agents.approval_deny") },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="lw-section-eyebrow uppercase text-dls-secondary">
          {t("agents.section_title")}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-dls-secondary">
          {filteredEntries.length.toString().padStart(2, "0")}
        </span>
      </div>

      {listError ? (
        <div className="rounded-[20px] border border-red-7/20 bg-red-1/40 px-5 py-4 text-[13px] text-red-12">
          {listError}
        </div>
      ) : null}

      {filteredEntries.length === 0 && !loading && !listError ? (
        <div className="border-y border-dls-border py-10 text-center text-[14px] text-dls-secondary">
          {t("agents.section_empty")}
        </div>
      ) : (
        <div className="divide-y divide-dls-border border-y border-dls-border">
          {filteredEntries.map((entry) => (
            <div key={entry.name} className={ledgerRowClass}>
              <span className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-dls-accent opacity-0 transition-opacity group-hover:opacity-100" />
              <Bot size={16} className="mt-0.5 shrink-0 text-dls-secondary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">
                    {entry.name}
                  </h4>
                  <span className={typeTagClass}>
                    {agentBadgeKind(entry.definition.mode) === "subagent"
                      ? t("agents.badge_subagent")
                      : t("agents.badge_agent")}
                  </span>
                </div>
                <p className="mt-1 truncate text-[13px] leading-relaxed text-dls-secondary">
                  {entry.definition.description || t("skills.no_description")}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  className={rowIconBtnClass}
                  onClick={() => openEdit(entry)}
                  disabled={props.busy}
                  title={t("common.edit")}
                  aria-label={t("common.edit")}
                >
                  <Edit2 size={15} />
                </button>
                <button
                  type="button"
                  className={rowIconBtnClass}
                  onClick={() => setDeleteTarget(entry)}
                  disabled={props.busy}
                  title={t("agents.delete_title")}
                  aria-label={t("agents.delete_title")}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.isNew
                ? t("agents.dialog_new_title")
                : t("agents.dialog_edit_title", { name: editor?.form.name ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {editor?.isNew ? t("agents.dialog_new_desc") : t("agents.dialog_edit_desc")}
            </DialogDescription>
          </DialogHeader>

          {form ? (
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-px py-1">
              {editor?.error ? (
                <div className="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {editor.error}
                </div>
              ) : null}

              {editor?.isNew ? (
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-dls-text">{t("agents.name_label")}</span>
                  <input
                    value={form.name}
                    onChange={(event) => updateForm({ name: event.currentTarget.value })}
                    placeholder="diligence-reviewer"
                    spellCheck={false}
                    className={inputClass}
                  />
                  <span className="text-[11px] text-dls-secondary">
                    {t("agents.name_hint", { path: agentFilePath(form.name.trim() || "<name>") })}
                  </span>
                </label>
              ) : null}

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-dls-text">
                  {t("agents.description_label")}
                </span>
                <textarea
                  value={form.description}
                  onChange={(event) => updateForm({ description: event.currentTarget.value })}
                  rows={2}
                  placeholder={t("agents.description_placeholder")}
                  className={`${inputClass} resize-none`}
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-dls-text">{t("agents.mode_label")}</span>
                  <Select
                    value={form.mode}
                    items={modeItems}
                    onValueChange={(value) => {
                      if (value === "primary" || value === "subagent" || value === "all") {
                        updateForm({ mode: value });
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {modeItems.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </label>

                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-dls-text">
                    {t("agents.temperature_label")}
                  </span>
                  <input
                    value={form.temperature}
                    onChange={(event) => updateForm({ temperature: event.currentTarget.value })}
                    placeholder={t("agents.temperature_placeholder")}
                    inputMode="decimal"
                    spellCheck={false}
                    className={inputClass}
                  />
                  <span className="text-[11px] text-dls-secondary">
                    {t("agents.temperature_hint")}
                  </span>
                </label>
              </div>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-dls-text">{t("agents.model_label")}</span>
                <Select
                  value={form.model}
                  items={[
                    { value: "", label: t("agents.model_default") },
                    ...(selectedModelKnown ? [] : [{ value: form.model, label: form.model }]),
                    ...modelGroups.flatMap((group) => group.options),
                  ]}
                  onValueChange={(value) => {
                    if (typeof value === "string") updateForm({ model: value });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={t("agents.model_default")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="">{t("agents.model_default")}</SelectItem>
                      {!selectedModelKnown ? (
                        <SelectItem value={form.model}>{form.model}</SelectItem>
                      ) : null}
                    </SelectGroup>
                    {modelGroups.map((group) => (
                      <SelectGroup key={group.label}>
                        <div className="px-2 py-1 text-[11px] font-medium text-dls-secondary">
                          {group.label}
                        </div>
                        {group.options.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-dls-text">{t("agents.prompt_label")}</span>
                <textarea
                  value={form.prompt}
                  onChange={(event) => updateForm({ prompt: event.currentTarget.value })}
                  rows={10}
                  spellCheck={false}
                  placeholder={t("agents.prompt_placeholder")}
                  className={`${inputClass} min-h-[200px] font-mono text-xs`}
                />
              </label>

              <div className="space-y-2">
                <span className="text-xs font-medium text-dls-text">{t("agents.tools_label")}</span>
                <div className="grid gap-2 rounded-xl border border-dls-border p-3 sm:grid-cols-2">
                  {AGENT_TOOL_KEYS.map((key) => (
                    <label key={key} className="flex items-center justify-between gap-3 text-[13px] text-dls-text">
                      <span>{TOOL_LABELS[key]()}</span>
                      <Switch
                        size="sm"
                        checked={isAgentToolEnabled(form.tools, key)}
                        onCheckedChange={(checked) =>
                          updateForm({ tools: toggleAgentTool(form.tools, key, checked) })
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <span className="text-xs font-medium text-dls-text">
                  {t("agents.approvals_label")}
                </span>
                <p className="text-[11px] text-dls-secondary">{t("agents.approvals_hint")}</p>
                <div className="grid gap-2 rounded-xl border border-dls-border p-3 sm:grid-cols-3">
                  {AGENT_PERMISSION_KEYS.map((key) => (
                    <label key={key} className="block space-y-1">
                      <span className="text-[12px] text-dls-text">{PERMISSION_LABELS[key]()}</span>
                      <Select
                        value={form.permission[key] ?? ""}
                        items={permissionOptions}
                        onValueChange={(value) => {
                          const action: AgentPermissionAction | null =
                            value === "allow" || value === "ask" || value === "deny" ? value : null;
                          updateForm({
                            permission: setAgentPermission(form.permission, key, action),
                          });
                        }}
                      >
                        <SelectTrigger className="w-full" size="sm">
                          <SelectValue placeholder={t("agents.approval_default")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {permissionOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{t("common.cancel")}</DialogClose>
            <Button
              type="button"
              disabled={!editor || editor.saving}
              onClick={() => void saveEditor()}
            >
              {editor?.saving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {t("agents.saving")}
                </>
              ) : editor?.isNew ? (
                t("agents.create_button")
              ) : (
                t("common.save")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t("agents.delete_title")}
        message={t("agents.delete_message", { name: deleteTarget?.name ?? "" })}
        confirmLabel={deleting ? t("agents.deleting") : t("agents.delete_confirm")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void deleteAgent()}
      />
    </div>
  );
}

export default WorkflowAgentsSection;
