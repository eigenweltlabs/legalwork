import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { BackOfficeRecord, BackOfficeValue, BackOfficeView } from "@legalwork/types/back-office";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><head></head><body></body></html>");
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
  Element: window.Element, Node: window.Node, Event: window.Event,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });

const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BackOfficeRecordSchema, BackOfficeFieldSchema, BackOfficeViewSchema, defaultBackOfficeModel } = await import("@legalwork/types/back-office");
const { RecordGridRow } = await import("../../src/react-app/domains/back-office/record-grid-row");
const { RecordDetail } = await import("../../src/react-app/domains/back-office/record-detail");
const { RecordGrid } = await import("../../src/react-app/domains/back-office/record-grid");
const { MemoryRouter } = await import("react-router-dom");
const { BackOfficeTheme } = await import("../../src/react-app/domains/back-office/twenty-controls");
const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
type EditingCell = import("../../src/react-app/domains/back-office/record-grid-row").EditingCell;
const field = BackOfficeFieldSchema.parse({ id: "notes", label: "Notes", type: "text" });
const nameField = BackOfficeFieldSchema.parse({ id: "name", label: "Name", type: "text" });
const original = BackOfficeRecordSchema.parse({
  id: crypto.randomUUID(), objectId: "matters", values: { name: "Original", notes: "Initial" },
  revision: 1, schemaRevision: 1, ownerId: "owner", archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});
const updated = { ...original, revision: 2, values: { name: "Colleague's name", notes: "Colleague's notes" } };
const saved: { record: BackOfficeRecord; values: Record<string, BackOfficeValue> }[] = [];
let fail = true;
let failure = "";
const onSave = async (record: BackOfficeRecord, values: Record<string, BackOfficeValue>) => {
  saved.push({ record, values });
  if (fail) throw new Error("Save failed; draft must survive");
};
function Row({ record, popup = false }: { record: BackOfficeRecord; popup?: boolean }) {
  const [editing, setEditing] = useState<EditingCell | null>(null);
  return <RecordGridRow record={record} index={0} template="32px 200px" fields={[popup ? nameField : field]}
    records={[record]} recordById={new Map([[record.id, record]])} editable userId="owner" selected={false}
    editing={editing ?? undefined} onEdit={setEditing} onError={message => { failure = message; }}
    onSelect={() => {}} onMove={() => {}} onOpen={() => {}} onSave={onSave} />;
}
const host = document.createElement("div");
document.body.append(host);
let root = createRoot(host);
const render = async (children: ReactNode) => { await act(async () => { root.render(<BackOfficeTheme>{children}</BackOfficeTheme>); }); };
const reset = async () => {
  await act(async () => root.unmount());
  root = createRoot(host);
  saved.length = 0; failure = "";
};
function input(label: string) {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(element, `Missing input ${label}`);
  return element;
}
async function type(label: string, text: string) {
  await act(async () => {
    const element = input(label);
    element.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    assert.ok(setter);
    setter.call(element, text);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function openCell() {
  const cell = host.querySelector<HTMLElement>('[role="gridcell"]');
  assert.ok(cell);
  await act(async () => cell.click());
}

try {
  await render(<Row record={original} />);
  await openCell();
  await type("Notes", "My unsaved notes");
  await act(async () => input("Notes").blur());
  assert.equal(input("Notes").value, "My unsaved notes");
  assert.match(failure, /Save failed/);
  fail = false;
  await act(async () => input("Notes").focus());
  await act(async () => input("Notes").blur());
  assert.equal(saved.length, 2, "A failed save must be retryable");
  assert.equal(saved[1].values.notes, "My unsaved notes");
  assert.equal(host.querySelector('input[aria-label="Notes"]'), null);

  await reset();
  fail = true;
  await render(<Row record={original} />);
  await openCell();
  await type("Notes", "Draft before refresh");
  await render(<Row record={updated} />);
  assert.equal(input("Notes").value, "Draft before refresh");
  await act(async () => input("Notes").blur());
  assert.equal(saved[0].record.revision, 1, "Save must use the version the user edited");
  assert.equal(saved[0].values.notes, "Draft before refresh");
  assert.equal(input("Notes").value, "Draft before refresh");

  await reset();
  await render(<Row record={original} popup />);
  await openCell();
  await type("Name", "Popup draft");
  await render(<Row record={updated} popup />);
  assert.equal(input("Name").value, "Popup draft", "Refresh must not remount the popup editor");
  const form = input("Name").closest("form");
  assert.ok(form);
  await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(saved[0].record.revision, 1);
  assert.equal(saved[0].values.name, "Popup draft");

  await reset();
  const object = defaultBackOfficeModel().objects.find(object => object.id === "matters");
  assert.ok(object);
  const client = createLegalworkServerClient({ baseUrl: "http://localhost" });
  const detail = (record: BackOfficeRecord) => <RecordDetail client={client} team={false} historyAccessKey="local" record={record}
    object={object} records={[record]} editable finance userId="owner" width={400} onWidthChange={() => {}}
    onClose={() => {}} onOpen={() => {}} onSave={onSave} />;
  await render(detail(original));
  await type("Matter name", "Name draft");
  await render(detail(updated));
  assert.equal(input("Matter name").value, "Name draft");
  await act(async () => input("Matter name").blur());
  assert.equal(saved[0].record.revision, 1);
  assert.equal(input("Matter name").value, "Name draft");

  await reset();
  const view = BackOfficeViewSchema.parse({ id: crypto.randomUUID(), objectId: "matters", name: "Original view", columns: ["name"] });
  const viewWrites: { view: BackOfficeView; expected: BackOfficeView | null }[] = [];
  const grid = (current: BackOfficeView) => <MemoryRouter initialEntries={[`/?viewId=${view.id}`]}>
    <RecordGrid object={object} records={[original]} views={[current]} editable finance userId="owner" archived={false}
      onArchivedChange={() => {}} onOpen={() => {}} onCreate={() => {}} onSave={onSave}
      onSaveView={async (next, expected) => { viewWrites.push({ view: next, expected }); throw new Error("View conflict"); }} />
  </MemoryRouter>;
  await render(grid(view));
  await type("Search records", "My filter");
  await render(grid({ ...view, name: "Renamed elsewhere" }));
  const options = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "Options");
  assert.ok(options);
  await act(async () => options.click());
  const saveView = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === "Save view");
  assert.ok(saveView);
  await act(async () => saveView.click());
  assert.equal(viewWrites.length, 1);
  assert.deepEqual(viewWrites[0].expected, view, "A refresh must not silently advance the settings' base");
  assert.equal(viewWrites[0].view.query, "My filter");
  assert.equal(input("Search records").value, "My filter", "A view conflict must preserve unsaved settings");
  console.log("All editing regressions passed");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.close();
}
