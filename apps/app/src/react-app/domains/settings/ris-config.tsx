/** @jsxImportSource react */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { registerExtensionRuntime, type ExtensionConfigContext } from "./extension-registry";
import { risStatusQuery } from "./ris-status";

export function RisConfig({ legalworkServerClient: client, onExtensionConnectionChange }: Pick<ExtensionConfigContext, "legalworkServerClient" | "onExtensionConnectionChange">) {
  const cache = useQueryClient();
  const status = useQuery(risStatusQuery(client));
  const enabled = status.data?.enabled === true && status.data.allowed;
  useEffect(() => {
    if (status.data) onExtensionConnectionChange?.("ris", enabled);
  }, [enabled, status.data, onExtensionConnectionChange]);
  const change = useMutation({ mutationFn: (value: boolean) => {
    if (!client) throw new Error(t("ris.unavailable"));
    return client.risSaveSettings(value);
  }, onSuccess: value => { cache.setQueryData(risStatusQuery(client).queryKey, value); test.reset(); } });
  const test = useMutation({ mutationFn: () => {
    if (!client) throw new Error(t("ris.unavailable"));
    return client.risTestConnection();
  } });
  const error = status.error ?? change.error ?? test.error;
  const canChange = Boolean(client?.canApprove && status.data && !status.data.readOnly);
  return <div className="space-y-5" data-testid="ris-config">
    <p className="text-sm text-muted-foreground">{t("ris.setup")}</p>
    <p className="text-sm text-muted-foreground">{t("ris.execution")}</p>
    <div className="flex items-center gap-2 text-sm" role="status">
      {status.isPending ? <Loader2 className="size-4 animate-spin" /> : enabled ? <CheckCircle2 className="size-4 text-green-600" /> : null}
      {t(!client ? "ris.unavailable" : status.isPending ? "ris.loading" : !status.data?.allowed && status.data ? "ris.blocked" : enabled ? "ris.enabled" : "ris.disabled")}
    </div>
    {status.data?.readOnly ? <p className="text-sm text-muted-foreground">{t("ris.read_only")}</p> : !client?.canApprove ? <p className="text-sm text-muted-foreground">{t("ris.owner_only")}</p> : null}
    {error ? <Alert variant="destructive"><AlertDescription>{error.message}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={!canChange || change.isPending || !enabled && status.data?.allowed === false}
        variant={enabled ? "outline" : "default"} onClick={() => change.mutate(!enabled)}>
        {change.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}{t(enabled ? "ris.disable" : "ris.enable")}
      </Button>
      <Button variant="outline" disabled={!enabled || !client?.canApprove || test.isPending || change.isPending}
        onClick={() => test.mutate()}>{test.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}{t("ris.test")}</Button>
    </div>
    {test.isSuccess ? <p className="text-sm" role="status">{t("ris.test_success")}</p> : null}
    <p className="text-xs text-muted-foreground">{t("ris.source")}</p>
  </div>;
}

registerExtensionRuntime({ id: "ris", settingsPanel: context => <RisConfig {...context} />,
  isConnected: (_entry, context) => context.extensionConnections?.ris === true });
