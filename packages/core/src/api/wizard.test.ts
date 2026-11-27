import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonDoc, cloneDoc } from "../ops/doc.ts";
import { resolveSchema } from "../schema/resolve.ts";
import { formatSchema, parseSchema } from "../schema/yaml.ts";
import { ApiError, Sapwood } from "./sapwood.ts";
import { needsDeveloper } from "./wizard.ts";

// DESIGN §9.3's example.
const SCHEMA = `
structs:
  RewardSpec: { fields: { item: string, amount: int } }
types:
  MailMessage: { fields: { subject: string, format: "ref<Format>", rewards: "list<ref<Reward>>", cost: float, urgent: bool } }
  Format: { fields: { template: string } }
  Reward: { fields: { item: string, amount: int } }
  Note: { fields: { text: string } }
wizards:
  RewardedMail:
    title: "New rewarded mail"
    params:
      key: { type: string, required: true, pattern: "^[a-z0-9_]+$" }
      subject: { type: string, required: true }
      rewards: { type: "list<struct<RewardSpec>>", minItems: 1 }
      tier: { type: int, default: 1 }
      urgent: { type: bool }
      pack: { type: pack, default: root }
    sheet: { pack: "{pack}", name: RewardedMail, create: true }
    position: afterLastGroup
    spacing: 1
    rows:
      - type: MailMessage
        id: "mail_{key}"
        fields: { subject: "{subject}", format: "fmt_{key}", rewards: "{rewardRows.ids}", cost: "=10*{tier}", urgent: "{urgent}" }
      - type: Format
        id: "fmt_{key}"
        fields: { template: standard }
      - name: rewardRows
        forEach: rewards
        as: r
        type: Reward
        id: "rwd_{key}_{r.index}"
        fields: { item: "{r.item}", amount: "{r.amount}" }
      - type: Note
        id: "note_{key}"
        when: urgent
        fields: { text: "Urgent: {subject}" }
`;
const project = () => Sapwood.load(SCHEMA, { sheets: [{ name: "Other", rows: [["Note", "n0", "hi"]] }] });
const welcome = { key: "welcome", subject: "Welcome!", rewards: [{ item: "gold", amount: 100 }, { item: "gem", amount: 1 }] };

describe("wizards (DESIGN §9.3)", () => {
  it("read and written as YAML, and checked when the schema resolves", () => {
    const s = parseSchema(SCHEMA);
    expect(s.issues).toEqual([]);
    expect(resolveSchema(s.schema).issues).toEqual([]);
    const w = s.schema.wizards[0]!;
    expect(w).toMatchObject({ name: "RewardedMail", title: "New rewarded mail", position: "afterLastGroup", spacing: 1, sheet: { name: "RewardedMail", create: true } });
    expect(w.id).toMatch(/^w/);
    const text = formatSchema(s.schema);
    expect(formatSchema(parseSchema(text, { existing: s.schema }).schema)).toBe(text);
    // What the checks catch.
    const bad = parseSchema(SCHEMA.replace("type: Format\n", "type: Nope\n").replace("{subject}\", format", "{subjet}\", format").replace("forEach: rewards", "forEach: subject"));
    const msgs = resolveSchema(bad.schema).issues.map((i) => i.message);
    expect(msgs.some((m) => m.includes('Unknown type "Nope"'))).toBe(true);
    expect(msgs.some((m) => m.includes("{subjet} names no parameter"))).toBe(true);
    expect(msgs.some((m) => m.includes("subject isn't a list"))).toBe(true);
  });

  it("a run: its rows in order, filled in, on a sheet it makes; the next goes after it", () => {
    const s = project();
    const before = canonDoc(cloneDoc(s.doc));
    const { report } = s.runWizard("RewardedMail", welcome);
    expect(report.sheets).toEqual(["RewardedMail"]);
    expect(report.made.map((m) => `${m.id}@${m.cell}`)).toEqual(["mail_welcome@A1", "fmt_welcome@A2", "rwd_welcome_0@A3", "rwd_welcome_1@A4"]);
    expect(s.get("mail_welcome")).toMatchObject({ subject: "Welcome!", format: "fmt_welcome", rewards: ["rwd_welcome_0", "rwd_welcome_1"], cost: { $value: 10, $formula: "=10*1" } });
    expect(s.get("rwd_welcome_1")).toMatchObject({ item: "gem", amount: 1 });
    expect(report.issues).toEqual([]);
    // Another run: after the last group, one blank row between.
    const r2 = s.runWizard("RewardedMail", { key: "back", subject: "Come back", rewards: [{ item: "gold", amount: 5 }], tier: 3, urgent: true }).report;
    expect(r2.made.map((m) => `${m.id}@${m.cell}`)).toEqual(["mail_back@A6", "fmt_back@A7", "rwd_back_0@A8", "note_back@A9"]);
    expect(s.get("mail_back").cost).toMatchObject({ $value: 30 });
    expect(s.get("note_back").text).toBe("Urgent: Come back");
    expect(s.validate().errors).toBe(0);
    s.undo();
    s.undo();
    expect(canonDoc(s.doc)).toEqual(before);
  });

  it("refused, saying why: parameters that don't do, an ID that exists", () => {
    const s = project();
    const msg = (p: Record<string, unknown>) => {
      try {
        s.runWizard("RewardedMail", p);
      } catch (e) {
        return (e as ApiError).message;
      }
      return "ran";
    };
    expect(msg({ subject: "x", rewards: [] })).toBe("New rewarded mail can't run: key is required; rewards needs at least 1 item");
    expect(msg({ ...welcome, key: "Bad Key" })).toMatch(/key must match/);
    expect(msg({ ...welcome, nope: 1 })).toMatch(/has no parameter nope/);
    expect(msg({ ...welcome, key: "n0" }).length).toBeGreaterThan(0);
    s.runWizard("RewardedMail", welcome);
    expect(msg(welcome)).toMatch(/ID "mail_welcome" is taken/);
  });

  it("a parameter left blank takes its default, and one with a default is never missing", () => {
    const s = project();
    const req = Sapwood.load(SCHEMA.replace("tier: { type: int, default: 1 }", "tier: { type: int, default: 2, required: true }"), { sheets: [] });
    for (const tier of [undefined, null, "", "  "]) {
      const r = req.previewWizard("RewardedMail", { ...welcome, tier });
      expect(r.made.length).toBe(4);
    }
    req.runWizard("RewardedMail", { ...welcome, tier: "" });
    expect(req.get("mail_welcome").cost).toMatchObject({ $formula: "=10*2" });
    // Without a default, blank is still missing; blank isn't checked against the pattern.
    expect(() => s.runWizard("RewardedMail", { ...welcome, key: "" })).toThrow(/key is required$/);
  });

  it("a preview changes nothing; as a patch; at the cursor", () => {
    const s = project();
    const before = canonDoc(cloneDoc(s.doc));
    expect(s.previewWizard("RewardedMail", welcome).made.length).toBe(4);
    expect(canonDoc(s.doc)).toEqual(before);
    s.apply([{ op: "runWizard", wizard: "RewardedMail", params: welcome }]);
    expect(s.get("fmt_welcome").$sheet).toBe("RewardedMail");
  });

  it("steps that make a pack and a sheet first; a run at the selected row", () => {
    const schema = SCHEMA + `
  Event:
    params: { key: { type: string, required: true } }
    steps:
      - createPack: "event_{key}"
        editors: true
      - createSheet: Notes
        pack: "event_{key}"
    sheet: { pack: "event_{key}", name: Notes }
    rows:
      - { type: Note, id: "intro_{key}", fields: { text: "About {key}" } }
  Here:
    params: { key: { type: string, required: true } }
    sheet: Other
    position: cursor
    rows:
      - { type: Note, id: "here_{key}" }
`;
    const s = Sapwood.load(schema, { sheets: [{ name: "Other", rows: [["Note", "n0", "hi"], ["Note", "n1", "yo"]] }] });
    const r = s.runWizard("Event", { key: "spring" }).report;
    expect([r.packs, r.sheets]).toEqual([["event_spring"], ["Notes"]]);
    expect(s.get("intro_spring")).toMatchObject({ $pack: "event_spring", $sheet: "Notes", text: "About spring" });
    // At row 2 of Other: between n0 and n1.
    s.runWizard("Here", { key: "x" }, { cursor: { sheet: "Other", row: 2 } });
    expect(s.query("Note", { pack: "root" }).map((e) => e.$id)).toEqual(["n0", "here_x", "n1"]);
    // Without a cursor it goes at the end.
    s.runWizard("Here", { key: "y" });
    expect(s.query("Note", { pack: "root" }).map((e) => e.$id)).toEqual(["n0", "here_x", "n1", "here_y"]);
    const ws = s.project.schema.schema.wizards;
    expect(ws.map((w) => [w.name, needsDeveloper(w)])).toEqual([["RewardedMail", false], ["Event", false], ["Here", false]]);
  });
});

describe("KRBSG's DLC wizard", () => {
  const krbsg = () => {
    const f = (n: string) => readFileSync(new URL(`../../fixtures/krbsg/${n}`, import.meta.url), "utf8");
    return Sapwood.load(f("schema.yaml"), f("project.yaml"));
  };
  const raiders = { name: "VoidRaiders", enemy: "void_raider", weapon: "IonCannon", bolt: "IonBolt", cooldown: 0.9, damage: 3 };

  it("makes a pack with Art and Ships sheets, each row on its own sheet, and validates", () => {
    const s = krbsg();
    const r = s.runWizard("NewDLC", raiders).report;
    expect([r.packs, r.sheets]).toEqual([["VoidRaiders"], ["Art", "Ships"]]);
    expect(r.made.map((m) => `${m.sheet}!${m.cell} ${m.id}`)).toEqual([
      "Art!A1 tex_void_raider",
      "Art!A2 spr_void_raider",
      "Art!A3 tex_IonBolt",
      "Art!A4 spr_IonBolt",
      "Ships!A1 IonBolt",
      "Ships!A2 IonCannon",
      "Ships!A3 void_raider",
    ]);
    expect(s.get("IonCannon")).toMatchObject({ $pack: "VoidRaiders", projectiles: ["IonBolt"], cooldown: 0.9, damage: 3, script: "IonCannon.lua" });
    expect(s.get("spr_void_raider")).toMatchObject({ $sheet: "Art", width: 48, height: 48, shader: "Textured" });
    expect(s.get("void_raider")).toMatchObject({ $sheet: "Ships", collider: "house" });
    expect(r.issues).toEqual([]);
    expect(s.validate().errors).toBe(0);
    // A second enemy in the same pack: the pack and sheets are there, its rows go after the first's.
    const again = s.runWizard("NewDLC", { name: "VoidRaiders", enemy: "void_drone", size: 32 }).report;
    expect([again.packs, again.sheets]).toEqual([[], []]);
    expect(again.made.map((m) => `${m.sheet}!${m.cell} ${m.id}`)).toEqual(["Art!A5 tex_void_drone", "Art!A6 spr_void_drone", "Ships!A4 void_drone"]);
    expect(s.validate().errors).toBe(0);
  });

  it("takes names as identifiers (pattern: identifier)", () => {
    const s = krbsg();
    const why = (enemy: string) => {
      try {
        s.previewWizard("NewDLC", { name: "Pack", enemy });
        return null;
      } catch (e) {
        return (e as ApiError).message.replace(/^.*can't run: /, "");
      }
    };
    for (const ok of ["voidRaider", "VoidRaider", "void_raider", "VOID_RAIDER", "_raider", "raider2"]) expect(why(ok), ok).toBeNull();
    for (const bad of ["2raider", "void-raider", "void raider", "raider!", "räider"]) expect(why(bad), bad).toBe("enemy must be an identifier: a letter or _, then letters, digits or _");
  });

  it("needs a Developer, as it makes a pack", () => {
    expect(needsDeveloper(krbsg().project.schema.schema.wizards.find((w) => w.name === "NewDLC")!)).toBe(true);
  });

  it("a row's sheet that's missing is refused unless the wizard makes it", () => {
    const s = Sapwood.load(SCHEMA + `
  Split:
    params: { key: { type: string, required: true } }
    sheet: Other
    rows:
      - { type: Note, id: "a_{key}" }
      - { type: Note, id: "b_{key}", sheet: "Elsewhere" }
`, { sheets: [{ name: "Other", rows: [] }] });
    expect(() => s.previewWizard("Split", { key: "x" })).toThrow(/No sheet called Elsewhere in pack root/);
    const bad = parseSchema(SCHEMA + `
  Bad:
    params: {}
    rows: [{ type: Note, id: n, sheet: "{nope}" }]
`);
    expect(resolveSchema(bad.schema).issues.map((i) => i.message)).toContain("{nope} names no parameter");
    // A pattern is a preset's name or a regex that compiles.
    const badPattern = parseSchema(SCHEMA + `
  Odd:
    params: { k: { type: string, pattern: "([a-z" } }
    rows: [{ type: Note, id: "n_{k}" }]
`);
    expect(resolveSchema(badPattern.schema).issues.map((i) => i.message).join("\n")).toMatch(/Not a valid regular expression, nor a preset \(identifier\)/);
  });

  it("a string field's pattern can be the preset too", () => {
    const s = Sapwood.load(
      "types:\n  Tag: { fields: { code: { type: string, pattern: identifier } } }\n",
      { sheets: [{ name: "Tags", rows: [["# Tag", "id", "code"], ["Tag", "t1", "MAX_HP"], ["Tag", "t2", "max-hp"]] }] },
    );
    const issues = s.validate().issues;
    expect(issues.map((i) => [i.entity?.id, i.message])).toEqual([["t2", expect.stringContaining("must be an identifier")]]);
  });
});

describe("documents saved before wizards", () => {
  it("load, with no wizards", async () => {
    const { docToJson, docFromJson } = await import("../ops/doc.ts");
    const json = docToJson(Sapwood.load("types:\n  T: { fields: {} }\n", { sheets: [{ name: "S", rows: [["T", "t1"]] }] }).doc) as unknown as { schema: Record<string, unknown> };
    delete json.schema.wizards;
    const s = Sapwood.fromDoc(docFromJson(json));
    expect(s.get("t1").$type).toBe("T");
    expect(s.project.schema.schema.wizards).toEqual([]);
  });
});
