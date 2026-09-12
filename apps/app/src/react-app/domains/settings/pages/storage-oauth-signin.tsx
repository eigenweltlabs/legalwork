/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { usePlatform } from "../../../kernel/platform";

export function StorageOAuthSignIn({ client, workspaceId, connectionId, onChanged }: {
  client: LegalworkServerClient; workspaceId: string; connectionId: string; onChanged: () => void;
}) {
  const platform = usePlatform();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const status = useQuery({
    queryKey: ["storage-oauth-status", workspaceId, connectionId],
    queryFn: () => client.storageOAuthStatus(workspaceId, connectionId),
    refetchInterval: (query) => query.state.data?.pending ? 1500 : false,
  });
  useEffect(() => { onChanged(); }, [status.data?.connected]);
  return <div className="flex flex-col items-start gap-1">
    <Button variant="outline" size="sm" disabled={busy || status.isLoading} onClick={async () => {
      setBusy(true); setError("");
      try {
        if (status.data?.connected || status.data?.pending) await client.storageOAuthDisconnect(workspaceId, connectionId);
        else {
          const flow = await client.storageOAuthStart(workspaceId, connectionId);
          platform.openLink(flow.authUrl);
        }
        await status.refetch();
      } catch (cause) { setError(cause instanceof Error ? cause.message : t("storage.failed")); }
      finally { setBusy(false); }
    }}>
      {(busy || status.data?.pending) && <Loader2 className="size-3.5 animate-spin" />}
      {t(status.data?.connected ? "storage.oauth_signout" : status.data?.pending ? "common.cancel" : "storage.oauth_connect")}
    </Button>
    {status.data?.pending && <span className="text-xs text-muted-foreground">{t("storage.oauth_pending")}</span>}
    {status.data?.connected && <span className="text-xs text-muted-foreground">{t("storage.oauth_connected")}</span>}
    {(error || status.error || status.data?.error) && <span role="alert" className="max-w-xs text-xs text-destructive">{error || status.error?.message || status.data?.error}</span>}
  </div>;
}
