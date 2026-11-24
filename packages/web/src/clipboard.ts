// Our own clipboard (DESIGN §6.6, spike S2), apart from the grid component.
//
// Copy writes two formats:
//  - text/plain: the shown values as TSV, which is what Excel and Sheets paste as values;
//  - text/html: a table of the shown values. Formula cells also carry their formula in
//    relative R1C1 (`data-sheets-formula`), which Google Sheets reads. Sapwood's own paste
//    reads what was typed (`data-sapwood-input`) and the formats, with where the copy came
//    from, so formulas move as they do in Excel.
//
// Paste reads the HTML table if there is one (Sapwood, Sheets and Excel all write one),
// else the TSV. A cell from elsewhere that starts with = but isn't a formula stays text.

import { formulaR1C1, moveFormula, numberToCol, type Format } from "@thek42/sapwood-core";
import type { Rect, SheetGrid } from "./grid.ts";

export interface Pasted {
  input: string;
  /** From a Sapwood copy: the cell's format (null: none). Absent from elsewhere. */
  format?: Format | null;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function copyPayload(g: SheetGrid, rect: Rect): { text: string; html: string } {
  const tsv: string[] = [];
  const trs: string[] = [];
  for (let r = rect.row; r < rect.row + rect.rows; r++) {
    const line: string[] = [];
    const tds: string[] = [];
    for (let c = rect.col; c < rect.col + rect.cols; c++) {
      const v = g.cell(r, c);
      // A struct's summary would lose it: elsewhere it goes as its JSON.
      const text = v.panel && !v.formula ? v.input : v.text;
      line.push(/[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
      let attrs = ` data-sapwood-input="${esc(v.input)}"`;
      const f = v.formula ? formulaR1C1(v.input, r + 1, c + 1) : null;
      if (f) attrs += ` data-sheets-formula="${esc(f)}"`;
      if (v.format) attrs += ` data-sapwood-format="${esc(JSON.stringify(v.format))}"`;
      const style = v.format ? styleOf(v.format) : "";
      tds.push(`<td${attrs}${style ? ` style="${esc(style)}"` : ""}>${esc(text).replace(/\n/g, "<br>")}</td>`);
    }
    tsv.push(line.join("\t"));
    trs.push(`<tr>${tds.join("")}</tr>`);
  }
  // Sheets reads its own attributes only inside this tag.
  const html = `<meta charset="utf-8"><google-sheets-html-origin><table data-sapwood-origin="${rect.row},${rect.col}"><tbody>${trs.join("")}</tbody></table></google-sheets-html-origin>`;
  return { text: tsv.join("\n"), html };
}

/** How a format looks to other spreadsheets, so a paste there keeps bold and colors. */
function styleOf(f: Format): string {
  const out: string[] = [];
  if (f.bold) out.push("font-weight:bold");
  if (f.italic) out.push("font-style:italic");
  if (typeof f.fill === "string") out.push(`background-color:${f.fill}`);
  if (typeof f.color === "string") out.push(`color:${f.color}`);
  return out.join(";");
}

/** What to write, cell by cell, for a paste whose top left is `at` (0-based). */
export function parsePaste(html: string, text: string, at: { row: number; col: number }): Pasted[][] {
  if (/<table/i.test(html)) {
    const grid = fromTable(html, at);
    if (grid.length > 0) return grid;
  }
  return parseTsv(text).map((row) => row.map((input) => ({ input: asText(input) })));
}

/** A value from elsewhere that looks like a formula but was text there stays text here. */
const asText = (s: string): string => (/^=./.test(s) ? `'${s}` : s);

// ------------------------------------------------------------ an HTML table, read

interface Td {
  attrs: Map<string, string>;
  text: string;
}

function fromTable(html: string, at: { row: number; col: number }): Pasted[][] {
  const table = /<table\b([^>]*)>([\s\S]*?)<\/table>/i.exec(html);
  if (!table) return [];
  const origin = /^(\d+),(\d+)$/.exec(attributes(table[1]!).get("data-sapwood-origin") ?? "");
  const rows = readRows(table[2]!);
  const out: Pasted[][] = [];
  const taken: boolean[][] = []; // under an earlier rowspan
  rows.forEach((tds, ri) => {
    const row = (out[ri] ??= []);
    let ci = 0;
    for (const td of tds) {
      while (taken[ri]?.[ci]) row[ci++] ??= { input: "" };
      const r = at.row + ri;
      const c = at.col + ci;
      let cell: Pasted;
      const mine = td.attrs.get("data-sapwood-input");
      const sheets = td.attrs.get("data-sheets-formula");
      if (origin && mine !== undefined) {
        // From Sapwood: as typed, moved from where it was copied.
        cell = { input: moveFormula(mine, r - (Number(origin[1]) + ri), c - (Number(origin[2]) + ci)) };
        const f = td.attrs.get("data-sapwood-format");
        try {
          cell.format = f ? (JSON.parse(f) as Format) : null;
        } catch {
          cell.format = null;
        }
      } else if (sheets) cell = { input: r1c1ToA1(sheets, r + 1, c + 1) };
      else {
        // Excel writes the plain number in x:num when the shown text is formatted ("1,234.50").
        const num = td.attrs.get("x:num");
        cell = { input: num !== undefined && num !== "" ? num : asText(td.text) };
      }
      const span = Math.max(1, Number(td.attrs.get("colspan") ?? 1) || 1);
      const rspan = Math.max(1, Number(td.attrs.get("rowspan") ?? 1) || 1);
      for (let k = 0; k < span; k++) {
        row[ci + k] = k === 0 ? cell : { input: "" };
        for (let j = 1; j < rspan; j++) ((taken[ri + j] ??= [])[ci + k] = true);
      }
      ci += span;
    }
  });
  return out;
}

/** The rows of a table body: each row's cells, with attributes and text. */
function readRows(body: string): Td[][] {
  const rows: Td[][] = [];
  for (const tr of body.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/tbody|<\/table|$)/gi)) {
    const tds: Td[] = [];
    for (const m of tr[1]!.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)(?=<\/t[dh]>|<t[dh]\b|<\/tr>|$)/gi)) tds.push({ attrs: attributes(m[2]!), text: cellText(m[3]!) });
    rows.push(tds);
  }
  return rows;
}

function attributes(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) out.set(m[1]!.toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ""));
  return out;
}

/** A cell's text: <br> is a line break, other tags go, other whitespace collapses. */
function cellText(inner: string): string {
  const t = inner.replace(/<br\s*\/?>/gi, "\u0000").replace(/<[^>]*>/g, "");
  return decode(t)
    .replace(/[ \t\r\n ]+/g, " ")
    .replace(/ ?\u0000 ?/g, "\n")
    .trim();
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith("#x")) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith("#")) return String.fromCodePoint(Number(k.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k]!;
  });
}

// ------------------------------------------------------------ R1C1 from Sheets

/** Split a formula into string literals (left alone) and the rest (rewritten). */
function mapCode(formula: string, fn: (code: string) => string): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

const R1C1 = /(?<![\w.$])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![\w(])/g;

/** Relative R1C1, as Sheets copies a formula, in A1 from the cell at (`row`, `col`), 1-based. */
export function r1c1ToA1(formula: string, row: number, col: number): string {
  let off = false;
  const a1 = mapCode(formula, (code) =>
    code.replace(R1C1, (m, r: string | undefined, c: string | undefined) => {
      if (r === undefined || c === undefined) return m; // whole rows and columns: left as they are
      const rel = (s: string) => s.startsWith("[");
      const n = (s: string) => Number(s.replace(/[[\]]/g, ""));
      const rr = rel(r) ? row + n(r) : n(r);
      const cc = rel(c) ? col + n(c) : n(c);
      if (rr < 1 || cc < 1) off = true;
      return (rel(c) ? "" : "$") + numberToCol(Math.max(1, cc)) + (rel(r) ? "" : "$") + Math.max(1, rr);
    }),
  );
  return off ? "=#REF!" : a1;
}

// ------------------------------------------------------------ TSV

export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const t = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === "\t") row.push(cell), (cell = "");
    else if (ch === "\n") row.push(cell), rows.push(row), (row = []), (cell = "");
    else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
