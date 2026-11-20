/**
 * Our own clipboard format, independent of the grid component (DESIGN §6.6).
 *
 * Copy writes:
 *  - text/plain: TSV of displayed values (what Excel and Sheets paste as values),
 *  - text/html: a table of displayed values, where formula cells also carry
 *    `data-sheets-formula` in relative R1C1 form. Google Sheets reads that attribute,
 *    and so do we, so a Sapwood-to-Sapwood paste keeps formulas and shifts them.
 *
 * Paste reads HTML first (Sheets, Excel and ourselves all write a <table>), then TSV.
 */
import { colName, type SheetModel } from "./sheet-model.ts";

// ------------------------------------------------------------ A1 <-> relative R1C1

/** Split a formula into string literals (left alone) and code (rewritten). */
function mapCode(formula: string, fn: (code: string) => string): string {
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

const colNum = (s: string): number => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

// A cell reference not glued to a name (LOG10, my_name.A1) and not a function call.
const A1_RE = /(?<![\w.$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g;
const R1C1_RE = /(?<![\w.$])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![\w(])/g;

export function a1ToR1C1(formula: string, row: number, col: number): string {
  return mapCode(formula, (code) =>
    code.replace(A1_RE, (_m, ca: string, c: string, ra: string, r: string) => {
      const rr = ra ? `R${r}` : `R[${Number(r) - row}]`;
      const cc = ca ? `C${colNum(c)}` : `C[${colNum(c) - col}]`;
      return rr + cc;
    }),
  );
}

export function r1c1ToA1(formula: string, row: number, col: number): string {
  return mapCode(formula, (code) =>
    code.replace(R1C1_RE, (m, r: string | undefined, c: string | undefined) => {
      if (r === undefined || c === undefined) return m; // whole rows/columns: not in the spike
      const rel = (s: string) => s.startsWith("[");
      const n = (s: string) => Number(s.replace(/[[\]]/g, ""));
      const rr = rel(r) ? row + n(r) : n(r);
      const cc = rel(c) ? col + n(c) : n(c);
      if (rr < 1 || cc < 1) return "#REF!";
      return (rel(c) ? "" : "$") + colName(cc) + (rel(r) ? "" : "$") + rr;
    }),
  );
}

// ------------------------------------------------------------ copy

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Rect {
  r: number;
  c: number;
  rows: number;
  cols: number;
}

export function copyPayload(model: SheetModel, rect: Rect): { text: string; html: string } {
  const tsv: string[] = [];
  const trs: string[] = [];
  for (let r = rect.r; r < rect.r + rect.rows; r++) {
    const line: string[] = [];
    const tds: string[] = [];
    for (let c = rect.c; c < rect.c + rect.cols; c++) {
      const v = model.cell(r, c);
      line.push(/[\t\n"]/.test(v.text) ? `"${v.text.replace(/"/g, '""')}"` : v.text);
      const f = v.isFormula ? ` data-sheets-formula="${esc(a1ToR1C1(v.input, r, c))}"` : "";
      const lit = !v.isFormula && v.input !== v.text ? ` data-sapwood-input="${esc(v.input)}"` : "";
      tds.push(`<td${f}${lit}>${esc(v.text)}</td>`);
    }
    tsv.push(line.join("\t"));
    trs.push(`<tr>${tds.join("")}</tr>`);
  }
  // The wrapper tag is how Sheets recognises its own attributes on paste.
  const html = `<meta charset="utf-8"><google-sheets-html-origin><table data-sapwood="1"><tbody>${trs.join("")}</tbody></table></google-sheets-html-origin>`;
  return { text: tsv.join("\n"), html };
}

// ------------------------------------------------------------ paste

/** Inputs to write, relative to the paste target. */
export function parsePaste(html: string, text: string, at: { r: number; c: number }): string[][] {
  if (html && /<table/i.test(html)) {
    const grid = parseHtmlTable(html, at);
    if (grid.length > 0) return grid;
  }
  return parseTsv(text);
}

function parseHtmlTable(html: string, at: { r: number; c: number }): string[][] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const table = doc.querySelector("table");
  if (!table) return [];
  const out: string[][] = [];
  const taken: boolean[][] = []; // cells covered by an earlier rowspan
  [...table.querySelectorAll("tr")].forEach((tr, ri) => {
    const row = (out[ri] ??= []);
    let ci = 0;
    for (const td of tr.querySelectorAll("td, th")) {
      while (taken[ri]?.[ci]) row[ci++] ??= "";
      const formula = td.getAttribute("data-sheets-formula");
      let input: string;
      if (formula) input = r1c1ToA1(formula, at.r + ri, at.c + ci);
      else if (td.hasAttribute("data-sapwood-input")) input = td.getAttribute("data-sapwood-input")!;
      else {
        // Excel writes the raw number in x:num when the shown text is formatted ("1,234.50").
        const num = td.getAttribute("x:num");
        input = num !== null && num !== "" ? num : cellText(td);
        if (num === null && /^[=+-]/.test(input) && !/^[+-]?\d/.test(input)) input = "'" + input; // text, not a formula
      }
      const span = Number(td.getAttribute("colspan") ?? 1);
      const rspan = Number(td.getAttribute("rowspan") ?? 1);
      for (let k = 0; k < span; k++) {
        row[ci + k] = k === 0 ? input : "";
        for (let j = 1; j < rspan; j++) ((taken[ri + j] ??= [])[ci + k] = true);
      }
      ci += span;
    }
  });
  return out;
}

function cellText(td: Element): string {
  // <br> inside a cell is a line break in the value; other whitespace collapses.
  td.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return (td.textContent ?? "").replace(/[ \t\r\n ]+/g, (m) => (m.includes("\n") ? "\n" : " ")).trim();
}

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

/** Apply a paste as one op. */
export function pasteInto(model: SheetModel, at: { r: number; c: number }, grid: string[][]): number {
  const cells: { r: number; c: number; input: string }[] = [];
  grid.forEach((row, i) => row.forEach((input, j) => cells.push({ r: at.r + i, c: at.c + j, input })));
  model.edit(cells);
  return cells.length;
}
