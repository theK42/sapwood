// Your own order of the types on the entity page: kept in this browser, by the types' stable
// schema IDs (so a renamed type keeps its place). Types you haven't placed (new ones) follow
// in the schema's order. The schema's own order is shared, and changed on the Schema page.

const KEY = "sapwood.typeOrder";

/** The saved order (type IDs), or [] when there's none or storage can't be read. */
export function savedOrder(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Keep an order ([] forgets it: back to the schema's). */
export function saveOrder(ids: string[]): void {
  try {
    if (ids.length) localStorage.setItem(KEY, JSON.stringify(ids));
    else localStorage.removeItem(KEY);
  } catch {
    // kept for this page only
  }
}

/** Items in the saved order; those it doesn't name after them, as they came. */
export function inOrder<T extends { id: string }>(items: readonly T[], saved: readonly string[]): T[] {
  const at = new Map(saved.map((id, i) => [id, i]));
  const placed = items.filter((x) => at.has(x.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...placed, ...items.filter((x) => !at.has(x.id))];
}

/** The order after moving `id` just before or after `target` (IDs, as shown now). */
export function moveIn(shown: readonly string[], id: string, target: string, where: "before" | "after"): string[] {
  if (id === target) return [...shown];
  const rest = shown.filter((x) => x !== id);
  const i = rest.indexOf(target);
  if (i < 0) return [...shown];
  rest.splice(where === "after" ? i + 1 : i, 0, id);
  return rest;
}
