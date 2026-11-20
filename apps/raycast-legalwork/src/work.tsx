import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useState } from "react";
import { launch, readPairing, request, type Pairing, type WorkItem } from "./legalwork";
import { requireCurrentPairing } from "./pairing";
import { completedLabel, label } from "./status-labels";

const STATUS = {
  "input-required": { label: label("Input required", "Eingabe erforderlich"), icon: Icon.QuestionMark, color: Color.Orange },
  running: { label: label("Running", "Läuft"), icon: Icon.CircleProgress, color: Color.Blue },
  queued: { label: label("Queued", "Wartend"), icon: Icon.Clock, color: Color.SecondaryText },
  idle: { label: label("Idle", "Inaktiv"), icon: Icon.Circle, color: Color.SecondaryText },
  returned: { label: completedLabel, icon: Icon.CheckCircle, color: Color.Green },
  failed: { label: label("Failed", "Fehlgeschlagen"), icon: Icon.XMarkCircle, color: Color.Red },
  stopped: { label: label("Stopped", "Gestoppt"), icon: Icon.Stop, color: Color.SecondaryText },
  unavailable: { label: label("Unavailable", "Nicht verfügbar"), icon: Icon.Warning, color: Color.Orange },
} satisfies Record<WorkItem["status"], { label: string; icon: Icon; color: Color }>;

export default function Command() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [results, setResults] = useState<{ pairing: Pairing; items: WorkItem[] } | null>(null);
  const items = results?.items ?? [];
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(null); setResults(null);
    void readPairing().then(async found => {
      if (controller.signal.aborted) return;
      setPairing(found);
      if (!found) return;
      const work: WorkItem[] = []; let snapshot: string | undefined; let offset: number | null = 0;
      do {
        const page: { items: WorkItem[]; nextOffset: number | null; snapshot?: string } = await request(found, `/assistant/work?limit=100&offset=${offset}${snapshot ? "&snapshot=" + encodeURIComponent(snapshot) : ""}`, { signal: controller.signal });
        snapshot = page.snapshot; work.push(...page.items);
        const next = page.nextOffset ?? null;
        if (next !== null && next <= offset) throw new Error("LegalWork returned an invalid work page. Refresh to try again.");
        offset = next;
      } while (offset !== null);
      if (!controller.signal.aborted) setResults({ pairing: found, items: work });
    }).catch(reason => { if (!controller.signal.aborted) { setResults(null); setError(reason instanceof Error ? reason.message : String(reason)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [refresh]);
  const openWork = async (item: WorkItem, origin = false) => {
    if (!results) return;
    try {
      const found = await requireCurrentPairing(results.pairing, "Refresh Work");
      await launch(origin ? { action: "resume", conversationId: item.originConversationId ?? undefined } : {
        action: "open", result: { kind: "chats", id: item.sessionId, workspaceId: item.workspaceId, sourceId: `local:${item.workspaceId}`, sessionId: item.sessionId },
      }, found);
    } catch (reason) { await showToast({ style: Toast.Style.Failure, title: "Could not open work", message: reason instanceof Error ? reason.message : String(reason) }); }
  };
  const refreshAction = <Action title="Refresh Work" icon={Icon.ArrowClockwise} onAction={() => setRefresh(value => value + 1)} />;
  if (pairing === null) return <List><List.EmptyView title="LegalWork is not paired" description="Enable Raycast pairing in LegalWork Settings, Assistant launcher." actions={<ActionPanel>{refreshAction}</ActionPanel>} /></List>;
  return <List isLoading={loading} searchBarPlaceholder="Delegated work">
    {items.map(item => <List.Item key={item.id} icon={{ source: STATUS[item.status].icon, tintColor: STATUS[item.status].color }} title={item.title} subtitle={item.projectName} accessories={[{ tag: { value: STATUS[item.status].label, color: STATUS[item.status].color } }]}
      actions={<ActionPanel><Action title="Open in LegalWork" icon={Icon.ArrowRight} onAction={() => void openWork(item)} />{item.originConversationId && <Action title="Open Origin Conversation" icon={Icon.Message} onAction={() => void openWork(item, true)} />}{refreshAction}</ActionPanel>} />)}
    {!loading && !items.length && <List.EmptyView title={error ? "Work unavailable" : "No delegated work"} description={error ?? "Work the Assistant starts in your projects appears here."} actions={<ActionPanel>{refreshAction}</ActionPanel>} />}
  </List>;
}
