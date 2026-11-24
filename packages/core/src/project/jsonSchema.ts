// JSON Schema for `json` fields (DESIGN §5.3): the part of it that game data needs, checked
// by validation and read by the web app's panel to generate a form.
//
// Understood: `type` (one or a list), `enum`, `const`, `properties`, `required`,
// `additionalProperties` (false or a schema), `items`, `minItems`, `maxItems`, `uniqueItems`,
// `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `minLength`, `maxLength`,
// `pattern`, and `anyOf`. Other keywords (`$ref`, `if`, formats…) are ignored, so a schema
// that uses them checks less than it says, never more.

export interface JsonSchemaIssue {
  /** Where in the value: `""` for the whole, then `.key` and `[0]`, as validation writes paths. */
  path: string;
  message: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The JSON type of a value, as JSON Schema names it. */
export function jsonType(v: unknown): "null" | "boolean" | "integer" | "number" | "string" | "array" | "object" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v as "boolean" | "string" | "object";
}

const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 40 ? s.slice(0, 40) + "…" : s;
};

/** Check a value against a JSON Schema. Each problem once, outermost first. */
export function checkJsonSchema(schema: unknown, value: unknown, path = ""): JsonSchemaIssue[] {
  const out: JsonSchemaIssue[] = [];
  check(schema, value, path, out);
  return out;
}

function check(s: unknown, v: unknown, path: string, out: JsonSchemaIssue[]): void {
  if (s === false) return void out.push({ path, message: "isn't allowed here" });
  if (!isObj(s)) return; // true, or not a schema: anything goes
  const bad = (message: string): void => void out.push({ path, message });

  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]).filter((t): t is string => typeof t === "string");
    const t = jsonType(v);
    if (types.length && !types.some((x) => x === t || (x === "number" && t === "integer")))
      return bad(`must be ${types.map(article).join(" or ")}, not ${show(v)}`);
  }
  if (Array.isArray(s.enum) && !s.enum.some((x) => same(x, v))) return bad(`must be one of ${s.enum.map(show).join(", ")}`);
  if ("const" in s && !same(s.const, v)) return bad(`must be ${show(s.const)}`);

  if (Array.isArray(s.anyOf) && s.anyOf.length) {
    const results = s.anyOf.map((x) => checkJsonSchema(x, v, path));
    if (!results.some((r) => r.length === 0)) {
      // The closest option's problems say the most: one of the value's own type, with fewest.
      const score = (r: JsonSchemaIssue[]) => r.length + (r.some((i) => i.path === path && i.message.startsWith("must be ")) ? 1000 : 0);
      const best = results.reduce((a, b) => (score(b) < score(a) ? b : a));
      out.push(...best);
      return;
    }
  }

  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) bad(`must be at least ${s.minimum}`);
    if (typeof s.maximum === "number" && v > s.maximum) bad(`must be at most ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && v <= s.exclusiveMinimum) bad(`must be more than ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && v >= s.exclusiveMaximum) bad(`must be less than ${s.exclusiveMaximum}`);
  }
  if (typeof v === "string") {
    const n = [...v].length;
    if (typeof s.minLength === "number" && n < s.minLength) bad(`must be at least ${s.minLength} character${s.minLength === 1 ? "" : "s"}`);
    if (typeof s.maxLength === "number" && n > s.maxLength) bad(`must be at most ${s.maxLength} character${s.maxLength === 1 ? "" : "s"}`);
    if (typeof s.pattern === "string") {
      let re: RegExp | null = null;
      try {
        re = new RegExp(s.pattern, "u");
      } catch {
        // A bad pattern checks nothing.
      }
      if (re && !re.test(v)) bad(`must match ${s.pattern}`);
    }
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) bad(`needs at least ${s.minItems} item${s.minItems === 1 ? "" : "s"}`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems) bad(`allows at most ${s.maxItems} item${s.maxItems === 1 ? "" : "s"}`);
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      for (const x of v) {
        const k = canonical(x);
        if (seen.has(k)) bad(`has ${show(x)} twice, but must be unique`);
        seen.add(k);
      }
    }
    if (s.items !== undefined && !Array.isArray(s.items)) v.forEach((x, i) => check(s.items, x, `${path}[${i}]`, out));
  }
  if (isObj(v)) {
    const props = isObj(s.properties) ? s.properties : {};
    if (Array.isArray(s.required))
      for (const k of s.required) if (typeof k === "string" && !(k in v)) out.push({ path: key(path, k), message: "is required" });
    for (const [k, x] of Object.entries(v)) {
      if (k in props) check(props[k], x, key(path, k), out);
      else if (s.additionalProperties === false) out.push({ path: key(path, k), message: "isn't a known key" });
      else if (isObj(s.additionalProperties)) check(s.additionalProperties, x, key(path, k), out);
    }
  }
}

const key = (path: string, k: string) => (/^[A-Za-z_]\w*$/.test(k) ? `${path}.${k}` : `${path}[${JSON.stringify(k)}]`);

const article = (t: string) => (t === "integer" ? "a whole number" : t === "array" ? "a list" : t === "object" ? "an object" : t === "null" ? "null" : t === "boolean" ? "true or false" : t === "string" ? "text" : `a ${t}`);

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
