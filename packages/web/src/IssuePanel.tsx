// The validation panel (DESIGN §9.2): every issue in your task (or at the head), beside the
// home page or the sheet. Clicking one opens its sheet at its cell.

import { useMemo, useState } from "react";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { issueList, type IssueItem } from "./issues.ts";

interface Props {
  source: Source;
  /** The open sheet, if any: the panel can keep to it. */
  sheet: string | null;
  jump(item: IssueItem): void;
  close(): void;
}

type Show = "all" | "error" | "warning";

export function IssuePanel(p: Props) {
  const tick = useSource(p.source);
  const all = useMemo(() => issueList(p.source.project), [p.source, tick]);
  const [show, setShow] = useState<Show>("all");
  const [here, setHere] = useState(false);
  const errors = all.filter((x) => x.issue.level === "error").length;
  const warnings = all.length - errors;
  const items = all.filter((x) => (show === "all" || x.issue.level === show) && (!here || !p.sheet || x.sheet?.id === p.sheet));

  // Grouped by sheet, in the list's order.
  const groups: { key: string; name: string; items: IssueItem[] }[] = [];
  for (const x of items) {
    const key = x.sheet?.id ?? "";
    let g = groups.at(-1);
    if (g?.key !== key) groups.push((g = { key, name: x.sheet?.name ?? "Not on a sheet", items: [] }));
    g.items.push(x);
  }

  return (
    <aside className="issues" aria-label="Validation issues">
      <div className="issues-head">
        <h2>Issues</h2>
        <span className="spacer" />
        <button className="button quiet" onClick={p.close} title="Close" aria-label="Close the issues">
          ×
        </button>
      </div>
      {all.length === 0 ? (
        <p className="muted issues-none">No errors or warnings.</p>
      ) : (
        <>
          <div className="issues-filter" role="group" aria-label="Show">
            {(
              [
                ["all", `All ${all.length}`],
                ["error", plural(errors, "error")],
                ["warning", plural(warnings, "warning")],
              ] as const
            ).map(([k, label]) => (
              <button key={k} className={show === k ? "chip on" : "chip"} aria-pressed={show === k} onClick={() => setShow(k)}>
                {label}
              </button>
            ))}
            {p.sheet && (
              <label className="small">
                <input type="checkbox" checked={here} onChange={(e) => setHere(e.target.checked)} /> This sheet only
              </label>
            )}
          </div>
          <div className="issues-list">
            {groups.length === 0 && <p className="muted">None to show.</p>}
            {groups.map((g) => (
              <section key={g.key}>
                <h3>{g.name}</h3>
                <ul>
                  {g.items.map((x, i) => (
                    <li key={i}>
                      <button className={`issue-item ${x.issue.level}`} disabled={x.sheet === null || x.row === null} onClick={() => p.jump(x)} title={x.sheet ? `Go to ${x.sheet.name}!${x.where}` : undefined}>
                        <span className={`dot ${x.issue.level}`} aria-label={x.issue.level} />
                        <span className="where">{x.where}</span>
                        <span className="msg">
                          {x.issue.message}
                          {x.entity && <span className="muted small"> · {x.entity}</span>}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
