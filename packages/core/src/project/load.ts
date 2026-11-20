// Build a project from text: schema YAML plus a project definition (packs, sheets,
// rows of cell inputs). Used for test fixtures now, and for import and seeding later.

import { parse as parseYaml } from "yaml";
import type { SheetKind } from "../formula/model.ts";
import { formatNumber } from "../formula/values.ts";
import { resolveSchema } from "../schema/resolve.ts";
import { parseSchema, type SchemaIssue } from "../schema/yaml.ts";
import { Project } from "./project.ts";

export interface SheetDef {
  name: string;
  pack?: string;
  kind?: SheetKind;
  /** Per type: column specs from C (see Project.setLayout). Missing types use the default. */
  layouts?: Record<string, string[]>;
  /** Cell inputs from A1, as typed: "=C2*2", "0.5", "TRUE", "text". */
  rows: unknown[][];
}

export interface ProjectDef {
  /** Packs below root, parents first. Root is always there. */
  packs?: { name: string; parent?: string }[];
  sheets: SheetDef[];
}

/** Load a project. Schema issues are returned; a schema with errors still loads as far as it can. */
export function loadProject(schemaYaml: string, def: ProjectDef | string): { project: Project; schemaIssues: SchemaIssue[] } {
  const parsed = parseSchema(schemaYaml);
  const schema = resolveSchema(parsed.schema);
  const project = new Project(schema);
  const d: ProjectDef = typeof def === "string" ? (parseYaml(def) as ProjectDef) : def;
  for (const p of d.packs ?? []) project.addPack(p.name, p.parent ?? project.wb.root);
  project.engine.batch(() => {
    for (const s of d.sheets) {
      const id = project.addSheet(s.name, s.pack ?? project.wb.root, s.kind ?? "data");
      for (const [type, specs] of Object.entries(s.layouts ?? {})) project.setLayout(id, type, specs);
      project.setRows(id, s.rows.map((r) => r.map(toInput)));
    }
  });
  return { project, schemaIssues: [...parsed.issues, ...schema.issues] };
}

/** A YAML scalar as cell input: numbers and booleans as they'd be typed. */
function toInput(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return formatNumber(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return v;
  return JSON.stringify(v); // a YAML list or map in a cell: JSON, as a list/struct cell holds
}
