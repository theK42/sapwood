// The schema editor's preview (DESIGN §5.8): what applying an edited schema would do, worked
// out on a copy of the project. Apart from React, so it's tested in Node.

import { ApiError, cloneDoc, formatType, isSection, Sapwood, schemaNodes, type CellAddress, type IssueJson, type Op, type FieldType, type Project, type Schema } from "@thek42/sapwood-core";

export interface SchemaPreview {
  /** The text doesn't parse or resolve: why, one problem each. Then nothing else is set. */
  problems: string[];
  /** It's the schema as it is. */
  same: boolean;
  /** What it changes, said plainly: "Vec2.x renamed to px", "3 cells rewritten". */
  changes: string[];
  /** Data cells it turns into scratch (§5.9): applying needs a yes. */
  scratch: CellAddress[];
  /** Formulas mentioning a renamed name, left as they are. */
  formulas: CellAddress[];
  /** Rules mentioning a renamed name, left as they are. */
  rules: string[];
  /** What the text asks for that isn't applied, such as reordering. */
  notes: string[];
  /** Issues it adds. */
  issues: IssueJson[];
  /** Issues it clears. */
  fixed: number;
}

const key = (i: IssueJson) => `${i.code}|${i.message}|${i.entity?.type ?? ""}|${i.entity?.id ?? ""}`;

/** Issues in `a` that `b` hasn't (as many times). */
function minus(a: readonly IssueJson[], b: readonly IssueJson[]): IssueJson[] {
  const n = new Map<string, number>();
  for (const i of b) n.set(key(i), (n.get(key(i)) ?? 0) + 1);
  return a.filter((i) => {
    const k = n.get(key(i)) ?? 0;
    if (k > 0) n.set(key(i), k - 1);
    return k === 0;
  });
}

export function previewSchema(project: Project, yaml: string): SchemaPreview {
  const none = { problems: [], same: false, changes: [], scratch: [], formulas: [], rules: [], notes: [], issues: [], fixed: 0 };
  const copy = Sapwood.fromDoc(cloneDoc(project.doc));
  copy.project.wb.idSalt = project.wb.idSalt;
  const before = copy.validate().issues;
  const old = copy.project.doc.schema;
  try {
    const c = copy.applySchema(yaml, { force: true });
    if (c.ops.length === 0) return { ...none, same: true, notes: c.notes };
    const after = copy.validate().issues;
    return { ...none, changes: describe(old, copy.project.doc.schema, c.ops), scratch: c.scratch, formulas: c.formulas, rules: c.rules, notes: c.notes, issues: minus(after, before), fixed: minus(before, after).length };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    // "The schema has problems:\n- a\n- b", or one message.
    const lines = e.message.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    return { ...none, problems: lines.length ? lines : [e.message] };
  }
}

/** A change's schema ops, said plainly, and how many cells it rewrote (renames, enum members). */
export function describe(old: Schema, now: Schema, ops: readonly Op[]): string[] {
  const before = schemaNodes(old);
  const after = schemaNodes(now);
  const name = (id: string, nodes = before): string => {
    const n = nodes.get(id) ?? after.get(id) ?? before.get(id);
    if (!n) return id;
    const own = String(n.def.name ?? n.id);
    return isSection(n.parent) ? own : `${name(n.parent, nodes)}.${own}`;
  };
  const kind = (id: string) => {
    const n = after.get(id) ?? before.get(id);
    if (!n) return "";
    return isSection(n.parent) ? { types: "type", traits: "trait", structs: "struct", unions: "union", enums: "enum", rules: "rule" }[n.parent as string] ?? "" : "field";
  };
  const out: string[] = [];
  let cells = 0;
  for (const op of ops)
    switch (op.kind) {
      case "renameType":
      case "renameField":
        out.push(`${kind(op.id)} ${name(op.id)} renamed to ${op.name}`);
        break;
      case "renameEnumMember":
        out.push(`enum ${name(op.enum)}: member ${op.from} renamed to ${op.to}`);
        break;
      case "addSchema":
        out.push(`${kind(op.def.id)} ${name(op.def.id, after)} added`);
        break;
      case "removeSchema":
        out.push(`${kind(op.id)} ${name(op.id)} removed`);
        break;
      case "setSchema": {
        const shown = op.key === "type" && typeof op.value === "object" && op.value !== null ? formatType(op.value as FieldType) : typeof op.value === "object" ? JSON.stringify(op.value) : String(op.value);
        const v = op.value === undefined ? "removed" : `set to ${shown}`;
        out.push(`${name(op.id, after)}: ${op.key} ${v}`);
        break;
      }
      case "setCell":
        cells++;
        break;
      default:
        break;
    }
  if (cells) out.push(`${cells} ${cells === 1 ? "cell" : "cells"} rewritten to match`);
  return out;
}
