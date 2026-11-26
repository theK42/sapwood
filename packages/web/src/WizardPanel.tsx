// Running a wizard (DESIGN §9.3): its parameters as a form (the entity form's editors; a pack
// picker for `pack`), and, as they're filled in, what it would make: each row and where, the
// sheets and packs it makes first, and the issues it would add, or what stops it. Run sends it
// to the server (which decides who may make packs) as one change in your task.

import { useEffect, useMemo, useState } from "react";
import { ApiError, parseType, Sapwood, type FieldDef, type FieldType, type Project, type WizardCursor, type WizardDef, type WizardReport } from "@thek42/sapwood-core";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { Fields, RefScope } from "./ValuePanel.tsx";

interface Props {
  source: Source;
  name: string;
  cursor?: WizardCursor | undefined;
  canEdit: boolean;
  /** Run it; the reason if refused. */
  run(wizard: string, params: Record<string, unknown>, cursor?: WizardCursor): Promise<string | null>;
  /** Show what it made: the first entity, on its sheet. */
  show(sheet: string, cell: string): void;
  close(): void;
}

/** A parameter as a field the form can show; `pack` shown separately. */
function asField(name: string, d: WizardDef["params"][string]): FieldDef | null {
  if (d.type === "pack") return null;
  let type: FieldType;
  try {
    type = parseType(d.type);
  } catch {
    type = { kind: "string" };
  }
  const f: FieldDef = { id: name, name, type };
  if (d.required) f.required = true;
  if (d.description) f.description = d.description;
  return f;
}

export function WizardPanel(p: Props) {
  const tick = useSource(p.source);
  const project: Project = p.source.project;
  const w = project.schema.schema.wizards.find((x) => x.name === p.name);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<WizardReport | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const fields = useMemo(() => (w ? Object.entries(w.params).map(([n, d]) => asField(n, d)).filter((f): f is FieldDef => f !== null) : []), [w]);
  const packParams = w ? Object.entries(w.params).filter(([, d]) => d.type === "pack").map(([n]) => n) : [];
  // The preview, a moment after the form changes.
  const [checked, setChecked] = useState(params);
  useEffect(() => {
    const t = setTimeout(() => setChecked(params), 250);
    return () => clearTimeout(t);
  }, [params]);
  const preview = useMemo(() => {
    if (!w) return null;
    try {
      return { report: new Sapwood(project).previewWizard(w.name, checked, p.cursor ? { cursor: p.cursor } : {}), error: null };
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      return { report: null, error: e.message };
    }
  }, [project, tick, w, checked, p.cursor?.sheet, p.cursor?.row]);

  if (!w)
    return (
      <aside className="issues value-panel wizard-panel" aria-label="Wizard">
        <Head title="Wizard" close={p.close} />
        <p className="muted small pad">No wizard called {p.name}.</p>
      </aside>
    );

  const go = async () => {
    setBusy(true);
    const r = preview?.report ?? null;
    const why = await p.run(w.name, params, p.cursor);
    setBusy(false);
    if (why) setRefused(why);
    else setDone(r);
  };

  return (
    <aside className="issues value-panel wizard-panel" aria-label={w.title ?? w.name}>
      <Head title={w.title ?? w.name} close={p.close} />
      <RefScope.Provider value={{ project, from: project.wb.root }}>
        <div className="issues-list vf">
          {w.description && <p className="small">{w.description}</p>}
          {done ? (
            <>
              <p>Made {plural(done.made.length, "entity", "entities")} in your task.</p>
              {done.made[0] && (
                <button className="link" onClick={() => p.show(done.made[0]!.sheet, done.made[0]!.cell)}>
                  Show them on {done.made[0].sheet}
                </button>
              )}
              <div className="vf-buttons">
                <button className="button quiet small" onClick={() => (setDone(null), setParams({}))}>
                  Run it again
                </button>
              </div>
            </>
          ) : (
            <>
              {p.cursor && <p className="muted small">At row {p.cursor.row} of {p.cursor.sheet}.</p>}
              {packParams.map((n) => (
                <label key={n} className="vf-row">
                  <span className="vf-name">{n}</span>
                  <select value={String(params[n] ?? w.params[n]!.default ?? "root")} onChange={(e) => setParams({ ...params, [n]: e.target.value })}>
                    {[...project.wb.packs.values()].map((x) => (
                      <option key={x.id}>{x.name}</option>
                    ))}
                  </select>
                </label>
              ))}
              {fields.length > 0 && (
                <Fields
                  schema={project.schema}
                  def={null}
                  type={{ kind: "struct", name: `wizard ${w.name}` }}
                  value={params}
                  path=""
                  issues={new Map()}
                  readOnly={!p.canEdit}
                  set={(v) => setParams({ ...((v as Record<string, unknown>) ?? {}) })}
                  depth={1}
                  fields={fields}
                  obj={params}
                />
              )}
              <h3 className="vf-h">It makes{checked !== params ? "…" : ""}</h3>
              {preview?.error ? (
                <p className="vf-bad small">{preview.error.replace(/^.*can't run: /, "")}</p>
              ) : preview?.report ? (
                <>
                  {preview.report.packs.map((x) => (
                    <p key={x} className="small">
                      A pack, {x}
                    </p>
                  ))}
                  {preview.report.sheets.map((x) => (
                    <p key={x} className="small">
                      A sheet, {x}
                    </p>
                  ))}
                  <ul className="move-list small">
                    {preview.report.made.map((m) => (
                      <li key={m.id}>
                        <code>{m.id}</code> <span className="muted">{m.type} at {m.sheet}!{m.cell}</span>
                      </li>
                    ))}
                  </ul>
                  {preview.report.issues.length > 0 && (
                    <ul className="vf-issues move-issues">
                      {preview.report.issues.slice(0, 6).map((i, n) => (
                        <li key={n} className={i.level}>
                          {i.entity?.id && <code>{i.entity.id}</code>} {i.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : null}
              {refused && <p className="vf-bad small" role="alert">{refused}</p>}
              {p.canEdit && (
                <div className="vf-buttons">
                  <button className="button" disabled={busy || !preview?.report} onClick={() => void go()}>
                    {busy ? "Running…" : `Make ${preview?.report ? plural(preview.report.made.length, "entity", "entities") : "them"}`}
                  </button>
                  {preview?.report && preview.report.issues.length > 0 && <span className="muted small">The new issues show in your task until they're fixed.</span>}
                </div>
              )}
            </>
          )}
        </div>
      </RefScope.Provider>
    </aside>
  );
}

function Head(p: { title: string; close(): void }) {
  return (
    <div className="issues-head">
      <h2>{p.title}</h2>
      <span className="spacer" />
      <button className="button quiet" onClick={p.close} title="Close" aria-label="Close">
        ×
      </button>
    </div>
  );
}
