/** Keep the user's ordering of surviving drafts; newly queued drafts go last. */
export function reconcileQueuedOrder(order: string[], current: string[]) {
  return [...new Set([...order.filter(id => current.includes(id)), ...current])];
}
