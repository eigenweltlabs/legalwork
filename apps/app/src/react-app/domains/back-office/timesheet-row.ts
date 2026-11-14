import type { TimeDraft, TimesheetState } from "@legalwork/types/timesheet";
import { t } from "@/i18n";

export type LedgerDirectory = Pick<
  TimesheetState,
  "userId" | "matters" | "clients" | "people" | "products" | "projects"
>;

export type RowValues = {
  date: string;
  matter: string;
  workers: string;
  activity: string;
  narrative: string;
  product: string;
  productId?: string;
  createProduct?: boolean;
  worked: string;
  charge: string;
  billable: boolean;
};

export const rowColumns = [
  "date",
  "matter",
  "workers",
  "activity",
  "narrative",
  "product",
  "worked",
  "charge",
  "billable",
] as const;
export type RowColumn = (typeof rowColumns)[number];

export function localDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function offsetDate(value: string, offset: number) {
  const date = new Date(value + "T12:00:00");
  date.setDate(date.getDate() + offset);
  return localDate(date);
}

export function weekDates(value: string) {
  const monday = offsetDate(value, -((new Date(value + "T12:00:00").getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => offsetDate(monday, index));
}

export function matterOptions(state: LedgerDirectory) {
  const clients = new Map(state.clients.map((client) => [client.id, client.name]));
  const matches = state.matters.flatMap((matter) => {
    const ids = matter.clientIds.length ? matter.clientIds : [""];
    const projects = state.projects.filter((project) => project.matterIds.includes(matter.id));
    return ids.flatMap((clientId) =>
      [undefined, ...projects].map((project) => ({
        matterId: matter.id,
        clientId,
        projectId: project?.id,
        label: [clients.get(clientId), matter.name, matter.reference, project?.name]
          .filter(Boolean)
          .join(" · "),
      })),
    );
  });
  const counts = new Map<string, number>();
  matches.forEach((item) => counts.set(item.label, (counts.get(item.label) ?? 0) + 1));
  return matches.map((item) =>
    counts.get(item.label) === 1
      ? item
      : {
          ...item,
          label:
            item.label +
            " · " +
            item.matterId +
            (item.clientId ? " / " + item.clientId : "") +
            (item.projectId ? " / " + item.projectId : ""),
        },
  );
}

export function workerOptions(state: LedgerDirectory) {
  const people = [...state.people];
  if (!people.some((person) => person.id === state.userId))
    people.unshift({ id: state.userId, name: t("timesheets.ledger.me") });
  return people.map((person) => ({
    id: person.id,
    label: people.some((other) => other.id !== person.id && person.name === other.name)
      ? person.name + " (" + person.id + ")"
      : person.name || person.id,
  }));
}

export function productOptions(state: LedgerDirectory, matterId?: string) {
  const items = state.products.filter((product) => product.matterId === matterId);
  const counts = new Map<string, number>();
  for (const item of items)
    counts.set(item.name.toLocaleLowerCase(), (counts.get(item.name.toLocaleLowerCase()) ?? 0) + 1);
  return items.map((item) => {
    const duplicate = (counts.get(item.name.toLocaleLowerCase()) ?? 0) > 1;
    const author =
      item.authorId && (state.people.find((p) => p.id === item.authorId)?.name ?? item.authorId);
    const details = [item.reference, author, item.createdAt?.slice(0, 10)].filter(Boolean).join(" · ");
    return {
      id: item.id,
      name: item.name,
      label: duplicate ? [item.name, details, item.id].filter(Boolean).join(" · ") : item.name,
    };
  });
}

export function emptyRow(date: string, worker: string, matter = ""): RowValues {
  return {
    date,
    matter,
    workers: worker,
    activity: "",
    narrative: "",
    product: "",
    worked: "",
    charge: "",
    billable: true,
  };
}

export function fromDraft(
  entry: Partial<TimeDraft>,
  worker: string,
  date: string,
  state: LedgerDirectory,
  options = matterOptions(state),
): RowValues {
  const candidates = options.filter(
    (item) => item.matterId === entry.matterId && item.projectId === entry.projectId,
  );
  const matter =
    candidates.find((item) => item.clientId === entry.clientId) ??
    (!entry.clientId && candidates.length === 1 ? candidates[0] : undefined);
  return {
    date: entry.date ?? date,
    matter: matter?.label ?? "",
    workers: worker,
    activity: entry.activity ?? "",
    narrative: entry.narrative ?? "",
    product:
      productOptions(state, entry.matterId).find((product) => product.id === entry.workProductId)
        ?.label ??
      entry.workProductTitle ??
      "",
    productId: entry.workProductId,
    worked: entry.workedMinutes?.toString() ?? "",
    charge: (entry.billableMinutes ?? entry.workedMinutes)?.toString() ?? "",
    billable: entry.billable ?? true,
  };
}

type ParsedRow = { entry: TimeDraft; workerIds: string[] };
type RowError = { field: RowColumn; error: string };
export function parseRow(values: RowValues, state: LedgerDirectory): ParsedRow | RowError {
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(values.date) &&
    localDate(new Date(values.date + "T12:00:00")) === values.date;
  if (!validDate) return { field: "date", error: t("timesheets.ledger.valid_date") };
  const options = matterOptions(state);
  const query = values.matter.trim().toLocaleLowerCase();
  const exact = options.find((item) => item.label.toLocaleLowerCase() === query);
  const matches = query ? options.filter((item) => item.label.toLocaleLowerCase().includes(query)) : [];
  const matter = exact ?? (matches.length === 1 ? matches[0] : undefined);
  if (!matter) return { field: "matter", error: t("timesheets.ledger.choose_matter") };
  const people = workerOptions(state);
  // An exact match takes precedence over the separator in a person's name.
  const exactWorker = people.find((person) => person.label === values.workers.trim());
  const names = exactWorker
    ? [exactWorker.label]
    : values.workers.split(" + ").map((name) => name.trim());
  const workerIds = new Set<string>();
  for (const name of names) {
    const person = people.find(
      (person) => person.label.toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (!person) return { field: "workers", error: t("timesheets.ledger.choose_worker") };
    workerIds.add(person.id);
  }
  if (!values.activity.trim())
    return { field: "activity", error: t("timesheets.ledger.enter_activity") };
  if (!values.narrative.trim())
    return { field: "narrative", error: t("timesheets.ledger.enter_narrative") };
  if (!/^\d+$/.test(values.worked) || +values.worked < 1 || +values.worked > 1440)
    return { field: "worked", error: t("timesheets.ledger.valid_worked") };
  if (values.billable && (!/^\d+$/.test(values.charge) || +values.charge > 1440))
    return { field: "charge", error: t("timesheets.ledger.valid_charge") };
  const title = values.product.trim();
  const optionsForMatter = productOptions(state, matter.matterId);
  let product = values.productId ? optionsForMatter.find((p) => p.id === values.productId) : undefined;
  if (values.createProduct && !title)
    return { field: "product", error: t("timesheets.ledger.new_product_title") };
  if (!values.createProduct && values.productId && !product)
    return { field: "product", error: t("timesheets.ledger.product_missing") };
  if (!values.createProduct && !product && title) {
    const query = title.toLocaleLowerCase();
    const matches = optionsForMatter.filter(
      (p) => p.label.toLocaleLowerCase() === query || p.name.toLocaleLowerCase() === query,
    );
    if (matches.length > 1) return { field: "product", error: t("timesheets.ledger.product_ambiguous") };
    product = matches[0];
  }
  const entry = {
    date: values.date,
    matterId: matter.matterId,
    clientId: matter.clientId,
    ...(matter.projectId ? { projectId: matter.projectId } : {}),
    activity: values.activity.trim(),
    narrative: values.narrative.trim(),
    workedMinutes: Number(values.worked),
    billable: values.billable,
    billableMinutes: values.billable ? Number(values.charge) : 0,
    ...(values.createProduct
      ? { workProductTitle: title, createWorkProduct: true as const }
      : product
        ? { workProductId: product.id }
        : title
          ? { workProductTitle: title }
          : {}),
  };
  return { entry, workerIds: [...workerIds] };
}

export function duration(minutes: number) {
  return Math.floor(minutes / 60) + ":" + String(minutes % 60).padStart(2, "0");
}
