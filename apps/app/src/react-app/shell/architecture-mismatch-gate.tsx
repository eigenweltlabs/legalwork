/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

type ArchitectureInfo = {
  appArch: string;
  appArchLabel: string;
  systemArch: string;
  systemArchLabel: string;
  mismatch: boolean;
  platform: "darwin" | "linux" | "windows";
  version: string;
  downloadUrl: string | null;
  releaseUrl: string;
};

function noticeKey(info: ArchitectureInfo) {
  return `legalwork.architecture.dismissed.${info.version}.${info.appArch}.${info.systemArch}`;
}

// An emulated build can still run. Architecture advice must never hold up
// runtime boot or make the workspace depend on the release feed being online.
export function ArchitectureMismatchGate({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<ArchitectureInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [availability, setAvailability] = useState<"available" | "unavailable" | "error" | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.__LEGALWORK_ELECTRON__?.system?.getArchitectureInfo?.().then((next) => {
      if (cancelled) return;
      try { setDismissed(window.localStorage.getItem(noticeKey(next)) === "1"); } catch { /* Storage may be disabled. */ }
      setInfo(next);
    }).catch((error) => console.warn("[architecture] local check failed", error));
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    setDismissed(true);
    if (info) try { window.localStorage.setItem(noticeKey(info), "1"); } catch { /* Keep working without storage. */ }
  };

  const checkDownload = async () => {
    setChecking(true);
    try {
      const result = await window.__LEGALWORK_ELECTRON__?.system?.getArchitectureDownload?.();
      setAvailability(result?.status ?? "error");
      setDownloadUrl(result?.downloadUrl ?? null);
    } catch {
      setAvailability("error");
    } finally {
      setChecking(false);
    }
  };

  return <>
    {children}
    {info?.mismatch && !dismissed && (
      <aside role="status" className="fixed bottom-4 right-4 z-[1000] w-[min(26rem,calc(100vw-2rem))] space-y-3 rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-xl">
        <p className="font-semibold">{t("architecture.performance_title")}</p>
        <p className="text-sm text-muted-foreground">{t("architecture.performance_body", {
          appArch: info.appArchLabel,
          systemArch: info.systemArchLabel,
          platform: info.platform === "darwin" ? "macOS" : info.platform === "windows" ? "Windows" : "Linux",
        })}</p>
        {availability === "unavailable" && <p className="text-sm">{t("architecture.not_available", { arch: info.systemArchLabel })}</p>}
        {availability === "error" && <p className="text-sm">{t("architecture.check_failed")}</p>}
        <div className="flex flex-wrap gap-2">
          {downloadUrl ? (
            <Button size="sm" onClick={() => void window.__LEGALWORK_ELECTRON__?.shell?.openExternal?.(downloadUrl)}>{t("architecture.download_correct")}</Button>
          ) : (
            <Button size="sm" disabled={checking} onClick={() => void checkDownload()}>{t(checking ? "architecture.checking" : "architecture.check_native")}</Button>
          )}
          <Button size="sm" variant="outline" onClick={dismiss}>{t("architecture.keep_using")}</Button>
        </div>
      </aside>
    )}
  </>;
}
