/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { LauncherFoldersSection } from "./launcher-folders-section";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Keyboard, Loader2, Plus, Trash2 } from "lucide-react";
import { DEFAULT_LAUNCHER_SETTINGS, LAUNCHER_SEARCH_KINDS, type LauncherDesktopStatus, type LauncherSettings, type QuickAction, type QuickActionInput } from "@legalwork/types/launcher";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { launcherRaycastPairing, launcherSettingsSet, launcherStatus } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";
import { dictationAcceleratorFromEvent, formatDictationShortcut } from "../../recorder/dictation-shortcut";
import { launcherAliasCollisions, normalizeLauncherAliases } from "../../../launcher/launcher-query";
import { LayoutSectionItem, LayoutSectionItemDescription, LayoutSectionItemHeader, LayoutSectionItemHeaderActions, LayoutSectionItemTitle, LayoutStack } from "../settings-layout";

const ACTION_SHORTCUT_IDS = ["app.search-files", "app.ask", "app.speak", "app.capture-region", "app.add-selection"] as const;
const emptyAction: QuickActionInput = { name: "", alias: "", shortcut: null, prompt: "", skill: null, command: null, requires: ["selection"], output: "preview", target: "assistant", projectId: null, favorite: false };

function ShortcutCapture({ value, platform, onChange, onClear }: { value: string | null; platform: LauncherDesktopStatus["platform"]; onChange: (accelerator: string) => void; onClear?: () => void }) {
  const [capturing, setCapturing] = useState(false);
  return <div className="flex items-center gap-2">
    <span className="inline-flex items-center gap-2 text-sm text-subtext"><Keyboard className="size-4" />{value ? formatDictationShortcut(value, platform) : "—".replace("—", "")}</span>
    <Button variant="outline" size="sm" aria-pressed={capturing} onClick={() => setCapturing(true)} onBlur={() => setCapturing(false)} onKeyDown={event => {
      if (!capturing) return;
      event.preventDefault();
      if (event.key === "Escape") { setCapturing(false); return; }
      const accelerator = dictationAcceleratorFromEvent(event, platform);
      if (accelerator) { onChange(accelerator); setCapturing(false); }
    }}>{capturing ? t("launcher.settings.shortcut_capture") : t("launcher.settings.shortcut_change")}</Button>
    {onClear && value && <Button variant="ghost" size="sm" onClick={onClear}>{t("launcher.settings.action_shortcut_clear")}</Button>}
  </div>;
}

export function LauncherSettingsView({ client }: { client: LegalworkServerClient | null }) {
  const desktop = isDesktopRuntime();
  const cache = useQueryClient();
  const status = useQuery({ queryKey: ["launcher-desktop-status"], queryFn: () => launcherStatus(), enabled: desktop });
  const [saving, setSaving] = useState(false);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  useEffect(() => { if (status.data) setAliases(status.data.aliases); }, [status.data]);
  const apply = async (patch: Partial<LauncherSettings>) => {
    setSaving(true);
    try { cache.setQueryData(["launcher-desktop-status"], await launcherSettingsSet(patch)); }
    finally { setSaving(false); }
  };
  const collisions = launcherAliasCollisions(normalizeLauncherAliases(aliases));
  const settings = status.data ?? { ...DEFAULT_LAUNCHER_SETTINGS, platform: "darwin" as const };
  return <LayoutStack>
    {!desktop && <p className="text-sm text-subtext">{t("launcher.settings.desktop_only")}</p>}
    {desktop && status.isError && <p role="alert" className="text-sm text-destructive">{t("launcher.settings.unavailable")}</p>}
    {desktop && status.data && <>
      <LayoutSectionItem>
        <LayoutSectionItemHeader><div><LayoutSectionItemTitle>{t("launcher.settings.shortcut")}</LayoutSectionItemTitle><LayoutSectionItemDescription>{t("launcher.settings.shortcut_hint")}</LayoutSectionItemDescription></div>
          <LayoutSectionItemHeaderActions><ShortcutCapture value={status.data.shortcut} platform={status.data.platform} onChange={accelerator => void apply({ shortcut: accelerator })} /></LayoutSectionItemHeaderActions></LayoutSectionItemHeader>
        {!status.data.shortcutRegistered && <p role="alert" className="text-sm text-destructive">{t("launcher.settings.shortcut_unregistered")}</p>}
        {status.data.conflicts.map(conflict => <p key={`${conflict.id}:${conflict.accelerator}`} role="alert" className="text-sm text-destructive">{t(`launcher.settings.conflict_${conflict.reason}`, { id: conflict.id })}</p>)}
        <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-xs font-medium text-ink">{t("launcher.settings.background")}</div><div className="mt-1 text-sm text-subtext">{t("launcher.settings.background_hint")}</div></div><Switch aria-label={t("launcher.settings.background")} checked={status.data.backgroundPresence} disabled={saving} onCheckedChange={checked => void apply({ backgroundPresence: checked })} /></div>
        <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-xs font-medium text-ink">{t("launcher.settings.autostart")}</div><div className="mt-1 text-sm text-subtext">{status.data.autostartRequiresApproval ? t("launcher.settings.autostart_approval") : t("launcher.settings.autostart_hint")}</div></div><Switch aria-label={t("launcher.settings.autostart")} checked={status.data.autostart} disabled={saving} onCheckedChange={checked => void apply({ autostart: checked })} /></div>
        <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-xs font-medium text-ink">{t("launcher.settings.companion")}</div><div className="mt-1 text-sm text-subtext">{t("launcher.settings.companion_hint")}</div></div><Switch aria-label={t("launcher.settings.companion")} checked={status.data.companion} disabled={saving} onCheckedChange={checked => void apply({ companion: checked })} /></div>
        <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between"><div className="text-xs font-medium text-ink">{t("launcher.settings.companion_badge")}</div><Switch aria-label={t("launcher.settings.companion_badge")} checked={status.data.companionBadge} disabled={saving || !status.data.companion} onCheckedChange={checked => void apply({ companionBadge: checked })} /></div>
        <div className="flex flex-col gap-3 border-t border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between"><div className="text-xs font-medium text-ink">{t("launcher.settings.remember_position")}</div><Switch aria-label={t("launcher.settings.remember_position")} checked={status.data.rememberPosition} disabled={saving} onCheckedChange={checked => void apply({ rememberPosition: checked })} /></div>
      </LayoutSectionItem>
      <LayoutSectionItem>
        <LayoutSectionItemHeader><div><LayoutSectionItemTitle>{t("launcher.settings.aliases")}</LayoutSectionItemTitle><LayoutSectionItemDescription>{t("launcher.settings.aliases_hint")}</LayoutSectionItemDescription></div></LayoutSectionItemHeader>
        <div className="grid gap-3 sm:grid-cols-5">{LAUNCHER_SEARCH_KINDS.map(kind => <label key={kind} className="flex flex-col gap-1 text-xs font-medium text-ink">{t(`launcher.kind.${kind}`)}
          <Input value={aliases[kind] ?? ""} maxLength={3} className="font-mono" onChange={event => setAliases(current => ({ ...current, [kind]: event.target.value.toLowerCase() }))} onBlur={() => { const next = normalizeLauncherAliases(aliases); if (!launcherAliasCollisions(next).length) void apply({ aliases: next }); }} /></label>)}</div>
        {collisions.map(collision => <p key={collision.alias} role="alert" className="text-sm text-destructive">{t("launcher.settings.alias_collision", { alias: collision.alias, kinds: collision.kinds.map(kind => t(`launcher.kind.${kind}`)).join(", ") })}</p>)}
      </LayoutSectionItem>
      <LayoutSectionItem>
        <LayoutSectionItemHeader><div><LayoutSectionItemTitle>{t("launcher.settings.action_shortcuts")}</LayoutSectionItemTitle><LayoutSectionItemDescription>{t("launcher.settings.action_shortcuts_hint")}</LayoutSectionItemDescription></div></LayoutSectionItemHeader>
        {ACTION_SHORTCUT_IDS.map(id => <div key={id} className="flex flex-col gap-2 border-t border-subtle pt-3 sm:flex-row sm:items-center sm:justify-between"><span className="text-sm">{t(`launcher.action.${id.slice(4)}`)}</span>
          <ShortcutCapture value={settings.actionShortcuts[id] ?? null} platform={status.data.platform} onChange={accelerator => void apply({ actionShortcuts: { ...settings.actionShortcuts, [id]: accelerator } })} onClear={() => { const next = { ...settings.actionShortcuts }; delete next[id]; void apply({ actionShortcuts: next }); }} /></div>)}
      </LayoutSectionItem>
      <LayoutSectionItem>
        <LayoutSectionItemHeader><div><LayoutSectionItemTitle>{t("launcher.settings.raycast")}</LayoutSectionItemTitle><LayoutSectionItemDescription>{t("launcher.settings.raycast_hint")}</LayoutSectionItemDescription></div>
          <LayoutSectionItemHeaderActions><Button variant="outline" size="sm" disabled={saving} onClick={() => { setSaving(true); void launcherRaycastPairing(status.data?.raycastPairing.enabled ? "disable" : "enable").then(() => status.refetch()).finally(() => setSaving(false)); }}>{status.data.raycastPairing.enabled ? t("launcher.settings.raycast_disable") : t("launcher.settings.raycast_enable")}</Button></LayoutSectionItemHeaderActions></LayoutSectionItemHeader>
        <p className="text-sm text-subtext">{status.data.raycastPairing.enabled && status.data.raycastPairing.path ? t("launcher.settings.raycast_path", { path: status.data.raycastPairing.path }) : t("launcher.settings.raycast_off")}</p>
      </LayoutSectionItem>
    </>}
    {client && <LauncherFoldersSection client={client} />}
    {client && <QuickActionsSection client={client} platform={status.data?.platform ?? "darwin"} shortcuts={desktop && status.data ? { current: status.data.actionShortcuts, apply: next => apply({ actionShortcuts: next }) } : null} />}
  </LayoutStack>;
}

function QuickActionsSection({ client, platform, shortcuts }: { client: LegalworkServerClient; platform: LauncherDesktopStatus["platform"]; shortcuts: { current: Record<string, string>; apply: (next: Record<string, string>) => Promise<void> } | null }) {
  const cache = useQueryClient();
  const actions = useQuery({ queryKey: ["quick-actions", client.baseUrl], queryFn: () => client.quickActions() });
  const [editing, setEditing] = useState<{ id: string | null; draft: QuickActionInput } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => Promise.all([actions.refetch(), cache.invalidateQueries({ queryKey: ["launcher-catalog"] })]);
  const save = async () => {
    if (!editing) return;
    setBusy(true); setError(null);
    try {
      const input: QuickActionInput = { ...editing.draft, name: editing.draft.name.trim(), alias: editing.draft.alias.trim().toLowerCase(), prompt: editing.draft.prompt.trim() };
      const { action } = editing.id ? await client.updateQuickAction(editing.id, input) : await client.createQuickAction(input);
      // The saved shortcut is a desktop registration too; the registry reports conflicts.
      if (shortcuts) { const next = { ...shortcuts.current }; if (action.shortcut) next[`quick-action:${action.id}`] = action.shortcut; else delete next[`quick-action:${action.id}`]; await shortcuts.apply(next); }
      setEditing(null);
      await refresh();
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const remove = async (action: QuickAction) => {
    setBusy(true);
    try {
      await client.deleteQuickAction(action.id);
      if (shortcuts && `quick-action:${action.id}` in shortcuts.current) { const next = { ...shortcuts.current }; delete next[`quick-action:${action.id}`]; await shortcuts.apply(next); }
      await refresh();
    } finally { setBusy(false); }
  };
  return <LayoutSectionItem>
    <LayoutSectionItemHeader><div><LayoutSectionItemTitle>{t("launcher.settings.quick_actions")}</LayoutSectionItemTitle><LayoutSectionItemDescription>{t("launcher.settings.quick_actions_hint")}</LayoutSectionItemDescription></div>
      <LayoutSectionItemHeaderActions><Button variant="outline" size="sm" disabled={busy || editing !== null} onClick={() => setEditing({ id: null, draft: { ...emptyAction } })}><Plus className="size-4" />{t("launcher.settings.quick_action_new")}</Button></LayoutSectionItemHeaderActions></LayoutSectionItemHeader>
    {actions.isPending && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />}
    {actions.data && !actions.data.actions.length && !editing && <p className="text-sm text-subtext">{t("launcher.settings.quick_actions_empty")}</p>}
    {actions.data?.actions.map(action => <div key={action.id} className="flex flex-col gap-2 border-t border-subtle pt-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0"><div className="text-sm font-medium">{action.name}{action.favorite ? " ★" : ""}{action.alias ? <span className="ml-2 font-mono text-xs text-subtext">{action.alias}</span> : null}</div><div className="truncate text-xs text-subtext">{[action.requires.map(input => t(`launcher.input.${input}`)).join(", "), t(`launcher.settings.output.${action.output}`), action.shortcut ? formatDictationShortcut(action.shortcut, platform) : null].filter(Boolean).join(" · ")}</div></div>
      <div className="flex gap-1"><Button variant="ghost" size="sm" disabled={busy} onClick={() => { const { id, createdAt: _c, updatedAt: _u, usedAt: _a, uses: _n, ...draft } = action; setEditing({ id, draft }); }}>{t("common.edit")}</Button><Button variant="ghost" size="icon-sm" aria-label={t("launcher.settings.quick_action_delete")} disabled={busy} onClick={() => void remove(action)}><Trash2 className="size-4" /></Button></div>
    </div>)}
    {editing && <form className="space-y-3 border-t border-subtle pt-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-ink">{t("launcher.settings.quick_action_name")}<Input required value={editing.draft.name} maxLength={80} onChange={event => setEditing({ ...editing, draft: { ...editing.draft, name: event.target.value } })} /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink">{t("launcher.settings.quick_action_alias")}<Input value={editing.draft.alias} maxLength={24} className="font-mono" pattern="[a-z0-9-]*" onChange={event => setEditing({ ...editing, draft: { ...editing.draft, alias: event.target.value } })} /></label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-medium text-ink">{t("launcher.settings.quick_action_prompt")}<Textarea required value={editing.draft.prompt} maxLength={8000} rows={4} onChange={event => setEditing({ ...editing, draft: { ...editing.draft, prompt: event.target.value } })} /><span className="font-normal text-subtext">{t("launcher.settings.quick_action_prompt_hint")}</span></label>
      <div className="grid gap-3 sm:grid-cols-3">
        <fieldset className="flex flex-col gap-1 text-xs font-medium text-ink"><legend>{t("launcher.settings.quick_action_requires")}</legend>{(["selection", "clipboard", "files", "arguments"] as const).map(input => <label key={input} className="flex items-center gap-2 font-normal"><input type="checkbox" checked={editing.draft.requires.includes(input)} onChange={event => setEditing({ ...editing, draft: { ...editing.draft, requires: event.target.checked ? [...editing.draft.requires, input] : editing.draft.requires.filter(item => item !== input) } })} />{t(`launcher.input.${input}`)}</label>)}</fieldset>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink">{t("launcher.settings.quick_action_output")}<select className="rounded-md border border-border bg-transparent px-2 py-1 text-sm font-normal" value={editing.draft.output} onChange={event => setEditing({ ...editing, draft: { ...editing.draft, output: event.target.value as QuickActionInput["output"] } })}>{(["preview", "copy", "save", "insert", "open"] as const).map(output => <option key={output} value={output}>{t(`launcher.settings.output.${output}`)}</option>)}</select></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-ink">{t("launcher.settings.quick_action_target")}<select className="rounded-md border border-border bg-transparent px-2 py-1 text-sm font-normal" value={editing.draft.target} onChange={event => setEditing({ ...editing, draft: { ...editing.draft, target: event.target.value === "project" || event.target.value === "none" ? event.target.value : "assistant" } })}>{(["assistant", "project", "none"] as const).map(target => <option key={target} value={target}>{t(`launcher.settings.target.${target}`)}</option>)}</select></label>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm"><Switch checked={editing.draft.favorite} onCheckedChange={checked => setEditing({ ...editing, draft: { ...editing.draft, favorite: checked } })} />{t("launcher.settings.quick_action_favorite")}</label>
        <span className="text-sm">{t("launcher.settings.quick_action_shortcut")}</span><ShortcutCapture value={editing.draft.shortcut} platform={platform} onChange={accelerator => setEditing({ ...editing, draft: { ...editing.draft, shortcut: accelerator } })} onClear={() => setEditing({ ...editing, draft: { ...editing.draft, shortcut: null } })} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={busy || !editing.draft.name.trim() || !editing.draft.prompt.trim()}>{t("common.save")}</Button><Button type="button" variant="ghost" onClick={() => setEditing(null)}>{t("common.cancel")}</Button></div>
    </form>}
  </LayoutSectionItem>;
}
