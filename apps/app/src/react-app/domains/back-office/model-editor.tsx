import { displayBackOfficeObject } from "./labels";
import { useState } from "react";
import {
  ArrowUpRight,
  ArrowLeft,
  BriefcaseBusiness,
  Building2,
  ChevronRight,
  Database,
  Link2,
  LockKeyhole,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  UserRound,
  UsersRound,
} from "lucide-react";
import { Button, Checkbox, Input } from "twenty-ui/primitives/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { Breadcrumb, ListItem, Tabs } from "twenty-ui/primitives/navigation";
import {
  BackOfficeFieldSchema,
  isInternalBackOfficeObject,
  BackOfficeObjectSchema,
  type BackOfficeModel,
  type BackOfficeField,
} from "@legalwork/types/back-office";
import type { ModelPreview } from "./api";
import { FieldIcon } from "./record-values";
import { DirectoryDialog, DirectorySelect } from "./twenty-controls";

const fieldTypeOrder: BackOfficeField["type"][] = [
  "text",
  "number",
  "boolean",
  "datetime",
  "date",
  "select",
  "multiselect",
  "currency",
  "email",
  "relation",
];
const objectIcons = {
  matters: BriefcaseBusiness,
  clients: UsersRound,
  people: UserRound,
  companies: Building2,
};
function ObjectIcon({ id }: { id: string }) {
  const Icon =
    id === "matters"
      ? objectIcons.matters
      : id === "clients"
        ? objectIcons.clients
        : id === "people"
          ? objectIcons.people
          : id === "companies"
            ? objectIcons.companies
            : Database;
  return <Icon size={15} />;
}
export function ModelEditor({
  model,
  editable,
  onSave,
  onPreview,
  onRecords,
}: {
  model: BackOfficeModel;
  editable: boolean;
  onSave: (model: BackOfficeModel) => Promise<void>;
  onRecords: (id: string) => void;
  onPreview: (model: BackOfficeModel) => Promise<ModelPreview>;
}) {
  const [objectId, setObjectId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("fields");
  const [showArchived, setShowArchived] = useState(false);
  const [selectingType, setSelectingType] = useState(false);
  const [typeQuery, setTypeQuery] = useState("");
  const [adding, setAdding] = useState<"object" | "field" | null>(null);
  const [editing, setEditing] = useState<BackOfficeField | null>(null);
  const [label, setLabel] = useState("");
  const [plural, setPlural] = useState("");
  const [fieldType, setFieldType] = useState<BackOfficeField["type"]>("text");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [visibility, setVisibility] =
    useState<BackOfficeField["visibility"]>("normal");
  const [required, setRequired] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState<{
    model: BackOfficeModel;
    preview: ModelPreview;
  } | null>(null);
  const object = model.objects.find((object) => object.id === objectId);
  const commit = async (next: BackOfficeModel) => {
    setSaving(true);
    setError("");
    try {
      await onSave(next);
      setAdding(null);
      setEditing(null);
      setReview(null);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not save the model.",
      );
    } finally {
      setSaving(false);
    }
  };
  const apply = async (next: BackOfficeModel) => {
    setError("");
    try {
      const preview = await onPreview(next);
      if (!preview.valid) {
        setError(preview.errors.join(" "));
        return;
      }
      if (preview.changes.some((change) => change.records > 0)) {
        setAdding(null);
        setReview({ model: next, preview });
      } else await commit(next);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not review the change.",
      );
    }
  };
  const add = (kind: "object" | "field", relation = false) => {
    setAdding(kind);
    setSelectingType(kind === "field" && !relation);
    setTypeQuery("");
    setEditing(null);
    setLabel("");
    setPlural("");
    setOptions("");
    setTarget("");
    setFieldType(relation ? "relation" : "text");
    setMultiple(false);
    setVisibility("normal");
    setRequired(false);
    setError("");
  };
  const editField = (field: BackOfficeField) => {
    setAdding("field");
    setSelectingType(false);
    setEditing(field);
    setLabel(field.label);
    setFieldType(field.type);
    setOptions(field.options.join(", "));
    setTarget(field.target ?? "");
    setMultiple(field.multiple);
    setVisibility(field.visibility);
    setRequired(field.required);
    setError("");
  };
  const openObject = (id: string) => {
    setObjectId(id);
    setQuery("");
    setTab("fields");
    setError("");
  };
  const rows = object?.fields.filter((field) =>
    field.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="bo-model">
      <header className="bo-model-header">
        <Breadcrumb
          links={[
            { children: "Workspace" },
            {
              children: "Objects",
              onClick: () => {
                setObjectId(null);
                setQuery("");
              },
            },
            ...(object
              ? [{ children: displayBackOfficeObject(object).plural }]
              : []),
          ]}
        />
        <h2>
          <ObjectIcon id={object?.id ?? ""} />
          {object?.plural ?? "Data model"}
        </h2>
        <div>
          {object && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRecords(object.id)}
              startIcon={<ArrowUpRight size={13} />}
            >
              See records
            </Button>
          )}
          <Button
            size="sm"
            variant="solid"
            color="accent"
            disabled={!editable}
            onClick={() => add(object ? "field" : "object")}
            startIcon={<Plus size={14} />}
          >
            {object ? "New field" : "Add object"}
          </Button>
        </div>
      </header>
      {object && (
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setTab(value);
              setLabel(object.label);
              setPlural(
                object.plural === "Clients · Mandanten"
                  ? displayBackOfficeObject(object).plural
                  : object.plural,
              );
            }
          }}
        >
          <Tabs.List className="bo-schema-tabs">
            <Tabs.Tab
              value="fields"
              size="sm"
              startIcon={<SlidersHorizontal size={14} />}
            >
              Fields
            </Tabs.Tab>
            <Tabs.Tab
              value="settings"
              size="sm"
              startIcon={<Settings2 size={14} />}
            >
              Settings
            </Tabs.Tab>
            <Tabs.Indicator />
          </Tabs.List>
        </Tabs.Root>
      )}
      <div className="bo-model-content">
        {object && tab === "settings" ? (
          <form
            className="bo-form"
            onSubmit={(event) => {
              event.preventDefault();
              void apply({
                ...model,
                objects: model.objects.map((item) =>
                  item.id === object.id ? { ...item, label, plural } : item,
                ),
              });
            }}
          >
            <h3>Object settings</h3>
            <label>
              Name
              <Input
                required
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                disabled={!editable}
              />
            </label>
            <label>
              Plural name
              <Input
                required
                value={plural}
                onChange={(event) => setPlural(event.target.value)}
                disabled={!editable}
              />
            </label>
            <p className="bo-model-notice">
              <LockKeyhole size={13} />
              {object.protected
                ? "This object is part of LegalWork’s protected core model."
                : "Archiving hides this object while keeping its records."}
            </p>
            <div className="bo-modal-footer">
              {!object.protected && (
                <Button
                  size="sm"
                  type="button"
                  color="danger"
                  disabled={!editable || saving}
                  onClick={() => {
                    void apply({
                      ...model,
                      objects: model.objects.map((item) =>
                        item.id === object.id
                          ? { ...item, archived: !item.archived }
                          : item,
                      ),
                    }).then(() => setObjectId(null));
                  }}
                >
                  {object.archived ? "Restore object" : "Archive object"}
                </Button>
              )}
              <Button
                size="sm"
                type="submit"
                variant="solid"
                color="accent"
                disabled={!editable || saving}
              >
                Save
              </Button>
            </div>
          </form>
        ) : object ? (
          <>
            <h3>Relations</h3>
            <p className="bo-muted">
              Relations between this object and other objects.
            </p>
            <label className="bo-model-search">
              <Search size={14} />
              <Input
                variant="plain"
                size="sm"
                placeholder="Search a field…"
                aria-label="Search a field"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="bo-schema-heading">
              <span>Name</span>
              <span>Type</span>
              <span />
            </div>
            <div className="bo-field-list">
              {rows
                ?.filter((field) => field.type === "relation")
                .map((field) => (
                  <ListItem
                    key={field.id}
                    render={<button />}
                    startIcon={<Link2 size={14} />}
                    onClick={() => editField(field)}
                    actionsVisibility="always"
                    actions={
                      <>
                        <span className="bo-schema-type">
                          {field.multiple ? "Many records" : "One record"}
                        </span>
                        {field.protected && <LockKeyhole size={12} />}
                        <ChevronRight size={14} />
                      </>
                    }
                  >
                    <span>
                      {
                        model.objects.find(
                          (object) => object.id === field.target,
                        )?.plural
                      }
                      <span className="bo-muted"> · {field.label}</span>
                    </span>
                  </ListItem>
                ))}
            </div>
            {editable && (
              <div className="bo-schema-add">
                <Button
                  size="sm"
                  startIcon={<Plus size={13} />}
                  onClick={() => add("field", true)}
                >
                  Add relation
                </Button>
              </div>
            )}
            <h3>Fields</h3>
            <p className="bo-muted">
              Customize properties in {object.label.toLocaleLowerCase()} views
              and record details.
            </p>
            <div className="bo-schema-heading">
              <span>Name</span>
              <span>Data type</span>
              <span />
            </div>
            <div className="bo-field-list">
              {rows
                ?.filter((field) => field.type !== "relation")
                .map((field) => (
                  <ListItem
                    key={field.id}
                    render={<button />}
                    startIcon={<FieldIcon field={field} />}
                    onClick={() => editField(field)}
                    actionsVisibility="always"
                    actions={
                      <>
                        <span className="bo-schema-type">{field.type}</span>
                        {field.protected && <LockKeyhole size={12} />}
                        <ChevronRight size={14} />
                      </>
                    }
                  >
                    {field.label}
                  </ListItem>
                ))}
            </div>
          </>
        ) : (
          <>
            <h3>Objects</h3>
            <p className="bo-muted">
              Manage your firm’s objects, fields and relationships.
            </p>
            <label className="bo-model-search">
              <Search size={14} />
              <Input
                variant="plain"
                size="sm"
                placeholder="Search for an object…"
                aria-label="Search for an object"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="bo-schema-heading">
              <span>Name</span>
              <span>Fields</span>
              <span />
            </div>
            <div className="bo-field-list">
              {model.objects
                .filter(
                  (object) =>
                    !isInternalBackOfficeObject(object.id) &&
                    object.archived === showArchived &&
                    displayBackOfficeObject(object)
                      .plural.toLocaleLowerCase()
                      .includes(query.toLocaleLowerCase()),
                )
                .map((object) => (
                  <ListItem
                    key={object.id}
                    render={<button />}
                    startIcon={<ObjectIcon id={object.id} />}
                    onClick={() => openObject(object.id)}
                    actionsVisibility="always"
                    actions={
                      <>
                        <span className="bo-schema-type">
                          {object.fields.length} fields
                        </span>
                        {object.protected && <LockKeyhole size={12} />}
                        <ChevronRight size={14} />
                      </>
                    }
                  >
                    {displayBackOfficeObject(object).plural}
                  </ListItem>
                ))}
            </div>
            <div className="bo-schema-add">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowArchived(!showArchived)}
              >
                {showArchived ? "Show active objects" : "Show archived objects"}
              </Button>
              <Tag color="gray">Template {model.templateVersion}</Tag>
            </div>
          </>
        )}
        {error && !adding && (
          <p className="bo-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {adding && (
        <div
          className="bo-field-page"
          aria-label={
            adding === "object"
              ? "New object"
              : editing
                ? "Edit field"
                : "New field"
          }
        >
          <header className="bo-model-header">
            <Breadcrumb
              links={[
                { children: "Workspace" },
                {
                  children: "Objects",
                  onClick: () => {
                    setAdding(null);
                    setObjectId(null);
                  },
                },
                ...(object
                  ? [
                      {
                        children: displayBackOfficeObject(object).plural,
                        onClick: () => setAdding(null),
                      },
                    ]
                  : []),
                {
                  children:
                    adding === "object"
                      ? "New object"
                      : editing
                        ? "Edit field"
                        : "New field",
                },
              ]}
            />
            <h2>
              <ObjectIcon id={object?.id ?? ""} />
              {object?.plural ?? "Data model"}
            </h2>
          </header>
          <div className="bo-field-step">
            <Button
              size="sm"
              variant="ghost"
              aria-label="Previous"
              startIcon={<ArrowLeft size={14} />}
              onClick={() => {
                if (adding === "field" && !editing && !selectingType)
                  setSelectingType(true);
                else setAdding(null);
              }}
            />
            <strong>
              {adding === "object"
                ? "Configure object"
                : selectingType
                  ? "1. Select a field type"
                  : editing
                    ? "Edit field"
                    : "2. Configure field"}
            </strong>
            {!selectingType && (
              <Button
                size="sm"
                variant="solid"
                color="accent"
                type="submit"
                form="bo-field-form"
                disabled={!label.trim() || saving || !editable}
              >
                Save
              </Button>
            )}
          </div>
          {selectingType ? (
            <div className="bo-model-content bo-type-selection">
              <label className="bo-model-search">
                <Search size={14} />
                <Input
                  variant="plain"
                  size="sm"
                  placeholder="Search a type"
                  value={typeQuery}
                  onChange={(event) => setTypeQuery(event.target.value)}
                />
              </label>
              <h3>Basic</h3>
              <p className="bo-muted">
                All the basic field types you need to start
              </p>
              <div className="bo-type-grid">
                {fieldTypeOrder
                  .filter(
                    (type) =>
                      type !== "relation" &&
                      type.toLowerCase().includes(typeQuery.toLowerCase()),
                  )
                  .map((type) => (
                    <ListItem
                      key={type}
                      render={<button />}
                      startIcon={
                        <FieldIcon
                          field={BackOfficeFieldSchema.parse({
                            id: "preview",
                            label: type,
                            type,
                          })}
                        />
                      }
                      endIcon={<ChevronRight size={13} />}
                      onClick={() => {
                        setFieldType(type);
                        setSelectingType(false);
                      }}
                    >
                      {
                        {
                          text: "Text",
                          number: "Number",
                          boolean: "True/False",
                          datetime: "Date and Time",
                          date: "Date",
                          select: "Select",
                          multiselect: "Multi-select",
                          currency: "Currency",
                          email: "Email",
                          relation: "Relation",
                        }[type]
                      }
                    </ListItem>
                  ))}
              </div>
              <h3>Relation</h3>
              <p className="bo-muted">Create a relation with other objects</p>
              <div className="bo-type-grid">
                <ListItem
                  render={<button />}
                  startIcon={<Link2 size={16} />}
                  endIcon={<ChevronRight size={13} />}
                  onClick={() => {
                    setFieldType("relation");
                    setSelectingType(false);
                  }}
                >
                  Relation
                </ListItem>
              </div>
            </div>
          ) : (
            <form
              id="bo-field-form"
              className="bo-model-content bo-form"
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  if (adding === "object") {
                    const id =
                      "custom_" + crypto.randomUUID().replaceAll("-", "");
                    const created = BackOfficeObjectSchema.parse({
                      id,
                      label,
                      plural,
                      fields: [
                        BackOfficeFieldSchema.parse({
                          id: "name",
                          label: "Name",
                          type: "text",
                          protected: true,
                          required: true,
                        }),
                      ],
                    });
                    void apply({
                      ...model,
                      objects: [...model.objects, created],
                    });
                    return;
                  }
                  if (!object) return;
                  const nextField = BackOfficeFieldSchema.parse({
                    ...editing,
                    id:
                      editing?.id ??
                      "custom_" + crypto.randomUUID().replaceAll("-", ""),
                    label,
                    type: fieldType,
                    target: fieldType === "relation" ? target : undefined,
                    multiple,
                    visibility,
                    required,
                    options: options
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  });
                  void apply({
                    ...model,
                    objects: model.objects.map((item) =>
                      item.id === object.id
                        ? {
                            ...item,
                            fields: editing
                              ? item.fields.map((field) =>
                                  field.id === editing.id ? nextField : field,
                                )
                              : [...item.fields, nextField],
                          }
                        : item,
                    ),
                  });
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Check this field.",
                  );
                }
              }}
            >
              <div>
                <h3>Icon and Name</h3>
                <p className="bo-muted">
                  The name of this {adding === "object" ? "object" : "field"}
                </p>
              </div>
              <label>
                Name
                <Input
                  required
                  autoFocus
                  value={label}
                  aria-label="Field name"
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={!editable}
                />
              </label>
              {adding === "object" ? (
                <label>
                  Plural name
                  <Input
                    value={plural}
                    onChange={(event) => setPlural(event.target.value)}
                    required
                    aria-label="Plural name"
                  />
                </label>
              ) : (
                <>
                  <label>
                    Field type
                    <DirectorySelect
                      label="Field type"
                      value={fieldType}
                      disabled={editing?.protected || !editable}
                      onChange={(value) => {
                        const parsed =
                          BackOfficeFieldSchema.shape.type.safeParse(value);
                        if (parsed.success) setFieldType(parsed.data);
                      }}
                      options={BackOfficeFieldSchema.shape.type.options.map(
                        (type) => ({ value: type, label: type }),
                      )}
                    />
                  </label>
                  {(fieldType === "select" || fieldType === "multiselect") && (
                    <label>
                      Options, separated by commas
                      <Input
                        value={options}
                        onChange={(event) => setOptions(event.target.value)}
                        disabled={!editable}
                      />
                    </label>
                  )}
                  {fieldType === "relation" && (
                    <>
                      <label>
                        Related object
                        <DirectorySelect
                          required
                          label="Related object"
                          value={target}
                          disabled={editing?.protected || !editable}
                          onChange={setTarget}
                          options={[
                            { value: "", label: "Choose an object" },
                            ...model.objects
                              .filter(
                                (object) =>
                                  !object.archived &&
                                  !isInternalBackOfficeObject(object.id),
                              )
                              .map((object) => ({
                                value: object.id,
                                label: displayBackOfficeObject(object).plural,
                              })),
                          ]}
                        />
                      </label>
                      <label className="bo-checkbox-label">
                        <Checkbox
                          size="sm"
                          checked={multiple}
                          disabled={editing?.protected || !editable}
                          onCheckedChange={setMultiple}
                        />
                        Allow several records
                      </label>
                    </>
                  )}
                  <label>
                    Visibility
                    <DirectorySelect
                      label="Field visibility"
                      value={visibility}
                      disabled={editing?.protected || !editable}
                      onChange={(value) => {
                        const parsed =
                          BackOfficeFieldSchema.shape.visibility.safeParse(
                            value,
                          );
                        if (parsed.success) setVisibility(parsed.data);
                      }}
                      options={[
                        { value: "normal", label: "Directory members" },
                        { value: "private", label: "Record owner only" },
                        { value: "finance", label: "Billing members only" },
                      ]}
                    />
                  </label>
                  <label className="bo-checkbox-label">
                    <Checkbox
                      size="sm"
                      checked={required}
                      disabled={editing?.protected || !editable}
                      onCheckedChange={setRequired}
                    />
                    Required field
                  </label>
                </>
              )}
              {editing?.protected && (
                <p className="bo-model-notice">
                  <LockKeyhole size={13} />
                  This field is part of the protected core model.
                </p>
              )}
              {error && (
                <p className="bo-error" role="alert">
                  {error}
                </p>
              )}
              <div className="bo-modal-footer">
                {editing && !editing.protected && object && (
                  <Button
                    type="button"
                    size="sm"
                    color="danger"
                    variant="ghost"
                    disabled={!editable || saving}
                    startIcon={<Trash2 size={13} />}
                    onClick={() =>
                      void apply({
                        ...model,
                        objects: model.objects.map((item) =>
                          item.id === object.id
                            ? {
                                ...item,
                                fields: item.fields.filter(
                                  (field) => field.id !== editing.id,
                                ),
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    Remove field
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>
      )}
      {review && (
        <DirectoryDialog
          title="Review model change"
          onClose={() => setReview(null)}
        >
          <div className="bo-form">
            <p>
              Existing records keep their IDs and values. Review the affected
              objects before applying this change.
            </p>
            {review.preview.changes.map((change) => (
              <div key={change.object}>
                <strong>{change.object}</strong>
                <p className="bo-muted">
                  {change.action} · {change.records} existing records
                </p>
              </div>
            ))}
            {error && (
              <p className="bo-error" role="alert">
                {error}
              </p>
            )}
            <div className="bo-modal-footer">
              <Button size="sm" onClick={() => setReview(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="solid"
                color="accent"
                disabled={saving}
                onClick={() => void commit(review.model)}
              >
                Apply change
              </Button>
            </div>
          </div>
        </DirectoryDialog>
      )}
    </div>
  );
}
