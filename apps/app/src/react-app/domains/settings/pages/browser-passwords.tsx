/** @jsxImportSource react */
import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { LayoutSection } from "../settings-layout";
import { Surface } from "@/react-app/design-system/surface";
import { SecretsEmptyState, SecretsSectionHeader } from "./secrets-section";
import { SettingsNotice } from "../settings-section";
import type { LegalworkBrowserPassword, LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { BrowserPasswordWebsites } from "./browser-password-websites";

type Draft = { id?: string; label: string; origin: string; username: string; password: string };
export function BrowserPasswords({ client }: { client: LegalworkServerClient }) {
  const queryClient = useQueryClient();
  const queryKey = ["browser-passwords", client.baseUrl];
  const list = useQuery({ queryKey, queryFn: () => client.listBrowserPasswords() });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<LegalworkBrowserPassword | null>(null);
  const [websitesBusy, setWebsitesBusy] = useState(false);
  const [removing, setRemoving] = useState<LegalworkBrowserPassword | null>(null);
  const fieldsId = useId();
  const save = useMutation({ gcTime: 0, mutationFn: (value: Draft) => client.saveBrowserPassword(value), onSuccess: async () => {
    setDraft(null); save.reset(); await queryClient.invalidateQueries({ queryKey });
  } });
  const remove = useMutation({ mutationFn: (id: string) => client.deleteBrowserPassword(id), onSuccess: async () => {
    setRemoving(null); await queryClient.invalidateQueries({ queryKey });
  } });
  const busy = save.isPending || remove.isPending || websitesBusy;
  const open = (value: Draft, saved?: LegalworkBrowserPassword) => { save.reset(); setDraft(value); setEditing(saved ?? null); };
  return <LayoutSection>
    <SecretsSectionHeader title={t("settings.browser_passwords.title")} description={t("settings.browser_passwords.description")}
      addLabel={t("settings.browser_passwords.add")} disabled={busy} onAdd={() => open({ label: "", origin: "", username: "", password: "" })} />
    {list.error ? <SettingsNotice tone="error">{list.error.message}</SettingsNotice> : null}
    {list.isLoading ? <p className="text-sm text-muted-foreground">{t("settings.browser_passwords.loading")}</p> : null}
    {list.data?.items.length === 0 ? <SecretsEmptyState icon={<KeyRound />}>{t("settings.browser_passwords.empty")}</SecretsEmptyState> : null}
    {list.data?.items.length ? <Surface className="divide-y divide-border/70 overflow-hidden rounded-xl">
      {list.data?.items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="font-medium break-words">{item.label}</p>
          <p className="text-sm text-muted-foreground break-all">{item.origin}{item.username ? ` · ${item.username}` : ""}</p>
          {item.websites?.filter(site => site.url !== `${item.origin}/` && site.url !== item.origin).map(site => <p key={site.url} className="text-xs text-muted-foreground break-all">{site.name}: {site.url}</p>)}
        </div>
        <div className="flex gap-1">
          <Button size="icon-sm" variant="ghost" className="text-muted-foreground" aria-label={`${t("settings.browser_passwords.edit")} ${item.label}`} title={t("settings.browser_passwords.edit")} disabled={busy} onClick={() => open({ id: item.id, label: item.label, origin: item.origin, username: item.username, password: "" }, item)}><Pencil /></Button>
          <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-destructive" aria-label={`${t("settings.environment.delete")} ${item.label}`} title={t("settings.environment.delete")} disabled={busy} onClick={() => { remove.reset(); setRemoving(item); }}><Trash2 /></Button>
        </div>
      </div>)}
    </Surface> : null}
    <Dialog open={draft !== null} onOpenChange={value => { if (!value && !busy) setDraft(null); }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader><DialogTitle>{t(draft?.id ? "settings.browser_passwords.edit" : "settings.browser_passwords.add")}</DialogTitle></DialogHeader>
        {draft ? <form onSubmit={event => { event.preventDefault(); if (!busy) save.mutate(draft); }}>
          <FieldGroup>
            <Field><FieldLabel htmlFor={`${fieldsId}-label`}>{t("settings.browser_passwords.label")}</FieldLabel>
              <Input id={`${fieldsId}-label`} value={draft.label} required maxLength={200} disabled={save.isPending} onChange={e => setDraft({ ...draft, label: e.target.value })} />
            </Field>
            <Field><FieldLabel htmlFor={`${fieldsId}-origin`}>{t("settings.browser_passwords.website")}</FieldLabel>
              <Input id={`${fieldsId}-origin`} value={draft.origin} type="url" required maxLength={2000} disabled={save.isPending} placeholder="https://example.com" onChange={e => setDraft({ ...draft, origin: e.target.value })} />
              <FieldDescription>{t("settings.browser_passwords.website_hint")}</FieldDescription>
            </Field>
            <Field><FieldLabel htmlFor={`${fieldsId}-username`}>{t("settings.browser_passwords.username")}</FieldLabel>
              <Input id={`${fieldsId}-username`} value={draft.username} maxLength={500} disabled={save.isPending} autoComplete="off" onChange={e => setDraft({ ...draft, username: e.target.value })} />
            </Field>
            <Field><FieldLabel htmlFor={`${fieldsId}-password`}>{t("settings.browser_passwords.password")}</FieldLabel>
              <Input id={`${fieldsId}-password`} value={draft.password} type="password" required={!draft.id} maxLength={10000} disabled={save.isPending} autoComplete="new-password" onChange={e => setDraft({ ...draft, password: e.target.value })} />
              {draft.id ? <FieldDescription>{t("settings.browser_passwords.keep_password")}</FieldDescription> : null}
            </Field>
          </FieldGroup>
          {editing ? <div className="mt-5"><BrowserPasswordWebsites key={editing.id} client={client} connection={editing} disabled={save.isPending}
            onBusyChange={setWebsitesBusy} onSaved={() => { void queryClient.invalidateQueries({ queryKey }); }} /></div> : null}
          {save.error ? <SettingsNotice tone="error">{save.error.message}</SettingsNotice> : null}
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>{t("settings.environment.cancel")}</Button>
            <Button type="submit" disabled={busy}>{t(save.isPending ? "settings.environment.saving" : "settings.environment.save")}</Button>
          </DialogFooter>
        </form> : null}
      </DialogContent>
    </Dialog>
    {remove.error ? <SettingsNotice tone="error">{remove.error.message}</SettingsNotice> : null}
    <ConfirmModal open={removing !== null} title={t("settings.browser_passwords.delete_title")}
      message={t("settings.browser_passwords.delete_message").replace("{label}", removing?.label ?? "")}
      confirmLabel={t("settings.environment.delete")} cancelLabel={t("settings.environment.cancel")} variant="danger" confirmButtonVariant="destructive"
      onCancel={() => { if (!remove.isPending) setRemoving(null); }} onConfirm={() => { if (removing && !remove.isPending) remove.mutate(removing.id); }} />
  </LayoutSection>;
}
