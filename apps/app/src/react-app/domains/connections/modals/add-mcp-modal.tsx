/** @jsxImportSource react */
import { useRef, useState } from "react";
import { CheckCircle2, Info, Loader2, Plus, XCircle } from "lucide-react";

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
  buildCustomConnectorEntry,
  DEFAULT_API_KEY_HEADER,
  defaultOAuthClient,
  MCP_OAUTH_REDIRECT_URI,
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
  onProbe?: (url: string) => Promise<CustomConnectorProbe>;
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
  apiKey: "",
  apiKeyHeader: DEFAULT_API_KEY_HEADER,
};

const STEP_LABELS: Record<CustomConnectorProbe["steps"][number]["id"], () => string> = {
  connect: () => t("add_mcp.step_connect"),
  resource_metadata: () => t("add_mcp.step_resource"),
  authorization_server: () => t("add_mcp.step_authorization"),
};

/** What the check found, step by step, with the headline it adds up to. */
export function CustomConnectorCheck({ probe }: { probe: CustomConnectorProbe }) {
  const verdict = probeVerdict(probe);
  const headline =
    verdict === "signin" ? t("add_mcp.found_signin")
    : verdict === "open" ? t("add_mcp.found_open")
    : verdict === "credentials" ? t("add_mcp.found_credentials")
    : verdict === "unreachable" ? t("add_mcp.unreachable")
    : t("add_mcp.unknown");
  const settled = verdict === "signin" || verdict === "open" || verdict === "credentials";
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-dls-border rounded-xl border border-dls-border px-4">
        {probe.steps.map((step) => (
          <li key={step.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
            <div className="flex min-w-0 items-center gap-2.5">
              {step.ok ? <CheckCircle2 size={16} className="shrink-0 text-emerald-11" /> : <XCircle size={16} className="shrink-0 text-red-11" />}
              <div className="min-w-0">
                <div className="truncate">{STEP_LABELS[step.id]()}</div>
                <div className="truncate text-xs text-dls-secondary">{step.ok ? t("add_mcp.step_done") : step.detail ?? t("add_mcp.step_failed")}</div>
              </div>
            </div>
            <span className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-xs ${step.ok ? "bg-emerald-3/30 text-emerald-11" : "bg-red-7/10 text-red-11"}`}>
              {step.status ?? "—"}
            </span>
          </li>
        ))}
      </ul>
      <div className={`flex gap-3 rounded-xl border px-4 py-3 text-sm ${settled ? "border-dls-border bg-dls-hover/40" : "border-amber-6 bg-amber-2 text-amber-11"}`} role="status">
        <Info size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">{headline}</p>
          {settled ? null : (
            <>
              {probe.error ? <p className="break-words text-xs opacity-80">{probe.error}</p> : null}
              <p className="text-xs opacity-80">{t("add_mcp.check_unavailable")}</p>
            </>
          )}
        </div>
      </div>
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

/** A static credential for servers that want one but publish no OAuth sign-in. */
export function CustomConnectorApiKeyFields({ form, onChange }: FieldsProps) {
  return (
    <section className="space-y-3">
      <div className="text-sm font-medium">{t("add_mcp.api_key")}</div>
      <p className="text-xs text-dls-secondary">{t("add_mcp.api_key_hint")}</p>
      <TextInput
        label={t("add_mcp.api_key_label")}
        placeholder={t("add_mcp.api_key_placeholder")}
        type="password"
        value={form.apiKey}
        onChange={(event) => onChange({ apiKey: event.currentTarget.value })}
      />
      <TextInput
        label={t("add_mcp.api_key_header")}
        hint={t("add_mcp.api_key_header_hint")}
        value={form.apiKeyHeader}
        onChange={(event) => onChange({ apiKeyHeader: event.currentTarget.value })}
      />
    </section>
  );
}

export function AddMcpModal(props: AddMcpModalProps) {
  const [form, setForm] = useState<CustomConnectorForm>(initialForm);
  const [command, setCommand] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("details");
  const [probe, setProbe] = useState<CustomConnectorProbe | null>(null);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // A check or save that finishes after the dialog closed must not act on it.
  const attempt = useRef(0);

  const patch = (next: Partial<CustomConnectorForm>) => setForm((current) => ({ ...current, ...next }));
  const local = command !== null;
  const verdict = probe ? probeVerdict(probe) : "unknown";

  const reset = () => {
    attempt.current += 1;
    setForm(initialForm);
    setCommand(null);
    setStep("details");
    setProbe(null);
    setApiKeyOpen(false);
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
    if (!form.url.trim()) return setError(t("mcp.url_or_command_required"));
    if (!props.onProbe) {
      setProbe(null);
      setStep("configure");
      return;
    }
    const id = ++attempt.current;
    setStep("checking");
    try {
      const result = await props.onProbe(form.url.trim());
      if (id !== attempt.current) return;
      setProbe(result);
      patch({ oauthClient: defaultOAuthClient(result) });
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

  const primaryLabel = step === "details" && !local
    ? t("add_mcp.continue")
    : verdict === "unknown" || verdict === "unreachable"
      ? t("add_mcp.add_anyway")
      : t("mcp.add_server_button");
  const primaryBusy = props.busy || submitting;

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

          {step === "checking" ? (
            <div className="space-y-3 rounded-[20px] border border-dls-border bg-dls-hover px-5 py-6 text-center" role="status">
              <Loader2 size={28} className="mx-auto animate-spin text-dls-accent" />
              <p className="text-sm font-medium">{t("add_mcp.checking")}</p>
              <p className="break-all font-mono text-xs text-dls-secondary">{form.url.trim()}</p>
            </div>
          ) : null}

          {step === "configure" ? (
            <>
              <div className="space-y-1">
                <p className="text-sm font-medium">{form.name.trim()}</p>
                <p className="break-all font-mono text-xs text-dls-secondary">{form.url.trim()}</p>
              </div>
              {probe ? <CustomConnectorCheck probe={probe} /> : (
                <div className="flex gap-3 rounded-xl border border-amber-6 bg-amber-2 px-4 py-3 text-sm text-amber-11" role="status">
                  <Info size={16} className="mt-0.5 shrink-0" />
                  <p>{t("add_mcp.check_unavailable")}</p>
                </div>
              )}
              {verdict === "signin" && probe ? (
                <CustomConnectorOAuthClientFields probe={probe} form={form} onChange={patch} />
              ) : verdict === "credentials" ? (
                <CustomConnectorApiKeyFields form={form} onChange={patch} />
              ) : (
                <div className="space-y-3">
                  <button
                    type="button"
                    className="text-xs text-dls-secondary underline underline-offset-4 hover:text-dls-text"
                    onClick={() => setApiKeyOpen((open) => !open)}
                  >
                    {t("add_mcp.api_key_optional")}
                  </button>
                  {apiKeyOpen ? <CustomConnectorApiKeyFields form={form} onChange={patch} /> : null}
                </div>
              )}
            </>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-red-6 bg-red-2 px-3 py-2 text-xs text-red-11" role="alert">{error}</div>
          ) : null}
        </div>

        <DialogFooter className="shrink-0">
          {step === "configure" ? (
            <Button variant="outline" disabled={submitting} onClick={() => { setError(null); setStep("details"); }}>
              {t("add_mcp.back")}
            </Button>
          ) : (
            <DialogClose render={<Button variant="outline" disabled={submitting} />} disabled={submitting}>
              {t("mcp.auth.cancel")}
            </DialogClose>
          )}
          {step === "configure" && verdict === "unreachable" ? (
            <Button variant="outline" disabled={submitting} onClick={() => void check()}>{t("add_mcp.try_again")}</Button>
          ) : null}
          {step !== "checking" ? (
            <Button
              onClick={() => void (step === "details" && !local ? check() : add())}
              disabled={primaryBusy}
            >
              {primaryBusy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : step === "details" && !local ? null : <Plus data-icon="inline-start" />}
              {primaryLabel}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
