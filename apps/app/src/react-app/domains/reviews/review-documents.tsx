import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { SavedReview } from "@legalwork/types/reviews";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/i18n";
import { ReviewError } from "./review-ui";

export function ReviewNameDialog({ client, workspaceId, review, onClose, onSaved }: {
  client: LegalworkServerClient; workspaceId: string; review?: SavedReview;
  onClose: () => void; onSaved: (review: SavedReview) => void;
}) {
  const [name, setName] = useState(review?.name ?? t("review.untitled"));
  const [requestId] = useState(() => crypto.randomUUID());
  const mutation = useMutation({ mutationFn: () => review
    ? client.editReview(workspaceId, review.id, { revision: review.revision, name: name.trim() })
    : client.createReview(workspaceId, { name: name.trim(), files: [], columns: [], requestId }),
    onSuccess: value => { onSaved(value); onClose(); },
  });
  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}><DialogContent className="sm:max-w-md">
    <DialogHeader><DialogTitle>{t(review ? "review.rename" : "review.new")}</DialogTitle></DialogHeader>
    <form className="space-y-5" onSubmit={event => { event.preventDefault(); if (name.trim() && !mutation.isPending) mutation.mutate(); }}>
      <div className="space-y-2"><Label htmlFor="review-name">{t("review.name")}</Label><Input id="review-name" autoFocus value={name} maxLength={180} disabled={mutation.isPending} onChange={event => setName(event.target.value)} /></div>
      <ReviewError error={mutation.error} />
      <DialogFooter><Button type="button" variant="ghost" disabled={mutation.isPending} onClick={onClose}>{t("review.cancel")}</Button><Button type="submit" disabled={!name.trim() || mutation.isPending}>{t(review ? "review.save" : "review.create")}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
