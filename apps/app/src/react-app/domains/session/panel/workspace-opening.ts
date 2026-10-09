import type { PanelTab, SessionPanelState } from "./panel-tab-store";
import { MAX_DOCUMENT_PANES, type DocumentLayoutNode, type DocumentDropEdge } from "./document-layout";

export type WorkspaceOpening = {
  mode: "chat-content" | "free";
  chatSide: "left" | "right";
  newContent: "active" | "beside";
};
export const DEFAULT_WORKSPACE_OPENING: WorkspaceOpening = { mode: "chat-content", chatSide: "left", newContent: "active" };
export const MIN_AUTO_SPLIT_WIDTH = 800;

export function restoreWorkspaceOpening(value: unknown): WorkspaceOpening {
  if (!value || typeof value !== "object") return { ...DEFAULT_WORKSPACE_OPENING };
  return {
    mode: "mode" in value && value.mode === "free" ? "free" : "chat-content",
    chatSide: "chatSide" in value && value.chatSide === "right" ? "right" : "left",
    newContent: "newContent" in value && value.newContent === "beside" ? "beside" : "active",
  };
}

function columns(tree: DocumentLayoutNode): number {
  if (tree.type === "pane") return 1;
  return tree.direction === "horizontal" ? columns(tree.first) + columns(tree.second) : Math.max(columns(tree.first), columns(tree.second));
}

/** Positions follow the actual split tree, including stacked and resized panes. */
function positions(session: SessionPanelState, node = session.tree, left = 0, width = 1): Array<{ id: string; left: number; width: number }> {
  if (node.type === "pane") return [{ id: node.id, left, width }];
  if (node.direction === "vertical") return [...positions(session, node.first, left, width), ...positions(session, node.second, left, width)];
  const fraction = (session.sizes[node.id]?.[node.first.id] ?? 50) / 100;
  return [...positions(session, node.first, left, width * fraction), ...positions(session, node.second, left + width * fraction, width * (1 - fraction))];
}

export function automaticTabDestination(session: SessionPanelState, tab: PanelTab, opening: WorkspaceOpening, width: number): { pane?: string; edge?: DocumentDropEdge } {
  const active = session.panes.find(pane => pane.id === session.focusedPaneId) ?? session.panes[0];
  if (!session.tabs.length) return { pane: active.id };
  const geometry = positions(session);
  const activePosition = geometry.find(pane => pane.id === active.id)!;
  const canSplit = session.panes.length < MAX_DOCUMENT_PANES && columns(session.tree) === 1 && width * activePosition.width >= MIN_AUTO_SPLIT_WIDTH;
  if (opening.mode === "free") {
    if (opening.newContent === "active") return { pane: active.id };
    const right = geometry.find(pane => pane.left >= activePosition.left + activePosition.width - 0.001 && pane.id !== active.id);
    return right ? { pane: right.id } : { pane: active.id, edge: canSplit ? "right" : undefined };
  }
  const chat = tab.type === "chat";
  const side = chat ? opening.chatSide : opening.chatSide === "left" ? "right" : "left";
  const ordered = [...geometry].sort((a, b) => side === "left" ? a.left - b.left : b.left + b.width - a.left - a.width);
  // Explicit drags are exceptions, not new opening rules. Once columns exist,
  // reserve the outer column for chats and use the remaining columns for content.
  // Full-width groups above/below those columns remain manual destinations.
  const columnPanes = ordered.filter(pane => pane.width < 1 - 1e-9);
  if (columnPanes.length) {
    const candidates = columnPanes.filter(pane => {
      const onChatSide = opening.chatSide === "left" ? pane.left < 1e-9 : pane.left + pane.width > 1 - 1e-9;
      return onChatSide === chat;
    });
    return { pane: (candidates.find(pane => pane.id === active.id) ?? candidates[0]).id };
  }
  // In a single column, reuse an unmixed group. A mixed group can acquire the
  // missing side once there is room, without moving any of its existing tabs.
  const matches = session.panes.filter(pane => pane.tabIds.length > 0 && pane.tabIds.every(id => session.tabs.some(item => item.id === id && (item.type === "chat") === chat)));
  if (matches.some(pane => pane.id === active.id)) return { pane: active.id };
  const match = ordered.find(pane => matches.some(item => item.id === pane.id));
  if (match) return { pane: match.id };
  if (canSplit) return { pane: active.id, edge: side };
  return { pane: ordered[0].id };
}
