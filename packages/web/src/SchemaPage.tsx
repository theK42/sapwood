// The schema editor (DESIGN §5.8): the schema as YAML, edited as a working copy. Beside it,
// what applying it would do, worked out on a copy of the project as it's typed: problems
// with the text, data cells that would become scratch, formulas and rules a rename leaves
// alone, and issues added or cleared. Applying sends the YAML to the server, as the CLI's
// `schema apply` does, into your task. Editing needs the Developer role (§11.2); anyone can read.

import { useEffect, useMemo, useState } from "react";
import { Sapwood, type CellAddress } from "@thek42/sapwood-core";
import type { Source } from "./head.ts";
import { plural, useSource } from "./hooks.ts";
import { previewSchema } from "./schema.ts";

interface Props {
  source: Source;
  /** A Developer, in a task that can be edited (or one to be made). */
  canEdit: boolean;
  /** Send the YAML; the reason if it's refused. */
  apply(yaml: string, force: boolean): Promise<string | null>;
  back(): void;
  goTo(sheet: string, cell: string): void;
}

export function SchemaPage(p: Props) {
  const tick = useSource(p.source);
  const project = p.source.project;
  const current = useMemo(() => new Sapwood(project).schemaYaml(), [project, tick]);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? current;
  // The preview follows the typing, a moment behind.
  const [checked, setChecked] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setChecked(text), 300);
    return () => clearTimeout(t);
  }, [text]);
  const preview = useMemo(() => (draft === null || checked === current ? null : previewSchema(project, checked)), [project, tick, checked, current, draft === null]);
  const [scratchOk, setScratchOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => setScratchOk(false), [checked]);

  const apply = async () => {
    setBusy(true);
    const refused = await p.apply(text, scratchOk);
    setBusy(false);
    if (refused) setResult(refused);
    else {
      setResult("Applied to your task.");
      setDraft(null);
    }
  };
  const ready = preview !== null && !preview.same && preview.problems.length === 0 && (preview.scratch.length === 0 || scratchOk) && checked === text;
  const at = (c: CellAddress) => (
    <button key={`${c.sheet}!${c.cell}`} className="link" onClick={() => p.goTo(c.sheet, c.cell)}>
      {c.sheet}!{c.cell}
    </button>
  );

  return (
    <main className="schema-page">
      <div className="sheet-bar">
        <button className="button quiet" onClick={p.back} title="Back to the packs">
          ←
        </button>
        <strong>Schema</strong>
        <span className="tag">YAML</span>
        <span className="muted small">{p.canEdit ? "Edit it here, then apply it to your task." : "Read only: editing the schema needs the Developer role."}</span>
        <span className="spacer" />
        {draft !== null && (
          <button className="button quiet small" onClick={() => (setDraft(null), setResult(null))}>
            Discard changes
          </button>
        )}
      </div>
      <div className="schema-body">
        <textarea
          className="schema-text"
          value={text}
          readOnly={!p.canEdit}
          spellCheck={false}
          aria-label="The schema, as YAML"
          onChange={(e) => (setDraft(e.target.value), setResult(null))}
          onKeyDown={(e) => {
            // Tab indents, as an editor does, rather than leaving the box.
            if (e.key !== "Tab" || e.shiftKey || !p.canEdit) return;
            e.preventDefault();
            const el = e.currentTarget;
            const s = el.selectionStart;
            const next = `${text.slice(0, s)}  ${text.slice(el.selectionEnd)}`;
            setDraft(next);
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
          }}
        />
        <aside className="schema-preview" aria-label="What applying it would do">
          <h2>What applying it would do</h2>
          {result && <p className={result.startsWith("Applied") ? "small" : "vf-bad small"} role="status">{result}</p>}
          {preview === null || preview.same ? (
            <p className="muted small">{draft === null ? "Nothing yet: edit the text, and this says what it would change." : "No change from the schema as it is."}</p>
          ) : preview.problems.length > 0 ? (
            <>
              <p className="vf-bad small">The text has {plural(preview.problems.length, "problem")}, so it can't be applied:</p>
              <ul className="vf-issues move-issues">
                {preview.problems.map((x, i) => (
                  <li key={i} className="error">
                    {x}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <ul className="move-list small schema-changes">
                {preview.changes.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              {preview.scratch.length > 0 && (
                <div className="schema-warn">
                  <p className="small">
                    A field it removes holds data: {plural(preview.scratch.length, "cell")} would become scratch (kept, but not part of the data): {preview.scratch.slice(0, 8).map(at)}
                    {preview.scratch.length > 8 && ` and ${preview.scratch.length - 8} more`}
                  </p>
                  <label className="small">
                    <input type="checkbox" checked={scratchOk} onChange={(e) => setScratchOk(e.target.checked)} /> That's fine
                  </label>
                </div>
              )}
              {preview.formulas.length > 0 && <p className="small">Formulas that mention a renamed name, left as they are: {preview.formulas.map(at)}</p>}
              {preview.rules.length > 0 && <p className="small">Rules that mention a renamed name, left as they are: {preview.rules.join(", ")}</p>}
              {preview.notes.map((n, i) => (
                <p key={i} className="small muted">
                  {n}
                </p>
              ))}
              {preview.issues.length > 0 ? (
                <>
                  <h3 className="vf-h">{plural(preview.issues.length, "new issue")}</h3>
                  <ul className="vf-issues move-issues">
                    {preview.issues.slice(0, 12).map((i, n) => (
                      <li key={n} className={i.level}>
                        {i.sheet && i.cell ? at({ sheet: i.sheet, cell: i.cell }) : null} {i.message}
                      </li>
                    ))}
                    {preview.issues.length > 12 && <li className="muted">…and {preview.issues.length - 12} more</li>}
                  </ul>
                </>
              ) : (
                <p className="small muted">It adds no issues.</p>
              )}
              {preview.fixed > 0 && <p className="small">It clears {plural(preview.fixed, "issue")}.</p>}
            </>
          )}
          {p.canEdit && (
            <div className="vf-buttons">
              <button className="button" disabled={!ready || busy} onClick={() => void apply()}>
                {busy ? "Applying…" : "Apply to my task"}
              </button>
              {preview && preview.issues.length > 0 && ready && <span className="muted small">The new issues show in your task until they're fixed.</span>}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
