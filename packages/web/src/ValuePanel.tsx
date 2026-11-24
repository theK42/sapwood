// The panel editor (DESIGN §5.6, §9.2): a struct, union, list or json cell, beside the sheet
// or type view, as a form generated from the schema (or from a json field's JSON Schema),
// with each part's issues beside it. Raw JSON is always there too, checked as it's typed.
//
// Each change writes the whole value back to the cell as one change of the task, so undo
// takes back one at a time. Text and numbers are written when they're left (Enter or Tab),
// not on each key. Nothing is drawn for parts the value doesn't have yet, only a button to
// add them, so a recursive type unfolds only as far as its value goes.

import { useEffect, useMemo, useState } from "react";
import {
  formatType, parseJson, validate,
  type ColId, type FieldDef, type FieldType, type Issue, type Op, type Project, type ResolvedSchema, type RowId, type SheetId,
} from "@thek42/sapwood-core";
import { SheetGrid } from "./grid.ts";
import type { Source } from "./head.ts";
import { useSource } from "./hooks.ts";
import { blank, cellText, issuesByPath, pathIn, summary, switchVariant } from "./panel.ts";

/** The cell the panel edits, by stable IDs, so it stays on it as rows and columns move. */
export interface PanelCell {
  sheet: SheetId;
  row: RowId;
  col: ColId;
}

interface Props {
  source: Source;
  at: PanelCell;
  canEdit: boolean;
  edit(fn: (p: Project) => { ops: Op[] }): void;
  /** Show the cell on its sheet. */
  goTo(sheet: SheetId, row: number, col: number): void;
  close(): void;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Where the cell is now, 0-based, or null if its row or column is gone. */
function place(p: Project, at: PanelCell): { row: number; col: number } | null {
  const s = p.wb.sheets.get(at.sheet);
  const r = s?.rows.posOf(at.row);
  const c = s?.cols.posOf(at.col);
  return r == null || c == null ? null : { row: r - 1, col: c - 1 };
}

export function ValuePanel(p: Props) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const view = useMemo(() => {
    const pos = place(project, p.at);
    if (!pos) return null;
    const g = new SheetGrid(project, p.at.sheet);
    const field = g.fieldAt(pos.row, pos.col);
    const cell = g.cell(pos.row, pos.col);
    const row = g.rowClass(pos.row);
    const issues = validate(project).issues.filter((i) => i.at?.sheet === p.at.sheet && i.at.row === p.at.row && i.at.col === p.at.col);
    let value: unknown;
    let bad = false;
    if (cell.input !== "" && !cell.formula)
      try {
        value = JSON.parse(cell.input);
      } catch {
        bad = true;
      }
    const id = row.kind === "entity" ? g.cell(pos.row, 1).text : null;
    return { pos, g, field, cell, issues, value, bad, id };
  }, [project, p.at.sheet, p.at.row, p.at.col, tick]);
  const [tab, setTab] = useState<"form" | "json">("form");
  useEffect(() => {
    if (view?.bad) setTab("json");
  }, [view?.bad]);

  const head = (title: string) => (
    <div className="issues-head">
      <h2>{title}</h2>
      <span className="spacer" />
      <button className="button quiet" onClick={p.close} title="Close" aria-label="Close the panel">
        ×
      </button>
    </div>
  );
  if (!view || !view.field)
    return (
      <aside className="issues value-panel" aria-label="Value">
        {head("Value")}
        <p className="muted small pad">{view ? "This cell isn't a struct, union, list or JSON field." : "This cell is gone: its row or column was deleted."}</p>
      </aside>
    );

  const { field, cell, g, pos } = view;
  const schema = project.schema;
  const readOnly = !p.canEdit || cell.formula;
  const byPath = issuesByPath(view.issues, field.label);
  const write = (v: unknown) =>
    p.edit((proj) => {
      const at = place(proj, p.at);
      if (!at) return { ops: [] };
      return new SheetGrid(proj, p.at.sheet).edit([{ row: at.row, col: at.col, input: cellText(proj.schema, field.type, v) }]);
    });

  // JSON that doesn't read is written as typed, so validation says what's wrong.
  const writeText = (t: string) =>
    p.edit((proj) => {
      const at = place(proj, p.at);
      return at ? new SheetGrid(proj, p.at.sheet).edit([{ row: at.row, col: at.col, input: t }]) : { ops: [] };
    });

  return (
    <aside className="issues value-panel" aria-label={`${field.label}, as a form`}>
      {head(view.id ? `${view.id} · ${field.label}` : field.label)}
      <div className="issues-filter small">
        <button className="link" onClick={() => p.goTo(p.at.sheet, pos.row, pos.col)} title="Show the cell">
          {g.name}!{g.address(pos.row, pos.col)}
        </button>
        <span className="muted"> · {formatType(field.type)}</span>
        <span className="spacer" />
        <span className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === "form"} className={tab === "form" ? "on" : ""} onClick={() => setTab("form")} disabled={view.bad}>
            Form
          </button>
          <button role="tab" aria-selected={tab === "json"} className={tab === "json" ? "on" : ""} onClick={() => setTab("json")}>
            JSON
          </button>
        </span>
      </div>
      <div className="issues-list vf">
        {cell.formula && <p className="muted small">This cell is a formula, so it's shown here but not edited. Its value: {cell.text}</p>}
        {/* The form shows each issue at its place; the JSON, all of them here, in full. */}
        <Issues list={tab === "json" || view.bad ? view.issues : byPath.get("")} />
        {tab === "json" || view.bad ? (
          <RawJson key={cell.input} schema={schema} type={field.type} input={cell.formula ? "" : cell.input} readOnly={readOnly} write={write} writeText={writeText} />
        ) : (
          <Value schema={schema} def={field.def} type={field.type} value={view.value} path="" issues={byPath} readOnly={readOnly} set={write} depth={0} />
        )}
      </div>
    </aside>
  );
}

function Issues({ list }: { list: Issue[] | undefined }) {
  if (!list?.length) return null;
  return (
    <ul className="vf-issues">
      {list.map((i, n) => (
        <li key={n} className={i.level}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

interface ValueProps {
  schema: ResolvedSchema;
  /** The field the value is for (its constraints), or null inside a json value. */
  def: FieldDef | null;
  type: FieldType;
  value: unknown;
  path: string;
  issues: Map<string, Issue[]>;
  readOnly: boolean;
  /** The new value; undefined takes it out. */
  set(v: unknown): void;
  depth: number;
}

/** One value of a field type, as a form. */
function Value(p: ValueProps) {
  const t = p.type;
  switch (t.kind) {
    case "struct": {
      const s = p.schema.structs.get(t.name);
      if (!s) return <p className="muted small">Unknown struct {t.name}</p>;
      if (!isObj(p.value)) return <Absent {...p} />;
      return <Fields {...p} fields={s.fields} obj={p.value} />;
    }
    case "union": {
      const u = p.schema.unions.get(t.name);
      if (!u) return <p className="muted small">Unknown union {t.name}</p>;
      if (!isObj(p.value)) return <Absent {...p} />;
      const tag = p.value[u.discriminator];
      const s = typeof tag === "string" ? p.schema.structs.get(tag) : undefined;
      return (
        <div className="vf-union">
          <label className="vf-row">
            <span className="vf-name">{u.discriminator}</span>
            <select value={typeof tag === "string" ? tag : ""} disabled={p.readOnly} onChange={(e) => p.set(switchVariant(p.schema, u.name, p.value, e.target.value))}>
              {!s && <option value="">{tag === undefined ? "Pick one" : String(tag)}</option>}
              {u.variants.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {s && <Fields {...p} fields={s.fields} obj={p.value} />}
        </div>
      );
    }
    case "list":
      return <List {...p} of={t.of} />;
    case "json":
      return p.def?.jsonSchema !== undefined ? <JsonValue {...p} js={p.def.jsonSchema} /> : <JsonText {...p} />;
    case "bool":
      return (
        <select value={p.value === true ? "true" : p.value === false ? "false" : ""} disabled={p.readOnly} onChange={(e) => p.set(e.target.value === "" ? undefined : e.target.value === "true")}>
          <option value="">—</option>
          <option value="true">TRUE</option>
          <option value="false">FALSE</option>
        </select>
      );
    case "enum": {
      const e = p.schema.enums.get(t.name);
      const v = typeof p.value === "string" ? p.value : "";
      return (
        <select value={v} disabled={p.readOnly} onChange={(x) => p.set(x.target.value === "" ? undefined : x.target.value)}>
          <option value="">—</option>
          {v && !e?.members.some((m) => m.name === v) && <option value={v}>{v}</option>}
          {e?.members.map((m) => (
            <option key={m.name} value={m.name} title={m.description}>
              {m.name}
            </option>
          ))}
        </select>
      );
    }
    case "int":
    case "float":
      return <Text value={p.value} readOnly={p.readOnly} number set={p.set} />;
    case "duration":
      // In JSON a duration is seconds, or text such as 90s.
      return <Text value={p.value} readOnly={p.readOnly} number loose set={p.set} placeholder="seconds, or 1m 30s" />;
    case "datetime":
      return <Text value={p.value} readOnly={p.readOnly} set={p.set} placeholder="2026-11-14 18:00 (UTC)" />;
    default:
      return <Text value={p.value} readOnly={p.readOnly} set={p.set} />;
  }
}

/** A struct or union that isn't there: a button to make it. */
function Absent(p: ValueProps) {
  if (p.value !== undefined && p.value !== null) return <p className="vf-bad small">Not {p.type.kind === "union" ? "a variant" : "an object"}: {JSON.stringify(p.value)}</p>;
  if (p.readOnly) return <span className="muted small">none</span>;
  return (
    <button className="button quiet small" onClick={() => p.set(blank(p.schema, p.type))}>
      + Set {p.type.kind === "struct" || p.type.kind === "union" ? p.type.name : ""}
    </button>
  );
}

const nested = (t: FieldType) => t.kind === "struct" || t.kind === "union" || t.kind === "list" || t.kind === "json";

/** A struct's fields, or a union variant's: one row each, nested ones in sections that fold. */
function Fields(p: ValueProps & { fields: readonly FieldDef[]; obj: Obj }) {
  const known = new Set(p.fields.map((f) => f.name));
  const extra = Object.keys(p.obj).filter((k) => !known.has(k) && !(p.type.kind === "union" && k === p.schema.unions.get(p.type.name)?.discriminator));
  const setField = (name: string, v: unknown) => {
    const next: Obj = { ...p.obj };
    if (v === undefined) delete next[name];
    else next[name] = v;
    p.set(next);
  };
  return (
    <div className="vf-fields">
      {p.fields.map((f) => {
        const path = pathIn(p.path, f.name);
        const v = p.obj[f.name];
        const child = (
          <Value schema={p.schema} def={f} type={f.type} value={v} path={path} issues={p.issues} readOnly={p.readOnly} set={(x) => setField(f.name, x)} depth={p.depth + 1} />
        );
        const label = (
          <span className="vf-name" title={[formatType(f.type), f.description].filter(Boolean).join(" · ")}>
            {f.name}
            {f.required && <span className="vf-req" title="Required"> *</span>}
          </span>
        );
        if (nested(f.type) && v !== undefined)
          return (
            <details key={f.id} className="vf-section" open={p.depth < 2}>
              <summary>
                {label}
                <span className="muted small vf-sum">{summary(p.schema, f.type, v)}</span>
                {!p.readOnly && !f.required && (
                  <button className="button quiet small vf-x" title={`Take out ${f.name}`} onClick={(e) => (e.preventDefault(), setField(f.name, undefined))}>
                    ×
                  </button>
                )}
              </summary>
              <Issues list={p.issues.get(path)} />
              {child}
            </details>
          );
        return (
          <div key={f.id} className="vf-field">
            <label className="vf-row">
              {label}
              {child}
              {f.default !== undefined && v === undefined && <span className="muted small"> default {String(f.default)}</span>}
            </label>
            <Issues list={p.issues.get(path)} />
          </div>
        );
      })}
      {extra.map((k) => (
        <div key={k} className="vf-field">
          <span className="vf-row">
            <span className="vf-name vf-bad">{k}</span>
            <code className="small">{JSON.stringify(p.obj[k])}</code>
            {!p.readOnly && (
              <button className="button quiet small" title={`Take out ${k}`} onClick={() => setField(k, undefined)}>
                ×
              </button>
            )}
          </span>
          <Issues list={p.issues.get(pathIn(p.path, k))} />
        </div>
      ))}
    </div>
  );
}

/** A list: each item with its place, moved up or down or taken out, and one added at the end. */
function List(p: ValueProps & { of: FieldType }) {
  if (p.value !== undefined && !Array.isArray(p.value)) return <p className="vf-bad small">Not a list: {JSON.stringify(p.value)}</p>;
  const items = (p.value as unknown[] | undefined) ?? [];
  const put = (next: unknown[]) => p.set(next);
  const move = (i: number, d: number) => {
    const next = [...items];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    put(next);
  };
  const big = nested(p.of);
  return (
    <div className="vf-list">
      {items.map((x, i) => {
        const path = pathIn(p.path, i);
        const tools = !p.readOnly && (
          <span className="vf-tools">
            <button className="button quiet small" disabled={i === 0} title="Move up" onClick={(e) => (e.preventDefault(), move(i, -1))}>
              ↑
            </button>
            <button className="button quiet small" disabled={i === items.length - 1} title="Move down" onClick={(e) => (e.preventDefault(), move(i, 1))}>
              ↓
            </button>
            <button className="button quiet small" title="Take out" onClick={(e) => (e.preventDefault(), put(items.filter((_, j) => j !== i)))}>
              ×
            </button>
          </span>
        );
        const child = <Value schema={p.schema} def={p.def} type={p.of} value={x} path={path} issues={p.issues} readOnly={p.readOnly} set={(v) => put(items.map((y, j) => (j === i ? (v === undefined ? blank(p.schema, p.of) : v) : y)))} depth={p.depth + 1} />;
        return big ? (
          <details key={i} className="vf-section vf-item" open={p.depth < 2}>
            <summary>
              <span className="vf-name">{i + 1}</span>
              <span className="muted small vf-sum">{summary(p.schema, p.of, x)}</span>
              {tools}
            </summary>
            <Issues list={p.issues.get(path)} />
            {child}
          </details>
        ) : (
          <div key={i} className="vf-field">
            <span className="vf-row">
              <span className="vf-name">{i + 1}</span>
              {child}
              {tools}
            </span>
            <Issues list={p.issues.get(path)} />
          </div>
        );
      })}
      {items.length === 0 && <p className="muted small">No items.</p>}
      {!p.readOnly && (
        <button className="button quiet small" onClick={() => put([...items, blank(p.schema, p.of)])}>
          + Add {p.of.kind === "struct" || p.of.kind === "union" ? p.of.name : "an item"}
        </button>
      )}
    </div>
  );
}

/**
 * A text or number box, written when it's left (Enter, Tab or a click away), not on each key.
 * Blank takes the value out. A number that doesn't read is written as typed, so validation says so.
 */
function Text(p: { value: unknown; readOnly: boolean; set(v: unknown): void; number?: boolean; loose?: boolean; placeholder?: string }) {
  const shown = p.value === undefined || p.value === null ? "" : typeof p.value === "string" ? p.value : JSON.stringify(p.value);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null || draft === shown) return setDraft(null);
    const t = draft.trim();
    let v: unknown = draft;
    if (t === "") v = undefined;
    else if (p.number && Number.isFinite(Number(t))) v = Number(t);
    setDraft(null);
    p.set(v);
  };
  return (
    <input
      className={p.number ? "vf-input num" : "vf-input"}
      value={draft ?? shown}
      readOnly={p.readOnly}
      spellCheck={false}
      placeholder={p.placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

/** A json value with no JSON Schema: its JSON text, written when it reads. */
function JsonText(p: ValueProps) {
  const shown = p.value === undefined ? "" : JSON.stringify(p.value, null, 2);
  const [draft, setDraft] = useState<string | null>(null);
  let error: string | null = null;
  if (draft !== null && draft.trim() !== "")
    try {
      JSON.parse(draft);
    } catch (e) {
      error = (e as Error).message;
    }
  const commit = () => {
    if (draft === null || error) return;
    setDraft(null);
    if (draft !== shown) p.set(draft.trim() === "" ? undefined : JSON.parse(draft));
  };
  return (
    <div className="vf-json">
      <textarea value={draft ?? shown} readOnly={p.readOnly} spellCheck={false} rows={Math.min(12, Math.max(2, (draft ?? shown).split("\n").length))} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />
      {error && <p className="vf-bad small">{error}</p>}
    </div>
  );
}

/** A json value with a JSON Schema: a form from the schema where it says enough, JSON text where it doesn't. */
function JsonValue(p: ValueProps & { js: unknown }) {
  const s: Obj = isObj(p.js) ? p.js : {};
  const type = Array.isArray(s.type) ? undefined : (s.type as string | undefined);
  const sub = (js: unknown, value: unknown, path: string, set: (v: unknown) => void) => <JsonValue {...p} js={js} value={value} path={path} set={set} depth={p.depth + 1} />;
  if (Array.isArray(s.enum))
    return (
      <select value={JSON.stringify(p.value) ?? ""} disabled={p.readOnly} onChange={(e) => p.set(e.target.value === "" ? undefined : JSON.parse(e.target.value))}>
        <option value="">—</option>
        {p.value !== undefined && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(p.value)) && <option value={JSON.stringify(p.value)}>{JSON.stringify(p.value)}</option>}
        {s.enum.map((x, i) => (
          <option key={i} value={JSON.stringify(x)}>
            {typeof x === "string" ? x : JSON.stringify(x)}
          </option>
        ))}
      </select>
    );
  if (type === "object" && isObj(s.properties) && (p.value === undefined || isObj(p.value))) {
    if (p.value === undefined)
      return p.readOnly ? <span className="muted small">none</span> : <button className="button quiet small" onClick={() => p.set({})}>+ Set</button>;
    const obj = p.value as Obj;
    const required = new Set(Array.isArray(s.required) ? s.required : []);
    const props = s.properties;
    const setKey = (k: string, v: unknown) => {
      const next: Obj = { ...obj };
      if (v === undefined) delete next[k];
      else next[k] = v;
      p.set(next);
    };
    const extra = Object.keys(obj).filter((k) => !(k in props));
    return (
      <div className="vf-fields">
        {[...Object.keys(props), ...extra].map((k) => {
          const path = pathIn(p.path, k);
          const ps = props[k] ?? (isObj(s.additionalProperties) ? s.additionalProperties : {});
          const t = isObj(ps) ? ps.type : undefined;
          const deep = (t === "object" || t === "array") && obj[k] !== undefined;
          const label = (
            <span className="vf-name" title={isObj(ps) && typeof ps.description === "string" ? ps.description : undefined}>
              {k}
              {required.has(k) && <span className="vf-req"> *</span>}
            </span>
          );
          return deep ? (
            <details key={k} className="vf-section" open={p.depth < 2}>
              <summary>
                {label}
                <span className="muted small vf-sum">{JSON.stringify(obj[k])}</span>
              </summary>
              <Issues list={p.issues.get(path)} />
              {sub(ps, obj[k], path, (v) => setKey(k, v))}
            </details>
          ) : (
            <div key={k} className="vf-field">
              <label className="vf-row">
                {label}
                {sub(ps, obj[k], path, (v) => setKey(k, v))}
              </label>
              <Issues list={p.issues.get(path)} />
            </div>
          );
        })}
      </div>
    );
  }
  if (type === "array" && isObj(s.items) && (p.value === undefined || Array.isArray(p.value))) {
    const items = (p.value as unknown[] | undefined) ?? [];
    const it = s.items;
    const start = it.type === "object" ? {} : it.type === "array" ? [] : it.type === "number" || it.type === "integer" ? 0 : it.type === "boolean" ? false : Array.isArray(it.enum) ? it.enum[0] : "";
    return (
      <div className="vf-list">
        {items.map((x, i) => (
          <div key={i} className="vf-field">
            <span className="vf-row">
              <span className="vf-name">{i + 1}</span>
              {sub(it, x, pathIn(p.path, i), (v) => p.set(items.map((y, j) => (j === i ? (v === undefined ? start : v) : y))))}
              {!p.readOnly && (
                <button className="button quiet small" title="Take out" onClick={() => p.set(items.filter((_, j) => j !== i))}>
                  ×
                </button>
              )}
            </span>
            <Issues list={p.issues.get(pathIn(p.path, i))} />
          </div>
        ))}
        {!p.readOnly && (
          <button className="button quiet small" onClick={() => p.set([...items, start])}>
            + Add an item
          </button>
        )}
      </div>
    );
  }
  if (type === "boolean")
    return (
      <select value={p.value === true ? "true" : p.value === false ? "false" : ""} disabled={p.readOnly} onChange={(e) => p.set(e.target.value === "" ? undefined : e.target.value === "true")}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  if ((type === "number" || type === "integer" || type === "string") && (p.value === undefined || typeof p.value !== "object"))
    return <Text value={p.value} readOnly={p.readOnly} number={type !== "string"} set={p.set} />;
  return <JsonText {...p} />;
}

/** The whole value as JSON text: checked against the field's type as it's typed, written with Apply. */
function RawJson(p: { schema: ResolvedSchema; type: FieldType; input: string; readOnly: boolean; write(v: unknown): void; writeText(t: string): void }) {
  const pretty = (() => {
    try {
      return p.input === "" ? "" : JSON.stringify(JSON.parse(p.input), null, 2);
    } catch {
      return p.input;
    }
  })();
  const [text, setText] = useState(pretty);
  let problem: string | null = null;
  let value: unknown;
  if (text.trim() !== "") {
    try {
      value = JSON.parse(text);
      const r = parseJson(p.schema, p.type, value);
      if (!r.ok) problem = r.message;
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  const changed = text !== pretty;
  return (
    <div className="vf-json">
      <textarea aria-label="The value as JSON" value={text} readOnly={p.readOnly} spellCheck={false} rows={Math.min(24, Math.max(6, text.split("\n").length + 1))} onChange={(e) => setText(e.target.value)} />
      {problem ? <p className="vf-bad small">{problem}</p> : text.trim() !== "" && <p className="muted small">Reads as {formatType(p.type)}.</p>}
      {!p.readOnly && (
        <div className="vf-actions">
          <button className="button" disabled={!changed} onClick={() => (text.trim() === "" ? p.write(undefined) : value === undefined ? p.writeText(text) : p.write(value))} title={problem ? "Apply anyway: validation will say what's wrong" : undefined}>
            Apply
          </button>
          <button className="button quiet" disabled={!changed} onClick={() => setText(pretty)}>
            Revert
          </button>
        </div>
      )}
    </div>
  );
}
