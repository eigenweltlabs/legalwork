import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { backOfficeAuthorKey } from "./principal.js";
import type { BackOfficeActor, BackOfficeValue } from "./schema.js";
import type { BackOfficeStore } from "./store.js";
import {
  validateBackOfficeValues,
  isInternalBackOfficeObject,
} from "./schema.js";

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") index++;
      row.push(cell);
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (quoted)
    throw new ApiError(
      400,
      "back_office_csv",
      "A CSV quotation is unfinished.",
    );
  row.push(cell);
  if (row.some((value) => value.length)) rows.push(row);
  if (rows.length > 501)
    throw new ApiError(
      400,
      "back_office_csv",
      "Import up to 500 rows at a time.",
    );
  if (!rows[0] || new Set(rows[0]).size !== rows[0].length)
    throw new ApiError(400, "back_office_csv", "Use unique column headers.");
  return rows;
}
type PlannedRow = {
  row: number;
  values: Record<string, BackOfficeValue>;
  sourceId?: string;
  existingId?: string;
  revision: number;
  warning?: string;
  error?: string;
};
const plans = new Map<
  string,
  {
    actor: string;
    scope: string;
    objectId: string;
    fingerprint: string;
    rows: PlannedRow[];
    expires: number;
  }
>();
function fingerprint(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  objectId: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        store.model(scope).revision,
        store
          .records(scope, actor, objectId)
          .map((record) => [record.id, record.revision]),
      ]),
    )
    .digest("hex");
}
export function previewImport(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  objectId: string,
  csv: string,
  mapping: Record<string, string>,
) {
  const object = store
    .model(scope)
    .objects.find((object) => object.id === objectId && !object.archived);
  if (!object || isInternalBackOfficeObject(objectId) || !actor.edit)
    throw new ApiError(
      403,
      "back_office_import",
      "This object cannot be imported.",
    );
  const [headers, ...records] = parseCsv(csv),
    existing = store.records(scope, actor, objectId);
  const seenSources = new Set<string>(),
    seenNames = new Set<string>();
  const directory = store.records(scope, actor);
  const rows: PlannedRow[] = records.map((cells, index) => {
    const values: Record<string, BackOfficeValue> = {};
    try {
      const sourceColumn = mapping.$sourceId;
      const sourceIndex = sourceColumn ? headers.indexOf(sourceColumn) : -1;
      if (sourceColumn && sourceIndex < 0) throw new Error(`Missing column ${sourceColumn}.`);
      const sourceId = sourceIndex < 0 ? undefined : cells[sourceIndex]?.trim() || undefined;
      for (const field of object.fields) {
        const column = mapping[field.id];
        if (!column) continue;
        const columnIndex = headers.indexOf(column);
        if (columnIndex < 0) throw new Error(`Missing column ${column}.`);
        const cell = cells[columnIndex]?.trim() ?? "";
        if (!cell) {
          values[field.id] = null;
          continue;
        }
        values[field.id] =
          field.type === "number"
            ? Number(cell)
            : field.type === "boolean"
              ? /^(true|yes|1)$/i.test(cell)
              : field.type === "currency"
                ? {
                    amountMinor: Math.round(Number(cell) * 100),
                    currency: "EUR",
                  }
                : field.type === "multiselect" ||
                    (field.type === "relation" && field.multiple)
                  ? cell.split("|").map((value) => value.trim())
                  : cell;
      }
      for (const field of object.fields.filter(
        (field) => field.type === "relation",
      )) {
        const raw = values[field.id];
        if (!raw) continue;
        const resolved = (Array.isArray(raw) ? raw : [raw]).map((value) => {
          const target = directory.find(
            (record) =>
              record.objectId === field.target &&
              (record.id === value ||
                (typeof value === "string" &&
                  value.startsWith("source:") &&
                  record.sourceId === value.slice(7))),
          );
          if (!target)
            throw new Error(
              `Use an accessible record ID or source:source-ID for ${field.label}.`,
            );
          return target.id;
        });
        values[field.id] = field.multiple ? resolved : resolved[0];
      }
      if (sourceId && seenSources.has(sourceId))
        throw new Error("This source ID occurs more than once in the CSV.");
      if (sourceId) seenSources.add(sourceId);
      validateBackOfficeValues(object, values);
      const matches = sourceId
        ? existing.filter((record) => record.sourceId === sourceId)
        : [];
      if (matches.length > 1)
        throw new Error(
          "Several records have this source ID. Resolve them before importing.",
        );
      const duplicateInFile = seenNames.has(
        String(values.name).toLocaleLowerCase(),
      );
      seenNames.add(String(values.name).toLocaleLowerCase());
      const duplicateName =
        duplicateInFile ||
        existing.some(
          (record) =>
            String(record.values.name).toLocaleLowerCase() ===
            String(values.name).toLocaleLowerCase(),
        );
      return {
        row: index + 2,
        values,
        sourceId,
        existingId: matches[0]?.id,
        revision: matches[0]?.revision ?? 0,
        warning: matches.length
          ? "Update the record with this source ID."
          : duplicateName
            ? "A record has the same name. It will stay separate unless you link its source ID first."
            : undefined,
      };
    } catch (error) {
      return {
        row: index + 2,
        values,
        revision: 0,
        error: error instanceof Error ? error.message : "Check this row.",
      };
    }
  });
  for (const [id, plan] of plans)
    if (plan.expires < Date.now()) plans.delete(id);
  if (plans.size > 100)
    throw new ApiError(
      429,
      "back_office_import",
      "Finish or repeat an existing import first.",
    );
  const planId = randomUUID();
  plans.set(planId, {
    actor: backOfficeAuthorKey(actor),
    scope,
    objectId,
    fingerprint: fingerprint(store, scope, actor, objectId),
    rows,
    expires: Date.now() + 600_000,
  });
  return { planId, rows, valid: rows.every((row) => !row.error) };
}
export function applyImport(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  planId: string,
) {
  const plan = plans.get(planId);
  if (
    !plan ||
    plan.expires < Date.now() ||
    plan.scope !== scope ||
    plan.actor !== backOfficeAuthorKey(actor)
  )
    throw new ApiError(409, "back_office_import", "Preview the import again.");
  if (
    plan.fingerprint !== fingerprint(store, scope, actor, plan.objectId) ||
    plan.rows.some((row) => row.error)
  )
    throw new ApiError(
      409,
      "back_office_import",
      "The model or records changed. Preview again before importing.",
    );
  plans.delete(planId);
  return store.transaction(() =>
    plan.rows.map((row) =>
      store.saveRecord(scope, actor, {
        id: row.existingId,
        objectId: plan.objectId,
        revision: row.revision,
        values: row.values,
        sourceId: row.sourceId,
      }),
    ),
  );
}
