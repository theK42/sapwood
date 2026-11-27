// The entity page's form for several entities at once (DESIGN §9.3): each field with the value
// they share, edited as one entity's would be and written to all of them; or, where they
// differ, what the values are and "Set one value for all", which edits a draft (starting from
// the first's) until it's applied. Comment out, uncomment, the "don't suggest moving" mark,
// Move… and Delete act on the whole selection. Every write is one change of the task.

import { useMemo, useState } from "react";
import { formatType, Sapwood, type Entity, type Op, type PackId, type Patch, type Project } from "@thek42/sapwood-core";
import { entityAt, refusal } from "./form.ts";
import type { FormRow } from "./FormPanel.tsx";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { differing, markAll, multiFormOf, setAll, type MultiField } from "./multi.ts";
import { summary } from "./panel.ts";
import { RefScope, Value } from "./ValuePanel.tsx";

interface Props {
  source: Source;
  rows: FormRow[];
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  /** Show just this one in the form. */
  showOne(e: Entity): void;
  clear(): void;
  move?: (ids: string[]) => void;
}

const nested = (k: string) => k === "struct" || k === "union" || k === "list" || k === "json";

export function MultiForm(p: Props) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const entities = useMemo(() => p.rows.map((r) => entityAt(project, r.sheet, r.row)).filter((e): e is Entity => e !== null), [project, tick, p.rows]);
  const form = useMemo(() => multiFormOf(project, entities), [project, tick, entities]);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !p.canEdit;
  const ids = entities.map((e) => e.id).filter((x): x is string => x !== null);
  const noId = entities.length - ids.length;

  /** Patches, all or nothing, as one change; built against the project as it is when written. */
  const write = (patches: (now: Entity[]) => Patch[]) =>
    p.edit((proj) => {
      try {
        const now = p.rows.map((r) => entityAt(proj, r.sheet, r.row)).filter((e): e is Entity => e !== null);
        const list = patches(now);
        if (!list.length) return { ops: [] };
        const ops = new Sapwood(proj).apply(list).ops;
        setError(null);
        return { ops };
      } catch (x) {
        const m = refusal(x) ?? (x instanceof Error ? x.message : null);
        if (m === null) throw x;
        setError(m);
        return { ops: [] };
      }
    });
  const remove = () => {
    if (!confirm(`Delete ${plural(ids.length, "entity", "entities")}? Their rows go from their sheets (undo brings them back).`)) return;
    write((now) => now.filter((e) => e.id !== null).map((e) => ({ op: "delete", id: e.id! }) as Patch));
    p.clear();
  };
  const packs = new Set(entities.map((e) => e.pack));
  const from: PackId = packs.size === 1 ? [...packs][0]! : project.wb.root;
  const allKept = form.kept === entities.length;

  return (
    <aside className="entity-form" aria-label={`${entities.length} entities, as one form`}>
      <div className="issues-head">
        <h2>
          {plural(entities.length, form.type ?? "entity", form.type ? `${form.type}s` : "entities")}
        </h2>
        <span className="spacer" />
        <button className="button quiet small" onClick={p.clear} title="Back to one at a time">
          Clear the selection
        </button>
      </div>
      <div className="issues-filter small multi-bar">
        {form.errors + form.warnings > 0 ? (
          <span className={form.errors ? "vf-bad" : "muted"}>
            {[form.errors && plural(form.errors, "error"), form.warnings && plural(form.warnings, "warning")].filter(Boolean).join(", ")} across them
          </span>
        ) : (
          <span className="muted">No issues</span>
        )}
        <span className="spacer" />
        {p.canEdit && ids.length > 0 && (
          <>
            {form.inactive < entities.length && (
              <button className="button quiet small" onClick={() => write((now) => markAll(now, "active", false))} title="Keep them on their sheets, but not in the data">
                Comment out
              </button>
            )}
            {form.inactive > 0 && (
              <button className="button quiet small" onClick={() => write((now) => markAll(now, "active", true))}>
                Uncomment
              </button>
            )}
            {p.move && (
              <button className="button quiet small" onClick={() => p.move!(ids)} title="Move them to another pack">
                Move…
              </button>
            )}
            <button className="button quiet small danger" onClick={remove}>
              Delete…
            </button>
          </>
        )}
      </div>
      <RefScope.Provider value={{ project, from }}>
        <div className="issues-list vf">
          {error && <p className="vf-bad small" role="alert">{error}</p>}
          <p className="small multi-ids">
            {entities.map((e) => (
              <button key={`${e.at.sheet}|${e.at.row}`} className={e.active ? "chip" : "chip muted"} onClick={() => p.showOne(e)} title="Show just this one">
                {e.id ?? "(no ID)"}
              </button>
            ))}
          </p>
          {noId > 0 && <p className="vf-note small">{plural(noId, "row has", "rows have")} no ID, so changes here leave {noId === 1 ? "it" : "them"} alone.</p>}
          {packs.size > 1 && <p className="muted small">They're in {packs.size} packs: ID suggestions are those the root pack can use.</p>}
          {form.type === null ? (
            <p className="muted small">They're of different types: pick entities of one type to edit their fields together.</p>
          ) : (
            <div className="vf-fields">
              {ids.length > 0 && (
                <label className="vf-row vf-keep small">
                  <input
                    type="checkbox"
                    checked={allKept}
                    ref={(x) => {
                      if (x) x.indeterminate = form.kept > 0 && !allKept;
                    }}
                    disabled={readOnly}
                    onChange={() => write((now) => markAll(now, "keepHere", !allKept))}
                  />
                  <span>📌 Don't suggest moving them to another pack{form.kept > 0 && !allKept ? ` (${form.kept} of ${entities.length} now)` : ""}</span>
                </label>
              )}
              {form.fields.map((f) => (
                <MultiRow key={f.def.id} project={project} f={f} count={entities.length} readOnly={readOnly || ids.length === 0} write={(v) => write((now) => setAll(now, f.def.name, v, f.computed))} />
              ))}
            </div>
          )}
        </div>
      </RefScope.Provider>
    </aside>
  );
}

function MultiRow(p: { project: Project; f: MultiField; count: number; readOnly: boolean; write(v: unknown): void }) {
  const { f } = p;
  const def = f.def;
  const schema = p.project.schema;
  const allComputed = f.computed.length === p.count;
  const readOnly = p.readOnly || allComputed;
  // A draft for a field they differ in: nothing is written until it's applied.
  const [draft, setDraft] = useState<{ value: unknown } | null>(null);
  const label = (
    <span className="vf-name" title={[formatType(def.type), def.description].filter(Boolean).join(" · ")}>
      {def.name}
      {def.required && <span className="vf-req" title="Required"> *</span>}
    </span>
  );
  const notes = (
    <>
      {f.computed.length > 0 && (
        <p className="muted small vf-hint">
          {allComputed ? "A formula computes it in each of them." : `A formula computes it in ${f.computed.length} of them (${f.computed.slice(0, 3).join(", ")}${f.computed.length > 3 ? ", …" : ""}): those are left as they are.`}
        </p>
      )}
      {f.withIssues > 0 && <p className="vf-bad small">{f.withIssues === p.count ? "Each has an issue here." : `${plural(f.withIssues, "of them has", "of them have")} an issue here.`}</p>}
    </>
  );
  const editor = (value: unknown, set: (v: unknown) => void) => <Value schema={schema} def={def} type={def.type} value={value} path="" issues={new Map()} readOnly={readOnly} set={set} depth={1} />;

  if (!f.same) {
    const show = (v: unknown) => (nested(def.type.kind) ? summary(schema, def.type, v) : typeof v === "string" ? v : JSON.stringify(v));
    return (
      <div className="vf-field multi-mixed">
        <div className="vf-row">
          {label}
          <span className="muted small">
            {f.values.length} different: {differing(f.values, show)}
          </span>
        </div>
        {draft ? (
          <div className="multi-draft">
            {editor(draft.value, (v) => setDraft({ value: v }))}
            <div className="vf-buttons">
              <button className="button small" onClick={() => (p.write(draft.value), setDraft(null))}>
                Set it for all {p.count - f.computed.length}
              </button>
              <button className="button quiet small" onClick={() => setDraft(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          !readOnly && (
            <div className="vf-buttons">
              <button className="button quiet small" onClick={() => setDraft({ value: f.values.find((v) => v !== undefined) })}>
                Set one value for all…
              </button>
              {!def.required && (
                <button className="button quiet small" onClick={() => p.write(undefined)} title={`Blank ${def.name} in each of them`}>
                  Clear in all
                </button>
              )}
            </div>
          )
        )}
        {notes}
      </div>
    );
  }
  if (nested(def.type.kind) && f.value !== undefined)
    return (
      <details className="vf-section" open>
        <summary>
          {label}
          <span className="muted small vf-sum">{summary(schema, def.type, f.value)}</span>
          <span className="muted small"> · the same in all</span>
        </summary>
        {notes}
        {editor(f.value, p.write)}
      </details>
    );
  return (
    <div className="vf-field">
      <label className="vf-row" onClick={(e) => nested(def.type.kind) && e.preventDefault()}>
        {label}
        {editor(f.value, p.write)}
        {def.default !== undefined && f.value === undefined && <span className="muted small"> default {String(def.default)}</span>}
      </label>
      {notes}
    </div>
  );
}
