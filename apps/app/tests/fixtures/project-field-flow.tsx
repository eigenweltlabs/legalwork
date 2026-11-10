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
  Element: window.Element, Node: window.Node, Event: window.Event, PointerEvent: window.PointerEvent,
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
const { ProjectMetadata } = await import("../../src/react-app/domains/workspace/project-metadata");
const { ProjectProperties } = await import("../../src/react-app/domains/workspace/project-properties");
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
let renderKey = 0;
const saves: ProjectField[][] = [];
const save = async (fields: ProjectField[]) => { saves.push(projectFieldsSchema.parse(fields)); };
const close = () => {};

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
  await render(<ProjectMetadata client={client} details={{ fields: [] }} onSave={save} onCancel={close} />);
  await click(t("projects.add_field"));
  await type(t("projects.field_name"), "Research note");
  assert.equal(button(t("projects.save")).disabled, false, "A named field may be saved before its optional content is known");
  await click(t("projects.save"));
  const empty = lastSave()[0];
  assert.equal(empty.label, "Research note"); assert.equal(empty.type, "text"); assert.equal(empty.value, null);

  await render(<ProjectMetadata client={client} details={{ fields: [empty] }} showTemplates={false} onSave={save} onCancel={close} />);
  await type(t("projects.field_value"), "Check the governing-law clause");
  await click(t("projects.save"));
  assert.deepEqual(lastSave(), [{ ...empty, value: "Check the governing-law clause" }], "Customize fills content without changing the field definition or ID");

  const reference: ProjectField = { id: "11111111-1111-4111-8111-111111111111", label: "Witnesses", labelSource: "custom",
    type: "backoffice", objectId: "people", multiple: true, value: null };
  await render(<ProjectMetadata client={client} details={{ fields: [reference] }} showTemplates={false} onSave={save} onCancel={close} />);
  await click(t("projects.save"));
  assert.deepEqual(lastSave(), [reference], "An optional reference can remain empty without generating an invalid empty record list");
  await render(<ProjectMetadata client={client} details={{ fields: [reference] }} showTemplates={false} onSave={save} onCancel={close} />);
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

  const primary: ProjectField = { id: "matter", label: "Matters", labelSource: "suggested", type: "backoffice", objectId: "matters", multiple: true, quickAction: true, value: null };
  const values: { id: string; value: ProjectField["value"] }[] = [];
  await render(<ProjectProperties client={client} fields={[empty, reference, primary]} onSave={async (id, value) => { values.push({ id, value }); }} />);
  assert.ok(document.body.textContent?.includes(empty.label), "An intentionally empty custom field remains visible");
  assert.ok(document.body.textContent?.includes(reference.label), "An intentionally empty reference role remains visible");
  assert.ok(button("Add Matter"));
  await click(t("projects.edit_value", { name: empty.label }));
  await type(empty.label, "Filled from Home"); await key(empty.label, "Enter");
  assert.deepEqual(values, [{ id: empty.id, value: "Filled from Home" }]);

  const quickRole = { ...reference, quickAction: true };
  await render(<ProjectMetadata client={client} details={{ fields: [reference] }} definitionsOnly onSave={save} onCancel={close} />);
  const toggle = [...document.querySelectorAll("label")].find(label => label.textContent?.includes(t("projects.field_quick_action")))?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(toggle); await act(async () => toggle.click()); await click(t("projects.save"));
  assert.deepEqual(lastSave(), [quickRole]);
  const oldValues: ProjectField["value"][] = [], freshValues: ProjectField["value"][] = [];
  await render(<ProjectProperties client={client} fields={[quickRole]} onSave={async (_id, value) => {
    oldValues.push(value); throw new LegalworkServerError(409, "project_changed", "Changed elsewhere");
  }} />);
  await click("Add Witnesses");
  const peopleSearch = t("back_office.create.search", { name: reference.label });
  await type(peopleSearch, "Alice"); await key(peopleSearch, "Enter");
  await render(<ProjectProperties client={client} fields={[quickRole]} onSave={async (_id, value) => { freshValues.push(value); }} />, true);
  await click(t("projects.save"));
  assert.equal(oldValues.length, 1, "An open quick action retains the starting revision");
  assert.equal(freshValues.length, 0);
  assert.equal(button(t("projects.save")).disabled, true);
  await click(t("projects.reload_fields"));
  await type(peopleSearch, "Alice"); await key(peopleSearch, "Enter");
  await click(t("projects.save"));
  assert.deepEqual(freshValues, [{ directoryId: "local:field-fixture", recordIds: [alice.id] }]);
  console.log("Project field flow passed");
} finally { await act(async () => root.unmount()); cache.clear(); store.close(); await window.happyDOM.close(); }
