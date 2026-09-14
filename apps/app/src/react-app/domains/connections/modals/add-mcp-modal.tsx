/** @jsxImportSource react */
import { useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Plus, X } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { TextInput } from "../../../design-system/text-input";
import type { McpDirectoryInfo } from "@/app/constants";
import {
  AUTHORIZATION_HEADER,
  buildCustomConnectorEntry,
  customConnectorHeaders,
  defaultOAuthClient,
  MAX_CUSTOM_HEADERS,
  MCP_OAUTH_REDIRECT_URI,
  normalizeCustomConnectorUrl,
  probeVerdict,
  type CustomConnectorForm,
  type CustomConnectorProbe,
} from "@/app/mcp-custom-connector";
import { getMcpOAuthErrorMessage } from "@/app/mcp-oauth-errors";
import { t } from "@/i18n";

export type AddMcpModalProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (entry: McpDirectoryInfo) => boolean | void | Promise<boolean | void>;
  /** Ask the server how the connector signs in; absent when nothing can check from here. */
  onProbe?: (url: string, headers?: Record<string, string>) => Promise<CustomConnectorProbe>;
  busy: boolean;
  isRemoteWorkspace: boolean;
};

type Step = "details" | "checking" | "configure";

const initialForm: CustomConnectorForm = {
  name: "",
  url: "",
  oauthClient: "automatic",
  clientId: "",
  clientSecret: "",
  headers: [],
};

const BADGE_CLASS = "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium";

/** What the check found: one badge, and one line on what to do when nothing settled. */
export function CustomConnectorCheck({ probe }: { probe: CustomConnectorProbe }) {
  const verdict = probeVerdict(probe);
  const headline =
    verdict === "signin" ? t("add_mcp.found_signin")
    : verdict === "open" ? t("add_mcp.found_open")
    : verdict === "credentials" ? t("add_mcp.found_credentials")
    : verdict === "unreachable" ? t("add_mcp.unreachable")
    : t("add_mcp.unknown");
  const settled = verdict === "signin" || verdict === "open" || verdict === "credentials";
  const hint = verdict === "unreachable" ? t("add_mcp.unreachable_hint") : verdict === "unknown" ? t("add_mcp.unknown_hint") : null;
  return (
    <div className="space-y-2">
      <span
        className={`${BADGE_CLASS} ${settled ? "border-emerald-7/20 bg-emerald-3/20 text-emerald-11" : "border-amber-6 bg-amber-2 text-amber-11"}`}
        role="status"
      >
        {settled ? <CheckCircle2 size={15} className="shrink-0" /> : <AlertCircle size={15} className="shrink-0" />}
        <span className="min-w-0 truncate">{headline}</span>
      </span>
      {hint ? <p className="text-xs text-dls-secondary">{hint}</p> : null}
    </div>
  );
}

type FieldsProps = { form: CustomConnectorForm; onChange: (patch: Partial<CustomConnectorForm>) => void };

/** Automatic registration when the provider offers it, or the firm's own OAuth client. */
export function CustomConnectorOAuthClientFields({ probe, form, onChange }: FieldsProps & { probe: CustomConnectorProbe }) {
  const automatic = probe.oauth?.dynamicRegistration === true;
  const optionClass = "flex cursor-pointer gap-3 rounded-xl border border-dls-border p-3 has-[[data-checked]]:border-dls-accent has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-60";
  return (
    <section className="space-y-3">
      <div className="text-sm font-medium">{t("add_mcp.oauth_client")}</div>
      <RadioGroup
        value={form.oauthClient}
        onValueChange={(value) => {
          if (value === "automatic" || value === "own") onChange({ oauthClient: value });
        }}
      >
        <label className={optionClass}>
          <RadioGroupItem value="automatic" disabled={!automatic} className="mt-0.5" />
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {t("add_mcp.oauth_automatic")}
              {automatic ? <Badge variant="secondary">{t("add_mcp.detected")}</Badge> : null}
            </div>
            <p className="text-xs text-dls-secondary">{automatic ? t("add_mcp.oauth_automatic_hint") : t("add_mcp.oauth_automatic_unavailable")}</p>
          </div>
        </label>
        <label className={optionClass}>
          <RadioGroupItem value="own" className="mt-0.5" />
          <div className="min-w-0 space-y-1">
            <div className="text-sm font-medium">{t("add_mcp.oauth_own")}</div>
            <p className="text-xs text-dls-secondary">{t("add_mcp.oauth_own_hint")}</p>
          </div>
        </label>
      </RadioGroup>
      {form.oauthClient === "own" ? (
        <div className="space-y-3 rounded-xl border border-dls-border bg-dls-hover/30 p-3">
          <div className="space-y-1.5 text-xs text-dls-secondary">
            <p>{t("add_mcp.redirect_hint")}</p>
            <code className="block break-all rounded-lg border border-dls-border bg-dls-hover px-3 py-2">{MCP_OAUTH_REDIRECT_URI}</code>
          </div>
          <TextInput
            label={t("mcp.oauth_client_id")}
            placeholder={t("mcp.oauth_client_id_placeholder")}
            value={form.clientId}
            onChange={(event) => onChange({ clientId: event.currentTarget.value })}
          />
          <TextInput
            label={t("mcp.oauth_client_secret")}
            placeholder={t("mcp.oauth_client_secret_placeholder")}
            type="password"
            value={form.clientSecret}
            onChange={(event) => onChange({ clientSecret: event.currentTarget.value })}
          />
        </div>
      ) : null}
      <p className="text-xs text-dls-secondary">{t("add_mcp.signin_now_note")}</p>
    </section>
  );
}

/**
 * Request headers the person adds themselves — an API key most of the time.
 * Offered on the first step so a key can go into the check, and again where
 * the outcome calls for one.
 */
export function CustomConnectorHeaderFields({ form, onChange, title, hint }: FieldsProps & { title?: string; hint?: string }) {
  const rows = form.headers;
  const update = (index: number, patch: Partial<CustomConnectorForm["headers"][number]>) =>
    onChange({ headers: rows.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const remove = (index: number) => onChange({ headers: rows.filter((_, i) => i !== index) });
  const add = () => onChange({ headers: [...rows, { name: rows.length ? "" : AUTHORIZATION_HEADER, value: "" }] });
  return (
    <section className="space-y-2">
      {title ? <div className="text-sm font-medium">{title}</div> : null}
      {hint ? <p className="text-xs text-dls-secondary">{hint}</p> : null}
      {rows.length ? (
        <div className="space-y-2">
          {!title ? <div className="text-xs font-medium text-dls-text">{t("add_mcp.headers_title")}</div> : null}
          {rows.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <TextInput
                aria-label={t("add_mcp.header_name")}
                placeholder={AUTHORIZATION_HEADER}
                value={row.name}
                spellCheck={false}
                onChange={(event) => update(index, { name: event.currentTarget.value })}
              />
              <TextInput
                aria-label={t("add_mcp.header_value")}
                placeholder={t("add_mcp.header_value_placeholder")}
                type="password"
                value={row.value}
                onChange={(event) => update(index, { value: event.currentTarget.value })}
              />
              <Button variant="ghost" size="icon-sm" aria-label={t("add_mcp.remove_header")} onClick={() => remove(index)}>
                <X size={14} />
              </Button>
            </div>
          ))}
          {!title ? <p className="text-xs text-dls-secondary">{t("add_mcp.headers_hint")}</p> : null}
        </div>
      ) : null}
      {rows.length < MAX_CUSTOM_HEADERS ? (
        <button
          type="button"
          className="text-xs text-dls-secondary underline underline-offset-4 hover:text-dls-text"
          onClick={add}
        >
          {rows.length ? t("add_mcp.add_another_header") : t("add_mcp.add_header")}
        </button>
      ) : null}
    </section>
  );
}

export function AddMcpModal(props: AddMcpModalProps) {
  const [form, setForm] = useState<CustomConnectorForm>(initialForm);
  const [command, setCommand] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("details");
  const [probe, setProbe] = useState<CustomConnectorProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A check or save that finishes after the dialog closed must not act on it.
  const attempt = useRef(0);

  const patch = (next: Partial<CustomConnectorForm>) => setForm((current) => ({ ...current, ...next }));
  const local = command !== null;
  // "unchecked": nothing could run the check from here, so the engine finds out on connect.
  const verdict = probe ? probeVerdict(probe) : "unchecked";

  const reset = () => {
    attempt.current += 1;
    setForm(initialForm);
    setCommand(null);
    setStep("details");
    setProbe(null);
    setError(null);
    setSubmitting(false);
  };
  const close = () => {
    if (submitting) return;
    reset();
    props.onClose();
  };

  const check = async () => {
    setError(null);
    if (!form.name.trim()) return setError(t("mcp.name_required"));
    const url = normalizeCustomConnectorUrl(form.url);
    if (!url) return setError(t("mcp.url_or_command_required"));
    let headers: Record<string, string> | undefined;
    try {
      headers = customConnectorHeaders(form);
    } catch (cause) {
      return setError(getMcpOAuthErrorMessage(cause));
    }
    patch({ url });
    if (!props.onProbe) {
      setProbe(null);
      setStep("configure");
      return;
    }
    const id = ++attempt.current;
    setStep("checking");
    try {
      const result = await props.onProbe(url, headers);
      if (id !== attempt.current) return;
      setProbe(result);
      patch({ oauthClient: defaultOAuthClient(result) });
      // A server that wants a key gets an Authorization row ready to fill.
      if (probeVerdict(result) === "credentials" && !form.headers.length) {
        patch({ headers: [{ name: AUTHORIZATION_HEADER, value: "" }] });
      }
      setStep("configure");
    } catch (cause) {
      if (id !== attempt.current) return;
      setStep("details");
      setError(t("add_mcp.check_failed", { message: getMcpOAuthErrorMessage(cause) }));
    }
  };

  const add = async () => {
    if (submitting) return;
    setError(null);
    let entry: McpDirectoryInfo;
    try {
      if (local) {
        if (!form.name.trim()) throw new Error(t("mcp.name_required"));
        if (!command.trim()) throw new Error(t("mcp.url_or_command_required"));
        entry = { name: form.name.trim(), description: "", type: "local", command: command.trim().split(/\s+/), oauth: false };
      } else {
        entry = buildCustomConnectorEntry(form, probe);
      }
    } catch (cause) {
      setError(getMcpOAuthErrorMessage(cause));
      return;
    }
    const id = attempt.current;
    setSubmitting(true);
    try {
      const outcome = await props.onAdd(entry);
      if (id !== attempt.current) return;
      if (outcome === false) {
        setError(t("add_mcp.connect_failed"));
        return;
      }
      reset();
      props.onClose();
    } catch (cause) {
      if (id === attempt.current) setError(getMcpOAuthErrorMessage(cause));
    } finally {
      if (id === attempt.current) setSubmitting(false);
    }
  };

  const primaryBusy = props.busy || submitting;
  // What the footer offers after the check: an unreachable address cannot be
  // connected either (the check runs where the engine runs), so it can only be
  // retried; an address that answers unlike an MCP server is most likely wrong,
  // so going back is the primary action and adding it anyway the fallback.
  const footer = step === "details"
    ? { primary: local ? t("mcp.add_server_button") : t("add_mcp.continue"), action: local ? add : check, back: false, retry: false, addAnyway: false }
    : step === "checking"
      ? null
      : verdict === "unreachable"
        ? { primary: t("add_mcp.try_again"), action: check, back: true, retry: false, addAnyway: false }
        : verdict === "unknown"
          ? { primary: t("add_mcp.back"), action: () => { setError(null); setStep("details"); }, back: false, retry: false, addAnyway: true }
          : { primary: verdict === "unchecked" ? t("add_mcp.add_anyway") : t("mcp.add_server_button"), action: add, back: true, retry: false, addAnyway: false };

  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-lg flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("mcp.add_modal_title")}</DialogTitle>
          <DialogDescription>{t("mcp.add_modal_subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-px py-1">
          {step === "details" ? (
            <>
              <TextInput
                label={t("add_mcp.name_label")}
                placeholder={t("add_mcp.name_placeholder")}
                hint={t("add_mcp.name_hint")}
                value={form.name}
                onChange={(event) => patch({ name: event.currentTarget.value })}
              />
              {local ? (
                <TextInput
                  label={t("mcp.server_command")}
                  placeholder={t("mcp.server_command_placeholder")}
                  hint={t("mcp.server_command_hint")}
                  value={command}
                  onChange={(event) => setCommand(event.currentTarget.value)}
                />
              ) : (
                <TextInput
                  label={t("mcp.server_url")}
                  placeholder={t("mcp.server_url_placeholder")}
                  hint={t("add_mcp.url_hint")}
                  value={form.url}
                  spellCheck={false}
                  onChange={(event) => patch({ url: event.currentTarget.value })}
                />
              )}
              {local ? null : <CustomConnectorHeaderFields form={form} onChange={patch} />}
              {props.isRemoteWorkspace ? (
                <p className="text-[11px] text-dls-secondary">{t("mcp.remote_workspace_url_hint")}</p>
              ) : (
                <button
                  type="button"
                  className="text-xs text-dls-secondary underline underline-offset-4 hover:text-dls-text"
                  onClick={() => setCommand(local ? null : "")}
                >
                  {local ? t("add_mcp.url_toggle") : t("add_mcp.local_toggle")}
                </button>
              )}
            </>
          ) : null}

          {step !== "details" ? (
            <div className="space-y-1">
              <p className="text-sm font-medium">{form.name.trim()}</p>
              <p className="break-all font-mono text-xs text-dls-secondary">{form.url.trim()}</p>
              {step === "configure" && probe && probe.reachable && probe.auth !== "unknown" && probe.url !== form.url.trim() ? (
                <p className="break-all text-xs text-dls-secondary">{t("add_mcp.found_at", { url: probe.url })}</p>
              ) : null}
            </div>
          ) : null}

          {step === "checking" ? (
            <span className={`${BADGE_CLASS} border-dls-border bg-dls-hover text-dls-text`} role="status">
              <Loader2 size={15} className="shrink-0 animate-spin" />
              {t("add_mcp.checking")}
            </span>
          ) : null}

          {step === "configure" ? (
            <>
              {probe ? <CustomConnectorCheck probe={probe} /> : (
                <span className={`${BADGE_CLASS} border-amber-6 bg-amber-2 text-amber-11`} role="status">
                  <AlertCircle size={15} className="shrink-0" />
                  {t("add_mcp.check_unavailable")}
                </span>
              )}
              {verdict === "signin" && probe ? (
                <CustomConnectorOAuthClientFields probe={probe} form={form} onChange={patch} />
              ) : verdict === "credentials" ? (
                <CustomConnectorHeaderFields form={form} onChange={patch} title={t("add_mcp.api_key")} hint={t("add_mcp.api_key_hint")} />
              ) : verdict === "open" ? (
                <CustomConnectorHeaderFields form={form} onChange={patch} />
              ) : null}
            </>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-red-6 bg-red-2 px-3 py-2 text-xs text-red-11" role="alert">{error}</div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0">
          {footer?.back ? (
            <Button variant="outline" disabled={submitting} onClick={() => { setError(null); setStep("details"); }}>
              {t("add_mcp.back")}
            </Button>
          ) : (
            <DialogClose render={<Button variant="outline" disabled={submitting} />} disabled={submitting}>
              {t("mcp.auth.cancel")}
            </DialogClose>
          )}
          {footer?.addAnyway ? (
            <Button variant="outline" disabled={primaryBusy} onClick={() => void add()}>
              {submitting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Plus data-icon="inline-start" />}
              {t("add_mcp.add_anyway")}
            </Button>
          ) : null}
          {footer ? (
            <Button onClick={() => void footer.action()} disabled={primaryBusy}>
              {primaryBusy && footer.action === add ? <Loader2 data-icon="inline-start" className="animate-spin" /> : footer.action === add ? <Plus data-icon="inline-start" /> : null}
              {footer.primary}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
