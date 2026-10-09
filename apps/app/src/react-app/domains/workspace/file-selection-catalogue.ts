export function fileSelectionCatalogue<T extends { key: string }>(collections: T[][], mounted: T[]) {
  return new Map([...collections.flat(), ...mounted].map(item => [item.key, item]));
}

/** Ranges stay in one logical list; scrolling does not change virtual row order. */
export function fileSelectionRange(collections: Array<Array<{ key: string }>>, mountedOrder: string[], anchor: string | null, target: string) {
  const collection = collections.find(items => items.some(item => item.key === target));
  const virtualKeys = new Set(collections.flat().map(item => item.key));
  const order = collection ? collection.map(item => item.key) : mountedOrder.filter(key => !virtualKeys.has(key));
  const from = anchor ? order.indexOf(anchor) : -1, to = order.indexOf(target);
  return from >= 0 && to >= 0 ? order.slice(Math.min(from, to), Math.max(from, to) + 1) : null;
}
