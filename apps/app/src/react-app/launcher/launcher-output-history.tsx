import { useQuery } from "@tanstack/react-query";
import { launcherOutputCancel, launcherOutputList } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { useLauncherStore } from "./launcher-store";

export function LauncherOutputHistory({ visible }: { visible: boolean }) {
  const notify = useLauncherStore(state => state.notify);
  const outputs = useQuery({ queryKey: ["launcher-outputs"], queryFn: launcherOutputList, enabled: visible, refetchInterval: visible ? 2500 : false });
  const tasks = outputs.data ?? [];
  if (outputs.isError) return <p className="launcher-notice" role="alert">{String(outputs.error)}</p>;
  if (!tasks.length) return null;
  const waiting = tasks.filter(task => task.state === "waiting").length;
  const latest = tasks[0];
  const act = async (work: () => Promise<unknown>) => {
    try { await work(); await outputs.refetch(); }
    catch (error) { notify({ tone: "error", text: String(error) }); }
  };
  return <details className="launcher-outputs">
    <summary>{t("launcher.output.title")} · {waiting > 0 ? t("launcher.output.pending", { count: waiting }) : t(`launcher.output.${latest.state === "done" ? latest.result ?? "copied" : latest.state}`)}</summary>
    <p>{t("launcher.output.hint")}</p>
    <ul>{[...tasks.filter(task => task.state === "waiting" || task.state === "delivering"), ...tasks.filter(task => task.state !== "waiting" && task.state !== "delivering").slice(0, 50)].map(task => <li key={task.requestId}>
      <div><strong>{t(`launcher.output.${task.state === "done" ? task.result ?? "copied" : task.state}`)}</strong><time dateTime={new Date(task.createdAt).toISOString()}>{new Date(task.createdAt).toLocaleString()}</time>
        {task.error && <p role="status">{task.error}</p>}{task.text && <p className="launcher-output-preview">{task.text}</p>}</div>
      {task.text && <Button size="sm" variant="ghost" onClick={() => void act(async () => { await navigator.clipboard.writeText(task.text ?? ""); notify({ tone: "info", text: t("launcher.notice.copied") }); })}>{t("launcher.output.copy")}</Button>}
      {task.state === "waiting" && <Button size="sm" variant="ghost" onClick={() => void act(() => launcherOutputCancel(task.requestId))}>{t("launcher.output.cancel")}</Button>}
    </li>)}</ul>
  </details>;
}
