import { useEffect, useState } from "react";
import type { OcrApiType, OcrSettingsView } from "@legalwork/types/ocr";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection, LayoutSectionDescription, LayoutSectionHeader, LayoutSectionItem,
  LayoutSectionItemHeader, LayoutSectionItemHeaderActions, LayoutSectionItemTitle, LayoutSectionTitle,
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

export function OcrSettingsSection({ client }: { client: LegalworkServerClient | null }) {
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

  return <>
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("ocr.title")}</LayoutSectionTitle>
        <LayoutSectionDescription>{t("ocr.description")}</LayoutSectionDescription>
      </LayoutSectionHeader>
      {!client ? <SettingsNotice>{t("ocr.no_server")}</SettingsNotice> : null}
      {client && !settings && !error ? <SettingsNotice>{t("ocr.loading")}</SettingsNotice> : null}
      {settings?.readOnly ? <SettingsNotice>{t("ocr.read_only")}</SettingsNotice> : null}
      {settings?.engines.map((engine) => <LayoutSectionItem key={engine.id}>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>
            {engineLabel(engine)}
            {settings.defaultEngineId === engine.id ? <SettingsStatusBadge tone="neutral" label={t("ocr.default")} /> : null}
            <SettingsStatusBadge tone={engine.status === "ready" ? "ready" : "warning"} label={t(`ocr.status_${engine.status}`)} />
          </LayoutSectionItemTitle>
          <LayoutSectionItemHeaderActions>
            {settings.defaultEngineId !== engine.id ? <Button variant="outline" disabled={disabled || engine.status !== "ready" || (engine.kind === "local" && installing)} onClick={() => client && void update(() => client.setDefaultOcrEngine(engine.id))}>{t("ocr.use_default")}</Button> : null}
            {engine.kind === "local" && engine.status !== "unsupported" && engine.status !== "ready" ? <Button disabled={disabled || installing || !settings.installerAvailable} onClick={() => client && void update(() => client.installOcrEngine(engine.id))}>{t("ocr.download")}</Button> : null}
            {engine.status === "ready" ? <Button variant="outline" disabled={disabled || installing} onClick={() => void test(engine)}>{t("ocr.test")}</Button> : null}
            {engine.kind !== "local" ? <>
              <Button variant="outline" disabled={disabled} onClick={() => {
                if (engine.kind === "local") return;
                setFormError(null); setDraft({ id: engine.id, kind: engine.kind, authentication: engine.authentication ?? "api-key", label: engine.label, endpoint: engine.endpoint ?? "", model: engine.model, languages: engine.languages, apiKey: "" });
              }}>{t("ocr.edit")}</Button>
              <Button variant="ghost" disabled={disabled} onClick={() => setRemoving(engine)}>{t("ocr.remove")}</Button>
            </> : null}
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
        <p className="text-sm text-muted-foreground">{engine.kind === "local"
          ? t(engine.model === "pp-ocrv6-small" ? "ocr.fast_description" : "ocr.quality_description")
          : t("ocr.remote_description")}</p>
        <p className="break-all text-xs text-muted-foreground">{engine.model}{engine.endpoint ? ` · ${engine.endpoint}` : ""}</p>
        {engine.status === "unsupported" ? <SettingsNotice tone="warning">{t("ocr.apple_required")}</SettingsNotice> : null}
        {tested === engine.id ? <SettingsNotice>{t("ocr.test_success")}</SettingsNotice> : null}
      </LayoutSectionItem>)}
      {settings ? <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <div><LayoutSectionItemTitle>{t("ocr.server_title")}</LayoutSectionItemTitle><p className="mt-1 text-sm text-muted-foreground">{t("ocr.server_description")}</p></div>
          <LayoutSectionItemHeaderActions><Button variant="outline" disabled={disabled} onClick={() => { setFormError(null); setDraft(emptyDraft()); }}>{t("ocr.add_server")}</Button></LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem> : null}
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
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t(draft?.id ? "ocr.edit_server" : "ocr.add_server")}</DialogTitle><DialogDescription>{t("ocr.form_description")}</DialogDescription></DialogHeader>
        {draft ? <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="grid gap-2"><Label htmlFor="ocr-name">{t("ocr.name")}</Label><Input id="ocr-name" required maxLength={120} value={draft.label} disabled={busy} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></div>
          <div className="grid gap-2"><Label htmlFor="ocr-api-type">{t("ocr.api_type")}</Label>
            <Select value={draft.kind} items={apiTypes} disabled={busy} onValueChange={(kind) => {
              if (kind === "paddleocr" || kind === "mistral-ocr" || kind === "chat-completions")
                setDraft({ ...draft, kind, model: kind === draft.kind ? draft.model : kind === "paddleocr" ? "PaddleOCR" : kind === "mistral-ocr" ? "mistral-ocr-latest" : "" });
            }}>
              <SelectTrigger id="ocr-api-type" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{apiTypes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-2"><Label htmlFor="ocr-endpoint">{t("ocr.endpoint")}</Label><Input id="ocr-endpoint" type="url" required placeholder={endpointExamples[draft.kind]} value={draft.endpoint} disabled={busy} onChange={(event) => {
            const endpoint = event.target.value;
            setDraft({ ...draft, endpoint, authentication: isLoopbackEndpoint(endpoint) ? draft.authentication : "api-key" });
          }} /></div>
          {draft.kind !== "paddleocr" ? <div className="grid gap-2"><Label htmlFor="ocr-model">{t("ocr.model")}</Label><Input id="ocr-model" required maxLength={200} value={draft.model} disabled={busy} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></div> : null}
          <div className="grid gap-2"><Label htmlFor="ocr-auth">{t("ocr.authentication")}</Label>
            <Select value={draft.authentication} items={authenticationItems} disabled={busy} onValueChange={(authentication) => {
              if (authentication === "api-key" || (authentication === "none" && isLoopbackEndpoint(draft.endpoint))) setDraft({ ...draft, authentication, apiKey: "" });
            }}>
              <SelectTrigger id="ocr-auth" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{authenticationItems.map((item) => <SelectItem key={item.value} value={item.value} disabled={item.value === "none" && !isLoopbackEndpoint(draft.endpoint)}>{item.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {draft.authentication === "api-key" ? <div className="grid gap-2"><Label htmlFor="ocr-key">{t("ocr.api_key")}</Label><Input id="ocr-key" type="password" autoComplete="new-password" required={!draft.id} maxLength={16384} value={draft.apiKey} disabled={busy} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} /><p className="text-xs text-muted-foreground">{t(draft.id ? "ocr.key_keep" : "ocr.key_private")}</p></div> : null}
          {formError ? <SettingsNotice tone="error"><span role="alert">{formError}</span></SettingsNotice> : null}
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setDraft(null)}>{t("ocr.cancel")}</Button><Button type="submit" disabled={busy}>{t(busy ? "ocr.saving" : "ocr.save")}</Button></DialogFooter>
        </form> : null}
      </DialogContent>
    </Dialog>
    <ConfirmModal open={removing !== null} title={t("ocr.remove_title")} message={t("ocr.remove_description")} confirmLabel={t("ocr.remove")} cancelLabel={t("ocr.cancel")} variant="danger" onCancel={() => setRemoving(null)} onConfirm={() => {
      if (client && removing) { const id = removing.id; setRemoving(null); void update(() => client.removeOcrServer(id)); }
    }} />
  </>;
}
