// Layouts (DESIGN §6.3, §6.4, §5.6): for one sheet and one type, which column holds
// which field. Column A is the type and column B the ID; layouts cover column C onward.
//
// A column holds one of:
//  - a whole field (`cooldown`), including lists, structs and unions as JSON;
//  - one sub-field of a flattened struct (`price.amount`);
//  - one element of a list spread over repeated columns (`projectiles[0]`).
//
// Layouts are stored against stable IDs: columns by column ID and fields by field ID,
// so moving columns or renaming fields never breaks them.

import type { ColId } from "../formula/model.ts";
import type { FieldDef } from "../schema/model.ts";
import type { ResolvedSchema, ResolvedType } from "../schema/resolve.ts";

export interface LayoutColumn {
  col: ColId;
  /** Top-level field, by stable ID. */
  field: string;
  /** Struct sub-fields, by stable ID, outermost first. Empty for a whole field. */
  path: string[];
  /** Element of a repeated-column list. */
  index?: number;
}

export type Layout = LayoutColumn[];

/** One column of a layout as written: `cooldown`, `price.amount`, `projectiles[2]`. */
export interface ColumnSpecError {
  spec: string;
  message: string;
}

/**
 * Turn column specs (field names as people write them) into layout entries against
 * field IDs. `cols` are the column IDs for C, D, E… in order.
 */
export function buildLayout(
  schema: ResolvedSchema,
  type: ResolvedType,
  specs: readonly string[],
  cols: readonly ColId[],
): { layout: Layout; errors: ColumnSpecError[] } {
  const layout: Layout = [];
  const errors: ColumnSpecError[] = [];
  const seen = new Set<string>();
  specs.forEach((spec, i) => {
    if (spec === "") return; // a deliberately unmapped (scratch) column
    const m = /^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*)*)(?:\[(\d+)\])?$/.exec(spec.trim());
    if (!m) return errors.push({ spec, message: `"${spec}" isn't a column: write field, field.sub or field[0]` });
    const [, name, rest, idx] = m;
    const top = type.fieldByName.get(name!);
    if (!top) return errors.push({ spec, message: `${type.def.name} has no field "${name}"` });
    let def: FieldDef = top.def;
    const path: string[] = [];
    for (const sub of (rest ?? "").split(".").filter(Boolean)) {
      if (def.type.kind !== "struct") return errors.push({ spec, message: `"${def.name}" isn't a struct, so it has no "${sub}"` });
      const s = schema.structs.get(def.type.name);
      const f = s?.fields.find((x) => x.name === sub);
      if (!f) return errors.push({ spec, message: `${def.type.name} has no field "${sub}"` });
      path.push(f.id);
      def = f;
    }
    if (idx !== undefined && def.type.kind !== "list") return errors.push({ spec, message: `"${def.name}" isn't a list, so it can't be spread over columns` });
    if (idx !== undefined && path.length) return errors.push({ spec, message: "Lists inside flattened structs can't be spread over columns" });
    const key = `${top.def.id}/${path.join("/")}/${idx ?? ""}`;
    if (seen.has(key)) return errors.push({ spec, message: `"${spec}" appears twice` });
    seen.add(key);
    const col: LayoutColumn = { col: cols[i]!, field: top.def.id, path };
    if (idx !== undefined) col.index = Number(idx);
    layout.push(col);
  });
  // A field can be one whole column, or split, but not both.
  const whole = new Set(layout.filter((c) => !c.path.length && c.index === undefined).map((c) => c.field));
  for (const c of layout)
    if ((c.path.length || c.index !== undefined) && whole.has(c.field)) {
      const name = type.fields.find((f) => f.def.id === c.field)!.def.name;
      errors.push({ spec: name, message: `"${name}" has a whole column and split columns` });
      whole.delete(c.field);
    }
  return { layout, errors };
}

/** The default layout: every field in schema order, one whole column each (§6.3). */
export const defaultSpecs = (type: ResolvedType): string[] => type.fields.map((f) => f.def.name);
