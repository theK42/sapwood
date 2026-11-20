# Spike S3: Op rebase

Status: **done** (2026-11-19). Code: [`spikes/s3-ops`](../../spikes/s3-ops).

## Decision

**The change model in DESIGN §8 works as designed.** Ops against stable row and column IDs, with tombstones for deletes, rebase cleanly. Phase 1 can build on this design:

- **Conflicts come from a three-way comparison of net effects.** Compare base, mine's result and theirs' result. Writing a cell and then writing it back is not a change, so it is not a conflict.
- **Ops are transformed one at a time.** A task keeps its own op history (undo, blame), and rebasing rewrites those ops to apply on the new head.
- **`renameId` is an intent op.** It is re-run against the head, so it also rewrites references that other tasks added concurrently.

Before everything passed, the property tests found two bugs and one design problem. The design problem was about anchors, and it needed a rule DESIGN didn't have. See [Decisions made here](#decisions-made-here).

## What was built

About 700 lines of TypeScript plus 470 lines of tests, using fast-check (MIT) for the property tests:

| File | Contents |
|---|---|
| `model.ts` | Sheets with row and column axes of stable IDs and tombstones, cells and formats keyed by `(row ID, column ID)`. `apply` returns the new state and the exact inverse. The ops: `setCell`, `setFormat`, `insert`, `delete`, `move` (rows or columns), `renameId`, plus `purge` and `restore`, which only appear as inverses |
| `rebase.ts` | `analyze` (one side's net effect), `detect` (the §8.5 conflicts), `rebase` (rewrite mine onto theirs, settling each conflict for mine or theirs) |
| `gen.ts` | Random sheets and valid op sequences. Values are drawn from a tiny vocabulary on purpose, so concurrent edits keep colliding |
| `ops.test.ts` | 20 example tests: one or more per §8.5 rule, `renameId`, inverses and revert |
| `props.test.ts` | 6 property tests (below) |
| `bench.ts` | Rebase timing on a 20k-row sheet |

Columns A and B (type and ID, DESIGN §6.2) are fixed system columns here. They can't be moved or deleted, which is what lets `renameId` find the ID cell.

## Pass criteria

The criterion was: random concurrent op sequences give the same result regardless of landing order where that's expected, and every conflict in DESIGN §8.5 is detected. **Both are met.**

Each property ran **100,000** random cases (`RUNS=100000`). The normal test run uses 3,000.

| Property | What it checks |
|---|---|
| Inverse | For any sequence of up to 10 ops, applying the inverse restores the state exactly, tombstones included |
| Three-way merge | Rebase two random tasks, settling each conflict at random for mine or theirs. Then check against an oracle computed from whole states, not from ops: (0) exactly the §8.5 conflicts are reported, no more and no fewer; (1) the rebased ops apply to the head; (2) which rows and columns are live; (3) every live cell's content and format; (4) each side's row and column order is kept for everything the other side didn't place |
| Coverage | The generator really produces every kind of conflict. In the 100,000-case run: 12,420 cell, 18,140 deleted-row or -column, 2,538 move and 1,017 rename conflicts, and 77,203 cases with none. The full run took 3.8 minutes |
| Symmetry | Landing A then B reports the same conflicts as landing B then A |
| Landing order | With no conflicts, both landing orders give the same sheet, apart from the expected differences below |
| Revert | Commit, then later commits, then the commit's inverse rebased onto the head (§8.7). It passes the same three-way check as the merge property |

**Where landing order is expected to matter:**

- Rows both sides insert at the same anchor go in landing order (§8.5).
- Formats are last-write-wins.
- A rename landed **after** another task added a reference rewrites that reference. A rename landed **before** it leaves the reference dangling. Validation reports it, and §8.4 already offers "update references".
- Tombstones of rows **both** sides deleted can end up in either side's order, and their cell contents can differ. Neither is visible unless both deletes are reverted.

## How rebase works

1. **Analyze both sides against the base:** each side's net cell and format changes, the rows and columns it deleted, edited (a cell changed, or moved) or moved, every row it placed and at which anchor, and its renames.
2. **Detect conflicts** (§8.5):
   - Both changed a cell, and their results differ.
   - One side deleted a row or column that the other edited or moved.
   - Both moved the same row to different places.
   - Both renamed the same ID to different names.
3. **Rewrite mine op by op against the head:**
   - Cell writes to cells theirs changed are dropped. Conflicts resolved for mine are written back explicitly at the end.
   - A deleted row that mine chose to keep is restored first, with its cells.
   - Inserts and moves get a new anchor (next section).
   - Deletes skip rows already gone.
   - A purge (undoing an insert) turns into a delete if another task wrote into the row since.
   - Renames are re-run. If a rename conflict is resolved for mine, `renameId(theirs, mine)` runs instead.

## Decisions made here

DESIGN didn't settle these points. The first two came out of the property tests.

1. **Inserts and moves anchored to a row the other side moved stay put.** They go after the anchor's old predecessor, as mine saw the sheet. Following the moved anchor made the result depend on which side landed first, and the landing-order property caught it. The same applies when mine's own earlier move of the anchor was dropped because theirs deleted it.
2. **Rows placed at the same anchor:** the earlier-landed side's rows come first, including rows they then inserted after those (§8.5, made exact).
3. **Moving a row counts as editing it.** Delete against move is a conflict.
4. **Both moving the same row to different places is a conflict.** Moving it to the same place is not. §8.5 should list this.
5. **Inserting after a row the other side deleted is not a conflict.** The tombstone still anchors it.
6. **Resolving "edit vs delete" for the edit restores the row with all its cells**, including theirs' edits from before the delete.
7. **The exact inverse of `renameId` is the cell writes it made**, not `renameId(new, old)`. Cells that already held the new name must stay as they were.
8. **A rename's rewrites are ordinary cell changes for conflict purposes.** If one side renames `bolt` while the other changes a cell holding `bolt` to something else, that cell conflicts.
9. **Formats: last write wins**, by landing order, and only for net changes. A format set and then cleared doesn't wipe the other side's.

## Bugs found

All were fixed in the spike, each in a few lines.

**Found by the property tests**, from shrunk counterexamples:

- **The anchor problem** in decision 1. It produced three different counterexamples, one of them in revert.
- **A shared skip list.** Rows both sides had moved to the same place were also left out of mine's delete, so the delete was lost.
- **Restored rows.** Mine's writes were replayed even where mine made no net change, which wiped theirs' edits on the restored row.

**Found while writing the oracle**, before the tests ran:

- Restoring a row dropped mine's edits to it.
- A format set and then cleared overwrote theirs.
- The inverse of a purge assumed the rows were contiguous, but another task can insert between them.

**On the test side:** a fresh-ID prefix collided with a column name, and the first version of the oracle was too strict about tombstones.

## Performance (not a criterion)

On 20,000 rows × 12 columns, rebasing 200 ops over 200 ops takes about **0.9 s**.

The spike diffs whole sheets to find net effects, and each rename scans every cell. Phase 2 should:

- work out the net effect from the keys the ops touch, not by diffing whole states;
- give axes an index for anchor lookups;
- give renames an index from ID to referencing cells. The validation index needs this anyway, see S2.

## Not covered

- **Schema ops.** Field and type renames, `setFieldType`, migrations (§5.9). `renameType` and `renameEnumMember` follow the same intent pattern as `renameId`, so this spike shows the mechanism but doesn't test them.
- **Sheet, pack, layout and wizard ops.** These are mostly last-write-wins or must-be-empty checks, a lower risk.
- **Range ops.** Range formats and multi-cell paste are modelled as single-cell ops; a range op would expand to them.
- **References to deleted rows from formulas.** S1 already covers this: such a reference renders `#REF!`, and comes back when the row is restored.
- **Branch merge and sync (§8.6).** These are the same rebase, applied to a branch's net change, and weren't tested separately.
- **Storage.** Compacting ops and storing analyses are Phase 2 questions.
