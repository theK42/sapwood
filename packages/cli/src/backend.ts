// What the data, schema, validation and export commands work on: a local project file
// (here) or a Sapwood server (remote.ts). The commands don't know which.

import {
  Sapwood, whereFilter,
  type CellAddress, type EntityJson, type ExportFile, type JsonValue, type MoveReport, type MoveSuggestion, type Patch, type ResolvedSchema, type SingletonJson, type ValidationJson,
} from "@thek42/sapwood-core";
import { saveProjectFile } from "./store.ts";

export type Readable = EntityJson | (SingletonJson & { $id?: undefined });

export interface QueryArgs {
  where: string[];
  pack?: string;
  inactive?: boolean;
}

export interface Written {
  formulas: CellAddress[];
  /** The server task the change went into. */
  task?: number;
}

export interface SchemaWritten extends Written {
  changed: boolean;
  rules: string[];
  scratch: CellAddress[];
  notes: string[];
}

export interface Backend {
  /** An entity, or a singleton named by its type. */
  get(id: string): Promise<Readable>;
  query(type: string, q: QueryArgs): Promise<EntityJson[]>;
  schema(): Promise<ResolvedSchema>;
  schemaYaml(): Promise<string>;
  patch(patches: Patch[]): Promise<Written>;
  applySchema(yaml: string, force: boolean): Promise<SchemaWritten>;
  validate(): Promise<ValidationJson>;
  export(allowInvalid: boolean): Promise<ExportFile[]>;
  /** What moving entities to a pack would do, changing nothing. */
  previewMove(ids: string[], pack: string, sheet?: string): Promise<MoveReport>;
  /** Entities that could move down the pack tree (in a pack and below, if named). */
  suggestMoves(pack?: string): Promise<MoveSuggestion[]>;
}

/** A project in a local file. Each write saves it. */
export class LocalBackend implements Backend {
  readonly file: string;
  readonly s: Sapwood;

  constructor(file: string, s: Sapwood) {
    this.file = file;
    this.s = s;
  }

  async get(id: string): Promise<Readable> {
    return readOne(this.s, id);
  }

  async query(type: string, q: QueryArgs): Promise<EntityJson[]> {
    const conds = q.where.map(whereFilter);
    const opts: Parameters<Sapwood["query"]>[1] = { where: (e) => conds.every((c) => c(e)) };
    if (q.pack !== undefined) opts.pack = q.pack;
    if (q.inactive) opts.inactive = true;
    return this.s.query(type, opts);
  }

  async schema(): Promise<ResolvedSchema> {
    return this.s.project.schema;
  }

  async schemaYaml(): Promise<string> {
    return this.s.schemaYaml();
  }

  async patch(patches: Patch[]): Promise<Written> {
    const c = this.s.apply(patches);
    saveProjectFile(this.file, this.s);
    return { formulas: c.formulas };
  }

  async applySchema(yaml: string, force: boolean): Promise<SchemaWritten> {
    const c = this.s.applySchema(yaml, { force });
    if (c.ops.length) saveProjectFile(this.file, this.s);
    return { changed: c.ops.length > 0, formulas: c.formulas, rules: c.rules, scratch: c.scratch, notes: c.notes };
  }

  async validate(): Promise<ValidationJson> {
    return this.s.validate();
  }

  async previewMove(ids: string[], pack: string, sheet?: string): Promise<MoveReport> {
    return this.s.previewMove(ids, pack, sheet === undefined ? {} : { sheet });
  }

  async suggestMoves(pack?: string): Promise<MoveSuggestion[]> {
    return this.s.suggestMoves(pack === undefined ? {} : { pack });
  }

  async export(allowInvalid: boolean): Promise<ExportFile[]> {
    return this.s.export({ allowInvalid });
  }
}

/** An entity, or a singleton named by its type (they have no ID). */
export function readOne(s: Sapwood, id: string): Readable {
  try {
    return s.get(id);
  } catch (e) {
    if ((e as { code?: unknown }).code === "singleton") return s.singleton(id);
    throw e;
  }
}

export type { JsonValue };
