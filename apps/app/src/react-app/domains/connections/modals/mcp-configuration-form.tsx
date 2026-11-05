import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { connectorConfigVariables, type ConnectorEditRemovals } from "@legalwork/types/connector-config";
import type { McpServerConfig, McpServerEntry } from "@/app/types";
import type { McpDirectoryInfo } from "@/app/constants";
import { configuredConnectorEntry, editableConnectorConfig, savedConnectorEditConfig, usesBasicCredentialTemplate } from "@/app/mcp-configuration";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import { CustomConnectorHeaderFields } from "./add-mcp-modal";
import { customConnectorHeaders } from "@/app/mcp-custom-connector";
import type { CustomConnectorForm } from "@/app/mcp-custom-connector";

function variableLabel(name: string, basic: boolean) {
  if (/TOKEN|API_KEY/i.test(name)) return t("connector_setup.access_token");
  if (name === "SERVER_URL") return t("connector_setup.server_url");
  if (basic && name === "BASIC_AUTH_CREDENTIALS") return t("connector_setup.basic_credentials");
  return name.replace(/^user_config\./, "").replace(/[_-]+/g, " ").toLowerCase().replace(/^\w/, letter => letter.toUpperCase());
}

export function ConnectorVariableFields(props: { config: McpServerConfig; variables?: string[]; values: Record<string, string>; onChange: (name: string, value: string) => void }) {
  const basic = usesBasicCredentialTemplate(props.config);
  return <div className="space-y-4">{(props.variables ?? connectorConfigVariables(props.config)).map((name, index) => <label key={name} className="block space-y-2 text-sm font-medium">
    <span>{variableLabel(name, basic)}</span>
    <Input autoFocus={index === 0} type={/TOKEN|KEY|SECRET|PASSWORD|CREDENTIALS/i.test(name) ? "password" : "text"} autoComplete="off" spellCheck={false} value={props.values[name] ?? ""} required onChange={event => props.onChange(name, event.target.value)} />
    {basic && name === "BASIC_AUTH_CREDENTIALS" ? <span className="block text-xs font-normal text-muted-foreground">{t("connector_setup.basic_hint")}</span> : null}
  </label>)}</div>;
}

/** Edits the saved connector in its existing scope; completion uses the normal connection flow. */
export function McpConfigurationForm(props: {
  entry: McpServerEntry;
  onBack: () => void;
  onCancel?: () => void;
  onConnect: (entry: McpDirectoryInfo) => boolean | void | Promise<boolean | void>;
}) {
  const [config, setConfig] = useState(() => editableConnectorConfig(props.entry.config));
  const [values, setValues] = useState<Record<string, string>>({});
  const [headers, setHeaders] = useState(() => props.entry.configured ? props.entry.configured.headers.map(name => ({ name, value: "" })) : Object.entries(props.entry.config.headers ?? {}).map(([name, value]) => ({ name, value })));
  const [removedEnvironment, setRemovedEnvironment] = useState<string[]>([]);
  const [resetFields, setResetFields] = useState<NonNullable<ConnectorEditRemovals["resetFields"]>>([]);
  const [executableEdit, setExecutableEdit] = useState<string>();
  const [argumentsEdit, setArgumentsEdit] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submission = useRef({ current: true, busy: false });
  useEffect(() => {
    submission.current.current = true;
    return () => { submission.current.current = false; if (submission.current.busy) props.onCancel?.(); };
  }, []);
  const patch = (change: Partial<McpServerConfig>) => setConfig(current => ({ ...current, ...change }));
  const headerForm: CustomConnectorForm = { name: props.entry.name, url: config.url ?? "", oauthClient: "automatic", clientId: "", clientSecret: "", headers };
  const draft = { ...config, ...(config.type === "remote" ? { headers: Object.fromEntries(headers.filter(row => row.name.trim()).map(row => [row.name.trim(), row.value])) } : {}) };
  const variables = props.entry.configured?.variables ?? connectorConfigVariables(draft);
  const updateMap = (key: "headers" | "environment", name: string, value: string) => patch({ [key]: { ...config[key], [name]: value } });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submission.current.busy) return;
    submission.current.busy = true;
    setBusy(true);
    setError("");
    try {
      const savedHeaders = customConnectorHeaders(headerForm);
      // Imported header schemes are authoritative; only newly added bare keys use the Add form's bearer shorthand.
      for (const row of headers) if (savedHeaders && row.value.trim() && (Object.hasOwn(props.entry.config.headers ?? {}, row.name.trim()) || props.entry.configured?.headers.some(name => name.toLowerCase() === row.name.trim().toLowerCase()))) savedHeaders[row.name.trim()] = row.value;
      const entry = configuredConnectorEntry(props.entry, savedConnectorEditConfig(props.entry, { ...draft, ...(draft.type === "remote" ? { headers: savedHeaders } : {}) }), values);
      if (props.entry.configured) entry.configEdit = { ...entry.configEdit,
        removeHeaders: props.entry.configured.headers.filter(name => !headers.some(row => row.name.trim().toLowerCase() === name.toLowerCase())),
        removeEnvironment: removedEnvironment, resetFields,
        ...(executableEdit?.trim() ? { executable: executableEdit.trim() } : {}),
        ...(argumentsEdit === undefined ? {} : { arguments: argumentsEdit }),
      };
      const connected = await props.onConnect(entry);
      if (!submission.current.current) return;
      if (connected === false) setError(t("connector_setup.failed"));
      else { submission.current.busy = false; props.onBack(); }
    } catch (cause) { if (submission.current.current) setError(cause instanceof Error ? cause.message : t("connector_setup.failed")); }
    finally { submission.current.busy = false; if (submission.current.current) setBusy(false); }
  };
  if (props.entry.editable === false) return <p className="text-sm text-muted-foreground">{t("connector_setup.authored_readonly")}</p>;
  const savedPlaceholder = props.entry.configured ? t("connector_setup.saved_value_kept") : undefined;
  const reset = (field: NonNullable<ConnectorEditRemovals["resetFields"]>[number]) => setResetFields(current => current.includes(field) ? current.filter(name => name !== field) : [...current, field]);
  const environment = props.entry.configured ? props.entry.configured.environment.map(name => [name, config.environment?.[name] ?? ""] satisfies [string, string]) : Object.entries(config.environment ?? {});
  return <form onSubmit={event => void submit(event)} className="space-y-5">
    {props.entry.configured ? <p className="text-xs text-muted-foreground">{t("connector_setup.saved_values_private")}</p> : null}
    <fieldset disabled={busy} className="space-y-5">
      {variables.length ? <ConnectorVariableFields config={draft} variables={variables} values={values} onChange={(name, value) => setValues(current => ({ ...current, [name]: value }))} /> : null}
      <details open={!variables.length} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">{t("connector_setup.settings")}<ChevronDown className="size-4 text-muted-foreground group-open:rotate-180" /></summary>
        <div className="mt-4 space-y-4">
          {config.type === "remote" ? <>
            <label className="block space-y-2 text-sm"><span>{t("connector_setup.server_url")}</span><Input value={config.url ?? ""} placeholder={savedPlaceholder} spellCheck={false} onChange={event => patch({ url: event.target.value })} /></label>
            <CustomConnectorHeaderFields form={headerForm} onChange={change => { if (change.headers) setHeaders(change.headers); }} />
            <label className="flex items-center justify-between text-sm"><span>{t("connector_setup.browser_signin")}</span><Switch checked={config.oauth !== false} onCheckedChange={enabled => patch({ oauth: enabled ? {} : false })} /></label>
            {config.oauth !== false ? <fieldset className="space-y-3" disabled={resetFields.includes("oauth")}>
              <label className="block space-y-1 text-xs text-muted-foreground"><span>{t("connector_setup.client_id")}</span><Input value={config.oauth?.clientId ?? ""} onChange={event => patch({ oauth: { ...config.oauth || {}, clientId: event.target.value } })} /></label>
              <label className="block space-y-1 text-xs text-muted-foreground"><span>{t("connector_setup.client_secret")}</span><Input type="password" autoComplete="off" value={config.oauth?.clientSecret ?? ""} onChange={event => patch({ oauth: { ...config.oauth || {}, clientSecret: event.target.value } })} /></label>
              <label className="block space-y-1 text-xs text-muted-foreground"><span>{t("connector_setup.callback_url")}</span><Input value={config.oauth?.redirectUri ?? ""} placeholder="http://127.0.0.1:19876/mcp/oauth/callback" onChange={event => patch({ oauth: { ...config.oauth || {}, redirectUri: event.target.value } })} /></label>
              <label className="block space-y-1 text-xs text-muted-foreground"><span>{t("connector_setup.callback_port")}</span><Input type="number" min={1} max={65535} placeholder="19876" value={config.oauth?.callbackPort ?? ""} onChange={event => patch({ oauth: { ...config.oauth || {}, callbackPort: event.target.value ? Number(event.target.value) : undefined } })} /></label>
              <label className="block space-y-1 text-xs text-muted-foreground"><span>{t("connector_setup.scopes")}</span><Input value={config.oauth?.scope ?? ""} onChange={event => patch({ oauth: { ...config.oauth || {}, scope: event.target.value } })} /></label>
            </fieldset> : null}
            {props.entry.configured?.oauth ? <Button type="button" size="sm" variant="outline" onClick={() => reset("oauth")}>{t(resetFields.includes("oauth") ? "connector_setup.keep_saved" : "connector_setup.reset_oauth")}</Button> : null}
          </> : <>
            <label className="block space-y-2 text-sm"><span>{t("connector_setup.command")}</span><Input value={props.entry.configured ? executableEdit ?? "" : config.command?.[0] ?? ""} placeholder={savedPlaceholder} spellCheck={false} onChange={event => props.entry.configured ? setExecutableEdit(event.target.value) : patch({ command: [event.target.value, ...config.command?.slice(1) ?? []] })} /></label>
            <label className="block space-y-2 text-sm"><span>{t("connector_setup.arguments")}</span><Textarea value={props.entry.configured ? argumentsEdit?.join("\n") ?? "" : config.command?.slice(1).join("\n") ?? ""} placeholder={savedPlaceholder} onChange={event => props.entry.configured ? setArgumentsEdit(event.target.value ? event.target.value.split("\n") : []) : patch({ command: [config.command?.[0] ?? "", ...event.target.value ? event.target.value.split("\n") : []] })} /></label>
            {props.entry.configured?.command ? <Button type="button" size="sm" variant="outline" onClick={() => setArgumentsEdit(current => current?.length === 0 ? undefined : [])}>{t(argumentsEdit?.length === 0 ? "connector_setup.keep_saved" : "connector_setup.clear_arguments")}</Button> : null}
            <label className="block space-y-2 text-sm"><span>{t("connector_setup.directory")}</span><Input value={config.cwd ?? ""} placeholder={savedPlaceholder} disabled={resetFields.includes("cwd")} onChange={event => patch({ cwd: event.target.value || undefined })} /></label>
            {props.entry.configured?.cwd ? <Button type="button" size="sm" variant="outline" onClick={() => reset("cwd")}>{t(resetFields.includes("cwd") ? "connector_setup.keep_saved" : "connector_setup.reset_directory")}</Button> : null}
            {environment.filter(([name]) => !["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT", "PLUGIN_ROOT"].includes(name)).map(([name, value]) => <div key={name} className="space-y-1"><label className="block space-y-1 text-xs text-muted-foreground"><span>{name}</span><Input type="password" autoComplete="off" placeholder={savedPlaceholder} disabled={removedEnvironment.includes(name)} value={value} onChange={event => updateMap("environment", name, event.target.value)} /></label>{props.entry.configured ? <Button type="button" size="sm" variant="ghost" onClick={() => setRemovedEnvironment(current => current.includes(name) ? current.filter(value => value !== name) : [...current, name])}>{t(removedEnvironment.includes(name) ? "connector_setup.keep_saved" : "common.remove")}</Button> : null}</div>)}
          </>}
        </div>
      </details>
    </fieldset>
    {error ? <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{error}</p> : null}
    <div className="flex justify-end border-t border-border pt-4"><Button type="submit" disabled={busy || variables.some(name => !values[name]?.trim())}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}{t("connector_setup.save_connect")}</Button></div>
  </form>;
}
