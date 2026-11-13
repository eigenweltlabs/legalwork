import { Action, ActionPanel, Clipboard, getSelectedText, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { launch, readPairing, requirePairing, request, type CatalogEntry, type Pairing } from "./legalwork";

/** Saved quick actions run through the same catalog and staged-context path as the native panel. */
export default function Command() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null);
    void readPairing().then(async found => {
      if (controller.signal.aborted) return;
      setPairing(found);
      if (!found) { setEntries([]); return; }
      const response = await request<{ entries: CatalogEntry[] }>(found, "/launcher/catalog", { signal: controller.signal });
      if (!controller.signal.aborted) setEntries(response.entries.filter(entry => entry.source === "quick-action"));
    }).catch(reason => { if (!controller.signal.aborted) { setEntries([]); setError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  const run = async (entry: CatalogEntry) => {
    const found = await requirePairing();
    if (!found) return;
    try {
      let selection = "";
      if (entry.requires.includes("selection")) { try { selection = (await getSelectedText()).trim(); } catch { selection = ""; } }
      const clipboard = entry.requires.includes("clipboard") ? ((await Clipboard.readText()) ?? "").trim() : "";
      const items = [...(selection ? [{ id: `sel_${Date.now().toString(36)}`, type: "selection", text: selection.slice(0, 200_000), sourceApp: null, sourceWindow: null, capturedAt: Date.now() }] : []), ...(clipboard ? [{ id: `clip_${Date.now().toString(36)}`, type: "clipboard", text: clipboard.slice(0, 200_000), capturedAt: Date.now() }] : [])];
      const staged = items.length ? await request<{ id: string }>(found, "/launcher/context", { method: "POST", body: { items, source: "raycast" } }) : null;
      await launch("quick-action", { action: entry.id, context: staged?.id }, found);
    } catch (error) { await showToast({ style: Toast.Style.Failure, title: "Quick action failed", message: error instanceof Error ? error.message : String(error) }); }
  };
  const refreshAction = <Action title="Refresh Actions" icon={Icon.ArrowClockwise} onAction={() => setRefresh(value => value + 1)} />;
  if (pairing === null) return <List><List.EmptyView title="LegalWork is not paired" description="Enable Raycast pairing in LegalWork Settings, Assistant launcher." actions={<ActionPanel>{refreshAction}</ActionPanel>} /></List>;
  return <List isLoading={loading} searchBarPlaceholder="Run a saved quick action">
    {entries.map(entry => <List.Item key={entry.id} icon={entry.favorite ? Icon.Star : Icon.Bolt} title={entry.label} subtitle={entry.requires.length ? `Needs ${entry.requires.join(", ")}` : undefined} actions={<ActionPanel><Action title="Run in LegalWork" icon={Icon.Play} onAction={() => void run(entry)} />{refreshAction}</ActionPanel>} />)}
    {!loading && !entries.length && <List.EmptyView title={error ? "Quick actions unavailable" : "No quick actions yet"} description={error ?? "Save one in LegalWork Settings, Assistant launcher."} actions={<ActionPanel>{refreshAction}</ActionPanel>} />}
  </List>;
}
