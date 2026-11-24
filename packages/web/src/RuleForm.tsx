// A validation rule in the schema editor (DESIGN §5.7): what it's for (a type or trait, or
// the whole project), how bad it is, its expression and its message. As the expression is
// typed, it's checked against the project as the schema being edited would leave it: whether
// it reads, how many entities it checks, and which it flags, each a link to its form.

import { useEffect, useMemo, useState } from "react";
import { checkRule, type Project, type RuleDef, type Schema } from "@thek42/sapwood-core";
import { plural } from "./hooks.ts";
import { removeRule, setRule } from "./schemaEdit.ts";

interface Props {
  schema: Schema;
  rule: RuleDef;
  canEdit: boolean;
  change(next: Schema): void;
  /** The project to check the rule on: as applying the draft would leave it. */
  checkOn: Project;
  openEntity(type: string, id: string): void;
  close(): void;
}

export function RuleForm(p: Props) {
  const { rule, schema } = p;
  const ro = !p.canEdit;
  const set = (patch: Parameters<typeof setRule>[2]) => p.change(setRule(schema, rule.id, patch));
  const [expr, setExpr] = useState<string | null>(null);
  useEffect(() => setExpr(null), [rule.id, rule.expr]);
  const typed = expr ?? rule.expr;
  // Checked a moment after typing stops.
  const [checked, setChecked] = useState(typed);
  useEffect(() => {
    const t = setTimeout(() => setChecked(typed), 250);
    return () => clearTimeout(t);
  }, [typed]);
  const result = useMemo(() => checkRule(p.checkOn, { ...rule, expr: checked }), [p.checkOn, rule.type, rule.severity, rule.message, checked]);
  const invalid = result.issues.find((i) => i.code === "rule.invalid");
  const flagged = result.issues.map((i, n) => ({ i, e: result.entities[n] ?? null })).filter((x) => x.i.code === "rule");
  const unchecked = result.issues.map((i, n) => ({ i, e: result.entities[n] ?? null })).filter((x) => x.i.code === "rule.error");
  const what = rule.type ?? null;
  const commit = () => {
    if (expr !== null && expr.trim() !== rule.expr) set({ expr: expr.trim() });
  };
  const strip = (m: string) => m.replace(/^Rule [^:]*: /, "").replace(/^Rule \S+ couldn't be checked: /, "");

  return (
    <div className="vf schema-def-form">
      <div className="vf-fields">
        <label className="vf-row">
          <span className="vf-name">For</span>
          <select disabled={ro} value={rule.type ?? ""} onChange={(e) => set({ type: e.target.value || undefined })}>
            <option value="">The whole project (runs once)</option>
            <optgroup label="Each entity of a type">
              {schema.types.filter((t) => !t.singleton).map((t) => (
                <option key={t.id}>{t.name}</option>
              ))}
            </optgroup>
            {schema.traits.length > 0 && (
              <optgroup label="Each entity with a trait">
                {schema.traits.map((t) => (
                  <option key={t.id}>{t.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="vf-row">
          <span className="vf-name">Severity</span>
          <select disabled={ro} value={rule.severity} onChange={(e) => set({ severity: e.target.value })}>
            <option value="warning">warning (doesn't block landing)</option>
            <option value="error">error (blocks landing)</option>
          </select>
        </label>
        <div className="vf-field">
          <label className="vf-row rule-expr">
            <span className="vf-name">Passes when</span>
            <textarea
              value={typed}
              readOnly={ro}
              spellCheck={false}
              rows={Math.min(6, Math.max(2, typed.split("\n").length))}
              aria-label="The rule's expression"
              onChange={(e) => setExpr(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
                else if (e.key === "Escape") setExpr(null);
              }}
            />
          </label>
          <p className="muted small vf-hint">
            A formula that's TRUE when all is well{what ? `; ${what}'s fields are named variables (=cooldown >= 0.05), and REFS(field, "other") follows refs` : `; ENTITIES("Type") and ENTITIES("Type", "field") list what's there`}.
          </p>
        </div>
        <label className="vf-row">
          <span className="vf-name">Message</span>
          <MessageBox value={rule.message} readOnly={ro} set={(v) => set({ message: v })} />
        </label>
      </div>

      <h3 className="vf-h">Now{checked !== typed ? "…" : ""}</h3>
      <div className="rule-results" aria-live="polite">
        {invalid ? (
          <p className="vf-bad small">The expression doesn't work: {strip(invalid.message)}</p>
        ) : what === null ? (
          flagged.length ? <p className="small">It fails: “{rule.message}” would show as {rule.severity === "error" ? "an error" : "a warning"}.</p> : unchecked.length ? <p className="vf-bad small">It can't be checked: {strip(unchecked[0]!.i.message)}</p> : <p className="small">It passes.</p>
        ) : (
          <>
            <p className="small">
              It checks {plural(result.checked, `active ${what}`, `active ${what}s`)}: {flagged.length === 0 ? "none flagged." : `${plural(flagged.length, "flagged", "flagged")}, each as ${rule.severity === "error" ? "an error" : "a warning"}.`}
            </p>
            {flagged.length > 0 && (
              <ul className="move-list small">
                {flagged.slice(0, 20).map(({ e }, n) => (
                  <li key={n}>
                    {e?.id ? (
                      <button className="link" onClick={() => p.openEntity(e.type, e.id!)}>
                        {e.id}
                      </button>
                    ) : (
                      "(no ID)"
                    )}{" "}
                    <span className="muted">{e?.type}</span>
                  </li>
                ))}
                {flagged.length > 20 && <li className="muted">…and {flagged.length - 20} more</li>}
              </ul>
            )}
            {unchecked.length > 0 && (
              <p className="vf-bad small">
                {plural(unchecked.length, "entity", "entities")} couldn't be checked: {strip(unchecked[0]!.i.message)}
              </p>
            )}
          </>
        )}
      </div>
      {p.canEdit && (
        <div className="vf-buttons">
          <button className="button quiet small danger" onClick={() => (p.change(removeRule(schema, rule.id)), p.close())}>
            Remove this rule
          </button>
        </div>
      )}
    </div>
  );
}

function MessageBox(p: { value: string; readOnly: boolean; set(v: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [p.value]);
  const commit = () => {
    if (draft !== null && draft.trim() && draft.trim() !== p.value) p.set(draft.trim());
    setDraft(null);
  };
  return (
    <input
      className="vf-input"
      value={draft ?? p.value}
      readOnly={p.readOnly}
      aria-label="The rule's message"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}
