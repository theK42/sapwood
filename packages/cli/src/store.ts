// A project kept in a local file, `sapwood.json`: the whole document as JSON (docToJson).
// Without a server this is where the CLI reads and writes; each command loads the file,
// and a command that changes the project saves it again.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { docFromJson, docToJson, Sapwood } from "@thek42/sapwood-core";
import { saveFile } from "./fsutil.ts";
import { UsageError } from "./values.ts";

export const PROJECT_FILE = "sapwood.json";

/** The project file: `--project` (a file, or a folder holding one), else the nearest one at or above `cwd`. */
export function findProject(cwd: string, explicit?: string): string {
  if (explicit !== undefined) {
    const p = resolve(cwd, explicit);
    const file = existsSync(p) && statSync(p).isDirectory() ? join(p, PROJECT_FILE) : p;
    if (!existsSync(file)) throw new UsageError(`No project at ${file}`);
    return file;
  }
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, PROJECT_FILE);
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) throw new UsageError(`No ${PROJECT_FILE} here or in any folder above: run sapwood init, or pass --project`);
  }
}

export function loadProjectFile(file: string): Sapwood {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`Can't read ${file}: ${(e as Error).message}`);
  }
  return Sapwood.fromDoc(docFromJson(json));
}

/** Save, replacing the file in one step so an interrupted save leaves the old one whole. */
export function saveProjectFile(file: string, s: Sapwood): void {
  saveFile(file, JSON.stringify(docToJson(s.doc), null, 1) + "\n");
}
