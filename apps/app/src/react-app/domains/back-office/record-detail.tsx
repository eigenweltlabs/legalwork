import { useEffect, useRef, useState } from "react";
import {
  Archive,
  CalendarDays,
  Home,
  Link2,
  LockKeyhole,
  Maximize2,
  MoreVertical,
  Plus,
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
import { DirectoryMenu, DirectorySelect } from "./twenty-controls";

export function RecordDetail({
  record,
  object,
  records,
  editable,
  finance,
  userId,
  projects,
  focusName,
  width,
  onWidthChange,
  onClose,
  onSave,
  onOpen,
  onLink,
  onUnlink,
}: {
  record: BackOfficeRecord;
  object: BackOfficeObject;
  records: BackOfficeRecord[];
  editable: boolean;
  finance: boolean;
  userId: string;
  projects: { id: string; name: string }[];
  focusName?: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onOpen: (record: BackOfficeRecord) => void;
  onSave: (
    record: BackOfficeRecord,
    values: Record<string, BackOfficeValue>,
    archived?: boolean,
  ) => Promise<void>;
  onLink: (projectId: string, matter: BackOfficeRecord) => Promise<void>;
  onUnlink: (link: BackOfficeRecord) => Promise<void>;
}) {
  const [edit, setEdit] = useState<string | null>(null),
    [project, setProject] = useState(""),
    [error, setError] = useState("");
  const cancelName = useRef(false);
  const [name, setName] = useState(String(record.values.name));
  useEffect(() => setName(String(record.values.name)), [record.values.name]);
  const links = records.filter(
    (item) =>
      item.objectId === "projectLinks" &&
      item.values.matter === record.id &&
      !item.archivedAt,
  );
  const saveName = () => {
    if (name.trim() && name.trim() !== record.values.name)
      void onSave(record, { name: name.trim() }).catch((error) =>
        setError(error.message),
      );
    else if (!name.trim()) setName(String(record.values.name));
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
          autoFocus={focusName}
          disabled={!editable}
          value={name}
          onFocus={(event) => {
            if (focusName && name === "Untitled") event.target.select();
          }}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (cancelName.current) {
              cancelName.current = false;
              return;
            }
            saveName();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              cancelName.current = true;
              setName(String(record.values.name));
              event.currentTarget.blur();
            }
          }}
        />
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
      <Tabs.Root value="home">
        <Tabs.List className="bo-detail-tabs">
          <Tabs.Tab value="home" size="sm" startIcon={<Home size={14} />}>
            Home
          </Tabs.Tab>
          <Tabs.Indicator />
        </Tabs.List>
      </Tabs.Root>
      <div className="bo-detail-fields">
        {record.revision === 0 && (
          <p className="bo-muted">
            Complete required fields to save this record.
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
          .map((field) => (
            <div className="bo-property" key={field.id}>
              <label>
                <FieldIcon field={field} />
                {field.label}
                {field.visibility === "private" && <LockKeyhole size={11} />}
              </label>
              <div className="bo-property-value">
                <Popover.Root
                  open={edit === field.id}
                  onOpenChange={(open) => setEdit(open ? field.id : null)}
                >
                  <Popover.Trigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        fullWidth
                        disabled={
                          !editable ||
                          (field.visibility === "private" &&
                            record.ownerId !== userId)
                        }
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
                      <Popover.Popup
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
                        <CellEditor
                          key={record.id + field.id + record.revision}
                          field={field}
                          value={record.values[field.id]}
                          records={records}
                          onCancel={() => setEdit(null)}
                          onSave={(value) =>
                            onSave(record, { [field.id]: value })
                          }
                        />
                      </Popover.Popup>
                    </Popover.Positioner>
                  </Popover.Portal>
                </Popover.Root>
              </div>
            </div>
          ))}
      </div>
      {object.id === "matters" && (
        <>
          <div className="bo-detail-section">
            <Link2 size={14} />
            Projects · {links.length}
          </div>
          <div className="bo-detail-links">
            {links.map((link) => (
              <div key={link.id}>
                <span>
                  {projects.find(
                    (project) => project.id === link.values.projectId,
                  )?.name ?? String(link.values.name)}
                </span>
                {editable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Unlink ${link.values.name}`}
                    onClick={() =>
                      void onUnlink(link).catch((error) =>
                        setError(error.message),
                      )
                    }
                    startIcon={<X size={13} />}
                  />
                )}
              </div>
            ))}
            {editable && record.revision > 0 && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (project)
                    void onLink(project, record)
                      .then(() => setProject(""))
                      .catch((error) => setError(error.message));
                }}
              >
                <DirectorySelect
                  label="Project to link"
                  value={project}
                  onChange={setProject}
                  options={[
                    { value: "", label: "Choose a project…" },
                    ...projects
                      .filter(
                        (project) =>
                          !links.some(
                            (link) => link.values.projectId === project.id,
                          ),
                      )
                      .map((project) => ({
                        value: project.id,
                        label: project.name,
                      })),
                  ]}
                />
                <Button
                  size="sm"
                  disabled={!project}
                  type="submit"
                  startIcon={<Plus size={13} />}
                >
                  Link
                </Button>
              </form>
            )}
          </div>
        </>
      )}
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
            disabled={!editable}
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
    </aside>
  );
}
