import { nativeKind,nativeModel } from "./native-model";
import { displayBackOfficeObject, displayBackOfficeField, backOfficeFieldTypeLabel } from "./labels";
import { useState } from "react";
import {
  ArrowUpRight,
  ArrowLeft,
  ChevronRight,
  Link2,
  LockKeyhole,
  Plus,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { Button, Checkbox, Input } from "twenty-ui/primitives/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { Breadcrumb, ListItem, Tabs } from "twenty-ui/primitives/navigation";
import {
  BackOfficeFieldSchema,
  isInternalBackOfficeObject,
  isOrderedListField,
  BackOfficeObjectSchema,
  type BackOfficeModel,
  type BackOfficeObject,
  type BackOfficeField,
} from "@legalwork/types/back-office";
import type { ModelPreview } from "./api";
import { FieldIcon } from "./record-values";
import { ObjectIcon } from "./object-icon";
import { DirectoryDialog, DirectorySelect } from "./twenty-controls";
import { quickCreateFieldIds } from "./record-creation-values";
import { t } from "@/i18n";

const basicFieldTypes: BackOfficeField["type"][] = [
  "text",
  "number",
  "boolean",
  "datetime",
  "date",
  "select",
  "multiselect",
  "textList",
  "linkList",
  "currency",
  "email",
  "file",
];

export function ModelEditor({
  model,
  editable: canEditModel,
  orderedListFields,
  onSave,
  onPreview,
  onRecords,
}: {
  model: BackOfficeModel;
  editable: boolean;
  orderedListFields: boolean;
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
  const [quickFields, setQuickFields] = useState<string[]>([]);
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
  const supported = (type: BackOfficeField["type"]) => orderedListFields || !isOrderedListField(type);
  const shownObjects = [...model.objects,nativeModel("task"),nativeModel("deadline")];
  const object = shownObjects.find(o => o.id === objectId);
  const displayedObject = object && displayBackOfficeObject(object);
  const editable = canEditModel && !nativeKind(objectId ?? "");
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
        error instanceof Error ? error.message : t("back_office.model_failed"),
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
        error instanceof Error ? error.message : t("back_office.review_failed"),
      );
    }
  };
  const applyObject = (updated: BackOfficeObject) => apply({
    ...model,
    objects: model.objects.map(item => item.id === updated.id ? updated : item),
  });
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
    setLabel(object ? displayBackOfficeField(field, object.id).label : field.label);
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
    displayBackOfficeField(field, object.id).label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const editorTitle = adding === "object" ? t("back_office.new_object") : editing ? t("back_office.edit_field") : t("back_office.new_field");
  const changeLabel = (action: string) => {
    const labels: Record<string, string> = {
      "Add object": t("back_office.add_object"),
      "Archive object": t("back_office.archive_object"),
      "Restore object": t("back_office.restore_object"),
      "Update fields or labels": t("back_office.update_fields"),
    };
    return labels[action] ?? action;
  };
  return (
    <div className="bo-model">
      <header className="bo-model-header">
        <Breadcrumb
          links={[
            { children: t("workspace.workbench") },
            {
              children: t("back_office.objects"),
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
          {displayedObject?.plural ?? t("back_office.data_model")}
        </h2>
        <div>
          {object && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onRecords(object.id)}
              startIcon={<ArrowUpRight size={13} />}
            >
              {t("back_office.see_records")}
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
            {object ? t("back_office.new_field") : t("back_office.add_object")}
          </Button>
        </div>
      </header>
      {object && (
        <Tabs.Root
          value={tab}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setTab(value);
              setLabel(displayBackOfficeObject(object).label);
              setQuickFields(quickCreateFieldIds(object));
              setPlural(displayBackOfficeObject(object).plural);
            }
          }}
        >
          <Tabs.List className="bo-schema-tabs">
            <Tabs.Tab
              value="fields"
              size="sm"
              startIcon={<SlidersHorizontal size={14} />}
            >
              {t("back_office.fields")}
            </Tabs.Tab>
            <Tabs.Tab
              value="settings"
              size="sm"
              startIcon={<Settings2 size={14} />}
            >
              {t("settings.tab_general")}
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
              void applyObject({ ...object,
                label: label === displayedObject?.label ? object.label : label,
                plural: plural === displayedObject?.plural ? object.plural : plural,
                quickCreateFields: quickFields,
              });
            }}
          >
            <h3>{t("back_office.object_settings")}</h3>
            <label>
              {t("plugin_create.name")}
              <Input
                required
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                disabled={!editable}
              />
            </label>
            <label>
              {t("back_office.plural_name")}
              <Input
                required
                value={plural}
                onChange={(event) => setPlural(event.target.value)}
                disabled={!editable}
              />
            </label>
            <fieldset className="space-y-2">
              <legend>{t("back_office.create.quick_fields")}</legend>
              <p className="bo-muted">{t("back_office.create.quick_fields_hint")}</p>
              {object.fields.map(field => <label key={field.id} className="flex items-center gap-2">
                <Checkbox checked={field.required || quickFields.includes(field.id)} disabled={!editable || saving || field.required}
                  onCheckedChange={checked => setQuickFields(current => checked ? [...current.filter(id => id !== field.id), field.id] : current.filter(id => id !== field.id))} />
                <FieldIcon field={field} />{displayBackOfficeField(field, object.id).label}{field.required ? " *" : ""}
              </label>)}
            </fieldset>
            <p className="bo-model-notice">
              <LockKeyhole size={13} />
              {object.protected
                ? t("back_office.protected_object")
                : t("back_office.archive_object_hint")}
            </p>
            <div className="bo-modal-footer">
              {!object.protected && (
                <Button
                  size="sm"
                  type="button"
                  color="danger"
                  disabled={!editable || saving}
                  onClick={() => {
                    void applyObject({ ...object, archived: !object.archived }).then(() => setObjectId(null));
                  }}
                >
                  {object.archived ? t("back_office.restore_object") : t("back_office.archive_object")}
                </Button>
              )}
              <Button
                size="sm"
                type="submit"
                variant="solid"
                color="accent"
                disabled={!editable || saving}
              >
                {t("scheduled.save")}
              </Button>
            </div>
          </form>
        ) : object ? (
          <>
            <h3>{t("back_office.relations")}</h3>
            <p className="bo-muted">
              {t("back_office.relations_hint")}
            </p>
            <label className="bo-model-search">
              <Search size={14} />
              <Input
                variant="plain"
                size="sm"
                placeholder={t("back_office.search_field")}
                aria-label={t("back_office.search_field_label")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="bo-schema-heading">
              <span>{t("plugin_create.name")}</span>
              <span>{t("mcp.server_type")}</span>
              <span />
            </div>
            <div className="bo-field-list">
              {rows
                ?.filter((field) => field.type === "relation")
                .map((field) => (
                  <ListItem
                    key={field.id}
                    render={<button />}
                    startIcon={<FieldIcon field={field} />}
                    onClick={() => editField(field)}
                    actionsVisibility="always"
                    actions={
                      <>
                        <span className="bo-schema-type">
                          {field.multiple ? t("back_office.many_records") : t("back_office.one_record")}
                        </span>
                        {field.protected && <LockKeyhole size={12} />}
                        <ChevronRight size={14} />
                      </>
                    }
                  >
                    <span>
                      {
                        field.target === "@directory" ? t("native.all_models") : field.target === "@member" ? t("tasks.column_assignee") :
                          model.objects.map(displayBackOfficeObject).find(candidate => candidate.id === field.target)?.plural
                      }
                      <span className="bo-muted"> · {displayBackOfficeField(field, object.id).label}</span>
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
                  {t("back_office.add_relation")}
                </Button>
              </div>
            )}
            <h3>{t("back_office.fields")}</h3>
            <p className="bo-muted">
              {t("back_office.customize_hint", { name: displayedObject?.plural ?? "" })}
            </p>
            <div className="bo-schema-heading">
              <span>{t("plugin_create.name")}</span>
              <span>{t("back_office.data_type")}</span>
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
                        <span className="bo-schema-type">{backOfficeFieldTypeLabel(field.type)}</span>
                        {field.protected && <LockKeyhole size={12} />}
                        <ChevronRight size={14} />
                      </>
                    }
                  >
                    {displayBackOfficeField(field, object.id).label}
                  </ListItem>
                ))}
            </div>
          </>
        ) : (
          <>
            <h3>{t("back_office.objects")}</h3>
            <p className="bo-muted">
              {t("back_office.objects_hint")}
            </p>
            <label className="bo-model-search">
              <Search size={14} />
              <Input
                variant="plain"
                size="sm"
                placeholder={t("back_office.search_object")}
                aria-label={t("back_office.search_object_label")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <div className="bo-schema-heading">
              <span>{t("plugin_create.name")}</span>
              <span>{t("back_office.fields")}</span>
              <span />
            </div>
            <div className="bo-field-list">
              {shownObjects
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
                          {t("back_office.fields_count", { count: object.fields.length })}
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
                {showArchived ? t("back_office.show_active_objects") : t("back_office.show_archived_objects")}
              </Button>
              <Tag color="gray">{t("back_office.template_version", { version: model.templateVersion })}</Tag>
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
          aria-label={editorTitle}
        >
          <header className="bo-model-header">
            <Breadcrumb
              links={[
                { children: t("workspace.workbench") },
                {
                  children: t("back_office.objects"),
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
                  children: editorTitle,
                },
              ]}
            />
            <h2>
              <ObjectIcon id={object?.id ?? ""} />
              {displayedObject?.plural ?? t("back_office.data_model")}
            </h2>
          </header>
          <div className="bo-field-step">
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("jev_search.previous")}
              startIcon={<ArrowLeft size={14} />}
              onClick={() => {
                if (adding === "field" && !editing && !selectingType)
                  setSelectingType(true);
                else setAdding(null);
              }}
            />
            <strong>
              {adding === "object"
                ? t("back_office.configure_object")
                : selectingType
                  ? t("back_office.select_type")
                  : editing
                    ? t("back_office.edit_field")
                    : t("back_office.configure_field")}
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
                {t("scheduled.save")}
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
                  placeholder={t("back_office.search_type")}
                  value={typeQuery}
                  onChange={(event) => setTypeQuery(event.target.value)}
                />
              </label>
              <h3>{t("back_office.basic")}</h3>
              <p className="bo-muted">
                {t("back_office.basic_hint")}
              </p>
              <div className="bo-type-grid">
                {basicFieldTypes.filter(supported)
                  .filter(type => backOfficeFieldTypeLabel(type).toLocaleLowerCase().includes(typeQuery.toLocaleLowerCase()))
                  .map(type => (
                    <ListItem
                      key={type}
                      render={<button />}
                      startIcon={<FieldIcon field={{ type }} />}
                      endIcon={<ChevronRight size={13} />}
                      onClick={() => {
                        setFieldType(type);
                        setSelectingType(false);
                      }}
                    >
                      {backOfficeFieldTypeLabel(type)}
                    </ListItem>
                  ))}
              </div>
              <h3>{t("back_office.field_type.relation")}</h3>
              <p className="bo-muted">{t("back_office.relation_hint")}</p>
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
                  {t("back_office.field_type.relation")}
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
                    label: editing && label === displayBackOfficeField(editing, object.id).label ? editing.label : label,
                    type: fieldType,
                    target: fieldType === "relation" ? target : undefined,
                    multiple: !isOrderedListField(fieldType) && multiple,
                    visibility,
                    required,
                    options: isOrderedListField(fieldType) ? [] : options
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  });
                  const fields = editing
                    ? object.fields.map(field => field.id === editing.id ? nextField : field)
                    : [...object.fields, nextField];
                  void applyObject({ ...object, fields });
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : t("back_office.check_field"),
                  );
                }
              }}
            >
              <div>
                <h3>{t("back_office.icon_name")}</h3>
                <p className="bo-muted">
                  {t(adding === "object" ? "back_office.object_name_hint" : "back_office.field_name_hint")}
                </p>
              </div>
              <label>
                {t("plugin_create.name")}
                <Input
                  required
                  autoFocus
                  value={label}
                  aria-label={t("projects.field_name")}
                  onChange={(event) => setLabel(event.target.value)}
                  disabled={!editable}
                />
              </label>
              {adding === "object" ? (
                <label>
                  {t("back_office.plural_name")}
                  <Input
                    value={plural}
                    onChange={(event) => setPlural(event.target.value)}
                    required
                    aria-label={t("back_office.plural_name")}
                  />
                </label>
              ) : (
                <>
                  <label>
                    {t("projects.field_type")}
                    <DirectorySelect
                      label={t("projects.field_type")}
                      value={fieldType}
                      disabled={editing?.protected || !editable}
                      onChange={(value) => {
                        const parsed =
                          BackOfficeFieldSchema.shape.type.safeParse(value);
                        if (parsed.success) setFieldType(parsed.data);
                      }}
                      options={BackOfficeFieldSchema.shape.type.options.filter(supported).map(
                        (type) => ({ value: type, label: backOfficeFieldTypeLabel(type) }),
                      )}
                    />
                  </label>
                  {(fieldType === "select" || fieldType === "multiselect") && (
                    <label>
                      {t("projects.options")}
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
                        {t("back_office.related_object")}
                        <DirectorySelect
                          required
                          label={t("back_office.related_object")}
                          value={target}
                          disabled={editing?.protected || !editable}
                          onChange={setTarget}
                          options={[
                            { value: "", label: t("back_office.choose_object") },
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
                        {t("back_office.several_records")}
                      </label>
                    </>
                  )}
                  {fieldType === "file" && (
                    <label className="bo-checkbox-label">
                      <Checkbox
                        size="sm"
                        checked={multiple}
                        disabled={editing?.protected || !editable}
                        onCheckedChange={setMultiple}
                      />
                      {t("back_office.several_files")}
                    </label>
                  )}
                  <label>
                    {t("back_office.visibility")}
                    <DirectorySelect
                      label={t("back_office.field_visibility")}
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
                        { value: "normal", label: t("back_office.directory_members") },
                        { value: "private", label: t("back_office.record_owner") },
                        { value: "finance", label: t("back_office.billing_members") },
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
                    {t("back_office.required")}
                  </label>
                </>
              )}
              {editing?.protected && (
                <p className="bo-model-notice">
                  <LockKeyhole size={13} />
                  {t("back_office.protected_field")}
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
                      void applyObject({ ...object, fields: object.fields.filter(field => field.id !== editing.id),
                        ...(object.quickCreateFields ? { quickCreateFields: object.quickCreateFields.filter(id => id !== editing.id) } : {}) })
                    }
                  >
                    {t("back_office.remove_field")}
                  </Button>
                )}
              </div>
            </form>
          )}
        </div>
      )}
      {review && (
        <DirectoryDialog
          title={t("back_office.review_title")}
          onClose={() => setReview(null)}
        >
          <div className="bo-form">
            <p>
              {t("back_office.review_hint")}
            </p>
            {review.preview.changes.map((change) => {
              const changedObject = review.model.objects.find(object => object.plural === change.object);
              return (
                <div key={change.object}>
                  <strong>{changedObject ? displayBackOfficeObject(changedObject).plural : change.object}</strong>
                  <p className="bo-muted">
                    {changeLabel(change.action)} · {t("back_office.existing_count", { count: change.records })}
                  </p>
                </div>
              );
            })}
            {error && (
              <p className="bo-error" role="alert">
                {error}
              </p>
            )}
            <div className="bo-modal-footer">
              <Button size="sm" onClick={() => setReview(null)}>
                {t("back_office.files.cancel")}
              </Button>
              <Button
                size="sm"
                variant="solid"
                color="accent"
                disabled={saving}
                onClick={() => void commit(review.model)}
              >
                {t("back_office.apply_change")}
              </Button>
            </div>
          </div>
        </DirectoryDialog>
      )}
    </div>
  );
}
