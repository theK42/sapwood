// Addresses in the app: /branches/<b>, then the page within the branch.

/** The page within a branch, from the address: /branches/<b>/… */
export type Route =
  | { kind: "home" }
  | { kind: "sheet"; id: string }
  | { kind: "type"; name: string }
  /** The entity page: a type's entities, and one in the form. */
  | { kind: "entities"; type: string | null; id: string | null }
  | { kind: "history" }
  /** The schema editor. */
  | { kind: "schema" }
  | { kind: "commit"; id: string }
  | { kind: "changes"; task: number };

export function routeFromPath(path = location.pathname): Route {
  const m = /^\/branches\/[^/]+\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?/.exec(path);
  if (!m) return { kind: "home" };
  const [, a, b, c] = m;
  const x = b === undefined ? "" : decodeURIComponent(b);
  if (a === "sheets" && x) return { kind: "sheet", id: x };
  if (a === "types" && x) return { kind: "type", name: x };
  if (a === "entities") return { kind: "entities", type: x || null, id: c === undefined ? null : decodeURIComponent(c) };
  if (a === "history" && !x) return { kind: "history" };
  if (a === "schema" && !x) return { kind: "schema" };
  if (a === "commits" && x) return { kind: "commit", id: x };
  if (a === "tasks" && /^\d+$/.test(x) && c === "changes") return { kind: "changes", task: Number(x) };
  return { kind: "home" };
}

export function routePath(branch: string, r: Route): string {
  const e = encodeURIComponent;
  if (r.kind === "entities") return `/branches/${e(branch)}/entities${r.type === null ? "" : `/${e(r.type)}${r.id === null ? "" : `/${e(r.id)}`}`}`;
  const rest = { home: "", sheet: `/sheets/${e((r as { id: string }).id)}`, type: `/types/${e((r as { name: string }).name)}`, history: "/history", schema: "/schema", commit: `/commits/${e((r as { id: string }).id)}`, changes: `/tasks/${(r as { task: number }).task}/changes` }[r.kind];
  return `/branches/${e(branch)}${rest}`;
}

/** The app's tabs (top bar): each page belongs to one. */
export type Tab = "sheets" | "entities" | "schema" | "history";

export const TABS: { tab: Tab; label: string; home: Route }[] = [
  { tab: "sheets", label: "Sheets", home: { kind: "home" } },
  { tab: "entities", label: "Entities", home: { kind: "entities", type: null, id: null } },
  { tab: "schema", label: "Schema", home: { kind: "schema" } },
  { tab: "history", label: "History", home: { kind: "history" } },
];

export function tabOf(r: Route): Tab {
  switch (r.kind) {
    case "entities":
      return "entities";
    case "schema":
      return "schema";
    case "history":
    case "commit":
    case "changes":
      return "history";
    default:
      return "sheets"; // the packs page, a sheet, a type's grid
  }
}

/**
 * Where a tab goes: back to where you were in it, or, if you're in it already, to its first
 * page (the packs page, the entity page's types, …); a tab not visited yet, to its first page.
 */
export function tabTarget(tab: Tab, now: Route, last: Partial<Record<Tab, Route>>): Route {
  const home = TABS.find((t) => t.tab === tab)!.home;
  if (tabOf(now) === tab) return home;
  return last[tab] ?? home;
}
