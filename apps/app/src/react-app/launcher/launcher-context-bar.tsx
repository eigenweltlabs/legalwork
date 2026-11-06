import { ListChecks, X } from "lucide-react";
import { t } from "@/i18n";
import { contextItemDetail, contextItemLabel } from "./context-capture";
import { useLauncherStore } from "./launcher-store";

/** Staged context with visible provenance; every item is removable before sending. */
export function LauncherContextBar() {
  const context = useLauncherStore(state => state.context);
  const previews = useLauncherStore(state => state.previews);
  const removeContext = useLauncherStore(state => state.removeContext);
  if (!context.length) return null;
  return <div className="launcher-context-bar" aria-label={t("launcher.context.title")}>
    {context.map(item => {
      const preview = previews.find(preview => preview.id === item.id);
      return <span key={item.id} className="launcher-context-item" title={item.type === "selection" || item.type === "clipboard" ? item.text.slice(0, 400) : contextItemDetail(item)}>
        {preview && <img src={preview.dataUrl} alt="" />}
        {item.type === "task" && <ListChecks aria-hidden className="size-3.5 shrink-0" />}
        <span>{contextItemLabel(item)}</span>
        {item.type !== "selection" && <span className="launcher-context-detail">{contextItemDetail(item)}</span>}
        <button type="button" aria-label={t("launcher.context.remove", { name: contextItemLabel(item) })} onClick={() => removeContext(item.id)}><X className="size-3.5" /></button>
      </span>;
    })}
  </div>;
}
