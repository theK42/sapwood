// A list whose items can be put in a new order: dragged above or below one another, or moved
// with Alt+↑ and Alt+↓ on a focused item. Used where order is shared and edited (the Schema
// page's definitions, rules and fields). A line shows where a dragged item would land.

import { useState, type DragEvent, type KeyboardEvent } from "react";

export type Where = "before" | "after";

/** The order after moving `id` just before or after `target`. */
export function reordered<T>(list: readonly T[], key: (x: T) => string, id: string, target: string, where: Where): T[] {
  const me = list.find((x) => key(x) === id);
  if (!me || id === target) return [...list];
  const rest = list.filter((x) => key(x) !== id);
  const i = rest.findIndex((x) => key(x) === target);
  if (i < 0) return [...list];
  rest.splice(where === "after" ? i + 1 : i, 0, me);
  return rest;
}

/**
 * Drag and keyboard handling for one list (or several, with `together` saying which items
 * share one: an item is only dropped beside those). `item(id, ids)` gives an item's props (on its
 * <li>); `keys(id, ids)` an Alt+↑↓ handler (for the focusable thing inside it).
 */
export function useReorder(enabled: boolean, move: (id: string, target: string, where: Where) => void, together: (a: string, b: string) => boolean = () => true) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; where: Where } | null>(null);
  const item = (id: string) =>
    !enabled
      ? {}
      : {
          draggable: true,
          className: `${drag === id ? "dragging" : ""}${over?.id === id ? ` drop-${over.where}` : ""}`,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", id);
            setDrag(id);
          },
          onDragEnd: () => (setDrag(null), setOver(null)),
          onDragOver: (e: DragEvent) => {
            if (drag === null || !together(drag, id)) return;
            e.preventDefault();
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const where: Where = e.clientY < r.top + r.height / 2 ? "before" : "after";
            if (over?.id !== id || over.where !== where) setOver({ id, where });
          },
          onDrop: (e: DragEvent) => {
            e.preventDefault();
            if (drag !== null && over && drag !== over.id) move(drag, over.id, over.where);
            setDrag(null);
            setOver(null);
          },
        };
  const keys = (id: string, ids: readonly string[]) => (e: KeyboardEvent<HTMLElement>) => {
    if (!enabled || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const i = ids.indexOf(id);
    const j = e.key === "ArrowUp" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ids.length) return;
    move(id, ids[j]!, e.key === "ArrowUp" ? "before" : "after");
    const el = e.currentTarget;
    requestAnimationFrame(() => el.focus());
  };
  return { item, keys };
}
