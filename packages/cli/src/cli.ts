// The sapwood command (DESIGN §9.4). Every command goes through the Sapwood API in
// @thek42/sapwood-core, over a project kept in a local file (store.ts) until the server
// exists. Auth, branch and task commands come with the server (ROADMAP Phase 2).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ApiError, Sapwood, type CellAddress, type Change, type EntityJson, type Patch } from "@thek42/sapwood-core";
import { findProject, loadProjectFile, PROJECT_FILE, saveProjectFile } from "./store.ts";
import { assignments, parseWhere, UsageError } from "./values.ts";

export interface Io {
  cwd: string;
  out(line: string): void;
  err(line: string): void;
}

const HELP = `Usage: sapwood <command> [options]

Project
  init [--schema <file>] [--from <project.yaml>] [--force]
                                  Start a project in ${PROJECT_FILE} here
Data
  get <id>                        An entity, or a singleton by type name, as JSON
  query <type|trait> [--where <field><op><value>]… [--pack <p>] [--inactive] [--ids]
                                  Entities as JSON lines; ops = != < <= > >= ~
  set <id> <field>=<value>… [--force]
                                  Set fields; blank clears, =… is a formula,
                                  $id=… renames, $active=false comments out
  create <type> <id> [<field>=<value>…] [--sheet <s>] [--pack <p>] [--after <id>]
  comment-out <id>  |  uncomment <id>  |  delete <id>
  apply <patch.jsonl>             Patches, one JSON object per line, all or nothing
Schema
  schema get                      The schema as YAML
  schema apply <file> [--force]   Apply an edited schema file
Validation and export
  validate [--json]               Exit status 1 when there are errors
  export --out <dir> [--allow-invalid]

Options for every command
  --project <path>                The project file, or a folder holding one
                                  (default: the nearest ${PROJECT_FILE} at or above here)`;

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

type Parsed = { values: Record<string, string | boolean | string[] | undefined>; positionals: string[] };

function parse(args: string[], options: Options = {}): Parsed {
  try {
    return parseArgs({ args, options: { project: { type: "string" }, ...options }, allowPositionals: true, strict: true }) as Parsed;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

function positionals(p: { positionals: string[] }, names: string[], rest = false): string[] {
  if (p.positionals.length < names.length) throw new UsageError(`Expected ${names.map((n) => `<${n}>`).join(" ")}`);
  if (!rest && p.positionals.length > names.length) throw new UsageError(`Unexpected ${p.positionals.slice(names.length).join(" ")}`);
  return p.positionals;
}

const where = (a: CellAddress) => `${a.sheet}!${a.cell}`;

/** Run one command. Returns the exit status: 0 done, 1 failed or invalid, 2 typed wrong. */
export function run(argv: string[], io: Io): number {
  try {
    return command(argv, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`sapwood: ${e.message}`);
      io.err("Run sapwood help for the commands.");
      return 2;
    }
    if (e instanceof ApiError) {
      io.err(`sapwood: ${e.message} [${e.code}]`);
      return 1;
    }
    io.err(`sapwood: ${(e as Error).message ?? String(e)}`);
    return 1;
  }
}

function command(argv: string[], io: Io): number {
  const [cmd, ...args] = argv;
  const open = (p: { values: { project?: unknown } }) => {
    const file = findProject(io.cwd, p.values.project as string | undefined);
    return { file, s: loadProjectFile(file) };
  };
  /** Save after a change, and say what it left for the user to check. */
  const saved = (file: string, s: Sapwood, change: Change, what: string): number => {
    saveProjectFile(file, s);
    io.out(what);
    if (change.formulas.length) io.out(`Formulas that mention the old name, left as they are: ${change.formulas.map(where).join(", ")}`);
    return 0;
  };

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(HELP);
      return 0;

    case "init": {
      const p = parse(args, { schema: { type: "string" }, from: { type: "string" }, force: { type: "boolean" } });
      positionals(p, []);
      const dir = resolve(io.cwd, (p.values.project as string | undefined) ?? ".");
      const file = dir.endsWith(".json") ? dir : join(dir, PROJECT_FILE);
      if (existsSync(file) && !p.values.force) throw new UsageError(`${file} exists: pass --force to replace it`);
      const read = (f: unknown) => readFileSync(resolve(io.cwd, f as string), "utf8");
      const schema = p.values.schema === undefined ? "" : read(p.values.schema);
      const s = Sapwood.load(schema, p.values.from === undefined ? { sheets: [] } : read(p.values.from));
      mkdirSync(dirname(file), { recursive: true });
      saveProjectFile(file, s);
      const v = s.validate();
      io.out(`Started a project in ${file}: ${countEntities(s)} entities, ${v.errors} errors, ${v.warnings} warnings.`);
      return 0;
    }

    case "get": {
      const p = parse(args);
      const [id] = positionals(p, ["id"]);
      const { s } = open(p);
      io.out(JSON.stringify(readOne(s, id!), null, 2));
      return 0;
    }

    case "query": {
      const p = parse(args, { where: { type: "string", multiple: true }, pack: { type: "string" }, inactive: { type: "boolean" }, ids: { type: "boolean" } });
      const [type] = positionals(p, ["type"]);
      const conds = ((p.values.where as string[] | undefined) ?? []).map(parseWhere);
      const { s } = open(p);
      const opts: Parameters<Sapwood["query"]>[1] = { where: (e) => conds.every((c) => c(e)) };
      if (p.values.pack !== undefined) opts.pack = p.values.pack as string;
      if (p.values.inactive) opts.inactive = true;
      for (const e of s.query(type!, opts)) io.out(p.values.ids ? e.$id : JSON.stringify(e));
      return 0;
    }

    case "set": {
      const p = parse(args, { force: { type: "boolean" } });
      const [id, ...rest] = positionals(p, ["id", "field=value"], true);
      const { file, s } = open(p);
      const current = readOne(s, id!);
      const fields = assignments(s.project.schema, current.$type, rest, current);
      const force = p.values.force === true;
      const change = "$id" in current ? s.set(id!, fields, { force }) : s.setSingleton(id!, fields, { force });
      const renamed = typeof fields.$id === "string" && fields.$id !== id ? ` (now ${fields.$id})` : "";
      return saved(file, s, change, `Set ${Object.keys(fields).join(", ")} on ${id}${renamed}.`);
    }

    case "create": {
      const p = parse(args, { sheet: { type: "string" }, pack: { type: "string" }, after: { type: "string" } });
      const [type, id, ...rest] = positionals(p, ["type", "id"], true);
      const { file, s } = open(p);
      const fields = { ...assignments(s.project.schema, type!, rest), $id: id! };
      const place: Parameters<Sapwood["create"]>[2] = {};
      for (const k of ["sheet", "pack", "after"] as const) if (p.values[k] !== undefined) place[k] = p.values[k] as string;
      const change = s.create(type!, fields, place);
      const e = s.get(id!);
      return saved(file, s, change, `Created ${type} ${id} on ${e.$sheet}.`);
    }

    case "comment-out":
    case "uncomment":
    case "delete": {
      const p = parse(args);
      const [id] = positionals(p, ["id"]);
      const { file, s } = open(p);
      const change = cmd === "delete" ? s.delete(id!) : cmd === "uncomment" ? s.uncomment(id!) : s.commentOut(id!);
      return saved(file, s, change, `${cmd === "delete" ? "Deleted" : cmd === "uncomment" ? "Uncommented" : "Commented out"} ${id}.`);
    }

    case "apply": {
      const p = parse(args);
      const [path] = positionals(p, ["patch.jsonl"]);
      const patches: Patch[] = [];
      for (const [i, line] of readFileSync(resolve(io.cwd, path!), "utf8").split(/\r?\n/).entries()) {
        if (line.trim() === "") continue;
        try {
          patches.push(JSON.parse(line) as Patch);
        } catch (e) {
          throw new UsageError(`${path} line ${i + 1}: ${(e as Error).message}`);
        }
      }
      const { file, s } = open(p);
      const change = s.apply(patches);
      return saved(file, s, change, `Applied ${patches.length} patch${patches.length === 1 ? "" : "es"}.`);
    }

    case "schema": {
      const [sub, ...rest] = args;
      if (sub === "get") {
        const p = parse(rest);
        positionals(p, []);
        io.out(open(p).s.schemaYaml().trimEnd());
        return 0;
      }
      if (sub === "apply") {
        const p = parse(rest, { force: { type: "boolean" } });
        const [path] = positionals(p, ["file"]);
        const text = readFileSync(resolve(io.cwd, path!), "utf8");
        const { file, s } = open(p);
        const c = s.applySchema(text, { force: p.values.force === true });
        if (!c.ops.length) io.out("The schema is unchanged.");
        else saved(file, s, c, "Schema updated.");
        if (c.scratch.length) io.out(`Cells of removed fields, scratch now: ${c.scratch.map(where).join(", ")}`);
        if (c.rules.length) io.out(`Rules that mention an old name, left as they are: ${c.rules.join(", ")}`);
        for (const n of c.notes) io.out(`Note: ${n}.`);
        return 0;
      }
      throw new UsageError(sub === undefined ? "Expected schema get or schema apply <file>" : `Unknown command schema ${sub}`);
    }

    case "validate": {
      const p = parse(args, { json: { type: "boolean" } });
      positionals(p, []);
      const v = open(p).s.validate();
      if (p.values.json) io.out(JSON.stringify(v, null, 2));
      else {
        for (const i of v.issues) {
          const place = i.sheet === undefined ? "" : ` ${i.sheet}!${i.cell ?? i.row ?? ""}`;
          const who = i.entity?.id ? ` (${i.entity.id})` : "";
          io.out(`${i.level}${place}${who} ${i.code}: ${i.message}`);
        }
        io.out(`${v.errors} error${v.errors === 1 ? "" : "s"}, ${v.warnings} warning${v.warnings === 1 ? "" : "s"}.`);
      }
      return v.errors ? 1 : 0;
    }

    case "export": {
      const p = parse(args, { out: { type: "string" }, "allow-invalid": { type: "boolean" } });
      positionals(p, []);
      if (p.values.out === undefined) throw new UsageError("Expected --out <dir>");
      const { s } = open(p);
      const files = s.export({ allowInvalid: p.values["allow-invalid"] === true });
      const out = resolve(io.cwd, p.values.out as string);
      for (const f of files) {
        const path = join(out, f.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.content);
      }
      io.out(`Exported ${files.length} file${files.length === 1 ? "" : "s"} to ${out}.`);
      return 0;
    }

    default:
      throw new UsageError(`Unknown command ${cmd}`);
  }
}

/** An entity, or a singleton named by its type (they have no ID). */
function readOne(s: Sapwood, id: string): EntityJson | (ReturnType<Sapwood["singleton"]> & { $id?: undefined }) {
  try {
    return s.get(id);
  } catch (e) {
    if (e instanceof ApiError && e.code === "singleton") return s.singleton(id);
    throw e;
  }
}

function countEntities(s: Sapwood): number {
  return s.project.project().entities.length;
}
