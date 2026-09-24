import { useEffect, useState } from "react";
import { FileAudio, Link2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { isElectronRuntime } from "@/app/utils";
import { currentLocale, t } from "@/i18n";
import { RecordingDetailDialog, RecordingRow } from "../recorder/recorder-pane";
import { useRecorderStore } from "../recorder/recorder-store";

export function ProjectRecordings(props: { projectId: string; onRecord: () => void }) {
  const recordings = useRecorderStore((state) => state.recordings);
  const active = useRecorderStore((state) => state.recording);
  const [linkOpen, setLinkOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const desktop = isElectronRuntime();
  const linked = recordings.filter((item) => item.id !== active?.id && item.projectIds?.includes(props.projectId));
  const available = recordings.filter((item) => item.status !== "recording" && !item.projectIds?.includes(props.projectId) && item.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));

  useEffect(() => {
    if (!desktop) { setLoading(false); return; }
    void useRecorderStore.getState().refreshRecordings().finally(() => setLoading(false));
  }, [desktop]);

  const setLink = async (id: string, value: boolean) => {
    setPendingId(id);
    try {
      await useRecorderStore.getState().setRecordingProject(id, props.projectId, value);
      if (value) setLinkOpen(false);
    } catch (error) {
      toast.error(t("recorder.link_failed"), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setPendingId(null);
    }
  };

  return <section className="mt-8" aria-label={t("recorder.recordings_title")}>
    <SectionHeading title={t("recorder.recordings_title")} action={
      <Button variant="ghost" size="icon-sm" disabled={!desktop} aria-label={t("recorder.link_existing")} title={t("recorder.link_existing")} onClick={() => { setSearch(""); setLinkOpen(true); }}><Link2 className="size-4" /></Button>
    } />
    <div className="mt-3 space-y-2">
      {active?.projectIds?.includes(props.projectId) ? <Button variant="outline" className="h-auto w-full justify-start gap-3 rounded-xl px-4 py-3" onClick={props.onRecord}><span className="size-2 rounded-full bg-destructive" /><span className="min-w-0 flex-1 truncate text-left">{active.title}</span><span className="text-xs text-muted-foreground">{t("stealth.recording_locally")}</span></Button> : null}
      {linked.map((recording) => <RecordingRow key={recording.id} recording={recording} workspaceTargets={[]} busy={pendingId !== null} onUnlink={() => { void setLink(recording.id, false); }} onOpen={() => {
        void useRecorderStore.getState().openRecording(recording.id).catch(() => toast.error(t("projects.failed")));
      }} />)}
      {!linked.length && !active?.projectIds?.includes(props.projectId) ? <Surface className="rounded-xl px-5 py-5 text-sm text-muted-foreground">
        {loading ? t("projects.loading") : desktop ? t("recorder.project_empty") : t("recorder.desktop_required_body")}
      </Surface> : null}
    </div>
    <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>{t("recorder.link_existing")}</DialogTitle><DialogDescription>{t("recorder.link_existing_hint")}</DialogDescription></DialogHeader>
        <Input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("recorder.search_recordings")} aria-label={t("recorder.search_recordings")} />
        <div className="max-h-[50vh] overflow-y-auto">
          {available.length ? <ul className="divide-y divide-border">
            {available.map((recording) => <li key={recording.id}>
              <Button variant="ghost" disabled={pendingId !== null} className="h-auto w-full justify-start gap-3 px-3 py-3 text-left font-normal" onClick={() => { void setLink(recording.id, true); }}>
                <FileAudio className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{recording.title}</span><span className="block text-xs text-muted-foreground">{new Date(recording.createdAt).toLocaleDateString(currentLocale())}</span></span>
                {pendingId === recording.id ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4 text-muted-foreground" />}
              </Button>
            </li>)}
          </ul> : <p className="py-8 text-center text-sm text-muted-foreground">{t("recorder.no_recordings_to_link")}</p>}
        </div>
      </DialogContent>
    </Dialog>
    <RecordingDetailDialog />
  </section>;
}
