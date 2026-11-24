// ID suggestions as you type (DESIGN §5.3 "ID string, with autocomplete", §9.3 ref pickers):
// which IDs a ref accepts (its types or traits, active, and reachable from the pack it's
// written in, §7.2), which part of the text is the ID being typed, and the text once one is
// picked. Apart from React, so it's tested in Node.

import { refAccepts, type FieldDef, type FieldType, type PackId, type Project } from "@thek42/sapwood-core";

/** What a place where an ID is typed accepts. */
export interface RefTarget {
  targets: string[] | "any";
  reach?: "descendants";
  /** The pack it's written in, for reach. */
  from: PackId;
  /** A whole list of refs in one cell: several IDs, as a plain or JSON list. */
  list: boolean;
}

export interface Candidate {
  id: string;
  type: string;
  /** Where it's defined, to tell IDs apart: "Weapons", "level1 / Enemies". */
  where: string;
}

/** The ref a field holds, if it's one, or a list of them; null for anything else. */
export function refTarget(def: FieldDef | null, type: FieldType, from: PackId): RefTarget | null {
  const reach = def?.reach ? { reach: def.reach } : {};
  if (type.kind === "ref") return { targets: type.targets, from, list: false, ...reach };
  if (type.kind === "list" && type.of.kind === "ref") return { targets: type.of.targets, from, list: true, ...reach };
  return null;
}

/**
 * The IDs a ref may point at, in pack-tree order as the project has them: active entities of
 * an accepted type or trait, in a pack it can reach. An ID defined twice is offered once.
 */
export function candidates(project: Project, t: RefTarget): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const reach = new Map<PackId, boolean>();
  const reachable = (to: PackId) => {
    let ok = reach.get(to);
    if (ok === undefined) {
      ok = to === t.from || project.wb.canReach(t.from, to) || (t.reach === "descendants" && project.wb.canReach(to, t.from));
      reach.set(to, ok);
    }
    return ok;
  };
  for (const e of project.project().entities) {
    if (!e.active || e.id === null || seen.has(e.id)) continue;
    if (!refAccepts(project.schema, t.targets, e.type) || !reachable(e.pack)) continue;
    seen.add(e.id);
    const sheet = project.wb.sheet(e.at.sheet);
    const pack = project.wb.packName(e.pack);
    out.push({ id: e.id, type: e.type, where: e.pack === project.wb.root ? sheet.name : `${pack} / ${sheet.name}` });
  }
  return out;
}

/** The part of the text that's the ID being typed: [start, end), and whether it goes in quotes. */
export interface Token {
  start: number;
  end: number;
  prefix: string;
  /** Inside a JSON list, outside quotes: the ID goes in with its quotes. */
  quote: boolean;
  /** Inside quotes not yet closed: the closing one goes in after the ID. */
  close?: boolean;
}

/**
 * The ID being typed at `caret`. One ref: the whole text. A list: the item the caret is in,
 * between commas in a plain list (`a, b`), or inside quotes in a JSON one (`["a", "b`).
 * A formula has none.
 */
export function tokenAt(text: string, caret: number, list: boolean): Token | null {
  if (text.trimStart().startsWith("=")) return null;
  if (!list) {
    const lead = text.length - text.trimStart().length;
    return { start: lead, end: text.length, prefix: text.slice(lead, caret).trim(), quote: false };
  }
  if (text.trimStart().startsWith("[")) {
    // Inside quotes: from the opening quote to the closing one (or the end).
    let open = -1;
    for (let i = 0; i < caret; i++) {
      if (text[i] === "\\") i++;
      else if (text[i] === '"') open = open < 0 ? i : -1;
    }
    if (open >= 0) {
      const close = text.indexOf('"', caret);
      if (close >= 0) return { start: open + 1, end: close, prefix: text.slice(open + 1, caret), quote: false };
      // Not closed yet: the ID runs to the next comma or ], which stay.
      const stop = text.slice(caret).search(/[,\]]/);
      return { start: open + 1, end: stop < 0 ? text.length : caret + stop, prefix: text.slice(open + 1, caret), quote: false, close: true };
    }
    // Just after [ or a comma: a new item.
    const before = text.slice(0, caret).trimEnd();
    if (before.endsWith("[") || before.endsWith(",")) return { start: caret, end: caret, prefix: "", quote: true };
    return null;
  }
  const start = text.lastIndexOf(",", caret - 1) + 1;
  const next = text.indexOf(",", caret);
  const end = next < 0 ? text.length : next;
  const lead = text.slice(start, end).length - text.slice(start, end).trimStart().length;
  return { start: start + lead, end, prefix: text.slice(start + lead, caret).trim(), quote: false };
}

/**
 * The candidates for a prefix, best first: those it starts (ignoring case), then those with
 * it after a word break (`bolt` finds `heavy_bolt`), then any containing it. The ID already
 * typed in full isn't offered again.
 */
export function suggest(all: readonly Candidate[], prefix: string, limit = 8): Candidate[] {
  const p = prefix.toLowerCase();
  const scored: { c: Candidate; s: number; i: number }[] = [];
  all.forEach((c, i) => {
    const id = c.id.toLowerCase();
    if (c.id === prefix) return;
    const at = id.indexOf(p);
    if (at < 0) return;
    // A word break: after _ or . or the like, or where camelCase starts a word (HeavyBolt).
    const word = at > 0 && (/[^A-Za-z0-9]/.test(c.id[at - 1]!) || (/[A-Z]/.test(c.id[at]!) && /[a-z0-9]/.test(c.id[at - 1]!)));
    const s = at === 0 ? 0 : word ? 1 : 2;
    scored.push({ c, s, i });
  });
  return scored.sort((a, b) => a.s - b.s || a.i - b.i).slice(0, limit).map((x) => x.c);
}

/** The text with the token replaced by an ID, and where the caret goes after it. */
export function complete(text: string, t: Token, id: string): { text: string; caret: number } {
  const ins = t.quote ? JSON.stringify(id) : t.close ? id + '"' : id;
  // Inside quotes, the caret goes past the closing one.
  return { text: text.slice(0, t.start) + ins + text.slice(t.end), caret: t.start + ins.length + (!t.quote && text[t.end] === '"' ? 1 : 0) };
}
