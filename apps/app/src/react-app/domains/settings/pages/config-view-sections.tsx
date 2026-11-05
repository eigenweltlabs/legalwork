/** @jsxImportSource react */
import { RefreshCcw } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import type { LegalworkTestState } from "./config-view-state";

export function ConfigWorkspaceSummary(props: { runtimeWorkspaceId: string | null }) {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-2">
      <div className="text-sm font-medium text-gray-12">{t("config.workspace_config_title")}</div>
      <div className="text-xs text-gray-10">{t("config.workspace_config_desc")}</div>
      {props.runtimeWorkspaceId ? (
        <div className="text-[11px] text-gray-7 font-mono truncate">
          {t("config.workspace_id_prefix")}
          {props.runtimeWorkspaceId}
        </div>
      ) : null}
    </div>
  );
}

export function ConfigEngineReloadSection(props: {
  anyActiveRuns: boolean;
  reloadBusy: boolean;
  reloadAvailabilityReason: string | null;
  reloadButtonTone: "destructive" | "secondary";
  reloadButtonDisabled: boolean;
  reloadButtonLabel: string;
  onReload: () => Promise<void>;
}) {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
      <div>
        <div className="text-sm font-medium text-gray-12">{t("config.engine_reload_title")}</div>
        <div className="text-xs text-gray-10">{t("config.engine_reload_desc")}</div>
      </div>
      <div className="flex items-center justify-between bg-gray-1 p-3 rounded-xl border border-gray-6 gap-3">
        <div className="min-w-0 space-y-1">
          <div className="text-sm text-gray-12">{t("config.reload_now_title")}</div>
          <div className="text-xs text-gray-7">{t("config.reload_now_desc")}</div>
          {props.anyActiveRuns ? <div className="text-[11px] text-amber-11">{t("config.reload_active_tasks_warning")}</div> : null}
          {props.reloadAvailabilityReason ? <div className="text-[11px] text-gray-9">{props.reloadAvailabilityReason}</div> : null}
        </div>
        <Button variant={props.reloadButtonTone} size="sm" className="shrink-0" onClick={props.onReload} disabled={props.reloadButtonDisabled}>
          <RefreshCcw size={14} className={props.reloadBusy ? "animate-spin" : ""} />
          {props.reloadButtonLabel}
        </Button>
      </div>
    </div>
  );
}

export function ConfigDiagnosticsSection(props: {
  busy: boolean;
  diagnosticsBundleJson: string;
  copyingField: string | null;
  onCopy: (value: string, field: string) => void | Promise<void>;
}) {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-3">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-medium text-gray-12">{t("config.diagnostics_title")}</div>
          <div className="text-xs text-gray-10">{t("config.diagnostics_desc")}</div>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={() => void props.onCopy(props.diagnosticsBundleJson, "debug-bundle")} disabled={props.busy}>
          {props.copyingField === "debug-bundle" ? t("config.copied") : t("config.copy")}
        </Button>
      </div>
      <pre className="text-xs text-gray-12 whitespace-pre-wrap break-words max-h-64 overflow-auto bg-gray-1/20 border border-gray-6 rounded-xl p-3">
        {props.diagnosticsBundleJson}
      </pre>
    </div>
  );
}

export function ConfigServerConnectionSection(props: {
  busy: boolean;
  legalworkUrl: string;
  legalworkToken: string;
  tokenVisible: boolean;
  legalworkStatusLabel: string;
  legalworkStatusStyle: string;
  resolvedWorkspaceUrl: string;
  resolvedWorkspaceId: string;
  legalworkTestState: LegalworkTestState;
  legalworkTestMessage: string | null;
  hasLegalworkChanges: boolean;
  onUrlChange: (url: string) => void;
  onTokenChange: (token: string) => void;
  onToggleToken: () => void;
  onTestConnection: () => Promise<void>;
  onSave: () => void;
  onReset: () => void;
}) {
  return (
    <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-medium text-gray-12">{t("config.server_section_title")}</div>
          <div className="text-xs text-gray-10">{t("config.server_section_desc")}</div>
        </div>
        <div className={`text-xs px-2 py-1 rounded-full border ${props.legalworkStatusStyle}`}>{props.legalworkStatusLabel}</div>
      </div>
      <div className="grid gap-3">
        <TextInput label={t("config.server_url_input_label")} value={props.legalworkUrl} onChange={(event) => props.onUrlChange(event.currentTarget.value)} placeholder="http://127.0.0.1:<port>" hint={t("config.server_url_hint")} disabled={props.busy} />
        <label className="block">
          <div className="mb-1 text-xs font-medium text-gray-11">{t("config.token_label")}</div>
          <div className="flex items-center gap-2">
            <input type={props.tokenVisible ? "text" : "password"} value={props.legalworkToken} onChange={(event) => props.onTokenChange(event.currentTarget.value)} placeholder={t("config.token_placeholder")} disabled={props.busy} className="w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20" />
            <Button variant="outline" className="shrink-0" onClick={props.onToggleToken} disabled={props.busy}>
              {props.tokenVisible ? t("common.hide") : t("common.show")}
            </Button>
          </div>
          <div className="mt-1 text-xs text-gray-10">{t("config.token_hint")}</div>
        </label>
      </div>
      <div className="space-y-1">
        <div className="text-[11px] text-gray-7 font-mono truncate">{t("config.resolved_worker_url")}{props.resolvedWorkspaceUrl || t("config.not_set")}</div>
        <div className="text-[11px] text-gray-8 font-mono truncate">{t("config.worker_id")}{props.resolvedWorkspaceId || t("config.unavailable")}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void props.onTestConnection()} disabled={props.busy || props.legalworkTestState === "testing"}>{props.legalworkTestState === "testing" ? t("config.testing") : t("config.test_connection")}</Button>
        <Button onClick={props.onSave} disabled={props.busy || !props.hasLegalworkChanges}>{t("common.save")}</Button>
        <Button variant="outline" onClick={props.onReset} disabled={props.busy}>{t("common.reset")}</Button>
      </div>
      {props.legalworkTestState !== "idle" ? <ConfigConnectionTestStatus state={props.legalworkTestState} message={props.legalworkTestMessage} /> : null}
      {props.legalworkStatusLabel !== t("config.status_connected") ? <div className="text-xs text-gray-9">{t("config.server_needed_hint")}</div> : null}
    </div>
  );
}

function ConfigConnectionTestStatus(props: { state: LegalworkTestState; message: string | null }) {
  return (
    <div className={`text-xs ${props.state === "success" ? "text-green-11" : props.state === "error" ? "text-red-11" : "text-gray-9"}`} role="status" aria-live="polite">
      {props.state === "testing" ? t("config.testing_connection") : (props.message ?? t("config.connection_status_updated"))}
    </div>
  );
}
