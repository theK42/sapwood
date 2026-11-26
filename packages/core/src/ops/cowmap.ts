// A Map that copies cheaply (copy-on-write): a base shared with its copies, never written,
// and a layer of its own changes on top. A copy (`fork`) shares the base and copies only the
// layer, so copying a sheet of 100k cells costs about as much as its recent changes. When the
// layer grows past half the base, it's folded into a new base (the old one is left alone, as
// copies may still be reading it).
//
// Documents keep a sheet's cells and formats in these (doc.ts, `own`); everything else uses
// them as ordinary Maps.

const GONE = Symbol("gone");

export class CowMap<K, V> implements Map<K, V> {
  private base: ReadonlyMap<K, V>;
  /** Changes over the base: a value, or GONE for a key deleted from it. */
  private layer: Map<K, V | typeof GONE>;
  private count: number;

  /** A map over `base`, which from now on must not be written (copies share it). */
  constructor(base: ReadonlyMap<K, V> = new Map(), layer?: Map<K, V | typeof GONE>, count?: number) {
    this.base = base;
    this.layer = layer ?? new Map();
    this.count = count ?? base.size;
  }

  /** A copy: the same base, its own copy of the changes. */
  fork(): CowMap<K, V> {
    return new CowMap(this.base, new Map(this.layer), this.count);
  }

  get size(): number {
    return this.count;
  }

  get(k: K): V | undefined {
    const v = this.layer.get(k);
    if (v === GONE) return undefined;
    if (v !== undefined || this.layer.has(k)) return v as V;
    return this.base.get(k);
  }

  has(k: K): boolean {
    const v = this.layer.get(k);
    if (v === GONE) return false;
    return v !== undefined || this.layer.has(k) || this.base.has(k);
  }

  set(k: K, v: V): this {
    if (!this.has(k)) this.count++;
    this.layer.set(k, v);
    this.fold();
    return this;
  }

  delete(k: K): boolean {
    if (!this.has(k)) return false;
    this.count--;
    if (this.base.has(k)) this.layer.set(k, GONE);
    else this.layer.delete(k);
    this.fold();
    return true;
  }

  clear(): void {
    this.base = new Map();
    this.layer = new Map();
    this.count = 0;
  }

  /** The layer folded into a new base, once it's large. */
  private fold(): void {
    if (this.layer.size < 1024 || this.layer.size * 2 < this.base.size) return;
    const next = new Map<K, V>();
    for (const [k, v] of this) next.set(k, v);
    this.base = next;
    this.layer = new Map();
  }

  *entries(): MapIterator<[K, V]> {
    for (const [k, v] of this.layer) if (v !== GONE) yield [k, v as V];
    for (const [k, v] of this.base) if (!this.layer.has(k)) yield [k, v];
  }

  *keys(): MapIterator<K> {
    for (const [k] of this.entries()) yield k;
  }

  *values(): MapIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  forEach(fn: (v: V, k: K, m: Map<K, V>) => void, self?: unknown): void {
    for (const [k, v] of this.entries()) fn.call(self, v, k, this);
  }

  get [Symbol.toStringTag](): string {
    return "CowMap";
  }
}

/**
 * The keys where two maps may differ, when one is a copy of the other (or both of a third):
 * only their layers of changes, since they share a base. Null when that can't be told, so
 * every key has to be compared.
 */
export function differingKeys<K, V>(a: ReadonlyMap<K, V>, b: ReadonlyMap<K, V>): Iterable<K> | null {
  if (a === b) return [];
  const base = (m: ReadonlyMap<K, V>) => (m instanceof CowMap ? (m as unknown as { base: ReadonlyMap<K, V> }).base : m);
  const layer = (m: ReadonlyMap<K, V>) => (m instanceof CowMap ? (m as unknown as { layer: Map<K, unknown> }).layer.keys() : []);
  if (base(a) !== base(b)) return null;
  return new Set([...layer(a), ...layer(b)]);
}

/** A copy of a map to write to: a fork of a CowMap, or a CowMap over a plain map (now shared, so never written again). */
export function forkMap<K, V>(m: Map<K, V>): CowMap<K, V> {
  return m instanceof CowMap ? m.fork() : new CowMap(m);
}
