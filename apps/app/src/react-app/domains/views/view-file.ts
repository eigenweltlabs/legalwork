import { StoredViewSchema, viewCopyInput, type ViewSummary, type ViewRecord, type ViewInput } from "@legalwork/types/views";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { viewInput } from "./view-save";

export async function renameView(client: Pick<LegalworkServerClient, "readView" | "updateView">, view: ViewSummary, title: string) {
  const current = await client.readView(view.owner, view.id);
  if (current.revision !== view.revision) throw new LegalworkServerError(409, "view_revision_conflict", "This dashboard changed. Reopen Rename to use its latest version.");
  return client.updateView(view.owner, view.id, { baseRevision: view.revision, input: { ...viewInput(current), title: title.trim() } });
}

export async function snapshotView(client: Pick<LegalworkServerClient, "queryWiki" | "baseUrl">, view: ViewRecord): Promise<ViewInput> {
  const datasets = { ...view.datasets };
  for (const [name, query] of Object.entries(view.queries)) {
    if (view.mode === "report") continue;
    if (view.owner.kind !== "wiki") throw new Error("This dashboard's original wiki is unavailable. Export a snapshot from its source wiki.");
    datasets[name] = { ...await client.queryWiki(view.owner.id, query), sourceOwner: view.owner, sourceServerUrl: client.baseUrl };
  }
  return viewCopyInput({ ...viewInput(view), datasets }, { owner: view.owner, serverUrl: client.baseUrl });
}

export async function exportViewFile(client: LegalworkServerClient, view: Pick<ViewSummary, "owner" | "id">) {
  const current = await client.readView(view.owner, view.id);
  const input = await snapshotView(client, current);
  return new TextEncoder().encode(`${JSON.stringify({ ...input, id: current.id, updatedAt: current.updatedAt }, null, 2)}\n`).buffer;
}

export async function prepareViewFileCopy(client: LegalworkServerClient, workspaceId: string, bytes: ArrayBuffer): Promise<ArrayBuffer> {
  // The repository validates the full saved record, including legacy metadata.
  const record = StoredViewSchema.pick({ id: true }).strip().parse(JSON.parse(new TextDecoder().decode(bytes)));
  const wiki = (await client.listWikis()).items.find(wiki => wiki.workspaceId === workspaceId);
  return exportViewFile(client, { id: record.id, owner: wiki ? { kind: "wiki", id: wiki.id } : { kind: "workspace", id: workspaceId } });
}

export async function downloadViewFile(client: LegalworkServerClient, view: ViewSummary) {
  const data = await exportViewFile(client, view);
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = `${view.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")}.view.json`;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
