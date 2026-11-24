// The history of one entity or one cell (DESIGN §8.7), beside the sheet, the type view or
// the entity page: each commit on the branch that changed it, newest first, with who, when,
// the commit's message, and what changed (field by field for an entity; before and after for
// a cell). "Restore" puts it back as it was after that commit, as an edit in your task, so
// it can be checked and undone like any other. What's only in tasks isn't history yet.

import { useEffect, useState } from "react";
import { ApiError as CoreApiError, Sapwood, type Op, type Project } from "@thek42/sapwood-core";
import type { Api, CellChange, EntityChange } from "./api.ts";
import { SheetGrid } from "./grid.ts";
import type { Source } from "./head.ts";
import { entityDiff, restoreFields } from "./historyView.ts";
import { ago } from "./hooks.ts";

export type HistoryOf = { kind: "entity"; id: string } | { kind: "cell"; sheet: string; row: string; col: string; label: string };

interface Props {
  api: Api;
  branch: string;
  of: HistoryOf;
  source: Source;
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  openCommit(id: string): void;
  close(): void;
}

export function HistoryPanel(p: Props) {
  const [list, setList] = useState<(EntityChange | CellChange)[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const key = p.of.kind === "entity" ? p.of.id : `${p.of.sheet}|${p.of.row}|${p.of.col}`;
  useEffect(() => {
    setList(null);
    setError(null);
    const get = p.of.kind === "entity" ? p.api.entityHistory(p.branch, p.of.id) : p.api.cellHistory(p.branch, p.of.sheet, p.of.row, p.of.col);
    get.then(setList, (e: unknown) => setError((e as Error).message));
  }, [p.branch, key]);

  const restoreEntity = (c: EntityChange) =>
    p.edit((proj) => {
      try {
        const s = new Sapwood(proj);
        const was = c.after!;
        const { fields, skipped } = restoreFields(proj.schema, was);
        const id = p.of.kind === "entity" ? p.of.id : was.$id;
        let ops: Op[];
        try {
          s.get(id);
          ops = s.set(id, fields, { force: true }).ops;
        } catch (e) {
          if (!(e instanceof CoreApiError) || e.code !== "not-found") throw e;
          // Gone now: made again, in the pack it was in.
          ops = s.create(was.$type, { ...fields, $id: id }, { pack: was.$pack }).ops;
        }
        setSaid(`Put back as it was after “${c.commit.message}”, in your task.${skipped.length ? ` Left as they are (they didn't read then): ${skipped.join(", ")}.` : ""}`);
        return { ops };
      } catch (e) {
        if (!(e instanceof CoreApiError)) throw e;
        setSaid(e.message);
        return { ops: [] };
      }
    });

  const restoreCell = (c: CellChange) => {
    if (p.of.kind !== "cell") return;
    const { sheet, row, col } = p.of;
    p.edit((proj) => {
      const sh = proj.wb.sheets.get(sheet);
      const r = sh?.rows.posOf(row);
      const k = sh?.cols.posOf(col);
      if (!sh || r == null || k == null) {
        setSaid("The cell isn't there now: its row or column was deleted.");
        return { ops: [] };
      }
      setSaid(`Put back as it was after “${c.commit.message}”, in your task.`);
      return new SheetGrid(proj, sheet).edit([{ row: r - 1, col: k - 1, input: c.after?.input ?? "" }]);
    });
  };

  return (
    <aside className="issues value-panel history-panel" aria-label="History">
      <div className="issues-head">
        <h2>History · {p.of.kind === "entity" ? p.of.id : p.of.label}</h2>
        <span className="spacer" />
        <button className="button quiet" onClick={p.close} title="Close" aria-label="Close">
          ×
        </button>
      </div>
      <div className="issues-list vf">
        <p className="muted small">Each commit on {p.branch} that changed it, newest first. Changes still in tasks show here once they land.</p>
        {said && <p className="small" role="status">{said}</p>}
        {error && <p className="vf-bad small">{error}</p>}
        {!list && !error && <p className="muted small">Reading the history…</p>}
        {list && list.length === 0 && <p className="small">No commit has changed it.</p>}
        <ol className="history-list">
          {list?.map((c, n) => (
            <li key={c.commit.id + n}>
              <div className="history-head small">
                <button className="link" onClick={() => p.openCommit(c.commit.id)}>
                  {c.commit.message || "(no message)"}
                </button>
                <span className="muted">
                  {" "}
                  · {c.commit.author} · {ago(c.commit.at)}
                </span>
              </div>
              {p.of.kind === "entity" ? <EntityChanges c={c as EntityChange} /> : <CellChanges c={c as CellChange} />}
              {p.canEdit && c.after && n > 0 && (
                <button className="link small" onClick={() => (p.of.kind === "entity" ? restoreEntity(c as EntityChange) : restoreCell(c as CellChange))} title="Put it back as it was after this commit, as an edit in your task">
                  Restore it as it was here
                </button>
              )}
              {n === 0 && c.after && <span className="muted small">As it is on {p.branch} now.</span>}
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}

function EntityChanges({ c }: { c: EntityChange }) {
  if (!c.before) return <p className="small">Made{c.after ? ` on ${c.after.$sheet}${c.after.$pack !== "root" ? ` (${c.after.$pack})` : ""}` : ""}.</p>;
  if (!c.after) return <p className="small">Deleted (or its ID went to another).</p>;
  const d = entityDiff(c.before, c.after);
  return (
    <table className="history-diff small">
      <tbody>
        {d.map((x) => (
          <tr key={x.field}>
            <th>{x.field}</th>
            <td className="was">{x.before ?? <span className="muted">blank</span>}</td>
            <td>→</td>
            <td>{x.after ?? <span className="muted">blank</span>}</td>
          </tr>
        ))}
        {d.length === 0 && (
          <tr>
            <td className="muted">Nothing in its fields: its row moved, or a format changed.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function CellChanges({ c }: { c: CellChange }) {
  const show = (x: CellChange["before"]) =>
    x === null ? <span className="muted">not there</span> : x.input === "" ? <span className="muted">blank</span> : x.input.startsWith("=") ? <><code>{x.input}</code> <span className="muted">({x.shown})</span></> : x.input;
  return (
    <p className="small history-cell">
      {c.before === null ? "Made: " : <>{show(c.before)} → </>}
      {show(c.after)}
      {c.after && c.before && c.after.cell !== c.before.cell && <span className="muted"> (now {c.after.cell})</span>}
    </p>
  );
}
