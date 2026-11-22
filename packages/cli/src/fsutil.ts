// Saving a file in one step: write a temporary file, then rename it over the old one, so
// an interrupted save leaves the old file whole.

import { renameSync, rmSync, writeFileSync, type WriteFileOptions } from "node:fs";

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Block for a few milliseconds (the CLI's saves are synchronous). */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Write `content` to `file` in one step. On Windows a rename over a file that something
 * else has open for a moment (a virus scanner, the search indexer) fails with EPERM or
 * EBUSY, so it is tried again for up to about two seconds before giving up.
 */
export function saveFile(file: string, content: string, opts: WriteFileOptions = {}): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, opts);
  for (let wait = 10; ; wait *= 2) {
    try {
      renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === undefined || !BUSY.has(code) || wait > 1000) {
        rmSync(tmp, { force: true });
        throw e;
      }
      pause(wait);
    }
  }
}
