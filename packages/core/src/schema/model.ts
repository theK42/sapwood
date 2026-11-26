// The schema as authored (DESIGN §5): types, traits, structs, unions, enums and rules.
//
// Every named thing has a stable internal ID. Names are labels: renaming a field changes
// its name, never its ID, so layouts and stored data keep pointing at the same field.
// This module is plain data. `resolve.ts` checks it and builds the lookups.

export type Id = string;

/** A parsed field type expression, such as `list<ref<Projectile>>` (§5.3). */
export type FieldType =
  | { kind: "string" }
  | { kind: "int" }
  | { kind: "float" }
  | { kind: "bool" }
  | { kind: "datetime" }
  | { kind: "duration" }
  | { kind: "json" }
  | { kind: "enum"; name: string }
  /** Target type or trait names, or "any". */
  | { kind: "ref"; targets: string[] | "any" }
  | { kind: "list"; of: FieldType }
  | { kind: "struct"; name: string }
  | { kind: "union"; name: string };

export type Scalar = string | number | boolean;

export interface FieldDef {
  id: Id;
  name: string;
  type: FieldType;
  description?: string;
  /** Blank is an error. Mutually exclusive with `default`. */
  required?: boolean;
  /** What a blank cell exports as. Written as the cell would be (§5.3 "Presence"). */
  default?: Scalar;
  // Constraints. Which ones apply depends on the type; resolve.ts reports misplaced ones.
  min?: number | string; // numbers; datetimes and durations as their text form
  max?: number | string;
  finite?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  nonEmpty?: boolean;
  minItems?: number;
  maxItems?: number;
  unique?: boolean;
  /** `ref` and `list<ref>` only: allow targets in descendant packs (§7.2). */
  reach?: "descendants";
  /** `json` only: a JSON Schema the value must satisfy. */
  jsonSchema?: unknown;
}

export interface TypeDef {
  id: Id;
  name: string;
  description?: string;
  /** Trait names, in order. Their fields come before the type's own (§5.5). */
  traits: string[];
  fields: FieldDef[];
  /** At most one instance per branch, no ID (§5.2). */
  singleton?: boolean;
  /** Singletons only: the pack its entries live in. Default `root`. */
  pack?: string;
}

export interface TraitDef {
  id: Id;
  name: string;
  description?: string;
  traits: string[];
  fields: FieldDef[];
}

export interface StructDef {
  id: Id;
  name: string;
  description?: string;
  fields: FieldDef[];
}

export interface UnionDef {
  id: Id;
  name: string;
  description?: string;
  /** Exported field that names the variant. Default `kind`. */
  discriminator: string;
  /** Struct names. */
  variants: string[];
}

export interface EnumMember {
  name: string;
  description?: string;
}

export interface EnumDef {
  id: Id;
  name: string;
  description?: string;
  members: EnumMember[];
}

export interface RuleDef {
  id: Id;
  /** Per-entity rule for this type or trait; absent for a global rule (§5.7). */
  type?: string;
  severity: "error" | "warning";
  expr: string;
  message: string;
}

/**
 * A wizard (DESIGN §9.3): a template, written by a Developer, that makes several entities at
 * once from a few parameters, as one change. Everything but its ID and name is kept as written
 * (see wizard.ts for what each part means), so the schema's ops version it like any definition.
 */
export interface WizardDef {
  id: Id;
  name: string;
  title?: string;
  description?: string;
  /** By name: a field type as text (`string`, `list<struct<Reward>>`) or `pack`, and constraints. */
  params: Record<string, WizardParam>;
  /** Where its rows go: a sheet by name (templated), in a pack, made if `create`. */
  sheet: { name: string; pack?: string; create?: boolean };
  position?: "end" | "afterLastGroup" | "cursor";
  /** Blank rows between one run's rows and what's above them. */
  spacing?: number;
  /** Packs and sheets made before the rows. */
  steps?: WizardStep[];
  rows: WizardRow[];
}

export interface WizardParam {
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
}

export type WizardStep =
  | { createPack: string; parent?: string; when?: string; editors?: boolean }
  | { createSheet: string; pack?: string; when?: string };

export interface WizardRow {
  type: string;
  /** The entity's ID, templated. */
  id: string;
  /** Field values, templated: `"{param}"` alone keeps its value as is (a number, a list). */
  fields?: Record<string, unknown>;
  /** Repeat the row for each item of this list parameter, as `as` (default `item`), with `.index`. */
  forEach?: string;
  as?: string;
  /** Lets other rows name the IDs this row makes: `{name.ids}`. */
  name?: string;
  /** Include the row only when this holds: `param`, `!param`, or `param == value`. */
  when?: string;
}

export interface Schema {
  enums: EnumDef[];
  traits: TraitDef[];
  structs: StructDef[];
  unions: UnionDef[];
  types: TypeDef[];
  rules: RuleDef[];
  wizards: WizardDef[];
}

export const emptySchema = (): Schema => ({ enums: [], traits: [], structs: [], unions: [], types: [], rules: [], wizards: [] });

// ------------------------------------------------------------ type expressions

export class TypeSyntaxError extends Error {}

const SIMPLE = new Set(["string", "int", "float", "bool", "datetime", "duration", "json"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse `list<ref<Projectile|Enemy>>` and friends. Names are checked later, by resolve.ts. */
export function parseType(text: string): FieldType {
  let i = 0;
  const s = text.replace(/\s+/g, "");
  const fail = (msg: string): never => {
    throw new TypeSyntaxError(`${msg} in type "${text}"`);
  };
  const word = (): string => {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (!m) fail(`expected a name at position ${i + 1}`);
    i += m![0].length;
    return m![0];
  };
  const eat = (ch: string) => {
    if (s[i] !== ch) fail(`expected "${ch}" at position ${i + 1}`);
    i++;
  };
  const type = (): FieldType => {
    const w = word();
    if (SIMPLE.has(w)) return { kind: w } as FieldType;
    switch (w) {
      case "list": {
        eat("<");
        const of = type();
        eat(">");
        if (of.kind === "list") fail("lists of lists aren't supported");
        return { kind: "list", of };
      }
      case "ref": {
        eat("<");
        const names = [word()];
        while (s[i] === "|") (i++, names.push(word()));
        eat(">");
        if (names.includes("any")) {
          if (names.length > 1) fail('"any" can\'t be combined with other targets');
          return { kind: "ref", targets: "any" };
        }
        return { kind: "ref", targets: names };
      }
      case "enum":
      case "struct":
      case "union": {
        eat("<");
        const name = word();
        eat(">");
        return { kind: w, name };
      }
      default:
        return fail(`unknown type "${w}"`);
    }
  };
  const t = type();
  if (i !== s.length) fail(`unexpected "${s.slice(i)}"`);
  return t;
}

export function formatType(t: FieldType): string {
  switch (t.kind) {
    case "enum":
    case "struct":
    case "union":
      return `${t.kind}<${t.name}>`;
    case "ref":
      return `ref<${t.targets === "any" ? "any" : t.targets.join("|")}>`;
    case "list":
      return `list<${formatType(t.of)}>`;
    default:
      return t.kind;
  }
}

export const isValidName = (name: string): boolean => NAME.test(name);
