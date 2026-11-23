// Find references (DESIGN §9.2): where an ID is defined and every place that uses it, beside
// the home page or the sheet, kept current as the task changes. Clicking one goes there.

import { useMemo } from "react";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { refList, type RefItem } from "./refs.ts";

interface Props {
  source: Source;
  id: string;
  jump(at: RefItem): void;
  close(): void;
}

export function RefsPanel(p: Props) {
  const tick = useSource(p.source);
  const items = useMemo(() => refList(p.source.project, p.id), [p.source, p.id, tick]);
  const defs = items.filter((x) => x.kind === "definition");
  const uses = items.filter((x) => x.kind !== "definition");
  const row = (x: RefItem, i: number) => (
    <li key={i}>
      <button className={x.active ? "issue-item" : "issue-item inactive"} onClick={() => p.jump(x)} title={`Go to ${x.sheetName}!${x.where}`}>
        <span />
        <span className="where">{x.where}</span>
        <span className="msg">
          {x.kind === "definition" ? x.owner : x.kind === "formula" ? `${x.owner ? `${x.owner}: ` : ""}a formula` : `${x.owner} · ${x.field}`}
          <span className="muted small">
            {" "}
            · {x.sheetName}
            {!x.active && " · commented out"}
          </span>
        </span>
      </button>
    </li>
  );
  return (
    <aside className="issues" aria-label={`References to ${p.id}`}>
      <div className="issues-head">
        <h2>
          References to <span className="ref-id">{p.id}</span>
        </h2>
        <span className="spacer" />
        <button className="button quiet" onClick={p.close} title="Close" aria-label="Close the references">
          ×
        </button>
      </div>
      <div className="issues-filter small muted">
        {defs.length === 0 ? "No entity has this ID." : defs.length > 1 ? `Defined ${defs.length} times.` : "Defined once."} {uses.length === 0 ? "Nothing uses it." : `Used ${plural(uses.length, "time")}.`}
      </div>
      <div className="issues-list">
        {defs.length > 0 && (
          <section>
            <h3>Definition</h3>
            <ul>{defs.map(row)}</ul>
          </section>
        )}
        {uses.length > 0 && (
          <section>
            <h3>Used by</h3>
            <ul>{uses.map(row)}</ul>
          </section>
        )}
      </div>
    </aside>
  );
}
