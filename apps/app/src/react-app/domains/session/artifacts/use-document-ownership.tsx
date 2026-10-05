import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { createDocumentOwnership, type DocumentAccess } from "./document-ownership";
import { documentIdentityKey } from "./document-identity";

type Options = {
  enabled: boolean;
  client: LegalworkServerClient;
  workspaceId: string;
  path: string;
  isLocalWorkspace: boolean;
  refresh: () => Promise<void>;
  flush: () => Promise<boolean>;
  drain: () => Promise<void>;
};

export function useDocumentOwnership(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const [access, setAccess] = useState<DocumentAccess>("checking");
  const controller = useRef<ReturnType<typeof createDocumentOwnership> | null>(null);
  const identity = useQuery({
    queryKey: ["document-identity", options.client.baseUrl, options.workspaceId, options.path],
    queryFn: () => options.client.statWorkspaceFile(options.workspaceId, options.path),
    enabled: options.enabled,
    staleTime: Infinity,
  });
  const key = identity.data?.fileId ? documentIdentityKey(options.client.baseUrl, identity.data.fileId, options.isLocalWorkspace) : null;

  useEffect(() => {
    if (!options.enabled || !key) return;
    if (!navigator.locks || typeof BroadcastChannel === "undefined") { setAccess("unavailable"); return; }
    setAccess("checking");
    const ownership = createDocumentOwnership({
      key,
      locks: navigator.locks,
      channel: new BroadcastChannel(`legalwork:document:${key}`),
      changed: (value) => flushSync(() => setAccess(value)),
      acquire: () => latest.current.refresh(),
      flush: () => latest.current.flush(),
      drain: () => latest.current.drain(),
      refresh: () => { void latest.current.refresh().catch(() => toast.error(t("document_access.refresh_failed"))); },
      failed: () => toast.error(t("document_access.handoff_failed")),
    });
    controller.current = ownership;
    const onFocus = () => {
      if (!ownership.canWrite()) void latest.current.refresh().catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => {
      controller.current = null;
      window.removeEventListener("focus", onFocus);
      void ownership.dispose().catch(() => {});
    };
  }, [options.enabled, key]);

  const status = options.enabled ? identity.isError || (identity.isSuccess && !key) ? "unavailable" : access : "owner";
  return {
    status,
    key,
    editable: status === "owner",
    ownsFile: status === "owner" || status === "releasing",
    assertWrite: () => {
      if (options.enabled && !controller.current?.canWrite()) throw new Error(t("document_access.read_only"));
    },
    saved: () => controller.current?.saved(),
    request: () => controller.current?.request(),
  };
}

export function DocumentAccessBanner({ access }: { access: ReturnType<typeof useDocumentOwnership> }) {
  if (access.status === "owner") return null;
  return <div role="status" data-document-access={access.status} className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs">
    <span className="min-w-0 flex-1">{t(access.status === "releasing" ? "document_access.releasing" : access.status === "requesting" ? "document_access.requesting" : access.status === "checking" ? "document_access.checking" : access.status === "unavailable" ? "document_access.unavailable" : "document_access.read_only")}</span>
    {access.status === "reader" && <Button size="sm" variant="outline" onClick={access.request}>{t("document_access.edit_here")}</Button>}
  </div>;
}
