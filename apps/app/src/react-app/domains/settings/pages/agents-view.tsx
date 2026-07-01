/** @jsxImportSource react */
// Agents settings view (EIG-61): a GUI builder for opencode agents/subagents.
// Lists agents from the engine (`GET /agent`), and creates/edits/deletes the
// workspace-authored ones stored as `.opencode/agents/<name>.md` files via the
// same LegalWork workspace-file endpoints the messaging view uses.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bot, Edit2, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { Agent } from "@opencode-ai/sdk/v2/client";

import type { Client } from "@/app/types";
import { unwrap } from "@/app/lib/opencode";
import {
  LegalworkServerError,
  type LegalworkServerClient,
} from "@/app/lib/legalwork-server";
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
import { pillPrimaryClass } from "@/react-app/domains/workspace/modal-styles";
import {
  getConnectedProviderItems,
  useProviderListQuery,
} from "@/react-app/infra/provider-list-query";
import {
  AGENT_PERMISSION_KEYS,
  AGENT_TOOL_KEYS,
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
  type AgentFormState,
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

const TOOL_LABELS: Record<AgentToolKey, string> = {
  read: "Read files",
  write: "Create files",
  edit: "Edit files",
  patch: "Patch files",
  bash: "Run terminal commands",
  webfetch: "Fetch web pages",
};

const PERMISSION_LABELS: Record<AgentPermissionKey, string> = {
  edit: "Editing files",
  bash: "Terminal commands",
  webfetch: "Fetching web pages",
};

const PERMISSION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Workspace default" },
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask first" },
  { value: "deny", label: "Never allow" },
];

const MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "primary", label: "Primary — users can chat with it" },
  { value: "subagent", label: "Subagent — other agents delegate to it" },
  { value: "all", label: "Primary and subagent" },
];

function modeTag(mode: Agent["mode"]): string {
  if (mode === "subagent") return "Subagent";
  if (mode === "primary") return "Primary";
  return "Primary + subagent";
}

function formatError(error: unknown): string {
  if (error instanceof LegalworkServerError) return `${error.message} (${error.status})`;
  return error instanceof Error ? error.message : String(error);
}

type AgentListEntry = {
  agent: Agent;
  /** Set when a `.opencode/agents/<name>.md` file exists — i.e. editable. */
  fileUpdatedAt: number | null;
  hasFile: boolean;
};

type EditorState = {
  isNew: boolean;
  form: AgentFormState;
  baseUpdatedAt: number | null;
  saving: boolean;
  error: string | null;
};

export type AgentsViewProps = {
  busy: boolean;
  opencodeClient: Client | null;
  opencodeBaseUrl: string;
  workspaceRoot: string;
  legalworkServerClient: LegalworkServerClient | null;
  workspaceId: string | null;
  /** Reloads the workspace engine so newly saved agent files are picked up. */
  onReloadEngine: () => Promise<boolean>;
};

export function AgentsView(props: AgentsViewProps) {
  const { opencodeClient, legalworkServerClient, workspaceId } = props;
  const [entries, setEntries] = useState<AgentListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [openingName, setOpeningName] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentListEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canEditFiles = Boolean(legalworkServerClient && workspaceId);

  const providerList = useProviderListQuery({
    client: opencodeClient,
    baseUrl: props.opencodeBaseUrl,
    directory: props.workspaceRoot,
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
    if (!opencodeClient) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setListError(null);
    try {
      const agents = unwrap(await opencodeClient.app.agents()).filter((agent) => !agent.hidden);
      const stats = await Promise.all(
        agents.map(async (agent) => {
          if (!legalworkServerClient || !workspaceId) return null;
          try {
            return await legalworkServerClient.statWorkspaceFile(workspaceId, agentFilePath(agent.name));
          } catch {
            return null;
          }
        }),
      );
      setEntries(
        agents
          .map((agent, index) => {
            const stat = stats[index];
            const hasFile = stat?.exists === true && stat.kind !== "dir";
            return {
              agent,
              hasFile,
              fileUpdatedAt: hasFile && typeof stat?.updatedAt === "number" ? stat.updatedAt : null,
            };
          })
          .sort((a, b) => {
            if (a.hasFile !== b.hasFile) return a.hasFile ? -1 : 1;
            return a.agent.name.localeCompare(b.agent.name);
          }),
      );
    } catch (error) {
      setListError(formatError(error));
    } finally {
      setLoading(false);
    }
  }, [legalworkServerClient, opencodeClient, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const existingNames = useMemo(
    () => new Set(entries.map((entry) => entry.agent.name)),
    [entries],
  );

  const openCreate = useCallback(() => {
    setEditor({
      isNew: true,
      form: { ...emptyAgentForm(), mode: "primary" },
      baseUpdatedAt: null,
      saving: false,
      error: null,
    });
  }, []);

  const openEdit = useCallback(
    async (entry: AgentListEntry) => {
      if (!legalworkServerClient || !workspaceId || openingName) return;
      setOpeningName(entry.agent.name);
      try {
        const file = await legalworkServerClient.readWorkspaceFile(
          workspaceId,
          agentFilePath(entry.agent.name),
        );
        const definition = parseAgentMarkdown(file.content);
        setEditor({
          isNew: false,
          form: agentFormFromDefinition(entry.agent.name, definition),
          baseUpdatedAt: typeof file.updatedAt === "number" ? file.updatedAt : null,
          saving: false,
          error: null,
        });
      } catch (error) {
        toast.error(formatError(error));
      } finally {
        setOpeningName(null);
      }
    },
    [legalworkServerClient, openingName, workspaceId],
  );

  const updateForm = useCallback((update: Partial<AgentFormState>) => {
    setEditor((current) =>
      current ? { ...current, form: { ...current.form, ...update } } : current,
    );
  }, []);

  const saveEditor = useCallback(async () => {
    if (!editor || editor.saving || !legalworkServerClient || !workspaceId) return;
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
      await legalworkServerClient.writeWorkspaceFile(workspaceId, {
        path: agentFilePath(name),
        content,
        ...(editor.baseUpdatedAt !== null ? { baseUpdatedAt: editor.baseUpdatedAt } : {}),
      });
      setEditor(null);
      toast.success(editor.isNew ? "Agent created." : "Agent saved.");
      await props.onReloadEngine();
      await refresh();
    } catch (error) {
      const message =
        error instanceof LegalworkServerError && error.status === 409
          ? "This agent file changed elsewhere. Close the editor and reopen it to load the latest version."
          : formatError(error);
      setEditor((current) => (current ? { ...current, saving: false, error: message } : current));
    }
  }, [editor, existingNames, legalworkServerClient, props, refresh, workspaceId]);

  const deleteAgent = useCallback(async () => {
    const target = deleteTarget;
    if (!target || deleting || !legalworkServerClient || !workspaceId) return;
    setDeleting(true);
    try {
      const results = await legalworkServerClient.deleteWorkspaceFiles(workspaceId, [
        { path: agentFilePath(target.agent.name) },
      ]);
      const failed = results.find((result) => !result.ok);
      if (failed) {
        toast.error(`Could not delete the agent file (${failed.code ?? "unknown error"}).`);
        return;
      }
      setDeleteTarget(null);
      toast.success("Agent deleted.");
      await props.onReloadEngine();
      await refresh();
    } catch (error) {
      toast.error(formatError(error));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, legalworkServerClient, props, refresh, workspaceId]);

  const form = editor?.form ?? null;
  const selectedModelKnown =
    !form?.model || modelGroups.some((group) => group.options.some((option) => option.value === form.model));
  const modeItems = useMemo(() => {
    if (!form || form.mode !== "all") {
      return MODE_OPTIONS.filter((option) => option.value !== "all");
    }
    return MODE_OPTIONS;
  }, [form]);

  return (
    <section className="w-full max-w-3xl space-y-8">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-xl text-[14px] leading-[1.65] text-dls-secondary">
          Author the AI agents your firm works with — roles like “Diligence Reviewer” or
          “Compliance Analyst” — without editing configuration files. Each agent has its own
          instructions, model, and safety limits, saved into this workspace.
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={props.busy || loading}
            className={rowIconBtnClass}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button
            type="button"
            onClick={openCreate}
            disabled={props.busy || !canEditFiles}
            className={pillPrimaryClass}
          >
            <Plus size={14} />
            New agent
          </button>
        </div>
      </div>

      {!canEditFiles ? (
        <div className="rounded-[20px] border border-dls-border bg-dls-hover px-5 py-4 text-[13px] text-dls-secondary">
          Connect the LegalWork server and select a workspace to create or edit agents.
        </div>
      ) : null}

      {listError ? (
        <div className="rounded-[20px] border border-red-7/20 bg-red-1/40 px-5 py-4 text-[13px] text-red-12">
          {listError}
        </div>
      ) : null}

      {entries.length === 0 && !loading && !listError ? (
        <div className="border-y border-dls-border py-16 text-center text-[14px] text-dls-secondary">
          No agents yet — use “New agent” to create one.
        </div>
      ) : (
        <div className="divide-y divide-dls-border border-y border-dls-border">
          {entries.map((entry) => (
            <div key={entry.agent.name} className={ledgerRowClass}>
              <span className="pointer-events-none absolute inset-y-0 left-0 w-[2px] bg-dls-accent opacity-0 transition-opacity group-hover:opacity-100" />
              <Bot size={16} className="mt-0.5 shrink-0 text-dls-secondary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2.5">
                  <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">
                    {entry.agent.name}
                  </h4>
                  <span className={typeTagClass}>{modeTag(entry.agent.mode)}</span>
                  {!entry.hasFile ? <span className={typeTagClass}>Built-in</span> : null}
                </div>
                <p className="mt-1 truncate text-[13px] leading-relaxed text-dls-secondary">
                  {entry.agent.description || "No description."}
                </p>
              </div>
              {entry.hasFile ? (
                <div className="flex shrink-0 items-center gap-0.5 self-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <button
                    type="button"
                    className={rowIconBtnClass}
                    onClick={() => void openEdit(entry)}
                    disabled={props.busy || !canEditFiles || openingName !== null}
                    title={t("common.edit")}
                    aria-label={t("common.edit")}
                  >
                    {openingName === entry.agent.name ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Edit2 size={15} />
                    )}
                  </button>
                  <button
                    type="button"
                    className={rowIconBtnClass}
                    onClick={() => setDeleteTarget(entry)}
                    disabled={props.busy || !canEditFiles}
                    title={"Delete"}
                    aria-label={"Delete"}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ) : null}
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
            <DialogTitle>{editor?.isNew ? "New agent" : `Edit ${editor?.form.name}`}</DialogTitle>
            <DialogDescription>
              {editor?.isNew
                ? "Describe the role, pick a model, and set what the agent may do. Saved to your workspace."
                : "Changes are saved to this workspace and applied after a quick engine reload."}
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
                  <span className="text-xs font-medium text-dls-text">Name</span>
                  <input
                    value={form.name}
                    onChange={(event) => updateForm({ name: event.currentTarget.value })}
                    placeholder="diligence-reviewer"
                    spellCheck={false}
                    className={inputClass}
                  />
                  <span className="text-[11px] text-dls-secondary">
                    Lowercase letters, numbers, and dashes. Saved as{" "}
                    {agentFilePath(form.name.trim() || "<name>")}.
                  </span>
                </label>
              ) : null}

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-dls-text">Description (when to use it)</span>
                <textarea
                  value={form.description}
                  onChange={(event) => updateForm({ description: event.currentTarget.value })}
                  rows={2}
                  placeholder="Reviews diligence documents and flags unusual terms."
                  className={`${inputClass} resize-none`}
                />
              </label>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block space-y-1.5">
                  <span className="text-xs font-medium text-dls-text">Runs as</span>
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
                  <span className="text-xs font-medium text-dls-text">Temperature (optional)</span>
                  <input
                    value={form.temperature}
                    onChange={(event) => updateForm({ temperature: event.currentTarget.value })}
                    placeholder="Model default"
                    inputMode="decimal"
                    spellCheck={false}
                    className={inputClass}
                  />
                  <span className="text-[11px] text-dls-secondary">
                    0 = focused and repeatable, 2 = more creative.
                  </span>
                </label>
              </div>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-dls-text">Model</span>
                <Select
                  value={form.model}
                  items={[
                    { value: "", label: "Workspace default" },
                    ...(selectedModelKnown ? [] : [{ value: form.model, label: form.model }]),
                    ...modelGroups.flatMap((group) => group.options),
                  ]}
                  onValueChange={(value) => {
                    if (typeof value === "string") updateForm({ model: value });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Workspace default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="">Workspace default</SelectItem>
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
                <span className="text-xs font-medium text-dls-text">Instructions (role prompt)</span>
                <textarea
                  value={form.prompt}
                  onChange={(event) => updateForm({ prompt: event.currentTarget.value })}
                  rows={10}
                  spellCheck={false}
                  placeholder={
                    "You are a diligence reviewer for a law firm.\n\nWhen given documents, you..."
                  }
                  className={`${inputClass} min-h-[200px] font-mono text-xs`}
                />
              </label>

              <div className="space-y-2">
                <span className="text-xs font-medium text-dls-text">Tools</span>
                <div className="grid gap-2 rounded-xl border border-dls-border p-3 sm:grid-cols-2">
                  {AGENT_TOOL_KEYS.map((key) => (
                    <label key={key} className="flex items-center justify-between gap-3 text-[13px] text-dls-text">
                      <span>{TOOL_LABELS[key]}</span>
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
                <span className="text-xs font-medium text-dls-text">Approvals</span>
                <p className="text-[11px] text-dls-secondary">
                  Whether the agent may act on its own or must check with you first.
                </p>
                <div className="grid gap-2 rounded-xl border border-dls-border p-3 sm:grid-cols-3">
                  {AGENT_PERMISSION_KEYS.map((key) => (
                    <label key={key} className="block space-y-1">
                      <span className="text-[12px] text-dls-text">{PERMISSION_LABELS[key]}</span>
                      <Select
                        value={form.permission[key] ?? ""}
                        items={PERMISSION_OPTIONS}
                        onValueChange={(value) => {
                          const action: AgentPermissionAction | null =
                            value === "allow" || value === "ask" || value === "deny" ? value : null;
                          updateForm({
                            permission: setAgentPermission(form.permission, key, action),
                          });
                        }}
                      >
                        <SelectTrigger className="w-full" size="sm">
                          <SelectValue placeholder="Workspace default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {PERMISSION_OPTIONS.map((option) => (
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
              disabled={!editor || editor.saving || !canEditFiles}
              onClick={() => void saveEditor()}
            >
              {editor?.saving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Saving...
                </>
              ) : editor?.isNew ? (
                "Create agent"
              ) : (
                t("common.save")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete agent"
        message={`Delete “${deleteTarget?.agent.name ?? ""}”? This removes its file from the workspace.`}
        confirmLabel={deleting ? "Deleting..." : "Delete"}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        onConfirm={() => void deleteAgent()}
      />
    </section>
  );
}

export default AgentsView;
