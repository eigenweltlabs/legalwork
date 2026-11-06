import { Action, ActionPanel, Clipboard, getSelectedText, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { launch, readPairing, request, type CatalogEntry, type Pairing } from "./legalwork";

/** Saved quick actions run through the same catalog and staged-context path as the native panel. */
export default function Command() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  useEffect(() => { void readPairing().then(async found => { setPairing(found); if (found) setEntries((await request<{ entries: CatalogEntry[] }>(found, "/launcher/catalog")).entries.filter(entry => entry.source === "quick-action")); }); }, []);
  const run = async (entry: CatalogEntry) => {
    if (!pairing) return;
    try {
      let selection = "";
      if (entry.requires.includes("selection")) { try { selection = (await getSelectedText()).trim(); } catch { selection = ""; } }
      const clipboard = entry.requires.includes("clipboard") ? ((await Clipboard.readText()) ?? "").trim() : "";
      const items = [...(selection ? [{ id: `sel_${Date.now().toString(36)}`, type: "selection", text: selection.slice(0, 200_000), sourceApp: null, sourceWindow: null, capturedAt: Date.now() }] : []), ...(clipboard ? [{ id: `clip_${Date.now().toString(36)}`, type: "clipboard", text: clipboard.slice(0, 200_000), capturedAt: Date.now() }] : [])];
      const staged = items.length ? await request<{ id: string }>(pairing, "/launcher/context", { method: "POST", body: { items, source: "raycast" } }) : null;
      await launch("quick-action", { action: entry.id, context: staged?.id });
    } catch (error) { await showToast({ style: Toast.Style.Failure, title: "Quick action failed", message: error instanceof Error ? error.message : String(error) }); }
  };
  if (pairing === null) return <List><List.EmptyView title="LegalWork is not paired" description="Enable Raycast pairing in LegalWork Settings, Assistant launcher." /></List>;
  return <List isLoading={pairing === undefined} searchBarPlaceholder="Run a saved quick action">
    {entries.map(entry => <List.Item key={entry.id} icon={entry.favorite ? Icon.Star : Icon.Bolt} title={entry.label} subtitle={entry.requires.length ? `Needs ${entry.requires.join(", ")}` : undefined} actions={<ActionPanel><Action title="Run in LegalWork" icon={Icon.Play} onAction={() => void run(entry)} /></ActionPanel>} />)}
    {pairing && !entries.length && <List.EmptyView title="No quick actions yet" description="Save one in LegalWork Settings, Assistant launcher." />}
  </List>;
}
