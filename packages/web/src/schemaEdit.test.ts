import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatSchema, loadProject, parseSchema, type Schema } from "@thek42/sapwood-core";
import { previewSchema } from "./schema.ts";
import { addDef, addField, constraintsFor, defOf, removeField, renameDef, renameMember, setDef, setField } from "./schemaEdit.ts";

const fixture = (f: string) => readFileSync(new URL(`../../core/fixtures/krbsg/${f}`, import.meta.url), "utf8");
const krbsg = () => loadProject(fixture("schema.yaml"), fixture("project.yaml")).project;
/** As the page does: write it, read it back (new items get IDs), and preview it. */
const through = (p: ReturnType<typeof krbsg>, s: Schema) => {
  const text = formatSchema(s);
  const back = parseSchema(text, { existing: p.doc.schema });
  return { text, schema: back.schema, issues: back.issues, preview: previewSchema(p, text) };
};

describe("the schema editor's forms", () => {
  it("renaming a struct renames the references to it", () => {
    const p = krbsg();
    const s = p.doc.schema;
    const vec = s.structs.find((x) => x.name === "Vec2")!;
    const r = through(p, renameDef(s, "structs", vec.id, "Point"));
    expect(r.preview.problems).toEqual([]);
    expect(r.preview.changes).toEqual(["struct Vec2 renamed to Point"]);
    expect(r.text).not.toMatch(/Vec2/);
  });

  it("renaming a type renames refs, traits' users, and rules' types", () => {
    const p = krbsg();
    const s = p.doc.schema;
    const sprite = s.types.find((x) => x.name === "Sprite")!;
    const r = through(p, renameDef(s, "types", sprite.id, "Image"));
    expect(r.preview.problems).toEqual([]);
    expect(r.text).toMatch(/ref<Image>/);
    const visual = s.traits.find((x) => x.name === "Visual")!;
    const t = through(p, renameDef(s, "traits", visual.id, "Drawn"));
    expect(t.preview.problems).toEqual([]);
    expect(t.text).toMatch(/traits: \[Drawn\]/);
  });

  it("a new type with fields, set and taken out; IDs come when it's read back", () => {
    const p = krbsg();
    let s = addDef(p.doc.schema, "types", "Boss");
    let r = through(p, s);
    const boss = r.schema.types.find((x) => x.name === "Boss")!;
    expect(boss.id).not.toBe("");
    s = addField(r.schema, "types", boss.id, "hp", { kind: "int" });
    s = addField(through(p, s).schema, "types", boss.id, "sprite", { kind: "ref", targets: ["Sprite"] });
    r = through(p, s);
    const [hp, sprite] = defOf(r.schema, "types", boss.id)!.fields!;
    s = setField(r.schema, "types", boss.id, hp!.id, { min: 1, required: true });
    s = setField(s, "types", boss.id, sprite!.id, { name: "image", default: "spr_ship" });
    s = setDef(s, "types", boss.id, { description: "A big one", traits: ["Collidable"] });
    r = through(p, s);
    expect(r.preview.problems).toEqual([]);
    expect(r.text).toMatch(/hp:\s+\{ id: \w+, type: int, required: true, min: 1 \}/);
    expect(r.text).toMatch(/traits: \[Collidable\]/);
    s = removeField(r.schema, "types", boss.id, hp!.id);
    expect(defOf(s, "types", boss.id)!.fields!.map((f) => f.name)).toEqual(["image"]);
  });

  it("an enum member renamed, with defaults that name it", () => {
    const p = loadProject("enums:\n  Element: { members: [fire, ice] }\ntypes:\n  W: { fields: { e: { type: \"enum<Element>\", default: fire } } }\n", { sheets: [{ name: "W", rows: [["W", "w1", "fire"]] }] }).project;
    const e = p.doc.schema.enums[0]!;
    const r = through(p, renameMember(p.doc.schema, e.id, "fire", "flame"));
    expect(r.preview.changes).toEqual(["enum Element: member fire renamed to flame"]); // the rename rewrites the cells itself
    expect(r.text).toMatch(/default: flame/);
  });

  it("which constraints a type has", () => {
    expect(constraintsFor({ kind: "string" })).toEqual(["minLength", "maxLength", "pattern", "nonEmpty"]);
    expect(constraintsFor({ kind: "list", of: { kind: "ref", targets: ["A"] } })).toEqual(["minItems", "maxItems", "unique", "reach"]);
    expect(constraintsFor({ kind: "bool" })).toEqual([]);
  });
});
