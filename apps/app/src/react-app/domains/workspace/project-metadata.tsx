import { useState } from "react";
import type { ProjectDetails, ProjectField } from "@legalwork/types/workspace";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { t } from "@/i18n";

export function ProjectMetadata(props: {
  details: ProjectDetails;
  onSave: (fields: ProjectField[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState(props.details.fields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (id: string, patch: Partial<ProjectField>) =>
    setFields((current) =>
      current.map((field) =>
        field.id === id ? { ...field, ...patch } : field,
      ),
    );
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onSave(fields);
    } catch (error) {
      setError(error instanceof Error ? error.message : t("projects.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={busy} className="space-y-4">
        {fields.map((field) => (
          <div
            key={field.id}
            className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[1fr_130px_auto]"
          >
            <Input
              aria-label={t("projects.field_name")}
              placeholder={t("projects.field_name")}
              required
              maxLength={100}
              value={field.label}
              onChange={(event) =>
                change(field.id, { label: event.target.value })
              }
            />
            <Select
              value={field.type}
              onValueChange={(value) => {
                if (
                  value === "text" ||
                  value === "number" ||
                  value === "date" ||
                  value === "select"
                )
                  change(field.id, {
                    type: value,
                    value: null,
                    options: value === "select" ? [] : undefined,
                  });
              }}
            >
              <SelectTrigger
                aria-label={t("projects.field_type")}
                className="w-full"
              >
                <SelectValue>{t(`projects.type_${field.type}`)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(
                  [
                    "text",
                    "number",
                    "date",
                    "select",
                  ] satisfies ProjectField["type"][]
                ).map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`projects.type_${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("projects.remove_field", { name: field.label })}
              onClick={() =>
                setFields((current) =>
                  current.filter((item) => item.id !== field.id),
                )
              }
            >
              <Trash2 className="size-4" />
            </Button>
            {field.type === "select" ? (
              <div className="grid gap-2 sm:col-span-3">
                <Input
                  aria-label={t("projects.options")}
                  placeholder={t("projects.options")}
                  defaultValue={field.options?.join(", ") ?? ""}
                  onBlur={(event) => {
                    const options = [
                      ...new Set(
                        event.target.value
                          .split(",")
                          .map((s) => s.trim())
                          .filter(Boolean),
                      ),
                    ];
                    change(field.id, {
                      options,
                      value: options.includes(String(field.value))
                        ? field.value
                        : null,
                    });
                  }}
                />
                <Select
                  value={String(field.value ?? "")}
                  onValueChange={(value) =>
                    change(field.id, { value: value || null })
                  }
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={field.label || t("projects.value")}
                  >
                    <SelectValue placeholder={t("projects.value")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">
                      {t("projects.empty_value")}
                    </SelectItem>
                    {field.options?.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <Input
                className="sm:col-span-3"
                aria-label={field.label || t("projects.value")}
                placeholder={t("projects.value")}
                type={
                  field.type === "number"
                    ? "number"
                    : field.type === "date"
                      ? "date"
                      : "text"
                }
                step="any"
                maxLength={4000}
                value={field.value ?? ""}
                onChange={(event) =>
                  change(field.id, {
                    value:
                      field.type === "number"
                        ? event.target.value === ""
                          ? null
                          : Number(event.target.value)
                        : event.target.value,
                  })
                }
              />
            )}
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={fields.length >= 50}
          onClick={() =>
            setFields((current) => [
              ...current,
              { id: crypto.randomUUID(), label: "", type: "text", value: null },
            ])
          }
        >
          <Plus className="size-4" />
          {t("projects.add_field")}
        </Button>
      </fieldset>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={props.onCancel}
        >
          {t("projects.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? t("projects.saving") : t("projects.save")}
        </Button>
      </div>
    </form>
  );
}
