import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProject } from "@thek42/sapwood-core";
import { copyPayload, parsePaste, parseTsv, r1c1ToA1 } from "./clipboard.ts";
import { SheetGrid } from "./grid.ts";

const fixture = (f: string) => readFileSync(new URL(`../../core/fixtures/krbsg/${f}`, import.meta.url), "utf8");

describe("the clipboard", () => {
  it("copies and pastes within Sapwood: as typed, formulas moved, formats kept", () => {
    const { project: p } = loadProject(fixture("schema.yaml"), fixture("project.yaml"));
    const s = p.sheetId("Weapons");
    new SheetGrid(p, s).edit([
      { row: 1, col: 6, input: "=F2/E2", format: { bold: true, fill: "#fff3b0" } },
      { row: 1, col: 7, input: "'42" },
    ]);
    const g = new SheetGrid(p, s);
    const { text, html } = copyPayload(g, { row: 1, col: 4, rows: 1, cols: 4 });
    expect(text).toBe("0.5\t1\t2\t42");
    expect(html).toContain('data-sheets-formula="=R[0]C[-1]/R[0]C[-2]"');
    expect(html).toContain("font-weight:bold");
    // Pasted two rows down and one right.
    const cells = parsePaste(html, text, { row: 3, col: 5 });
    expect(cells[0]!.map((c) => c.input)).toEqual(["0.5", "1", "=G4/F4", "'42"]);
    expect(cells[0]![2]!.format).toEqual({ bold: true, fill: "#fff3b0" });
    expect(cells[0]![0]!.format).toBe(null); // no format there: cleared on paste
  });

  it("reads Sheets' formulas, Excel's numbers, spans and line breaks", () => {
    const sheets = `<google-sheets-html-origin><table><tr><td data-sheets-formula="=R[0]C[-1]*2">10</td><td data-sheets-formula="=SUM(R1C1:R[-1]C[-2])">99</td></tr></table></google-sheets-html-origin>`;
    expect(parsePaste(sheets, "", { row: 4, col: 3 })[0]!.map((c) => c.input)).toEqual(["=C5*2", "=SUM($A$1:C4)"]);
    const excel = `<table><tr><td x:num="1234.5">1,234.50</td><td colspan=2>wide</td></tr><tr><td rowspan="2">tall &amp; thin</td><td>a<br>b</td><td>=not a formula</td></tr><tr><td>x</td></tr></table>`;
    expect(parsePaste(excel, "", { row: 0, col: 0 }).map((r) => r.map((c) => c.input))).toEqual([
      ["1234.5", "wide", ""],
      ["tall & thin", "a\nb", "'=not a formula"],
      ["", "x"],
    ]);
    expect(r1c1ToA1("=R[-5]C[0]", 2, 1)).toBe("=#REF!");
    expect(r1c1ToA1('="R[1]C[1]"&R[1]C[1]', 1, 1)).toBe('="R[1]C[1]"&B2');
  });

  it("falls back to TSV, with quoted cells", () => {
    expect(parseTsv('a\t"b\tc"\n"say ""hi"""\t\n')).toEqual([["a", "b\tc"], ['say "hi"', ""]]);
    expect(parsePaste("", "1\t=2+2", { row: 0, col: 0 })[0]!.map((c) => c.input)).toEqual(["1", "'=2+2"]);
  });
});
