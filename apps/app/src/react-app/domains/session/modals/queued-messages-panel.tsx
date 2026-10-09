/** @jsxImportSource react */
import { useRef, useState } from "react";
import { reconcileQueuedOrder } from "../surface/queued-order";
import { FileText, GripVertical, Pencil, Play, Trash2, Undo2 } from "lucide-react";
import { LazyMotion, Reorder, domMax, useDragControls, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { QueuedComposerDraft } from "../surface/composer-state-store";

export type QueuedMessagesPanelProps = {
  messages: QueuedComposerDraft[];
  onRemove: (id: string) => void;
  onEdit: (id: string) => void;
  onReorder: (ids: string[]) => void | Promise<void>;
  editingId?: string;
  onCancelEdit: () => void;
  paused: boolean;
  onResume: () => void;
  disabled: boolean;
};

export function QueuedMessagesPanel(props: QueuedMessagesPanelProps) {
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  const dragOrderRef = useRef<string[] | null>(null);
  const [savingOrder, setSavingOrder] = useState(false);
  const currentIds = props.messages.map(message => message.id);
  const ids = dragOrder
    ? reconcileQueuedOrder(dragOrder, currentIds)
    : currentIds;
  const messages = ids.flatMap(id => props.messages.filter(message => message.id === id));
  const commitOrder = async (order: string[]) => {
    setSavingOrder(true);
    try { await props.onReorder(order); }
    finally { dragOrderRef.current = null; setDragOrder(null); setSavingOrder(false); }
  };
  if (!props.messages.length && !props.editingId && !props.paused) return null;
  return (
    <section
      data-message-queue
      aria-label={t("composer.queued_count", { count: props.messages.length })}
      className="mx-3 -mb-3 rounded-t-[18px] border border-b-0 border-border/70 bg-background/90 px-1.5 pt-1 pb-3"
    >
      {props.paused && <div className="flex h-7 items-center justify-between gap-3 px-2 text-xs text-muted-foreground">
        <span>{t("composer.queue_paused")}</span>
        <Button variant="ghost" size="xs" disabled={props.disabled || props.messages.some(item => item.status === "uncertain" || item.locked) || Boolean(props.editingId)} onClick={props.onResume}>
          <Play className="size-3" />{t("composer.resume_queue")}
        </Button>
      </div>}
      {props.messages.some(message => message.status === "uncertain") && <p role="alert" className="px-2 py-2 text-xs text-destructive">{t("composer.queue_uncertain")}</p>}
      {props.messages.filter(message => message.status === "failed" && message.error).map(message => <p key={message.id} role="alert" className="px-2 py-2 text-xs text-destructive">{message.error}</p>)}
      {props.editingId && !props.messages.some(message => message.id === props.editingId) && <Button variant="ghost" size="xs" onClick={props.onCancelEdit}>{t("composer.cancel_queued_edit")}</Button>}
      <LazyMotion features={domMax}>
        <Reorder.Group axis="y" values={ids} onReorder={order => { dragOrderRef.current = order; setDragOrder(order); }} layoutScroll className="max-h-40 overflow-y-auto overscroll-contain">
          {messages.map((message, index) => (
            <QueuedMessageRow key={message.id} message={message} index={index} editing={props.editingId === message.id}
              disabled={props.disabled}
              reorderDisabled={props.disabled || savingOrder || Boolean(props.editingId)}
              onDragEnd={() => { if (dragOrderRef.current) void commitOrder(reconcileQueuedOrder(dragOrderRef.current, currentIds)); }}
              editDisabled={props.disabled || Boolean(props.editingId) || message.locked === true || message.status === "sending" || message.status === "uncertain"} onEdit={props.onEdit} onRemove={props.onRemove} onCancelEdit={props.onCancelEdit}
              onMove={(direction) => {
                const target = index + direction;
                if (target < 0 || target >= ids.length) return;
                const next = [...ids];
                next.splice(index, 1);
                next.splice(target, 0, message.id);
                setDragOrder(next);
                void commitOrder(next);
              }}
            />
          ))}
        </Reorder.Group>
      </LazyMotion>
    </section>
  );
}

function QueuedMessageRow(props: {
  disabled: boolean;
  reorderDisabled: boolean;
  message: QueuedComposerDraft;
  index: number;
  editing: boolean;
  editDisabled: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onCancelEdit: () => void;
  onMove: (direction: number) => void;
  onDragEnd: () => void;
}) {
  const dragControls = useDragControls();
  const reducedMotion = useReducedMotion();
  const { message } = props;
  return (
    <Reorder.Item value={message.id} dragListener={false} dragControls={dragControls} dragElastic={0} dragMomentum={false} onDragEnd={props.onDragEnd}
      transition={{ duration: reducedMotion ? 0 : 0.15 }}
      whileDrag={{ backgroundColor: "var(--background)", boxShadow: "0 3px 10px rgb(0 0 0 / 0.08)" }}
      className="relative flex h-8 items-center gap-1.5 rounded-lg px-1 hover:bg-muted/40"
    >
      <Button variant="ghost" size="icon-xs" className="touch-none cursor-grab text-muted-foreground/60 active:cursor-grabbing"
        aria-label={t("composer.reorder_queued", { number: props.index + 1 })} title={t("composer.reorder_queued_hint")}
        disabled={props.reorderDisabled}
        onPointerDown={(event) => { if (!props.reorderDisabled) dragControls.start(event); }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          event.stopPropagation();
          props.onMove(event.key === "ArrowUp" ? -1 : 1);
        }}
      ><GripVertical className="size-3.5" /></Button>
      {message.attachments.slice(0, 2).map((attachment) => (
        <span key={attachment.id} title={attachment.name} className="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded border border-border/70 bg-muted/30">
          {attachment.kind === "image" && attachment.previewUrl
            ? <img src={attachment.previewUrl} alt={attachment.name} className="size-full object-cover" />
            : <FileText className="size-3.5 text-muted-foreground" />}
        </span>
      ))}
      <span className={`min-w-0 flex-1 truncate text-[13px] leading-5 ${props.editing ? "text-muted-foreground" : "text-foreground"}`} title={message.text}>
        {message.text.trim() || t("composer.queued_attachments_only", { count: message.attachments.length })}
      </span>
      {(message.status === "sending" || message.locked) && <span className="text-[11px] text-muted-foreground">{t(message.locked ? "composer.editing_elsewhere" : "composer.queue_sending")}</span>}
      {props.editing && <span className="text-[11px] text-muted-foreground">{t("composer.editing_queued")}</span>}
      <Button variant="ghost" size="icon-xs" disabled={!props.editing && props.editDisabled}
        onClick={() => props.editing ? props.onCancelEdit() : props.onEdit(message.id)}
        aria-label={t(props.editing ? "composer.cancel_queued_edit" : "composer.edit_queued")}
        title={t(props.editing ? "composer.cancel_queued_edit" : "composer.edit_queued")}
      >{props.editing ? <Undo2 className="size-3.5" /> : <Pencil className="size-3.5" />}</Button>
      <Button variant="ghost" size="icon-xs" className="hover:text-destructive" disabled={props.disabled || message.status === "sending" || message.locked || props.editing} onClick={() => props.onRemove(message.id)} aria-label={t("composer.remove_queued")} title={t("composer.remove_queued")}>
        <Trash2 className="size-3.5" />
      </Button>
    </Reorder.Item>
  );
}
