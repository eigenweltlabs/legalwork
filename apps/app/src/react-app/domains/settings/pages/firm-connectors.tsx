/** @jsxImportSource react */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogIn, Plug } from "lucide-react";
import type { FirmHubItem } from "@legalwork/types/firm-hub";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { McpStatusMap } from "@/app/types";
import { FIRM_HUB_QUERY_KEY, useFirmHub } from "../../connections/firm-hub";
import { FirmItemNote, MemberKeyDialog } from "../../connections/org-policy-ui";

/** "nda-review" -> "Nda Review", as the Team tab names hub items. */
const prettify = (slug: string) => slug.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, (letter) => letter.toUpperCase());

/**
 * The firm's connectors on this computer (server firm-hub.ts): what the admin
 * installed for everyone and what the member added. They follow the hub, so
 * there is nothing to remove here; a member signs in, or adds their own key,
 * where the firm asks each member for theirs.
 */
export function FirmConnectors(props: {
  client: LegalworkServerClient | null;
  statuses: McpStatusMap;
  /** Opens the sign-in for a connector the engine runs under `name`. */
  onSignIn: (name: string, url: string) => void;
}) {
  const queryClient = useQueryClient();
  const firmHub = useFirmHub(props.client);
  const [keyFor, setKeyFor] = useState<FirmHubItem | null>(null);
  const connectors = (firmHub.data?.items ?? []).filter(
    (item) => item.kind === "mcp" && item.connector && (item.installation === "automatic" || item.added),
  );
  if (connectors.length === 0) return null;

  async function saveKey(item: FirmHubItem, key: string) {
    if (!props.client) return;
    queryClient.setQueryData(FIRM_HUB_QUERY_KEY, await props.client.setFirmHubKey(item.id, key));
    toast.success(t("firm_hub.key_saved", { name: prettify(item.name) }));
  }

  return (
    <div className="space-y-4">
      <span className="lw-section-eyebrow uppercase text-dls-secondary">{t("firm_hub.from_firm_title")}</span>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
        {connectors.map((item) => {
          const connector = item.connector;
          if (!connector) return null;
          const status = props.statuses[connector.serverName]?.status;
          const needsKey = connector.access === "member" && !connector.hasOwnKey;
          const canSignIn = connector.access === "oauth" && connector.url !== null && status !== "connected";
          const state = needsKey
            ? t("firm_hub.connector_needs_key")
            : status === "connected"
              ? t("firm_hub.connector_connected")
              : status === "needs_auth" || status === "needs_client_registration"
                ? t("firm_hub.connector_needs_sign_in")
                : status === "failed"
                  ? t("firm_hub.connector_failed")
                  : null;
          return (
            <div key={item.id} className="flex flex-col rounded-[16px] border border-dls-border bg-dls-surface p-4">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-dls-border bg-dls-hover text-dls-accent">
                  <Plug size={15} strokeWidth={1.75} />
                </span>
                <h4 className="truncate text-[15px] font-medium tracking-[-0.01em] text-dls-text">{prettify(item.name)}</h4>
              </div>
              {item.description ? <p className="mt-2 line-clamp-2 text-[13px] leading-relaxed text-dls-secondary">{item.description}</p> : null}
              <div className="mt-3 flex flex-col gap-1">
                <FirmItemNote added={item.installation === "optional"} />
                {state ? <span className="text-[12px] text-dls-secondary">{state}</span> : null}
              </div>
              {connector.access === "member" || canSignIn ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {connector.access === "member" ? (
                    <Button variant="outline" size="sm" onClick={() => setKeyFor(item)}>
                      <KeyRound className="size-3.5" />
                      {t(connector.hasOwnKey ? "firm_hub.change_key" : "firm_hub.add_key")}
                    </Button>
                  ) : null}
                  {canSignIn && connector.url ? (
                    <Button variant="outline" size="sm" onClick={() => connector.url && props.onSignIn(connector.serverName, connector.url)}>
                      <LogIn className="size-3.5" />
                      {t("firm_hub.sign_in")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {keyFor ? <MemberKeyDialog name={prettify(keyFor.name)} onSave={(key) => saveKey(keyFor, key)} onClose={() => setKeyFor(null)} /> : null}
    </div>
  );
}
