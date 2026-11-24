// Suggested moves down the pack tree (DESIGN §7.4): entities used only from one branch
// below them, grouped by the pack they could go to. Tick the ones to move and review the
// move (the move panel's preview, with that pack chosen); or mark one "don't suggest
// moving", which takes it off the list for everyone.

import { useMemo, useState } from "react";
import { ApiError, Sapwood, type Op, type Project } from "@thek42/sapwood-core";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";

interface Props {
  source: Source;
  /** A pack's name: suggestions for it and its sub-packs. Else the whole project. */
  pack: string | null;
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  /** Review moving these to a pack, in the move panel. */
  review(ids: string[], pack: string): void;
  close(): void;
}

export function SuggestPanel(p: Props) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const list = useMemo(() => new Sapwood(project).suggestMoves(p.pack === null ? {} : { pack: p.pack }), [project, tick, p.pack]);
  const groups = useMemo(() => {
    const m = new Map<string, typeof list>();
    for (const s of list) m.set(s.to, [...(m.get(s.to) ?? []), s]);
    return [...m];
  }, [list]);
  // Unticked ones, by ID: everything starts ticked.
  const [off, setOff] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const keep = (id: string) =>
    p.edit((proj) => {
      try {
        setError(null);
        return { ops: new Sapwood(proj).set(id, { $keepHere: true }).ops };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        setError(e.message);
        return { ops: [] };
      }
    });

  return (
    <aside className="issues value-panel suggest-panel" aria-label="Suggested moves">
      <div className="issues-head">
        <h2>Suggested moves</h2>
        <span className="spacer" />
        <button className="button quiet" onClick={p.close} title="Close" aria-label="Close">
          ×
        </button>
      </div>
      <div className="issues-list vf">
        <p className="muted small">
          Entities{p.pack ? ` in ${p.pack} and below` : ""} that only packs further down use, and the lowest pack all their users reach. Entities nothing uses, and ones marked "don't suggest moving", aren't listed.
        </p>
        {error && <p className="vf-bad small" role="alert">{error}</p>}
        {groups.length === 0 && <p>No suggestions: nothing is used only from below where it is.</p>}
        {groups.map(([to, items]) => {
          const ticked = items.filter((s) => !off.has(s.id)).map((s) => s.id);
          return (
            <section key={to} className="suggest-group">
              <h3 className="vf-h">
                To {to} <span className="muted">({items.length})</span>
              </h3>
              <ul className="move-list">
                {items.map((s) => (
                  <li key={s.id}>
                    <label>
                      <input type="checkbox" aria-label={`Move ${s.id}`} checked={!off.has(s.id)} onChange={(e) => setOff((o) => { const n = new Set(o); if (e.target.checked) n.delete(s.id); else n.add(s.id); return n; })} /> <code>{s.id}</code>
                    </label>{" "}
                    <span className="muted small">
                      {s.type} in {s.from} · used by {s.usedBy.join(", ")}
                      {s.uses > s.usedBy.length ? ` and ${s.uses - s.usedBy.length} more` : ""}
                    </span>{" "}
                    {p.canEdit && (
                      <button className="link small" onClick={() => keep(s.id)} title="Leave it where it is, and don't suggest it again">
                        Don't suggest
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {p.canEdit && (
                <button className="button quiet small" disabled={!ticked.length} onClick={() => p.review(ticked, to)}>
                  Review moving {plural(ticked.length, "entity", "entities")} to {to}…
                </button>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
