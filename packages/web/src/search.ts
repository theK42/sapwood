// Search across the project (DESIGN §9.1): entities by ID, types and sheets by name, from the
// top bar. Each word typed must be in the name, ignoring case; the best matches come first:
// the whole name, then names starting with it, then one of its words starting with it
// (after _, -, a space, a change between letters and digits, or a lower-to-upper case
// change, so "star" finds spr_star1 and "bolt" finds IonBolt), then anywhere in it.
// Commented-out entities come after live ones that match as well. Apart from React, so
// it's tested in Node.

import { display, numberToCol, type ColId, type Project, type SheetId, type RowId } from "@thek42/sapwood-core";

export type Hit =
  | { kind: "entity"; id: string; type: string; where: string; active: boolean; at: { sheet: SheetId; row: RowId } }
  | { kind: "type"; name: string; count: number }
  | { kind: "sheet"; id: SheetId; name: string; where: string; rows: number };

export interface Found {
  /** In order: types, then sheets, then entities, each best first, cut to their limits. */
  hits: Hit[];
  /** How many entities matched past the limit. */
  moreEntities: number;
}

/** Where the word starts in a name: after a separator, a case change or a letter/digit change. */
function wordStarts(name: string): number[] {
  const out = [0];
  for (let i = 1; i < name.length; i++) {
    const a = name[i - 1]!;
    const b = name[i]!;
    if (/[_\-\s./]/.test(a) || (/[a-z]/.test(a) && /[A-Z]/.test(b)) || (/[A-Za-z]/.test(a) && /\d/.test(b)) || (/\d/.test(a) && /[A-Za-z]/.test(b))) out.push(i);
  }
  return out;
}

/** How well one word matches a name: 0 the whole name, 1 its start, 2 a word's start, 3 anywhere; null not at all. */
export function rank(name: string, word: string): number | null {
  const n = name.toLowerCase();
  const w = word.toLowerCase();
  if (!w) return 0;
  if (n === w) return 0;
  if (n.startsWith(w)) return 1;
  if (!n.includes(w)) return null;
  for (const i of wordStarts(name)) if (n.startsWith(w, i)) return 2;
  return 3;
}

/** A query's score for a name (lower is better): every word must match; the worst word counts. */
export function score(name: string, query: string): number | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  let worst = 0;
  for (const w of words) {
    const r = rank(name, w);
    if (r === null) return null;
    worst = Math.max(worst, r);
  }
  return worst;
}

const order = <T>(xs: { x: T; s: number; name: string }[]) =>
  xs.sort((a, b) => a.s - b.s || a.name.length - b.name.length || a.name.localeCompare(b.name)).map((y) => y.x);

export function search(project: Project, query: string, limits = { types: 5, sheets: 5, entities: 12 }): Found {
  if (!query.trim()) return { hits: [], moreEntities: 0 };
  const wb = project.wb;
  const entities = project.project().entities;
  const counts = new Map<string, number>();
  for (const e of entities) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);

  const types: { x: Hit; s: number; name: string }[] = [];
  for (const t of project.schema.types.values()) {
    if (t.def.singleton) continue;
    const s = score(t.def.name, query);
    if (s !== null) types.push({ x: { kind: "type", name: t.def.name, count: counts.get(t.def.name) ?? 0 }, s, name: t.def.name });
  }
  const sheets: { x: Hit; s: number; name: string }[] = [];
  for (const sh of wb.sheets.values()) {
    const s = score(sh.name, query);
    if (s === null) continue;
    const where = sh.pack === wb.root ? "root" : wb.packName(sh.pack);
    sheets.push({ x: { kind: "sheet", id: sh.id, name: sh.name, where, rows: sh.rows.liveIds().length }, s, name: sh.name });
  }
  const found: { x: Hit; s: number; name: string }[] = [];
  for (const e of entities) {
    if (e.id === null) continue;
    const s = score(e.id, query);
    if (s === null) continue;
    const sheet = wb.sheet(e.at.sheet).name;
    const where = e.pack === wb.root ? sheet : `${wb.packName(e.pack)} / ${sheet}`;
    // Commented-out ones after the live ones that match as well.
    found.push({ x: { kind: "entity", id: e.id, type: e.type, where, active: e.active, at: { sheet: e.at.sheet, row: e.at.row } }, s: s * 2 + (e.active ? 0 : 1), name: e.id });
  }
  const ents = order(found);
  // An entity whose ID is exactly what was typed comes first of all.
  const exact = ents[0] && found.some((f) => f.x === ents[0] && f.s === 0) ? [ents[0]] : [];
  return {
    hits: [...exact, ...order(types).slice(0, limits.types), ...order(sheets).slice(0, limits.sheets), ...ents.slice(exact.length, limits.entities)],
    moreEntities: Math.max(0, ents.length - limits.entities),
  };
}

// ------------------------------------------------------------ inside cells

/**
 * The full search: what every cell shows, and its formula's text, so part of a string finds
 * the row it's in (a localized line finds its token) and a token finds every cell using it.
 * Slower than names alone, so the box asks for it; the text is gathered once per version of
 * the project (cellIndex) and searched as often as the box changes.
 */
export interface CellHit {
  kind: "cell";
  sheet: SheetId;
  row: RowId;
  col: ColId;
  /** 0-based positions, to go to it. */
  rowPos: number;
  colPos: number;
  /** "Sprites!C4", or "level1 / Enemies!C4" outside the root pack. */
  address: string;
  text: string;
  formula: string | null;
  /** The entity and field the cell holds, when it holds one: field "$type" or "$id" for columns A and B. */
  entity: { id: string | null; type: string; field: string } | null;
}

interface IndexedCell {
  /** Sheet order, row and column positions: the index is sorted by them. */
  s: number;
  r: number;
  c: number;
  sheet: SheetId;
  row: RowId;
  col: ColId;
  text: string;
  formula: string | null;
  /** Both, lower-cased, for matching. */
  lower: string;
}

export interface CellIndex {
  /** In sheet order, row by row, so a search only filters. */
  cells: IndexedCell[];
}

/** A value as a cell shows it: numbers to 12 significant digits (as the grid shows them). */
function shown(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
  return display(v as Parameters<typeof display>[0]);
}

/** Every non-empty cell's text and formula, in order. */
export function cellIndex(project: Project): CellIndex {
  const wb = project.wb;
  const cells: IndexedCell[] = [];
  // Sheets in the pack tree's order, as the home page lists them: a pack's own sheets, then its packs'.
  const all = [...wb.sheets.values()];
  const ordered: typeof all = [];
  const walk = (pack: string) => {
    ordered.push(...all.filter((s) => s.pack === pack));
    for (const q of wb.packs.values()) if (q.parent === pack) walk(q.id);
  };
  walk(wb.root);
  let order = 0;
  for (const sh of ordered) {
    const sheetNo = order++;
    const doc = project.doc.sheets.get(sh.id);
    if (!doc) continue;
    for (const [key, content] of doc.cells) {
      if (content === null) continue;
      const bar = key.indexOf("|");
      const row = key.slice(0, bar) as RowId;
      const col = key.slice(bar + 1) as ColId;
      const r = sh.rows.posOf(row);
      const c = sh.cols.posOf(col);
      if (r === null || c === null) continue;
      let formula: string | null = null;
      if ("bad" in content) formula = content.bad;
      else if ("f" in content) formula = project.engine.formula(sh.id, `${numberToCol(c)}${r}`);
      const text = "bad" in content ? content.code : shown(project.engine.cellById(sh.id, row, col).value);
      if (!text && !formula) continue;
      cells.push({ s: sheetNo, r, c, sheet: sh.id, row, col, text, formula, lower: `${text}\u0000${formula ?? ""}`.toLowerCase() });
    }
  }
  cells.sort((a, b) => a.s - b.s || a.r - b.r || a.c - b.c);
  return { cells };
}

/**
 * Cells whose text or formula holds every word typed (any case): first those whose whole text
 * is what was typed (a token's own uses), then in sheet order, row by row.
 */
export function searchCells(project: Project, index: CellIndex, query: string, limit = 50): { hits: CellHit[]; more: number } {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { hits: [], more: 0 };
  const whole = query.trim().toLowerCase();
  const wb = project.wb;
  const all = index.cells.filter((c) => words.every((w) => c.lower.includes(w)));
  const exact = (c: IndexedCell) => c.text.toLowerCase() === whole || (c.formula ?? "").toLowerCase() === whole;
  const matched = [...all.filter(exact), ...all.filter((c) => !exact(c))];
  // Which entity and field each shown cell holds.
  const shownCells = matched.slice(0, limit);
  const want = new Set(shownCells.map((c) => `${c.sheet}|${c.row}`));
  const owner = new Map<string, { id: string | null; type: string; field: string }>();
  for (const e of project.project().entities) {
    if (!want.has(`${e.at.sheet}|${e.at.row}`)) continue;
    const s = wb.sheet(e.at.sheet);
    // Columns A and B, if the sheet has them (idAt would make them).
    const [a, b] = s.cols.liveIds();
    if (a) owner.set(`${e.at.sheet}|${e.at.row}|${a}`, { id: e.id, type: e.type, field: "$type" });
    if (b) owner.set(`${e.at.sheet}|${e.at.row}|${b}`, { id: e.id, type: e.type, field: "$id" });
    for (const [field, entry] of e.fields) for (const c of entry.cells) if (c.col !== undefined) owner.set(`${c.sheet}|${c.row}|${c.col}`, { id: e.id, type: e.type, field });
  }
  const hits = shownCells.map((c): CellHit => {
    const s = wb.sheet(c.sheet);
    const r = s.rows.posOf(c.row) ?? 1;
    const k = s.cols.posOf(c.col) ?? 1;
    const where = s.pack === wb.root ? s.name : `${wb.packName(s.pack)} / ${s.name}`;
    return { kind: "cell", sheet: c.sheet, row: c.row, col: c.col, rowPos: r - 1, colPos: k - 1, address: `${where}!${numberToCol(k)}${r}`, text: c.text, formula: c.formula, entity: owner.get(`${c.sheet}|${c.row}|${c.col}`) ?? null };
  });
  return { hits, more: matched.length - hits.length };
}
