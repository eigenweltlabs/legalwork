import { Download, ListChecks, X } from "lucide-react";
import { t } from "@/i18n";
import { useLauncherShell } from "./launcher-shell";
import { contextItemDetail, contextItemLabel } from "./context-capture";
import { useLauncherStore } from "./launcher-store";

/** Staged context with visible provenance; every item is removable before sending. */
export function LauncherContextBar({ readOnly = false }: { readOnly?: boolean }) {
  const { client } = useLauncherShell();
  const context = useLauncherStore(state => state.context);
  const previews = useLauncherStore(state => state.previews);
  const removeContext = useLauncherStore(state => state.removeContext);
  if (!context.length) return null;
  return <div className="launcher-context-bar" aria-label={t("launcher.context.title")}>
    {context.map(item => {
      const preview = previews.find(preview => preview.id === item.id);
      return <span key={item.id} className="launcher-context-item" title={item.type === "selection" || item.type === "clipboard" ? item.text.slice(0, 400) : contextItemDetail(item)}>
        {preview && <img src={preview.dataUrl} alt={contextItemLabel(item)} className="launcher-capture-thumb" />}
        {item.type === "task" && <ListChecks aria-hidden className="size-3.5 shrink-0" />}
        <span>{contextItemLabel(item)}</span>
        {item.type === "selection" ? <details>
          <summary className="launcher-context-detail" title={t("launcher.capture.inspect_selection")}>{item.text.slice(0, 120)}{item.text.length > 120 ? "…" : ""}</summary>
          <pre className="launcher-selection-text" tabIndex={0}>{item.text}</pre>
        </details> : <span className="launcher-context-detail">{contextItemDetail(item)}</span>}
        {item.type === "image" && <button type="button" aria-label={t("launcher.capture.save_image")} title={t("launcher.capture.save_image")} onClick={async () => {
          try {
            if (!preview && (!item.workspaceId || !item.path)) throw new Error(t("launcher.chat.context_unavailable"));
            const url = preview?.dataUrl ?? URL.createObjectURL(new Blob([(await client.downloadWorkspaceFile(item.workspaceId ?? "", item.path ?? "")).data], { type: "image/png" }));
            const link = document.createElement("a"); link.href = url; link.download = item.name; link.click();
            if (!preview) setTimeout(() => URL.revokeObjectURL(url), 60_000);
          } catch (error) { useLauncherStore.getState().notify({ tone: "error", text: String(error) }); }
        }}><Download className="size-4" />{t("launcher.capture.save_image")}</button>}
        <button type="button" disabled={readOnly} aria-label={t("launcher.context.remove", { name: contextItemLabel(item) })} onClick={() => removeContext(item.id)}><X className="size-3.5" /></button>
      </span>;
    })}
  </div>;
}
