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

  const reference: ProjectField = { id: "11111111-1111-4111-8111-111111111111", label: "Witnesses", labelSource: "custom",
    type: "backoffice", objectId: "people", multiple: true, value: null };
  const linked = { ...reference, value: { directoryId: "local:field-fixture", recordIds: [alice.id] } };
  const populated: ProjectField[] = [
    linked, { ...empty, value: "Check the governing-law clause" },
    { id: "budget", label: "Budget", labelSource: "custom", type: "number", value: 0 },
    { id: "due", label: "Due date", labelSource: "custom", type: "date", value: "2026-12-15" },
    { id: "stage", label: "Stage", labelSource: "custom", type: "select", options: ["Draft", "Approved"], value: "Approved" },
  ];
  await render(<ProjectMetadata client={client} details={{ fields: populated }} showTemplates={false} onSave={save} onCancel={close} />);
  await type(t("projects.field_name"), "Expert witnesses");
  await type(t("projects.options"), "Draft, Approved, Closed");
  await click(t("projects.save"));
  assert.deepEqual(lastSave(), [
    { ...linked, label: "Expert witnesses" }, ...populated.slice(1, -1), { ...populated[4], options: ["Draft", "Approved", "Closed"] },
  ], "Editing field definitions preserves every project value and the original record IDs");
  assert.equal(recordWrites, 0);

  const choice: ProjectField = { id: "stage", label: "Stage", labelSource: "custom", type: "select", options: ["Draft", "Approved"], value: null };
  const remoteChoice = { ...choice, options: ["Remote choice"] };
  await render(<ProjectMetadata client={client} details={{ fields: [choice] }} showTemplates={false}
    onSave={async () => { throw new LegalworkServerError(409, "project_changed", "Changed elsewhere"); }}
    onReload={async () => ({ fields: [remoteChoice] })} onCancel={close} />);
  await type(t("projects.options"), "Local draft choice"); await click(t("projects.save"));
  await click(t("projects.reload_fields"));
  assert.equal(input(t("projects.options")).value, "Remote choice", "Explicit reload resets the option input as well as the underlying field definition");

  await render(<ProjectMetadata client={client} details={{ fields: [{ ...empty, value: "Project-specific content" }] }} isTemplate onSave={save} onCancel={close} />);
  await click(t("projects.save")); assert.deepEqual(lastSave(), [empty], "Template definitions do not inherit project content");

  const primary: ProjectField = { id: "matter", label: "Matters", labelSource: "suggested", type: "backoffice", objectId: "matters", multiple: true, quickAction: true, value: null };
  const values: { id: string; value: ProjectField["value"] }[] = [];
  await render(<ProjectProperties client={client} fields={[empty, reference, primary]} onSave={async (id, value) => { values.push({ id, value }); }} />);
  assert.ok(document.body.textContent?.includes(empty.label), "An intentionally empty custom field remains visible");
  assert.ok(document.body.textContent?.includes(reference.label), "An intentionally empty reference role remains visible");
  assert.equal(button("Edit Matters").textContent?.trim(), t("projects.empty_value"));
  assert.ok(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === "Add Matter"));
  await click(t("projects.edit_value", { name: empty.label }));
  await type(empty.label, "Filled from Home"); await key(empty.label, "Enter");
  assert.deepEqual(values, [{ id: empty.id, value: "Filled from Home" }]);

  const quickRole = { ...reference, quickAction: true };
  await render(<ProjectMetadata client={client} details={{ fields: [reference] }} isTemplate onSave={save} onCancel={close} />);
  const toggle = [...document.querySelectorAll("label")].find(label => label.textContent?.includes(t("projects.field_quick_action")))?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.ok(toggle); await act(async () => toggle.click()); await click(t("projects.save"));
  assert.deepEqual(lastSave(), [quickRole]);
  const oldValues: ProjectField["value"][] = [], freshValues: ProjectField["value"][] = [];
  await render(<ProjectProperties client={client} fields={[quickRole]} onSave={async (_id, value) => {
    oldValues.push(value); throw new LegalworkServerError(409, "project_changed", "Changed elsewhere");
  }} />);
  await click("Edit Witnesses");
  const peopleSearch = t("back_office.create.search", { name: reference.label });
  await type(peopleSearch, "Alice");
  await render(<ProjectProperties client={client} fields={[quickRole]} onSave={async (_id, value) => { freshValues.push(value); }} />, true);
  await key(peopleSearch, "Enter");
  assert.equal(oldValues.length, 0, "A multi-record click uses the latest save callback");
  assert.deepEqual(freshValues, [{ directoryId: "local:field-fixture", recordIds: [alice.id] }]);
  await key(peopleSearch, "Escape");
  const single = { ...quickRole, multiple: false };
  await render(<ProjectProperties client={client} fields={[single]} onSave={async (_id, value) => { freshValues.push(value); }} />);
  await click("Edit Witnesses");
  await type(peopleSearch, "Alice");
  const candidate = document.querySelector<HTMLButtonElement>('.bo-choices [role="option"]');
  assert.ok(candidate?.textContent?.includes("Alice"));
  await act(async () => candidate!.click());
  assert.equal(freshValues.length, 2, "A single selection saves directly from the dropdown");
  assert.deepEqual(freshValues[1], { directoryId: "local:field-fixture", recordIds: [alice.id] });
  assert.equal(document.querySelector(".bo-editor-popup"), null);
  console.log("Project field flow passed");
} finally { await act(async () => root.unmount()); cache.clear(); store.close(); await window.happyDOM.close(); }
