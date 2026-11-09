import assert from "node:assert/strict";
import type { ReactNode } from "react";
import { Window } from "happy-dom";
import type { ProjectField } from "@legalwork/types/workspace";
import { BackOfficeStore } from "../../../server/src/back-office/store";
import { openSqlite } from "../../../server/src/runtime-db";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><head></head><body></body></html>");
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
  Element: window.Element, Node: window.Node, Event: window.Event,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { projectFieldsSchema } = await import("@legalwork/types/workspace");
const { createLegalworkServerClient, LegalworkServerError } = await import("../../src/app/lib/legalwork-server");
const { ProjectFieldDialog } = await import("../../src/react-app/domains/workspace/project-field-dialog");
const { ProjectMetadata } = await import("../../src/react-app/domains/workspace/project-metadata");
const { ProjectProperties } = await import("../../src/react-app/domains/workspace/project-properties");
const { ProjectReferenceActions } = await import("../../src/react-app/domains/workspace/project-reference-actions");
const { displayBackOfficeObject } = await import("../../src/react-app/domains/back-office/labels");
const { t, setLocale } = await import("../../src/i18n");
setLocale("en");

const store = new BackOfficeStore(await openSqlite(":memory:"));
const actor = { userId: "owner", model: true, edit: true, finance: true };
const alice = store.saveRecord("local", actor, { objectId: "people", revision: 0, values: { name: "Alice" } });
let recordWrites = 0;
const client = {
  ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
  backOffice: async (path: string, options?: { body?: unknown }) => {
    if (path.startsWith("?")) return { scope: "local", directoryId: "local:field-fixture", model: store.model("local"),
      records: store.records("local", actor), views: [], permissions: actor, sync: { enabled: false, cursor: 0, pending: 0, error: null } };
    if (path === "/projects") return { projects: [] };
    if (path === "/records" && options?.body) { recordWrites++; return { record: store.saveRecord("local", actor, options.body) }; }
    throw new Error(`Unexpected request ${path}`);
  },
};
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
let renderKey = 0, closes = 0;
const saves: ProjectField[][] = [];
const save = async (fields: ProjectField[]) => { saves.push(projectFieldsSchema.parse(fields)); };
const saveField = async (field: ProjectField) => save([field]);
const close = () => { closes++; };

async function render(content: ReactNode, preserveState = false) {
  if (!preserveState) renderKey++;
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter key={renderKey}>{content}</MemoryRouter></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function input(label: string) {
  const element = [...document.querySelectorAll<HTMLInputElement>("input")].find(item => item.getAttribute("aria-label") === label);
  assert.ok(element, `Missing input ${label}: ${document.body.textContent?.slice(-1400)}`); return element;
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
  assert.ok(element, `Missing button ${label}: ${document.body.textContent?.slice(-1400)}`); return element;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function type(label: string, value: string) {
  await act(async () => {
    const element = input(label); element.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; assert.ok(setter);
    setter.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function key(label: string, key: string) {
  await act(async () => input(label).dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}
function lastSave() { const fields = saves.at(-1); assert.ok(fields); return fields; }

try {
  await render(<ProjectFieldDialog client={client} onSave={saveField} onClose={close} />);
  await type(t("projects.field_name"), "Research note");
  assert.equal(button(t("projects.save")).disabled, false, "A named field may be saved before its optional content is known");
  await click(t("projects.save"));
  assert.equal(closes, 1);
  const empty = lastSave()[0];
  assert.equal(empty.label, "Research note"); assert.equal(empty.type, "text"); assert.equal(empty.value, null);

  await render(<ProjectMetadata client={client} details={{ fields: [empty] }} showTemplates={false} onSave={save} onCancel={close} />);
  await type(t("projects.field_value"), "Check the governing-law clause");
  await click(t("projects.save"));
  assert.deepEqual(lastSave(), [{ ...empty, value: "Check the governing-law clause" }], "Customize fills content without changing the field definition or ID");

  const reference: ProjectField = { id: "11111111-1111-4111-8111-111111111111", label: "Witnesses", labelSource: "custom",
    type: "backoffice", objectId: "people", multiple: true, value: null };
  await render(<ProjectFieldDialog client={client} field={reference} onSave={saveField} onClose={close} />);
  await click(t("projects.save"));
  assert.deepEqual(lastSave(), [reference], "An optional reference can remain empty without generating an invalid empty record list");
  await render(<ProjectFieldDialog client={client} field={reference} onSave={saveField} onClose={close} />);
  await click(t("projects.edit_value", { name: reference.label }));
  const search = t("back_office.create.search", { name: reference.label });
  await type(search, "Alice"); await key(search, "Enter"); await key(search, "Escape");
  await click(t("projects.save"));
  assert.deepEqual(lastSave(), [{ ...reference, value: { directoryId: "local:field-fixture", recordIds: [alice.id] } }],
    "A digit-leading UUID remains a valid project identity when adapting to the record picker");
  assert.equal(recordWrites, 0, "Linking an existing record does not create another record");

  for (const [field, content, expected] of [
    [{ id: "budget", label: "Budget", labelSource: "custom", type: "number", value: null }, "1250.5", 1250.5],
    [{ id: "due", label: "Due date", labelSource: "custom", type: "date", value: null }, "2026-12-15", "2026-12-15"],
  ] satisfies [ProjectField, string, string | number][]) {
    await render(<ProjectMetadata client={client} details={{ fields: [field] }} showTemplates={false} onSave={save} onCancel={close} />);
    await type(t("projects.field_value"), content); await click(t("projects.save"));
    assert.deepEqual(lastSave(), [{ ...field, value: expected }]);
  }

  const choice: ProjectField = { id: "stage", label: "Stage", labelSource: "custom", type: "select", options: ["Draft", "Approved"], value: null };
  await render(<ProjectMetadata client={client} details={{ fields: [choice] }} showTemplates={false} onSave={save} onCancel={close} />);
  await click(t("projects.field_value"));
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === "Approved");
  assert.ok(option, "Select field content offers the configured choices");
  await act(async () => option.focus());
  await act(async () => option.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await click(t("projects.save")); assert.deepEqual(lastSave(), [{ ...choice, value: "Approved" }]);

  const remoteChoice = { ...choice, options: ["Remote choice"] };
  await render(<ProjectMetadata client={client} details={{ fields: [choice] }} showTemplates={false}
    onSave={async () => { throw new LegalworkServerError(409, "project_changed", "Changed elsewhere"); }}
    onReload={async () => ({ fields: [remoteChoice] })} onCancel={close} />);
  await type(t("projects.options"), "Local draft choice"); await click(t("projects.save"));
  await click(t("projects.reload_fields"));
  assert.equal(input(t("projects.options")).value, "Remote choice", "Explicit reload resets the option input as well as the underlying field definition");

  await render(<ProjectMetadata client={client} details={{ fields: [{ ...empty, value: "Project-specific content" }] }} definitionsOnly onSave={save} onCancel={close} />);
  assert.equal([...document.querySelectorAll("[aria-label]")].some(item => item.getAttribute("aria-label") === t("projects.field_value")), false,
    "Template editing defines fields without presenting project-specific content");
  await click(t("projects.save")); assert.deepEqual(lastSave(), [empty], "Template definitions do not inherit project content");

  const primary: ProjectField = { id: "matter", label: "Matters", labelSource: "suggested", type: "backoffice", objectId: "matters", multiple: true, value: null };
  const values: { id: string; value: ProjectField["value"] }[] = [];
  await render(<ProjectProperties client={client} fields={[empty, reference, primary]} onSave={async (id, value) => { values.push({ id, value }); }} />);
  assert.ok(document.body.textContent?.includes(empty.label), "An intentionally empty custom field remains visible");
  assert.ok(document.body.textContent?.includes(reference.label), "An intentionally empty reference role remains visible");
  assert.equal(document.body.textContent?.includes(primary.label), false, "An unused generic primary connection does not add an empty row");
  await click(t("projects.edit_value", { name: empty.label }));
  await type(empty.label, "Filled from Home"); await key(empty.label, "Enter");
  assert.deepEqual(values, [{ id: empty.id, value: "Filled from Home" }]);

  const oldFields = [{ ...empty, value: "Before external change" }];
  const freshFields = [{ ...empty, value: "Externally updated" }];
  const oldSubmissions: ProjectField[][] = [], freshSubmissions: ProjectField[][] = [];
  const oldSave = async (fields: ProjectField[]) => {
    oldSubmissions.push(fields);
    throw new LegalworkServerError(409, "project_changed", "Changed elsewhere");
  };
  const freshSave = async (fields: ProjectField[]) => { freshSubmissions.push(projectFieldsSchema.parse(fields)); };
  await render(<ProjectReferenceActions client={client} fields={oldFields} onSave={oldSave} />);
  await click(t("projects.connections.add_record", { name: t("back_office.people.singular") }));
  const peopleSearch = t("back_office.create.search", { name: t("back_office.people.plural") });
  await type(peopleSearch, "Alice"); await key(peopleSearch, "Enter");
  await render(<ProjectReferenceActions client={client} fields={freshFields} onSave={freshSave} />, true);
  await click(t("projects.connections.link"));
  assert.equal(oldSubmissions.length, 1, "An open picker retains the save callback captured before the external update");
  assert.equal(freshSubmissions.length, 0, "A newer revision callback must not silently accept the older draft");
  assert.equal(oldSubmissions[0][0].value, "Before external change");
  assert.equal(button(t("projects.connections.link")).disabled, true, "Conflict blocks repeating the stale save");
  await click(t("projects.reload_fields"));
  await type(peopleSearch, "Alice"); await key(peopleSearch, "Enter");
  await click(t("projects.connections.link"));
  assert.equal(freshSubmissions.length, 1, "Explicit reload adopts the fresh callback");
  assert.equal(freshSubmissions[0][0].value, "Externally updated", "Reload preserves the concurrent edit");
  assert.deepEqual(freshSubmissions[0].find(field => field.type === "backoffice")?.value,
    { directoryId: "local:field-fixture", recordIds: [alice.id] });

  const fullFields: ProjectField[] = Array.from({ length: 50 }, (_, index) => ({
    id: `custom_${index}`, label: `Custom ${index}`, labelSource: "custom", type: "text", value: null,
  }));
  await render(<ProjectReferenceActions client={client} fields={fullFields} onSave={save} />);
  for (const objectId of ["matters", "clients", "people", "companies"]) {
    const object = store.model("local").objects.find(item => item.id === objectId); assert.ok(object);
    assert.equal(button(t("projects.connections.add_record", { name: displayBackOfficeObject(object).label })).disabled, true,
      `A missing ${objectId} field cannot be added beyond the 50-field limit`);
  }
  const clientField: ProjectField = { id: "client", label: "Clients", labelSource: "suggested", type: "backoffice", objectId: "clients", multiple: true, value: null };
  await render(<ProjectReferenceActions client={client} fields={[...fullFields.slice(0, 49), clientField]} onSave={save} />);
  assert.equal(button(t("projects.connections.add_record", { name: t("back_office.clients.singular") })).disabled, false,
    "Existing primary connections remain editable at the field limit");
  assert.equal(button(t("projects.connections.add_record", { name: t("back_office.matters.singular") })).disabled, true);
  console.log("Project field flow passed");
} finally { await act(async () => root.unmount()); cache.clear(); store.close(); await window.happyDOM.close(); }
