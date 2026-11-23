// Addresses in the app: /branches/<b>, then the page within the branch.

/** The page within a branch, from the address: /branches/<b>/… */
export type Route =
  | { kind: "home" }
  | { kind: "sheet"; id: string }
  | { kind: "type"; name: string }
  | { kind: "history" }
  | { kind: "commit"; id: string }
  | { kind: "changes"; task: number };

export function routeFromPath(path = location.pathname): Route {
  const m = /^\/branches\/[^/]+\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?/.exec(path);
  if (!m) return { kind: "home" };
  const [, a, b, c] = m;
  const x = b === undefined ? "" : decodeURIComponent(b);
  if (a === "sheets" && x) return { kind: "sheet", id: x };
  if (a === "types" && x) return { kind: "type", name: x };
  if (a === "history" && !x) return { kind: "history" };
  if (a === "commits" && x) return { kind: "commit", id: x };
  if (a === "tasks" && /^\d+$/.test(x) && c === "changes") return { kind: "changes", task: Number(x) };
  return { kind: "home" };
}

export function routePath(branch: string, r: Route): string {
  const e = encodeURIComponent;
  const rest = { home: "", sheet: `/sheets/${e((r as { id: string }).id)}`, type: `/types/${e((r as { name: string }).name)}`, history: "/history", commit: `/commits/${e((r as { id: string }).id)}`, changes: `/tasks/${(r as { task: number }).task}/changes` }[r.kind];
  return `/branches/${e(branch)}${rest}`;
}
