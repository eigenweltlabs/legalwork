/** Keep the selected visible document addressable while its chat composer has focus. */
export function documentControlTarget(visibleIds: readonly string[], focusedId: string | null | undefined, lastDocumentId: string | null) {
  if (focusedId && visibleIds.includes(focusedId)) return focusedId;
  if (lastDocumentId && visibleIds.includes(lastDocumentId)) return lastDocumentId;
  return visibleIds[0] ?? null;
}
