import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import type { BackOfficeRecord, BackOfficeValue, BackOfficeView } from "@legalwork/types/back-office";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><head></head><body></body></html>");
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
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
function Row({ record, popup = false, sheet = false, column = field }: { record: BackOfficeRecord; popup?: boolean; sheet?: boolean; column?: typeof field }) {
  const [editing, setEditing] = useState<EditingCell | null>(null);
  return <RecordGridRow sheet={sheet} record={record} index={0} template="32px 200px" fields={[popup ? nameField : column]}
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
  const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`input[aria-label="${label}"], textarea[aria-label="${label}"]`);
  assert.ok(element, `Missing input ${label}`);
  return element;
}
async function type(label: string, text: string) {
  await act(async () => {
    const element = input(label);
    element.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
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
  await render(<RecordDetail client={client} team={false} historyAccessKey="local" record={original}
    object={{ ...object, fields: [...object.fields.filter(item => item.id !== field.id), field] }} records={[original]}
    editable finance userId="owner" width={400} onWidthChange={() => {}} onClose={() => {}} onOpen={() => {}} onSave={onSave} />);
  const editNotes = document.querySelector<HTMLButtonElement>('button[aria-label="Edit Notes"]');
  assert.ok(editNotes);
  await act(async () => editNotes.click());
  assert.equal(input("Notes").tagName, "TEXTAREA");
  await type("Notes", "First line\nSecond line");
  await act(async () => input("Notes").closest("form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(saved[0].values.notes, "First line\nSecond line");

  await reset();
  const timeObject = defaultBackOfficeModel().objects.find(item => item.id === "timeEntries");
  assert.ok(timeObject);
  const timeRecord = { ...original, objectId: "timeEntries", values: { name: "Saved entry", billingNarrative: "Reviewed a clause" } };
  const archives: BackOfficeRecord[] = [];
  const timeDetail = (record: BackOfficeRecord) => <RecordDetail client={client} team={false} historyAccessKey="local" record={record}
    object={timeObject} records={[record]} editable finance userId="owner" width={400} onWidthChange={() => {}}
    onClose={() => {}} onOpen={() => {}} onSave={async (entry, _values, archive) => { if (archive) archives.push(entry); }} />;
  await render(timeDetail(timeRecord));
  const archiveDetail = async () => {
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Record options"]')!.click());
    const action = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === "Archive record");
    assert.ok(action);
    await act(async () => action.click());
  };
  const removalButton = (label: string) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(item => item.textContent?.trim() === label);
    assert.ok(button);
    return button;
  };
  await archiveDetail();
  assert.equal(archives.length, 0);
  await act(async () => removalButton("Cancel").click());
  assert.equal(archives.length, 0);
  await archiveDetail();
  await render(timeDetail({ ...timeRecord, revision: 2, values: { ...timeRecord.values, name: "Changed elsewhere" } }));
  await act(async () => removalButton("Remove").click());
  assert.equal(archives.length, 1);
  assert.equal(archives[0].revision, 1, "deletion stays bound to the reviewed version for the server's revision check");

  await reset();
  const view = BackOfficeViewSchema.parse({ id: crypto.randomUUID(), objectId: "matters", name: "Original view", columns: ["name"] });
  const viewWrites: { view: BackOfficeView; expected: BackOfficeView | null }[] = [];
  const grid = (current: BackOfficeView, scope = "editing-fixture") => <MemoryRouter initialEntries={[`/?viewId=${view.id}`]}>
    <RecordGrid columnScope={scope} object={object} records={[original]} views={[current]} editable finance userId="owner" archived={false}
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
  await reset();
  await render(grid(view));
  const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === "Options");
  assert.ok(toggle);
  await act(async () => toggle.click());
  const fieldLabel = object.fields.find(field => field.id === "fileNumber")!.label;
  const extra = [...document.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(item => item.textContent?.trim() === fieldLabel);
  assert.ok(extra);
  await act(async () => extra.click());
  const hasFileNumber = () => Boolean(host.querySelector('[role="columnheader"][data-field="fileNumber"]'));
  assert.ok(hasFileNumber());
  await reset();
  await render(grid(view));
  assert.ok(hasFileNumber(), "A named view retains the person's column choices");
  await reset();
  await render(grid(view, "another-account"));
  assert.equal(hasFileNumber(), false);
  await reset();
  await render(grid({ ...view, columns: ["name", "status"] }));
  assert.equal(hasFileNumber(), false, "A changed shared layout supersedes the previous personal overlay");
  await reset();
  fail = false;
  function Sheet() {
    const [record, setRecord] = useState(original);
    return <MemoryRouter><RecordGrid columnScope="editing-fixture" object={{ ...object!, fields: [nameField, field] }} records={[record]} views={[]}
      sheet={{ columns: ["name", "notes"], blankId: "new" }} editable finance userId="owner" archived={false}
      onArchivedChange={() => {}} onOpen={() => {}} onCreate={() => {}}
      onSave={async (base, patch) => { await onSave(base, patch); setRecord(current => ({ ...current, values: { ...current.values, ...patch }, revision: current.revision + 1 })); }}
      onSaveView={async view => view} /></MemoryRouter>;
  }
  await render(<Sheet />);
  await openCell();
  await type("Name", "Keyboard edit");
  await act(async () => input("Name").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(saved.at(-1)?.values.name, "Keyboard edit");
  assert.equal(document.activeElement, input("Notes"), "Tab commits then opens the cell to the right");
  await type("Notes", "Reverse navigation");
  await act(async () => input("Notes").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  assert.equal(saved.at(-1)?.values.notes, "Reverse navigation");
  assert.equal(document.activeElement, input("Name"), "Shift+Tab opens the preceding cell");
  assert.equal(input("Name").value, "Keyboard edit");
  await reset();
  await render(<Row sheet record={{ ...original, revision: 0 }} />);
  await openCell();
  await act(async () => input("Notes").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  assert.equal(saved.length, 1, "Tab confirms a copied private row even when its cell is unchanged");
  assert.equal(saved[0].values.notes, original.values.notes);
  await reset();
  const textList = BackOfficeFieldSchema.parse({ id: "items", label: "Items", type: "textList" });
  const linkList = BackOfficeFieldSchema.parse({ id: "links", label: "Links", type: "linkList" });
  const listRecord = { ...original, values: { ...original.values, items: ["North, West", "South"], links: [{ label: "Guide", url: "https://example.test/guide" }] } };
  const button = (label: string) => {
    const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label || button.textContent?.trim() === label);
    assert.ok(element, label);
    return act(async () => element.click());
  };
  await render(<Row record={listRecord} column={textList} />);
  assert.deepEqual([...host.querySelectorAll('[role="listitem"]')].map(item => item.textContent), ["North, West", "South"]);
  await openCell();
  await button("Add item");
  await type("Item 3", "East, Ridge");
  await button("Remove item 2");
  await button("Move down");
  await render(<Row record={{ ...listRecord, revision: 2 }} column={textList} />);
  await button("Save");
  assert.deepEqual(saved[0].values.items, ["East, Ridge", "North, West"]);
  assert.equal(saved[0].record.revision, 1);

  await reset();
  const openedUrls: string[] = [];
  Object.defineProperty(window, "__LEGALWORK_ELECTRON__", { configurable: true, value: { shell: { openExternal: async (url: string) => { openedUrls.push(url); } } } });
  const verifyLink = async () => {
    const link = host.querySelector<HTMLAnchorElement>('a[href="https://example.test/guide"]');
    assert.equal(link?.textContent, "Guide");
    assert.equal(link.closest("button"), null);
    await act(async () => link.click());
    assert.equal(document.querySelector('input[type="url"]'), null, "Opening a link must not edit the field");
  };
  await render(<Row record={listRecord} column={linkList} />);
  assert.deepEqual(openedUrls, []);
  await verifyLink();
  await reset();
  const linksDetail = (editable: boolean) => <RecordDetail client={client} team={false} historyAccessKey="local" record={listRecord}
    object={{ ...object, fields: [nameField, linkList] }} records={[listRecord]} editable={editable} finance userId="owner" width={400}
    onWidthChange={() => {}} onClose={() => {}} onOpen={() => {}} onSave={onSave} />;
  await render(linksDetail(false));
  await verifyLink();
  assert.deepEqual(openedUrls, [listRecord.values.links[0].url, listRecord.values.links[0].url]);
  await render(linksDetail(true));
  await button("Edit Links");
  await type("Web address 1", "ftp://example.test/guide");
  await button("Save");
  assert.equal(saved.length, 0);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /https:/);
  await type("Web address 1", "http://example.test/other");
  await type("Link label 1", "Other guide");
  await button("Save");
  assert.deepEqual(saved[0].values.links, [{ label: "Other guide", url: "http://example.test/other" }]);
  console.log("All editing regressions passed");
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.close();
}
