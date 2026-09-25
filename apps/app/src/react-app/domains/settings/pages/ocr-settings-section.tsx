import { useEffect, useId, useState } from "react";
import type { OcrApiType, OcrSettingsView } from "@legalwork/types/ocr";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import { ScanText, Monitor } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ProviderActionsMenu } from "../provider-actions-menu";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection, LayoutSectionDescription, LayoutSectionHeader, LayoutSectionItem,
  LayoutSectionTitle,
} from "../settings-layout";

type Engine = OcrSettingsView["engines"][number];
type Draft = { id?: string; kind: OcrApiType; authentication: "api-key" | "none"; label: string; endpoint: string; model: string; apiKey: string; languages: string[] | null };
const emptyDraft = (): Draft => ({ kind: "paddleocr", authentication: "api-key", label: "", endpoint: "", model: "PaddleOCR", apiKey: "", languages: null });
function isLoopbackEndpoint(endpoint: string) {
  try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname); }
  catch { return false; }
}
const endpointExamples: Record<OcrApiType, string> = {
  paddleocr: "http://localhost:8080/layout-parsing",
  "mistral-ocr": "https://api.mistral.ai/v1/ocr",
  "chat-completions": "http://localhost:8000/v1/chat/completions",
};
const activeInstall = (settings: OcrSettingsView | null) => Boolean(settings?.installation && !["complete", "failed", "cancelled"].includes(settings.installation.stage));
const engineLabel = (engine: Engine) => engine.kind === "local"
  ? t(engine.model === "pp-ocrv6-small" ? "ocr.fast" : "ocr.quality") : engine.label;

export function OcrSettingsSection({ client }: { client: Pick<LegalworkServerClient, "getOcrSettings" | "testOcrEngine" | "saveOcrServer" | "setDefaultOcrEngine" | "installOcrEngine" | "cancelOcrInstall" | "removeOcrServer"> | null }) {
  const formId = useId();
  const [settings, setSettings] = useState<OcrSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tested, setTested] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Engine | null>(null);
  const installing = activeInstall(settings);
  const apiTypes = [
    { value: "paddleocr", label: t("ocr.api_paddle") },
    { value: "mistral-ocr", label: t("ocr.api_mistral") },
    { value: "chat-completions", label: t("ocr.api_chat") },
  ];
  const authenticationItems = [{ value: "api-key", label: t("ocr.api_key") }, { value: "none", label: t("ocr.auth_none") }];

  useEffect(() => {
    let disposed = false;
    setSettings(null);
    setError(null);
    if (!client) return;
    const load = async () => {
      try {
        const next = await client.getOcrSettings();
        if (!disposed) { setSettings(next); setError(null); }
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : t("ocr.load_error"));
      }
    };
    void load();
    return () => { disposed = true; };
  }, [client]);

  useEffect(() => {
    if (!client || !installing) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await client.getOcrSettings();
        if (!disposed) setSettings(next);
      } catch (error) {
        if (!disposed) setError(error instanceof Error ? error.message : t("ocr.load_error"));
      }
      if (!disposed) timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 2500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [client, installing]);

  async function update(operation: () => Promise<OcrSettingsView>) {
    setBusy(true); setError(null); setTested(null);
    try { setSettings(await operation()); }
    catch (error) { setError(error instanceof Error ? error.message : t("ocr.save_error")); }
    finally { setBusy(false); }
  }
  async function test(engine: Engine) {
    if (!client) return;
    setBusy(true); setError(null); setTested(null);
    try { await client.testOcrEngine(engine.id); setTested(engine.id); }
    catch (error) { setError(error instanceof Error ? error.message : t("ocr.test_error")); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!client || !draft) return;
    setBusy(true); setFormError(null);
    try {
      const next = await client.saveOcrServer({
        kind: draft.kind, authentication: draft.authentication,
        label: draft.label, endpoint: draft.endpoint.trim(), model: draft.model,
        apiKey: draft.apiKey.trim() || undefined, languages: draft.languages,
      }, draft.id);
      setSettings(next); setDraft(null); setTested(null);
    } catch (error) { setFormError(error instanceof Error ? error.message : t("ocr.save_error")); }
    finally { setBusy(false); }
  }
  const disabled = busy || !client || !settings || settings.readOnly;

  function engineRow(engine: Engine) {
    if (!settings) return null;
    const selected = settings.defaultEngineId === engine.id;
    return <div key={engine.id} className="py-3 pl-8 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm">{engine.kind === "local" ? engineLabel(engine) : engine.model}</p>
            {selected ? <SettingsStatusBadge tone={engine.status === "ready" ? "ready" : "neutral"} label={t("ocr.default")} className="min-h-6 px-2" /> : null}
          </div>
          <p className="text-xs text-dls-secondary">{t(`ocr.status_${engine.status}`)}</p>
          {engine.kind === "local" ? <p className="mt-1 text-xs text-dls-secondary">{t(engine.model === "pp-ocrv6-small" ? "ocr.fast_description" : "ocr.quality_description")}</p> : null}
        </div>
        <ProviderActionsMenu name={engine.kind === "local" ? engineLabel(engine) : engine.model} disabled={disabled}>
          {!selected ? <DropdownMenuItem disabled={engine.status !== "ready" || (engine.kind === "local" && installing)} onClick={() => client && void update(() => client.setDefaultOcrEngine(engine.id))}>{t("ocr.use_default")}</DropdownMenuItem> : null}
          {engine.kind === "local" && engine.status !== "unsupported" && engine.status !== "ready" ? <DropdownMenuItem disabled={installing || !settings.installerAvailable} onClick={() => client && void update(() => client.installOcrEngine(engine.id))}>{t("ocr.download")}</DropdownMenuItem> : null}
          <DropdownMenuItem disabled={engine.status !== "ready" || installing} onClick={() => void test(engine)}>{t("ocr.test")}</DropdownMenuItem>
        </ProviderActionsMenu>
      </div>
      {engine.status === "unsupported" ? <p className="mt-2 text-xs text-dls-secondary">{t("ocr.apple_required")}</p> : null}
      {tested === engine.id ? <div className="mt-2"><SettingsNotice>{t("ocr.test_success")}</SettingsNotice></div> : null}
    </div>;
  }

  return <>
    <LayoutSection>
      <LayoutSectionHeader>
        <div className="flex items-center justify-between gap-3">
          <LayoutSectionTitle>{t("ocr.title")}</LayoutSectionTitle>
          {client ? <Button variant="default" size="sm" disabled={disabled} onClick={() => { setFormError(null); setDraft(emptyDraft()); }}>{t("ocr.add_provider")}</Button> : null}
        </div>
        <LayoutSectionDescription>{t("ocr.description")}</LayoutSectionDescription>
      </LayoutSectionHeader>
      {!client ? <SettingsNotice>{t("ocr.no_server")}</SettingsNotice> : null}
      {client && !settings && !error ? <SettingsNotice>{t("ocr.loading")}</SettingsNotice> : null}
      {settings?.readOnly ? <SettingsNotice>{t("ocr.read_only")}</SettingsNotice> : null}
      {settings?.engines.some(engine => engine.kind === "local") ? <LayoutSectionItem className="gap-0">
        <div className="flex min-w-0 items-center gap-3">
          <Monitor size={20} className="shrink-0 text-dls-text" />
          <div><p className="text-sm font-medium">{t("ocr.local_provider")}</p><p className="text-xs text-dls-secondary">{t("ocr.local_description")}</p></div>
        </div>
        <div className="mt-3 w-full divide-y divide-dls-border border-t border-dls-border">{settings.engines.filter(engine => engine.kind === "local").map(engineRow)}</div>
      </LayoutSectionItem> : null}
      {settings?.engines.filter(engine => engine.kind !== "local").map(engine => <LayoutSectionItem key={engine.id} className="gap-0">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <ScanText size={20} className="shrink-0 text-dls-text" />
            <div className="min-w-0"><p className="truncate text-sm font-medium">{engine.label}</p><p className="truncate text-xs text-dls-secondary" title={engine.endpoint}>{engine.endpoint}</p></div>
          </div>
          <ProviderActionsMenu name={engine.label} disabled={disabled}>
            <DropdownMenuItem onClick={() => {
              if (engine.kind === "local") return;
              setFormError(null); setDraft({ id: engine.id, kind: engine.kind, authentication: engine.authentication ?? "api-key", label: engine.label, endpoint: engine.endpoint ?? "", model: engine.model, languages: engine.languages, apiKey: "" });
            }}>{t("ocr.edit")}</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setRemoving(engine)}>{t("ocr.remove")}</DropdownMenuItem>
          </ProviderActionsMenu>
        </div>
        <div className="mt-3 w-full border-t border-dls-border">{engineRow(engine)}</div>
      </LayoutSectionItem>)}
      {settings && !settings.installerAvailable ? <SettingsNotice tone="warning">{t("ocr.installer_missing")}</SettingsNotice> : null}
      {settings?.installation ? <SettingsNotice tone={settings.installation.stage === "failed" ? "error" : "neutral"}>
        <div role="status" className="flex items-center justify-between gap-3">
          <span>{t(`ocr.install_${settings.installation.stage}`)}</span>
          {installing ? <Button variant="outline" disabled={disabled} onClick={() => client && void update(() => client.cancelOcrInstall())}>{t("ocr.cancel")}</Button> : null}
        </div>
      </SettingsNotice> : null}
      {error ? <SettingsNotice tone="error"><span role="alert">{error}</span></SettingsNotice> : null}
    </LayoutSection>

    <Dialog open={draft !== null} onOpenChange={(open) => { if (!open && !busy) { setDraft(null); setFormError(null); } }}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] min-h-0 max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0"><DialogTitle>{t(draft?.id ? "ocr.edit_server" : "ocr.add_server")}</DialogTitle><DialogDescription>{t("ocr.form_description")}</DialogDescription></DialogHeader>
        {draft ? <><form id={formId} className="-mr-1 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="space-y-1.5"><TextInput label={t("ocr.name")} id="ocr-name" required maxLength={120} value={draft.label} disabled={busy} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></div>
          <div className="grid gap-2"><Label className="text-xs font-medium text-dls-text" htmlFor="ocr-api-type">{t("ocr.api_type")}</Label>
            <Select value={draft.kind} items={apiTypes} disabled={busy} onValueChange={(kind) => {
              if (kind === "paddleocr" || kind === "mistral-ocr" || kind === "chat-completions")
                setDraft({ ...draft, kind, model: kind === draft.kind ? draft.model : kind === "paddleocr" ? "PaddleOCR" : kind === "mistral-ocr" ? "mistral-ocr-latest" : "" });
            }}>
              <SelectTrigger id="ocr-api-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{apiTypes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><TextInput label={t("ocr.endpoint")} id="ocr-endpoint" type="url" required placeholder={endpointExamples[draft.kind]} value={draft.endpoint} disabled={busy} onChange={(event) => {
            const endpoint = event.target.value;
            setDraft({ ...draft, endpoint, authentication: isLoopbackEndpoint(endpoint) ? draft.authentication : "api-key" });
          }} /></div>
          {draft.kind !== "paddleocr" ? <div className="space-y-1.5"><TextInput label={t("ocr.model")} id="ocr-model" required maxLength={200} value={draft.model} disabled={busy} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></div> : null}
          <div className="grid gap-2"><Label className="text-xs font-medium text-dls-text" htmlFor="ocr-auth">{t("ocr.authentication")}</Label>
            <Select value={draft.authentication} items={authenticationItems} disabled={busy} onValueChange={(authentication) => {
              if (authentication === "api-key" || (authentication === "none" && isLoopbackEndpoint(draft.endpoint))) setDraft({ ...draft, authentication, apiKey: "" });
            }}>
              <SelectTrigger id="ocr-auth" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{authenticationItems.map((item) => <SelectItem key={item.value} value={item.value} disabled={item.value === "none" && !isLoopbackEndpoint(draft.endpoint)}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {draft.authentication === "api-key" ? <div className="space-y-1.5"><TextInput label={t("ocr.api_key")} id="ocr-key" type="password" autoComplete="new-password" required={!draft.id} maxLength={16384} value={draft.apiKey} disabled={busy} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><p className="text-xs text-muted-foreground">{t(draft.id ? "ocr.key_keep" : "ocr.key_private")}</p></div> : null}
          {formError ? <SettingsNotice tone="error"><span role="alert">{formError}</span></SettingsNotice> : null}
        </form>
          <DialogFooter className="shrink-0"><Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>{t("ocr.cancel")}</Button><Button type="submit" form={formId} disabled={busy}>{t(busy ? "ocr.saving" : "ocr.save")}</Button></DialogFooter>
        </> : null}
      </DialogContent>
    </Dialog>
    <ConfirmModal open={removing !== null} title={t("ocr.remove_title")} message={t("ocr.remove_description")} confirmLabel={t("ocr.remove")} cancelLabel={t("ocr.cancel")} variant="danger" onCancel={() => setRemoving(null)} onConfirm={() => {
      if (client && removing) { const id = removing.id; setRemoving(null); void update(() => client.removeOcrServer(id)); }
    }} />
  </>;
}
