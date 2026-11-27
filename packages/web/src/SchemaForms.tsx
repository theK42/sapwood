// The schema editor's forms (DESIGN §5.8): the definitions down the left, the chosen one's
// form on the right. Every change edits the working copy (schemaEdit.ts); the page writes it
// as YAML and previews it, and nothing reaches the task until it's applied. Names are typed
// in place and kept on Enter or leaving the box; field types are picked, not typed (§13).
// Definitions, rules, wizards and fields are put in a new order by dragging them, or with
// Alt+↑↓ (reorder.tsx); like any change, it's applied with the rest.

import { useEffect, useState } from "react";
import { formatType, type EnumDef, type FieldDef, type FieldType, type Project, type Schema, type TraitDef, type TypeDef, type UnionDef } from "@thek42/sapwood-core";
import { RuleForm } from "./RuleForm.tsx";
import { useReorder } from "./reorder.tsx";
import type { WizardDef } from "@thek42/sapwood-core";
import {
  addDef, addField, addRule, constraintsFor, defOf, keyOf, moveDef, moveField, NAME, removeDef, removeField, renameDef, renameMember, SECTIONS, setDef, setField,
  type Def, type Section, type WithFields,
} from "./schemaEdit.ts";

export interface Selected {
  section: Section | "rules" | "wizards";
  id: string;
}

interface Props {
  schema: Schema;
  /** The schema as the task has it: what's new or changed shows against it. */
  applied: Schema;
  packs: string[];
  canEdit: boolean;
  /** A change to the working copy; `select` names a definition to show after it (by name: a new one has no ID yet). */
  change(next: Schema, select?: { section: Section | "rules"; name: string }): void;
  selected: Selected | null;
  select(s: Selected | null): void;
  /** Rules are checked on this: the project as applying the draft would leave it. */
  checkOn: Project;
  openEntity(type: string, id: string): void;
  /** Wizards are edited as YAML: switch to the YAML tab. */
  openYaml(): void;
}

export function SchemaForms(p: Props) {
  const sel = !p.selected
    ? null
    : p.selected.section === "rules"
      ? (p.schema.rules.some((r) => r.id === p.selected!.id) ? p.selected : null)
      : p.selected.section === "wizards"
        ? (p.schema.wizards.some((w) => w.id === p.selected!.id) ? p.selected : null)
        : defOf(p.schema, p.selected.section, p.selected.id) ? p.selected : null;
  const wizard = sel?.section === "wizards" ? p.schema.wizards.find((w) => w.id === sel.id)! : null;
  const rule = sel?.section === "rules" ? p.schema.rules.find((r) => r.id === sel.id)! : null;
  const [adding, setAdding] = useState<Section | null>(null);
  const isNew = (section: Section, id: string) => !defOf(p.applied, section, id);
  // Items are `${section}|${keyOf(def)}`: dragged only within their own section.
  const sectionOf = (k: string) => k.slice(0, k.indexOf("|"));
  const keyIn = (k: string) => k.slice(k.indexOf("|") + 1);
  const order = useReorder(
    p.canEdit,
    (k, target, where) => p.change(moveDef(p.schema, sectionOf(k) as Section, keyIn(k), keyIn(target), where)),
    (a, b) => sectionOf(a) === sectionOf(b),
  );
  const listed = (section: string, defs: { id: string; name?: string }[]) => defs.map((d) => `${section}|${keyOf(d)}`);
  return (
    <div className="schema-forms">
      <nav className="schema-defs" aria-label="Definitions">
        {SECTIONS.map(({ key, one, many }) => (
          <section key={key}>
            <h3>
              {many}
              {p.canEdit && (
                <button className="link small" onClick={() => setAdding(key)} title={`A new ${one}`}>
                  + Add
                </button>
              )}
            </h3>
            <ul>
              {(p.schema[key] as Def[]).map((d) => (
                <li key={keyOf(d)} {...order.item(`${key}|${keyOf(d)}`)}>
                  <button className={sel?.section === key && sel.id === d.id ? "on" : ""} onClick={() => p.select({ section: key, id: d.id })} onKeyDown={order.keys(`${key}|${keyOf(d)}`, listed(key, p.schema[key] as Def[]))}>
                    {d.name}
                    {isNew(key, d.id) && <span className="tag">new</span>}
                    {key === "types" && (d as TypeDef).singleton && <span className="muted small"> singleton</span>}
                  </button>
                </li>
              ))}
              {adding === key && (
                <li>
                  <NameBox start="" label={`New ${one}'s name`} done={(n) => (setAdding(null), n && p.change(addDef(p.schema, key, n), { section: key, name: n }))} />
                </li>
              )}
            </ul>
          </section>
        ))}
        <section>
          <h3>
            Rules
            {p.canEdit && (
              <button className="link small" onClick={() => p.change(addRule(p.schema, sel && sel.section === "types" ? defOf(p.schema, "types", sel.id)?.name : undefined), { section: "rules", name: "" })} title="A new validation rule">
                + Add
              </button>
            )}
          </h3>
          <ul>
            {p.schema.rules.map((r) => (
              <li key={r.id} {...order.item(`rules|${keyOf(r)}`)}>
                <button className={sel?.section === "rules" && sel.id === r.id ? "on" : ""} onClick={() => p.select({ section: "rules", id: r.id })} onKeyDown={order.keys(`rules|${keyOf(r)}`, listed("rules", p.schema.rules))} title={r.expr}>
                  <span className="rule-name">{r.message}</span>
                  {!p.applied.rules.some((x) => x.id === r.id) && <span className="tag">new</span>}
                  <span className="muted small">{r.type ?? "global"}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h3>
            Wizards
            {p.canEdit && (
              <button className="link small" onClick={p.openYaml} title="Wizards are written in the YAML tab (wizards:)">
                + Add
              </button>
            )}
          </h3>
          <ul>
            {p.schema.wizards.map((w) => (
              <li key={w.id} {...order.item(`wizards|${keyOf(w)}`)}>
                <button className={sel?.section === "wizards" && sel.id === w.id ? "on" : ""} onClick={() => p.select({ section: "wizards", id: w.id })} onKeyDown={order.keys(`wizards|${keyOf(w)}`, listed("wizards", p.schema.wizards))}>
                  <span className="rule-name">{w.title ?? w.name}</span>
                  {!p.applied.wizards.some((x) => x.id === w.id) && <span className="tag">new</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      </nav>
      <div className="schema-def">
        {!sel ? (
          <p className="muted pad">Pick a definition on the left{p.canEdit ? ", or add one" : ""}.</p>
        ) : rule ? (
          <RuleForm schema={p.schema} rule={rule} canEdit={p.canEdit} change={(n) => p.change(n)} checkOn={p.checkOn} openEntity={p.openEntity} close={() => p.select(null)} />
        ) : wizard ? (
          <WizardView w={wizard} canEdit={p.canEdit} openYaml={p.openYaml} />
        ) : sel.section === "rules" || sel.section === "wizards" ? null : (
          <DefForm {...p} sel={sel as { section: Section; id: string }} def={defOf(p.schema, sel.section as Section, sel.id)!} />
        )}
      </div>
    </div>
  );
}

function DefForm(p: Props & { sel: { section: Section; id: string }; def: Def }) {
  const { sel, def, schema } = p;
  const ro = !p.canEdit;
  const one = SECTIONS.find((x) => x.key === sel.section)!.one;
  const set = (patch: Record<string, unknown>) => p.change(setDef(schema, sel.section, def.id, patch));
  return (
    <div className="vf schema-def-form">
      <div className="vf-fields">
        <label className="vf-row">
          <span className="vf-name">{one[0]!.toUpperCase() + one.slice(1)}</span>
          <TextBox value={def.name} readOnly={ro} check={(v) => (NAME.test(v) ? null : "Letters, digits and _, not starting with a digit")} set={(v) => p.change(renameDef(schema, sel.section, def.id, v), { section: sel.section, name: v })} />
        </label>
        <label className="vf-row">
          <span className="vf-name">Description</span>
          <TextBox value={def.description ?? ""} readOnly={ro} set={(v) => set({ description: v || undefined })} />
        </label>
        {sel.section === "types" && (
          <>
            <label className="vf-row">
              <span className="vf-name">Singleton</span>
              <input type="checkbox" disabled={ro} checked={!!(def as TypeDef).singleton} onChange={(e) => set({ singleton: e.target.checked || undefined, pack: e.target.checked ? (def as TypeDef).pack : undefined })} />
              <span className="muted small">one per branch, with no ID (fields as rows)</span>
            </label>
            {(def as TypeDef).singleton && (
              <label className="vf-row">
                <span className="vf-name">Pack</span>
                <select disabled={ro} value={(def as TypeDef).pack ?? "root"} onChange={(e) => set({ pack: e.target.value === "root" ? undefined : e.target.value })}>
                  {p.packs.map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {(sel.section === "types" || sel.section === "traits") && (
          <Names
            label="Traits"
            values={(def as TypeDef | TraitDef).traits}
            options={schema.traits.map((t) => t.name).filter((n) => n !== def.name)}
            readOnly={ro}
            set={(v) => set({ traits: v })}
          />
        )}
        {sel.section === "unions" && (
          <>
            <label className="vf-row">
              <span className="vf-name">Tag field</span>
              <TextBox value={(def as UnionDef).discriminator} readOnly={ro} check={(v) => (NAME.test(v) ? null : "A field name")} set={(v) => set({ discriminator: v })} />
            </label>
            <Names label="Variants" values={(def as UnionDef).variants} options={schema.structs.map((s) => s.name)} readOnly={ro} set={(v) => set({ variants: v })} />
          </>
        )}
      </div>
      {sel.section === "enums" && <Members {...p} def={def as EnumDef} />}
      {(sel.section === "types" || sel.section === "traits" || sel.section === "structs") && <Fields {...p} section={sel.section} def={def as TypeDef} />}
      {p.canEdit && (
        <div className="vf-buttons">
          <button className="button quiet small danger" onClick={() => (p.change(removeDef(schema, sel.section, def.id)), p.select(null))}>
            Remove this {one}
          </button>
          <span className="muted small">Nothing is removed until it's applied; the preview says what it would do.</span>
        </div>
      )}
    </div>
  );
}

function Members(p: Props & { sel: Selected; def: EnumDef }) {
  const ro = !p.canEdit;
  const members = p.def.members;
  const put = (next: EnumDef["members"]) => p.change(setDef(p.schema, "enums", p.def.id, { members: next }));
  const [adding, setAdding] = useState(false);
  return (
    <>
      <h3 className="vf-h">Members</h3>
      <ul className="schema-rows">
        {members.map((m, i) => (
          <li key={i} className="vf-row">
            <TextBox value={m.name} readOnly={ro} check={(v) => (members.some((x, j) => j !== i && x.name === v) ? "There's one called that" : null)} set={(v) => p.change(renameMember(p.schema, p.def.id, m.name, v))} />
            <TextBox value={m.description ?? ""} readOnly={ro} placeholder="description" set={(v) => put(members.map((x, j) => (j === i ? { name: x.name, ...(v ? { description: v } : {}) } : x)))} />
            {!ro && (
              <button className="button quiet small" title={`Take out ${m.name}`} onClick={() => put(members.filter((_, j) => j !== i))}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {!ro &&
        (adding ? (
          <NameBox start="" label="New member" done={(n) => (setAdding(false), n && put([...members, { name: n }]))} />
        ) : (
          <button className="button quiet small" onClick={() => setAdding(true)}>
            + Add a member
          </button>
        ))}
    </>
  );
}

function Fields(p: Props & { sel: Selected; section: WithFields; def: TypeDef | TraitDef }) {
  const ro = !p.canEdit;
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const applied = (defOf(p.applied, p.section, p.def.id) as TypeDef | undefined)?.fields ?? [];
  const order = useReorder(!ro, (k, target, where) => p.change(moveField(p.schema, p.section, p.def.id, k, target, where)));
  const keys = p.def.fields.map(keyOf);
  return (
    <>
      <h3 className="vf-h">Fields</h3>
      {p.def.fields.length === 0 && <p className="muted small">None yet.</p>}
      <ul className="schema-rows">
        {p.def.fields.map((f) => (
          // An open row (its boxes being typed in) isn't dragged, nor moved by Alt+arrows.
          <li key={keyOf(f)} {...(open === f.id ? {} : { ...order.item(keyOf(f)), onKeyDown: order.keys(keyOf(f), keys) })}>
            <FieldRow
              {...p}
              f={f}
              isNew={!applied.some((x) => x.id === f.id)}
              open={open === f.id}
              toggle={() => setOpen(open === f.id ? null : f.id)}
              set={(patch) => p.change(setField(p.schema, p.section, p.def.id, f.id, patch))}
              remove={() => p.change(removeField(p.schema, p.section, p.def.id, f.id))}
              readOnly={ro}
            />
          </li>
        ))}
      </ul>
      {!ro &&
        (adding ? (
          <NameBox start="" label="New field's name" done={(n) => (setAdding(false), n && NAME.test(n) && p.change(addField(p.schema, p.section, p.def.id, n, { kind: "string" })))} />
        ) : (
          <button className="button quiet small" onClick={() => setAdding(true)}>
            + Add a field
          </button>
        ))}
    </>
  );
}

const CONSTRAINT: Record<string, { label: string; kind: "number" | "text" | "bool" }> = {
  min: { label: "Min", kind: "text" },
  max: { label: "Max", kind: "text" },
  minLength: { label: "Min length", kind: "number" },
  maxLength: { label: "Max length", kind: "number" },
  pattern: { label: "Pattern", kind: "text" },
  nonEmpty: { label: "Not empty", kind: "bool" },
  minItems: { label: "Min items", kind: "number" },
  maxItems: { label: "Max items", kind: "number" },
  unique: { label: "Unique items", kind: "bool" },
  finite: { label: "Finite", kind: "bool" },
};

function FieldRow(p: Props & { f: FieldDef; isNew: boolean; open: boolean; toggle(): void; set(patch: Partial<Record<keyof FieldDef, unknown>>): void; remove(): void; readOnly: boolean }) {
  const { f } = p;
  const ro = p.readOnly;
  const presence = f.required ? "required" : f.default !== undefined ? "default" : "optional";
  return (
    <div className="schema-field">
      <div className="vf-row">
        <TextBox value={f.name} readOnly={ro} check={(v) => (NAME.test(v) ? null : "Letters, digits and _")} set={(v) => p.set({ name: v })} />
        <TypePicker schema={p.schema} value={f.type} readOnly={ro} set={(t) => p.set({ type: t })} />
        <select disabled={ro} value={presence} aria-label="Presence" onChange={(e) => p.set(e.target.value === "required" ? { required: true, default: undefined } : e.target.value === "default" ? { required: undefined, default: f.default ?? "" } : { required: undefined, default: undefined })}>
          <option value="optional">optional</option>
          <option value="required">required</option>
          <option value="default">default</option>
        </select>
        {presence === "default" && <TextBox value={String(f.default ?? "")} readOnly={ro} placeholder="default" set={(v) => p.set({ default: scalar(v, f.type) })} />}
        {p.isNew && <span className="tag">new</span>}
        <span className="spacer" />
        <button className="button quiet small" aria-expanded={p.open} onClick={p.toggle} title="Constraints and description">
          {p.open ? "Less" : "More"}
        </button>
        {!ro && (
          <button className="button quiet small" title={`Take out ${f.name}`} onClick={p.remove}>
            ×
          </button>
        )}
      </div>
      {p.open && (
        <div className="schema-more">
          {constraintsFor(f.type).map((k) =>
            k === "reach" ? (
              <label key={k} className="vf-row small">
                <span className="vf-name">Reach</span>
                <input type="checkbox" disabled={ro} checked={f.reach === "descendants"} onChange={(e) => p.set({ reach: e.target.checked ? "descendants" : undefined })} />
                <span className="muted">may also point into packs below its own</span>
              </label>
            ) : CONSTRAINT[k]!.kind === "bool" ? (
              <label key={k} className="vf-row small">
                <span className="vf-name">{CONSTRAINT[k]!.label}</span>
                <input type="checkbox" disabled={ro} checked={(f as unknown as Record<string, unknown>)[k] === true} onChange={(e) => p.set({ [k]: e.target.checked || undefined })} />
              </label>
            ) : (
              <label key={k} className="vf-row small">
                <span className="vf-name">{CONSTRAINT[k]!.label}</span>
                <TextBox
                  value={String((f as unknown as Record<string, unknown>)[k] ?? "")}
                  readOnly={ro}
                  set={(v) => p.set({ [k]: v === "" ? undefined : CONSTRAINT[k]!.kind === "number" || (/^-?\d+(\.\d+)?$/.test(v) && (f.type.kind === "int" || f.type.kind === "float")) ? Number(v) : v })}
                />
              </label>
            ),
          )}
          <label className="vf-row small">
            <span className="vf-name">Description</span>
            <TextBox value={f.description ?? ""} readOnly={ro} set={(v) => p.set({ description: v || undefined })} />
          </label>
          {constraintsFor(f.type).length === 0 && f.type.kind !== "json" && <p className="muted small">No constraints for {formatType(f.type)}.</p>}
          {f.type.kind === "json" && <p className="muted small">A JSON Schema for it is edited in the YAML tab (jsonSchema).</p>}
        </div>
      )}
    </div>
  );
}

/** A default as the YAML has it: a number for number fields, true/false for booleans. */
function scalar(v: string, t: FieldType): string | number | boolean {
  if ((t.kind === "int" || t.kind === "float") && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (t.kind === "bool" && /^(true|false)$/i.test(v)) return v.toLowerCase() === "true";
  return v;
}

const SIMPLE = ["string", "int", "float", "bool", "datetime", "duration", "json"] as const;

/** A field type, picked: the kind, then what it names (or, for a list, what it holds). */
export function TypePicker(p: { schema: Schema; value: FieldType; readOnly: boolean; set(t: FieldType): void }) {
  const t = p.value;
  const s = p.schema;
  const first = (names: string[]) => names[0] ?? "";
  const make = (kind: string): FieldType => {
    switch (kind) {
      case "enum":
        return { kind, name: first(s.enums.map((e) => e.name)) };
      case "struct":
        return { kind, name: first(s.structs.map((x) => x.name)) };
      case "union":
        return { kind, name: first(s.unions.map((x) => x.name)) };
      case "ref":
        return { kind, targets: s.types[0] ? [s.types[0].name] : "any" };
      case "list":
        return { kind, of: { kind: "string" } };
      default:
        return { kind } as FieldType;
    }
  };
  const named = (names: string[], name: string, setName: (n: string) => void) => (
    <select disabled={p.readOnly} value={name} aria-label="Which" onChange={(e) => setName(e.target.value)}>
      {!names.includes(name) && <option value={name}>{name || "—"}</option>}
      {names.map((n) => (
        <option key={n}>{n}</option>
      ))}
    </select>
  );
  return (
    <span className="type-picker" title={formatType(t)}>
      <select disabled={p.readOnly} value={t.kind} aria-label="Type" onChange={(e) => p.set(make(e.target.value))}>
        {[...SIMPLE, "enum", "ref", "list", "struct", "union"].map((k) => (
          <option key={k}>{k}</option>
        ))}
      </select>
      {t.kind === "enum" && named(s.enums.map((e) => e.name), t.name, (n) => p.set({ kind: "enum", name: n }))}
      {t.kind === "struct" && named(s.structs.map((x) => x.name), t.name, (n) => p.set({ kind: "struct", name: n }))}
      {t.kind === "union" && named(s.unions.map((x) => x.name), t.name, (n) => p.set({ kind: "union", name: n }))}
      {t.kind === "ref" && (
        <Names
          label="to"
          values={t.targets === "any" ? ["any"] : t.targets}
          options={["any", ...s.types.filter((x) => !x.singleton).map((x) => x.name), ...s.traits.map((x) => x.name)]}
          readOnly={p.readOnly}
          inline
          set={(v) => p.set({ kind: "ref", targets: v.includes("any") || v.length === 0 ? "any" : v })}
        />
      )}
      {t.kind === "list" && (
        <>
          <span className="muted small">of</span>
          <TypePicker schema={s} value={t.of} readOnly={p.readOnly} set={(of) => p.set({ kind: "list", of })} />
        </>
      )}
    </span>
  );
}

/** Names picked from a list, as chips: × to take one out, a list to add one. */
function Names(p: { label: string; values: string[]; options: string[]; readOnly: boolean; set(v: string[]): void; inline?: boolean }) {
  const left = p.options.filter((o) => !p.values.includes(o));
  const chips = (
    <span className="chips">
      {p.values.map((v) => (
        <span key={v} className="chip">
          {v}
          {!p.readOnly && (
            <button className="link" aria-label={`Take out ${v}`} onClick={() => p.set(p.values.filter((x) => x !== v))}>
              ×
            </button>
          )}
        </span>
      ))}
      {!p.readOnly && left.length > 0 && (
        <select value="" aria-label={`Add to ${p.label}`} onChange={(e) => e.target.value && p.set(e.target.value === "any" ? ["any"] : [...p.values.filter((x) => x !== "any"), e.target.value])}>
          <option value="">+</option>
          {left.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
      )}
      {p.values.length === 0 && p.readOnly && <span className="muted small">none</span>}
    </span>
  );
  if (p.inline) return chips;
  return (
    <div className="vf-row">
      <span className="vf-name">{p.label}</span>
      {chips}
    </div>
  );
}

/** Text kept on Enter or leaving the box; Escape puts it back. `check` refuses a value with a reason. */
function TextBox(p: { value: string; readOnly: boolean; set(v: string): void; check?: (v: string) => string | null; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [p.value]);
  const bad = draft !== null && p.check ? p.check(draft.trim()) : null;
  const commit = () => {
    if (draft === null) return;
    const v = draft.trim();
    if (v !== p.value && !bad) p.set(v);
    setDraft(null);
  };
  return (
    <span className="schema-text-box">
      <input
        className={bad ? "vf-input bad" : "vf-input"}
        value={draft ?? p.value}
        readOnly={p.readOnly}
        placeholder={p.placeholder}
        spellCheck={false}
        title={bad ?? undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
      />
    </span>
  );
}

function NameBox(p: { start: string; label: string; done(name: string | null): void }) {
  const [v, setV] = useState(p.start);
  const bad = v.trim() !== "" && !NAME.test(v.trim());
  return (
    <span className="vf-row">
      <input
        className={bad ? "vf-input bad" : "vf-input"}
        autoFocus
        value={v}
        aria-label={p.label}
        placeholder={p.label}
        spellCheck={false}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => p.done(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") p.done(v.trim() && !bad ? v.trim() : null);
          else if (e.key === "Escape") p.done(null);
        }}
      />
      {bad && <span className="vf-bad small">Letters, digits and _</span>}
    </span>
  );
}

/** A wizard, to read (DESIGN §9.3): it's edited as YAML. */
function WizardView(p: { w: WizardDef; canEdit: boolean; openYaml(): void }) {
  const { w } = p;
  const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return (
    <div className="vf schema-def-form">
      <h3 className="vf-h">{w.title ?? w.name}</h3>
      {w.description && <p className="small">{w.description}</p>}
      <p className="small">
        Name <code>{w.name}</code>. Writes on <code>{w.sheet.name}</code>
        {w.sheet.pack ? <> in <code>{w.sheet.pack}</code></> : null}
        {w.sheet.create ? " (made if it isn't there)" : ""},{" "}
        {w.position === "afterLastGroup" ? "after its last run there" : w.position === "cursor" ? "at the selected row" : "at the end"}
        {w.spacing ? `, ${w.spacing} blank ${w.spacing === 1 ? "row" : "rows"} before each run` : ""}.
      </p>
      <h3 className="vf-h">Parameters</h3>
      <table className="history-diff small">
        <tbody>
          {Object.entries(w.params).map(([n, d]) => (
            <tr key={n}>
              <th>{n}</th>
              <td>
                <code>{d.type}</code>
                {d.required ? " required" : ""}
                {d.default !== undefined ? ` (default ${json(d.default)})` : ""}
                {d.pattern === "identifier" ? ", an identifier" : d.pattern ? ` matching ${d.pattern}` : ""}
              </td>
            </tr>
          ))}
          {Object.keys(w.params).length === 0 && (
            <tr>
              <td className="muted">None.</td>
            </tr>
          )}
        </tbody>
      </table>
      {(w.steps ?? []).length > 0 && (
        <>
          <h3 className="vf-h">First</h3>
          <ul className="move-list small">
            {(w.steps ?? []).map((st, i) => (
              <li key={i}>{"createPack" in st ? `Makes pack ${st.createPack}${st.editors ? " (Editors may)" : " (a Developer's)"}` : `Makes sheet ${st.createSheet}${st.pack ? ` in ${st.pack}` : ""}`}</li>
            ))}
          </ul>
        </>
      )}
      <h3 className="vf-h">Rows</h3>
      <ul className="move-list small">
        {w.rows.map((r, i) => (
          <li key={i}>
            <code>{r.type}</code> <code>{r.id}</code>
            {r.forEach ? ` for each of ${r.forEach}` : ""}
            {r.when ? ` when ${r.when}` : ""}
            {r.sheet || r.pack ? ` on ${r.sheet ?? "its sheet"}${r.pack ? ` in ${r.pack}` : ""}` : ""}
            {r.fields && Object.keys(r.fields).length > 0 && <span className="muted"> · {Object.entries(r.fields).map(([k, v]) => `${k}: ${json(v)}`).join(", ")}</span>}
          </li>
        ))}
      </ul>
      {p.canEdit && (
        <div className="vf-buttons">
          <button className="button quiet small" onClick={p.openYaml}>
            Edit it in the YAML tab
          </button>
        </div>
      )}
    </div>
  );
}
