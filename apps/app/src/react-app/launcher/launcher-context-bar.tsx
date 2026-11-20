import { Download, ListChecks, X } from "lucide-react";
import type { LauncherCapture } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { contextItemDetail, contextItemLabel, screenshotName, type CaptureSaveSource } from "./context-capture";
import { useLauncherStore } from "./launcher-store";

/** Staged context with visible provenance; every item is removable before sending. */
export function LauncherContextBar({ readOnly = false, onSaveCapture }: { readOnly?: boolean; onSaveCapture: (source: CaptureSaveSource) => void }) {
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
        {item.type === "image" && (preview || item.workspaceId && item.path) && <button type="button" disabled={readOnly} aria-label={t("launcher.capture.save_image")} title={t("launcher.capture.save_image")} onClick={() => {
          if (preview) onSaveCapture({ name: item.name, dataUrl: preview.dataUrl });
          else if (item.workspaceId && item.path) onSaveCapture({ name: item.name, workspaceId: item.workspaceId, path: item.path });
        }}><Download className="size-4" />{t("launcher.capture.save_image")}</button>}
        <button type="button" disabled={readOnly} aria-label={t("launcher.context.remove", { name: contextItemLabel(item) })} onClick={() => removeContext(item.id)}><X className="size-3.5" /></button>
      </span>;
    })}
  </div>;
}


export function LauncherCapturePreview({ capture, attachDisabled, onAsk, onAttach, onSave, onClose }: {
  capture: LauncherCapture;
  attachDisabled: boolean;
  onAsk: () => void;
  onAttach: () => void;
  onSave: (source: CaptureSaveSource) => void;
  onClose: () => void;
}) {
  return <div className="launcher-capture-preview">
    <img src={capture.dataUrl} alt={t(capture.capture === "region" ? "launcher.context.region" : "launcher.context.window")} />
    <div className="launcher-context-actions">
      <Button type="button" size="sm" variant="outline" onClick={onAsk}>{t("launcher.capture.ask_image")}</Button>
      <Button type="button" size="sm" variant="ghost" disabled={attachDisabled} onClick={onAttach}>{t("launcher.capture.attach_image")}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => onSave({ name: screenshotName(capture), dataUrl: capture.dataUrl })}><Download className="size-4" />{t("launcher.capture.save_image")}</Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("common.close")} onClick={onClose}><X className="size-4" /></Button>
    </div>
  </div>;
}
