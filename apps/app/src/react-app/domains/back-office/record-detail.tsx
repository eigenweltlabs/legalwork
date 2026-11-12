import { useRef, useState } from "react";
import {
  Archive,
  CalendarDays,
  Home,
  History,
  LockKeyhole,
  Maximize2,
  MoreVertical,
  RotateCcw,
  X,
} from "lucide-react";
import { Button, Input } from "twenty-ui/primitives/input";
import { Avatar } from "twenty-ui/primitives/data-display";
import { Dropdown } from "twenty-ui/components/navigation";
import { Tabs } from "twenty-ui/primitives/navigation";
import { Popover } from "twenty-ui/primitives/surfaces";
import type {
  BackOfficeObject,
  BackOfficeRecord,
  BackOfficeValue,
} from "@legalwork/types/back-office";
import { FieldIcon, ValueDisplay } from "./record-values";
import { CellEditor } from "./cell-editor";
import { DirectoryEditorPopup, DirectoryMenu } from "./twenty-controls";
import { HistoryPanel } from "./history-panel";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function RecordDetail({
  client,
  team,
  historyAccessKey,
  record,
  object,
  records,
  editable,
  finance,
  userId,
  focusName, onReviewLocal,
  width,
  onWidthChange,
  onClose,
  onSave,
  onOpen,
}: {
  client: LegalworkServerClient;
  team: boolean;
  historyAccessKey: string;
  record: BackOfficeRecord;
  object: BackOfficeObject;
  records: BackOfficeRecord[];
  editable: boolean;
  finance: boolean;
  userId: string;
  focusName?: boolean;
  onReviewLocal?: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onOpen: (record: BackOfficeRecord) => void;
  onSave: (
    record: BackOfficeRecord,
    values: Record<string, BackOfficeValue>,
    archived?: boolean,
  ) => Promise<void>;
}) {
  const [edit, setEdit] = useState<{ field: string; base: BackOfficeRecord } | null>(null),
    [error, setError] = useState("");
  const [tab, setTab] = useState<"home" | "history">("home");
  const cancelName = useRef(false);
  const [nameDraft, setNameDraft] = useState<{ base: BackOfficeRecord; text: string } | null>(null);
  const savingName = useRef(false);
  const name = nameDraft?.text ?? String(record.values.name);
  const saveName = async () => {
    if (!nameDraft || savingName.current) return;
    if (!nameDraft.text.trim() || nameDraft.text.trim() === nameDraft.base.values.name) {
      setNameDraft(null);
      return;
    }
    savingName.current = true;
    setError("");
    try {
      await onSave(nameDraft.base, { name: nameDraft.text.trim() });
      setNameDraft(current => current === nameDraft ? null : current);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save the value.");
    } finally {
      savingName.current = false;
    }
  };
  const date = (value: string) =>
    new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  return (
    <aside className="bo-detail" aria-label={`${object.label} details`}>
      <div
        className="bo-detail-resize"
        role="separator"
        aria-label="Resize record panel"
        aria-orientation="vertical"
        onPointerDown={(event) => {
          const start = event.clientX;
          const target = event.currentTarget;
          target.setPointerCapture(event.pointerId);
          const move = (next: PointerEvent) =>
            onWidthChange(
              Math.max(360, Math.min(800, width + start - next.clientX)),
            );
          const end = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", end);
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", end);
        }}
      />
      <div className="bo-detail-toolbar">
        <Avatar
          size="xs"
          name={String(record.values.name)}
          colorSeed={record.id}
        />
        <Input
          className="bo-detail-name"
          variant="plain"
          size="sm"
          aria-label={`${object.label} name`}
          placeholder={object.fields.find(field => field.id === "name")?.label}
          autoFocus={focusName}
          disabled={!editable}
          value={name}
          onFocus={(event) => {
            setNameDraft(current => current ?? { base: record, text: String(record.values.name) });
            if (focusName && name === t("back_office.untitled")) event.target.select();
          }}
          onChange={(event) => {
            const text = event.target.value;
            setNameDraft(current => ({ base: current?.base ?? record, text }));
          }}
          onBlur={() => {
            if (cancelName.current) {
              cancelName.current = false;
              return;
            }
            void saveName();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              cancelName.current = true;
              setNameDraft(null);
              event.currentTarget.blur();
              if (record.revision === 0 && !name.trim()) onClose();
            }
          }}
        />
        {onReviewLocal && <Button size="sm" variant="ghost" onClick={onReviewLocal}>{t("back_office.team_sync")}</Button>}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Expand record"
          onClick={() => onWidthChange(width === 800 ? 400 : 800)}
          startIcon={<Maximize2 size={14} />}
        />
        <Button
          size="sm"
          variant="ghost"
          aria-label="Close record"
          onClick={onClose}
          startIcon={<X size={16} />}
        />
      </div>
      <Tabs.Root
        value={tab}
        onValueChange={(value) =>
          setTab(value === "history" ? "history" : "home")
        }
      >
        <Tabs.List className="bo-detail-tabs">
          <Tabs.Tab value="home" size="sm" startIcon={<Home size={14} />}>
            {t("back_office.history.home")}
          </Tabs.Tab>
          <Tabs.Tab
            value="history"
            size="sm"
            disabled={record.revision === 0 || !!onReviewLocal}
            startIcon={<History size={14} />}
          >
            {t("back_office.history.tab")}
          </Tabs.Tab>
          <Tabs.Indicator />
        </Tabs.List>
      </Tabs.Root>
      {tab === "history" ? (
        <HistoryPanel
          client={client}
          team={team}
          target={{ type: "record", id: record.id }}
          revision={record.revision}
          accessKey={historyAccessKey}
          records={records}
          userId={userId}
          onOpen={onOpen}
        />
      ) : (
        <>
          <div className="bo-detail-fields">
            {record.revision === 0 && (
              <p className="bo-muted">
                {t("back_office.create.draft_hint")}
              </p>
            )}
            <div className="bo-property bo-system-property">
              <label>
                <CalendarDays size={13} />
                Creation date
              </label>
              <span>{date(record.createdAt)}</span>
            </div>
            <div className="bo-property bo-system-property">
              <label>
                <CalendarDays size={13} />
                Last update
              </label>
              <span>{date(record.updatedAt)}</span>
            </div>
            {object.fields
              .filter(
                (field) =>
                  field.id !== "name" &&
                  (field.visibility !== "finance" || finance),
              )
              .map((field) => {
                const canEdit = editable && !(onReviewLocal && field.type === "file") && (field.visibility !== "private" || record.ownerId === userId);
                return <div className="bo-property" key={field.id}>
                  <label>
                    <FieldIcon field={field} />
                    {field.label}{record.revision === 0 && field.required ? " *" : ""}
                    {field.visibility === "private" && (
                      <LockKeyhole size={11} />
                    )}
                  </label>
                  <div className="bo-property-value">
                    <Popover.Root
                      open={canEdit && edit?.field === field.id}
                      onOpenChange={(open) => setEdit(open ? { field: field.id, base: record } : null)}
                    >
                      <Popover.Trigger
                        render={
                          <Button
                            size="sm"
                            variant="ghost"
                            fullWidth
                            disabled={!canEdit}
                            aria-label={`Edit ${field.label}`}
                          />
                        }
                      >
                        <ValueDisplay
                          field={field}
                          value={record.values[field.id]}
                          records={records}
                          onOpen={onOpen}
                        />
                        {(record.values[field.id] === null ||
                          record.values[field.id] === undefined ||
                          record.values[field.id] === "") && (
                          <span className="bo-muted">{field.label}</span>
                        )}
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Positioner align="start" sideOffset={-28}>
                          <DirectoryEditorPopup
                            className="bo-editor-popup"
                            style={{
                              width:
                                field.type === "date"
                                  ? "max-content"
                                  : field.type === "select"
                                    ? 200
                                    : 260,
                            }}
                          >
                            {edit?.field === field.id && <CellEditor
                              record={edit.base}
                              field={field}
                              value={field.multiple || field.type === "multiselect" ? record.values[field.id] : edit.base.values[field.id]}
                              records={records}
                              onCancel={() => setEdit(null)}
                              onSave={(value, previous) => onSave(previous ? { ...record, values: { ...record.values, [field.id]: previous } } : edit.base, { [field.id]: value })}
                            />}
                          </DirectoryEditorPopup>
                        </Popover.Positioner>
                      </Popover.Portal>
                    </Popover.Root>
                  </div>
                </div>
              })}
          </div>
          {error && (
            <p className="bo-error" role="alert">
              {error}
            </p>
          )}
          <div className="bo-detail-bottom">
            <span className="bo-muted">
              {record.archivedAt ? "Archived" : object.label}
            </span>
            <DirectoryMenu
              trigger={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Record options"
                  startIcon={<MoreVertical size={14} />}
                />
              }
            >
              <Dropdown.ActionItem
                disabled={!editable || record.revision === 0}
                startIcon={
                  record.archivedAt ? (
                    <RotateCcw size={14} />
                  ) : (
                    <Archive size={14} />
                  )
                }
                onClick={() =>
                  void onSave(record, {}, !record.archivedAt).catch((error) =>
                    setError(error.message),
                  )
                }
              >
                {record.archivedAt ? "Restore record" : "Archive record"}
              </Dropdown.ActionItem>
            </DirectoryMenu>
          </div>
        </>
      )}
    </aside>
  );
}
