// The form view (DESIGN §9.3): every field of one entity in one form, beside the sheet or
// type view, built from the schema as the value panel's forms are. A field a formula
// computes is shown but not edited, with "Show in the sheet" and "Replace the formula with
// its value". Each change is one change of the task, written through the API (`set`), so a
// split struct or a list spread over columns is written to its columns, and a new ID renames
// the entity and the refs to it.
//
// NewEntityPanel makes a new entity from a form: its type, pack and ID, and any fields,
// placed by the rules of §9.3 (the only sheet with the type, the user's pick of several, or
// the sheet named after the type, made if it isn't there).

import { useEffect, useMemo, useState } from "react";
import { formatType, Sapwood, type FieldDef, type FieldType, type JsonValue, type Op, type PackId, type Patch, type Project, type RowId, type SheetId } from "@thek42/sapwood-core";
import { SheetGrid } from "./grid.ts";
import { aOrAn, entityAt, formOf, placing, refusal, type FormField } from "./form.ts";
import type { Source } from "./head.ts";
import { useSource } from "./hooks.ts";
import { issuesByPath, summary } from "./panel.ts";
import { Fields, Issues, RefScope, Value } from "./ValuePanel.tsx";

/** The row of the entity the form shows, by stable IDs, so it stays on it as rows move. */
export interface FormRow {
  sheet: SheetId;
  row: RowId;
}

interface Props {
  source: Source;
  at: FormRow;
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  /** Show a cell on its sheet (0-based; col null: the row). */
  goTo(sheet: SheetId, row: number, col: number | null): void;
  /** A new entity of this type, from a form. */
  newEntity(type: string, pack: PackId): void;
  /** Absent on the entity page, where the form isn't closed. */
  close?: () => void;
  embedded?: boolean;
  /** Move this entity to another pack. */
  move?: (id: string) => void;
}

const nested = (k: string) => k === "struct" || k === "union" || k === "list" || k === "json";

function Head(p: { title: string; close?: (() => void) | undefined }) {
  return (
    <div className="issues-head">
      <h2>{p.title}</h2>
      <span className="spacer" />
      {p.close && (
        <button className="button quiet" onClick={p.close} title="Close" aria-label="Close the form">
          ×
        </button>
      )}
    </div>
  );
}

/** Beside a sheet, a panel; on the entity page, the page's right-hand part. */
const frame = (embedded: boolean | undefined) => (embedded ? "entity-form" : "issues value-panel form-panel");

export function FormPanel(p: Props) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const form = useMemo(() => {
    const e = entityAt(project, p.at.sheet, p.at.row);
    return e ? formOf(project, e) : null;
  }, [project, p.at.sheet, p.at.row, tick]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [p.at.sheet, p.at.row]);

  if (!form)
    return (
      <aside className={frame(p.embedded)} aria-label="Form">
        <Head title="Form" close={p.close} />
        <p className="muted small pad">This row isn't an entity's: put a type in column A and an ID in column B.</p>
      </aside>
    );

  const e = form.entity;
  const sheet = project.wb.sheet(e.at.sheet);
  const rowPos = (sheet.rows.posOf(e.at.row) ?? 1) - 1;
  const colPos = (c: FormField["cell"]) => (c?.col === undefined ? null : (sheet.cols.posOf(c.col) ?? 1) - 1);
  const readOnly = !p.canEdit;

  /** A write through the API, by the entity's ID as it is when the write is made. */
  const write = (fields: Record<string, JsonValue>, force = false) =>
    p.edit((proj) => {
      try {
        const now = entityAt(proj, p.at.sheet, p.at.row);
        if (!now) return { ops: [] };
        if (now.id === null) throw new Error("This row has no ID yet: give it one first");
        const ops = new Sapwood(proj).set(now.id, fields, { force }).ops;
        setError(null);
        return { ops };
      } catch (x) {
        const m = refusal(x) ?? (x instanceof Error ? x.message : null);
        if (m === null) throw x;
        setError(m);
        return { ops: [] };
      }
    });
  // With no ID there's no entity to write by: the ID goes in its cell, as typed there.
  const setId = (v: unknown) => {
    const id = typeof v === "string" ? v.trim() : "";
    if (id === (e.id ?? "")) return;
    if (e.id !== null && id !== "") return write({ $id: id });
    p.edit((proj) => {
      const r = proj.wb.sheet(p.at.sheet).rows.posOf(p.at.row);
      return r === null ? { ops: [] } : new SheetGrid(proj, p.at.sheet).edit([{ row: r - 1, col: 1, input: id }]);
    });
  };

  return (
    <aside className={frame(p.embedded)} aria-label={`${e.id ?? "No ID"}, as a form`}>
      <Head title={`${e.id ?? "(no ID)"} · ${e.type}`} close={p.close} />
      <div className="issues-filter small">
        <button className="link" onClick={() => p.goTo(e.at.sheet, rowPos, null)} title="Show the row">
          {sheet.name} row {rowPos + 1}
        </button>
        {e.pack !== project.wb.root && <span className="muted"> · {project.wb.packName(e.pack)}</span>}
        <span className="spacer" />
        {p.canEdit && p.move && e.id !== null && (
          <button className="button quiet small" onClick={() => p.move!(e.id!)} title="Move it to another pack">
            Move…
          </button>
        )}
        {p.canEdit && (
          <button className="button quiet small" onClick={() => p.newEntity(e.type, e.pack)} title={`A new ${e.type}, from a form`}>
            + New {e.type}
          </button>
        )}
      </div>
      <RefScope.Provider value={{ project, from: e.pack }}>
        <div className="issues-list vf">
          {!e.active && (
            <p className="vf-note small">
              Commented out: it's kept on the sheet, but isn't part of the data.{" "}
              {p.canEdit && (
                <button className="link" onClick={() => write({ $active: true })}>
                  Uncomment it
                </button>
              )}
            </p>
          )}
          {error && <p className="vf-bad small" role="alert">{error}</p>}
          <Issues list={form.rowIssues} />
          <div className="vf-fields">
            <div className="vf-field">
              <label className="vf-row">
                <span className="vf-name">ID</span>
                <IdBox value={e.id ?? ""} readOnly={readOnly} set={setId} />
              </label>
              {e.id !== null && !readOnly && <p className="muted small vf-hint">A new ID renames it, and the refs to it.</p>}
            </div>
            {form.fields.map((f) => (
              <FieldRow key={f.def.id} project={project} f={f} readOnly={readOnly || e.id === null} write={write} show={() => p.goTo(e.at.sheet, rowPos, colPos(f.cell))} />
            ))}
          </div>
        </div>
      </RefScope.Provider>
    </aside>
  );
}

/** The ID, written when it's left, as the form's text boxes are. */
function IdBox(p: { value: string; readOnly: boolean; set(v: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== p.value) p.set(draft);
    setDraft(null);
  };
  return (
    <input
      className="vf-input"
      value={draft ?? p.value}
      readOnly={p.readOnly}
      spellCheck={false}
      placeholder="an ID"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

function FieldRow(p: { project: Project; f: FormField; readOnly: boolean; write(fields: Record<string, JsonValue>, force?: boolean): void; show(): void }) {
  const { f } = p;
  const def = f.def;
  const schema = p.project.schema;
  const computed = f.formula !== null;
  const byPath = issuesByPath(f.issues, def.name);
  const set = (v: unknown) => p.write({ [def.name]: v === undefined ? null : (v as JsonValue) });
  const label = (
    <span className="vf-name" title={[formatType(def.type), def.description].filter(Boolean).join(" · ")}>
      {def.name}
      {def.required && <span className="vf-req" title="Required"> *</span>}
    </span>
  );
  const value = (
    <Value schema={schema} def={def} type={def.type} value={f.value} path="" issues={byPath} readOnly={p.readOnly || computed} set={set} depth={1} />
  );
  const formula = computed && (
    <div className="vf-formula small">
      <code title="Computed by this formula">{f.formula}</code>
      <span className="vf-actions">
        <button className="link" onClick={p.show}>
          Show in the sheet
        </button>
        {!p.readOnly && (
          <button className="link" onClick={() => p.write({ [def.name]: (f.value ?? null) as JsonValue }, true)} title="Write what the formula gives now in its place">
            Replace the formula with its value
          </button>
        )}
      </span>
    </div>
  );
  const invalid = f.invalid !== undefined && <p className="vf-bad small">In the cell: {String(f.invalid)}</p>;
  if (nested(def.type.kind) && f.value !== undefined)
    return (
      <details className="vf-section" open>
        <summary>
          {label}
          <span className="muted small vf-sum">{summary(schema, def.type, f.value)}</span>
          {!p.readOnly && !computed && !def.required && (
            <button className="button quiet small vf-x" title={`Take out ${def.name}`} onClick={(e) => (e.preventDefault(), set(undefined))}>
              ×
            </button>
          )}
        </summary>
        {formula}
        <Issues list={byPath.get("")} />
        {value}
      </details>
    );
  return (
    <div className="vf-field">
      <label className="vf-row" onClick={(e) => nested(def.type.kind) && e.preventDefault()}>
        {label}
        {value}
        {def.default !== undefined && f.value === undefined && <span className="muted small"> default {String(def.default)}</span>}
      </label>
      {formula}
      {invalid}
      <Issues list={byPath.get("")} />
    </div>
  );
}

// ------------------------------------------------------------ a new entity

interface NewProps {
  source: Source;
  /** What the form starts with: the type and pack it was opened for. */
  type: string | null;
  pack: PackId | null;
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  /** Made: show it in the form, and on its sheet. */
  made(at: FormRow, row: number): void;
  close?: () => void;
  embedded?: boolean;
}

export function NewEntityPanel(p: NewProps) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const schema = project.schema;
  const types = useMemo(() => [...schema.types.entries()].filter(([, x]) => !x.def.singleton).map(([n]) => n).sort((a, b) => a.localeCompare(b)), [schema]);
  const [type, setType] = useState(p.type ?? types[0] ?? "");
  const [pack, setPack] = useState<PackId>(p.pack ?? project.wb.root);
  const [sheet, setSheet] = useState<string | null>(null); // null: the default
  const [id, setId] = useState("");
  const [fields, setFields] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (p.type) setType(p.type);
    if (p.pack) setPack(p.pack);
  }, [p.type, p.pack]);
  useEffect(() => (setSheet(null), setFields({})), [type, pack]);
  const where = useMemo(() => (type ? placing(project, type, pack) : null), [project, type, pack, tick]);
  const t = schema.types.get(type);
  const packs = [...project.wb.packs.entries()];
  const goesOn = sheet ?? where?.default ?? type;
  const isNew = where !== null && goesOn === where.typeNamed.name && !where.typeNamed.exists;

  const create = () => {
    if (!t || !where) return;
    if (id.trim() === "") return setError("Give it an ID");
    const packName = project.wb.packName(pack);
    const body: Record<string, JsonValue> = { $id: id.trim() };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v as JsonValue;
    const patches: Patch[] = [
      ...(isNew ? [{ op: "createSheet" as const, name: goesOn, pack: packName }] : []),
      { op: "create", type, fields: body, sheet: goesOn, pack: packName },
    ];
    p.edit((proj) => {
      try {
        const ops = new Sapwood(proj).apply(patches).ops;
        const e = proj.project().entities.find((x) => x.id === body.$id && x.active && x.pack === pack);
        setError(null);
        if (e) {
          const row = (proj.wb.sheet(e.at.sheet).rows.posOf(e.at.row) ?? 1) - 1;
          queueMicrotask(() => p.made({ sheet: e.at.sheet, row: e.at.row }, row));
        }
        return { ops };
      } catch (x) {
        const m = refusal(x);
        if (m === null) throw x;
        setError(m);
        return { ops: [] };
      }
    });
  };

  return (
    <aside className={frame(p.embedded)} aria-label="A new entity">
      <Head title={type ? `New ${type}` : "New entity"} close={p.close} />
      {!p.canEdit ? (
        <p className="muted small pad">You can't edit here, so you can't add one.</p>
      ) : (
        <RefScope.Provider value={{ project, from: pack }}>
          <div className="issues-list vf">
            <div className="vf-fields">
              <label className="vf-row">
                <span className="vf-name">Type</span>
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  {types.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              {packs.length > 1 && (
                <label className="vf-row">
                  <span className="vf-name">Pack</span>
                  <select value={pack} onChange={(e) => setPack(e.target.value as PackId)}>
                    {packs.map(([pid, x]) => (
                      <option key={pid} value={pid}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {where && (
                <div className="vf-field">
                  <label className="vf-row">
                    <span className="vf-name">Sheet</span>
                    {where.pick ? (
                      <select value={goesOn} onChange={(e) => setSheet(e.target.value)}>
                        {where.sheets.map((s) => (
                          <option key={s.id}>{s.name}</option>
                        ))}
                        {!where.sheets.some((s) => s.name === where.typeNamed.name) && <option value={where.typeNamed.name}>{where.typeNamed.name}{where.typeNamed.exists ? "" : " (a new sheet)"}</option>}
                      </select>
                    ) : (
                      <span className="small">
                        {goesOn}
                        {isNew && <span className="muted"> (a new sheet)</span>}
                      </span>
                    )}
                  </label>
                  <p className="muted small vf-hint">
                    {where.pick
                      ? `Several sheets have ${aOrAn(type)}: pick one. It goes after the last ${type} there.`
                      : where.sheets.length === 1
                        ? `After the last ${type} there.`
                        : `No sheet in ${project.wb.packName(pack)} has ${aOrAn(type)} yet, so it goes on the sheet named after the type.`}
                  </p>
                </div>
              )}
              <label className="vf-row">
                <span className="vf-name">
                  ID<span className="vf-req" title="Required"> *</span>
                </span>
                <input className="vf-input" value={id} spellCheck={false} placeholder="an ID" onChange={(e) => setId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} />
              </label>
            </div>
            {t && t.fields.length > 0 && (
              <>
                <h3 className="vf-h">Fields</h3>
                <Fields
                  schema={schema}
                  def={null}
                  type={{ kind: "struct", name: type } as FieldType}
                  value={fields}
                  path=""
                  issues={new Map()}
                  readOnly={false}
                  set={(v) => setFields((v as Record<string, unknown>) ?? {})}
                  depth={1}
                  fields={t.fields.map((f) => f.def) as FieldDef[]}
                  obj={fields}
                />
              </>
            )}
            {error && <p className="vf-bad small" role="alert">{error}</p>}
            <div className="vf-buttons">
              <button className="button" onClick={create} disabled={!t}>
                Add {type}
              </button>
              <span className="muted small">Blank fields stay blank; you can fill them in later.</span>
            </div>
          </div>
        </RefScope.Provider>
      )}
    </aside>
  );
}
