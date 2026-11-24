// Moving entities to another pack (DESIGN §7.4): pick the pack (and a sheet there, or let
// the placement rules choose), and see first what the move would do. What the entities refer
// to that the new pack can't reach is offered to move along, ticked; what refers to them and
// would lose them is offered too, not ticked. The preview follows each choice. Then one
// change moves them all, with formulas following their cells.

import { useMemo, useState } from "react";
import { ApiError, Sapwood, type MoveReport, type Op, type Project } from "@thek42/sapwood-core";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";

interface Props {
  source: Source;
  /** The entities asked for, by ID. */
  ids: string[];
  /** The pack to start on (from a suggestion), by name. */
  pack?: string | undefined;
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  close(): void;
}

/** Why an entity is offered to move along. */
interface Offer {
  id: string;
  why: string;
  /** Ticked unless untouched: refs out of the moved ones are, refs into them aren't. */
  start: boolean;
}

export function MovePanel(p: Props) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const packs = [...project.wb.packs.values()];
  const here = useMemo(() => new Set(p.ids.map((id) => project.project().entities.find((e) => e.id === id)?.pack)), [p.ids, project, tick]);
  const [pack, setPack] = useState(() => p.pack ?? packs.find((x) => !here.has(x.id))?.name ?? packs[0]!.name);
  const [sheet, setSheet] = useState("");
  // Choices on the offers: ticked or not, by ID; an ID not here is as offered.
  const [choice, setChoice] = useState<Map<string, boolean>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The preview, with what's ticked moving along; refs out of what moves along are followed in turn.
  const view = useMemo(() => {
    const api = new Sapwood(project);
    const offers = new Map<string, Offer>();
    const all = new Set(p.ids);
    let r: MoveReport | null = null;
    try {
      for (let i = 0; i < 20; i++) {
        r = api.previewMove([...all], pack, sheet ? { sheet } : {});
        let more = false;
        for (const n of r.needs)
          if (!offers.has(n.to) && !all.has(n.to)) offers.set(n.to, { id: n.to, why: `${n.from}.${n.field} refers to it, and ${pack} can't reach where it is`, start: true });
        for (const n of r.breaks)
          if (!offers.has(n.from) && !all.has(n.from)) offers.set(n.from, { id: n.from, why: `its ${n.field} refers to ${n.to}, and won't reach it in ${pack}`, start: false });
        for (const o of offers.values())
          if ((choice.get(o.id) ?? o.start) && !all.has(o.id)) {
            all.add(o.id);
            more = true;
          }
        if (!more) break;
      }
      return { r, offers: [...offers.values()], all: [...all], error: null as string | null };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      return { r: null, offers: [...offers.values()], all: [...all], error: e.message };
    }
  }, [project, tick, p.ids.join("\n"), pack, sheet, [...choice].join()]);

  const sheets = [...project.wb.sheets.values()].filter((s) => s.kind === "data" && project.wb.packName(s.pack) === pack);
  const r = view.r;
  const at = (c: { sheet: string; cell: string }) => `${c.sheet}!${c.cell}`;
  const move = () =>
    p.edit((proj) => {
      try {
        const c = new Sapwood(proj).moveEntities(view.all, pack, sheet ? { sheet } : {});
        setError(null);
        setDone(`Moved ${plural(c.report.moved.length, "entity", "entities")} to ${pack}.`);
        return { ops: c.ops };
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        setError(e.message);
        return { ops: [] };
      }
    });

  return (
    <aside className="issues value-panel move-panel" aria-label="Move to another pack">
      <div className="issues-head">
        <h2>Move to another pack</h2>
        <span className="spacer" />
        <button className="button quiet" onClick={p.close} title="Close" aria-label="Close">
          ×
        </button>
      </div>
      <div className="issues-list vf">
        {done ? (
          <>
            <p>{done}</p>
            <button className="button" onClick={p.close}>
              Close
            </button>
          </>
        ) : (
          <>
            <div className="vf-fields">
              <label className="vf-row">
                <span className="vf-name">Pack</span>
                <select value={pack} onChange={(e) => (setPack(e.target.value), setSheet(""), setChoice(new Map()))}>
                  {packs.map((x) => (
                    <option key={x.id}>{x.name}</option>
                  ))}
                </select>
              </label>
              <label className="vf-row">
                <span className="vf-name">Sheet</span>
                <select value={sheet} onChange={(e) => setSheet(e.target.value)}>
                  <option value="">Where new ones go</option>
                  {sheets.map((s) => (
                    <option key={s.id}>{s.name}</option>
                  ))}
                </select>
              </label>
            </div>
            {view.error && <p className="vf-bad small">{view.error}</p>}
            {r && (
              <>
                <h3 className="vf-h">Moving</h3>
                {r.moved.length === 0 && <p className="muted small">Nothing: they're there already.</p>}
                <ul className="move-list">
                  {r.moved.map((m) => (
                    <li key={m.id}>
                      <code>{m.id}</code> <span className="muted small">to {m.sheet}</span>
                    </li>
                  ))}
                </ul>
                {view.offers.length > 0 && (
                  <>
                    <h3 className="vf-h">Move these too?</h3>
                    <ul className="move-list">
                      {view.offers.map((o) => (
                        <li key={o.id}>
                          <label>
                            <input type="checkbox" aria-label={`Move ${o.id} too`} checked={choice.get(o.id) ?? o.start} onChange={(e) => setChoice(new Map(choice).set(o.id, e.target.checked))} /> <code>{o.id}</code>
                          </label>
                          <span className="muted small"> {o.why}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {r.formulas.length > 0 && (
                  <>
                    <h3 className="vf-h">Formulas that can't follow</h3>
                    <ul className="move-list small">
                      {r.formulas.map((f, i) => (
                        <li key={i}>
                          <code>{at(f.cell)}</code> <span className="muted">{f.why}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {r.lost.length > 0 && <p className="small">Left behind with the old rows (not in any field): {r.lost.map(at).join(", ")}</p>}
                {r.issues.length > 0 ? (
                  <>
                    <h3 className="vf-h">{plural(r.issues.length, "new issue")}</h3>
                    <ul className="vf-issues move-issues">
                      {r.issues.slice(0, 8).map((i, n) => (
                        <li key={n} className={i.level}>
                          {i.entity?.id && <code>{i.entity.id}</code>} {i.message}
                        </li>
                      ))}
                      {r.issues.length > 8 && <li className="muted">…and {r.issues.length - 8} more</li>}
                    </ul>
                  </>
                ) : (
                  r.moved.length > 0 && <p className="small muted">It adds no issues. Formulas reading the moved cells follow them.</p>
                )}
              </>
            )}
            {error && <p className="vf-bad small" role="alert">{error}</p>}
            <div className="vf-buttons">
              <button className="button" disabled={!p.canEdit || !r || r.moved.length === 0} onClick={move}>
                Move {r ? plural(r.moved.length, "entity", "entities") : ""}
              </button>
              {r && r.issues.length > 0 && <span className="muted small">You can still move them: the issues show in your task until they're fixed.</span>}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
