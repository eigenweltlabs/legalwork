import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Folder, X } from "lucide-react";
import type { SavedReview } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { ReviewError } from "./review-ui";

const supported = /\.(pdf|docx|png|jpe?g|webp|txt|md|markdown)$/i;
export function ReviewDocumentsDialog({ client, workspaceId, review, onClose, onSaved }: { client: LegalworkServerClient; workspaceId: string; review?: SavedReview; onClose: () => void; onSaved: (review: SavedReview) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(review?.name ?? t("review.untitled"));
  const [files, setFiles] = useState<string[]>(review?.documents.map(document => document.path) ?? []);
  const [path, setPath] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const listing = useQuery({ queryKey: ["review-file-picker", workspaceId, path], queryFn: () => client.listWorkspaceDirectory(workspaceId, path) });
  const entries = listing.data?.entries.filter(entry => !entry.name.startsWith(".") && (entry.kind === "dir" || supported.test(entry.name))).sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name)) ?? [];
  const mutation = useMutation({ mutationFn: () => review ? client.editReview(workspaceId, review.id, { revision: review.revision, name: name.trim(), files }) : client.createReview(workspaceId, { name: name.trim(), files, columns: [], requestId }), onSuccess: async result => { await queryClient.invalidateQueries({ queryKey: ["project-reviews", workspaceId] }); onSaved(result); onClose(); } });
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}><DialogContent className="sm:max-w-2xl">
    <DialogHeader><DialogTitle>{t(review ? "review.edit_documents" : "review.new")}</DialogTitle><DialogDescription>{t("review.supported")}</DialogDescription></DialogHeader>
    <div className="space-y-2"><Label htmlFor="review-name">{t("review.name")}</Label><Input id="review-name" value={name} maxLength={180} onChange={event => setName(event.target.value)} /></div>
    <ReviewError error={listing.error || mutation.error} />
    <div className="overflow-hidden rounded-2xl border">
      <div className="flex items-center gap-2 border-b bg-muted/20 px-3 py-2"><Button variant="ghost" size="icon-sm" disabled={!path} aria-label={t("review.back")} onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}><ArrowLeft className="size-4" /></Button><span className="truncate text-sm">{path ? path.split("/").at(-1) : t("review.project_files")}</span><span className="ml-auto text-xs text-muted-foreground">{t("review.selected", { count: files.length })}</span></div>
      <div className="h-64 overflow-y-auto p-2">
        {listing.isPending ? <p className="p-4 text-sm text-muted-foreground">{t("review.loading")}</p> : !entries.length ? <p className="p-4 text-sm text-muted-foreground">{t("review.no_files")}</p> : entries.map(entry => entry.kind === "dir" ? <button key={entry.path} type="button" onClick={() => setPath(entry.path)} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted/50"><Folder className="size-4 text-muted-foreground" /><span className="truncate">{entry.name}</span></button> : <label key={entry.path} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted/50"><Checkbox checked={files.includes(entry.path)} disabled={!files.includes(entry.path) && files.length >= 100} onCheckedChange={checked => setFiles(previous => checked ? [...previous, entry.path] : previous.filter(file => file !== entry.path))} /><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{entry.name}</span></label>)}
        {listing.data?.truncated && <p className="p-3 text-xs text-muted-foreground">{t("review.truncated")}</p>}
      </div>
    </div>
    {files.length > 0 && <div className="flex max-h-20 flex-wrap gap-1.5 overflow-auto">{files.map(file => <Button key={file} variant="secondary" size="sm" className="max-w-52 gap-1 text-xs" onClick={() => setFiles(previous => previous.filter(item => item !== file))}><span className="truncate">{file.split("/").at(-1)}</span><X className="size-3 shrink-0" /></Button>)}</div>}
    <DialogFooter><Button variant="ghost" disabled={mutation.isPending} onClick={onClose}>{t("review.cancel")}</Button><Button disabled={!files.length || !name.trim() || mutation.isPending} onClick={() => mutation.mutate()}>{t(review ? "review.save" : "review.create")}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
