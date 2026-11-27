// The pack tree on the home page (DESIGN §7.1, §9.1): packs with their sheets and sub-packs,
// each with its validation badges. Each pack and sheet has a ⋯ menu: a new sheet or pack in
// it, rename, move to another pack, move up or down among its siblings, or delete (asked
// first; undo brings it back). Sheets are an Editor's to make, rename, move, order and delete;
// packs a Developer's (§11.2). Names are typed in place: Enter to keep, Escape to leave it.
//
// Sheets and packs can be dragged: a sheet above or below another (of its pack, or of another,
// which moves it there), or onto a pack's name to go last in it; a pack above or below another,
// or onto the middle of a pack's name to go inside it. A line shows where it would land; each
// drop is one change.

import { useEffect, useRef, useState, type DragEvent } from "react";
import type { Change, Patch, Sapwood } from "@thek42/sapwood-core";
import { dropPatches, type Counts, type DropAt, type Dragged, type PackNode, type SheetNode } from "./home.ts";
import { plural } from "./hooks.ts";

export interface TreeActions {
  /** Edit sheets (an Editor); edit packs too (a Developer). */
  sheets: boolean;
  packs: boolean;
  /** Make a change through the API; false (and the reason shown) if it's refused. */
  act(fn: (s: Sapwood) => Change): void;
  /** Suggested moves down the tree, for a pack and below. */
  suggest?(pack: string): void;
}

/** What's being typed in the tree: one thing at a time. */
type Typing =
  | { kind: "renamePack" | "newSheet" | "newPack" | "movePack"; pack: string }
  | { kind: "renameSheet" | "moveSheet"; sheet: string; pack: string }
  | null;

interface Props {
  root: PackNode;
  open(sheet: string): void;
  href(sheet: string): string;
  actions: TreeActions;
}

export function PackTree(p: Props) {
  const [typing, setTyping] = useState<Typing>(null);
  // Every pack, for "move to": by its place in the tree.
  const all: { id: string; name: string; depth: number; inside: Set<string> }[] = [];
  const walk = (n: PackNode, depth: number, above: string[]) => {
    all.push({ id: n.id, name: n.name, depth, inside: new Set(above) });
    for (const q of n.packs) walk(q, depth + 1, [...above, n.id]);
  };
  walk(p.root, 0, []);
  const name = (id: string) => all.find((x) => x.id === id)?.name ?? id;
  // Dragging: what, and where it would land now.
  const [drag, setDrag] = useState<Dragged | null>(null);
  const [over, setOver] = useState<DropAt | null>(null);
  const dnd: Dnd = {
    drag,
    over,
    start: (d, e, label) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", label);
      setTyping(null);
      setDrag(d);
    },
    end: () => (setDrag(null), setOver(null)),
    hover: (at, e) => {
      if (!drag || dropPatches(p.root, drag, at) === null) return false;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (over?.on !== at.on || over.id !== at.id || over.where !== at.where) setOver(at);
      return true;
    },
    drop: (at, e) => {
      e.preventDefault();
      const ps = drag ? dropPatches(p.root, drag, at) : null;
      setDrag(null);
      setOver(null);
      if (ps && ps.length) p.actions.act((s) => s.apply(ps as Patch[]));
    },
  };
  return (
    <div className={drag ? "tree-dragging" : undefined} onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(null)}>
      <Pack node={p.root} parent={null} depth={0} tree={{ ...p, typing, setTyping, all, name, dnd }} />
    </div>
  );
}

interface Dnd {
  drag: Dragged | null;
  over: DropAt | null;
  start(d: Dragged, e: DragEvent, label: string): void;
  end(): void;
  /** Over a place: true (and the drop allowed) if it can land there. */
  hover(at: DropAt, e: DragEvent): boolean;
  drop(at: DropAt, e: DragEvent): void;
}

/** The upper or lower half of what's under the pointer. */
const half = (e: DragEvent): "before" | "after" => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < r.top + r.height / 2 ? "before" : "after";
};
/** On a pack's name: its top quarter is before it, the bottom quarter after, the rest into it. */
const third = (e: DragEvent): "before" | "after" | "into" => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  return y < 0.25 ? "before" : y > 0.75 ? "after" : "into";
};
const overClass = (over: DropAt | null, on: DropAt["on"], id: string) => (over && over.on === on && over.id === id ? ` drop-${over.where}` : "");

/** Up or down among siblings: the one to go after (null: first), or undefined if it can't go that way. */
function neighbour(names: string[], i: number, up: boolean): string | null | undefined {
  if (up) return i <= 0 ? undefined : i >= 2 ? names[i - 2]! : null;
  return i < 0 || i >= names.length - 1 ? undefined : names[i + 1]!;
}

/** Everything in a pack, counted: its sheets, packs and rows, its own and its packs'. */
function contentsOf(n: PackNode): { sheets: number; packs: number; rows: number } {
  const out = { sheets: n.sheets.length, packs: n.packs.length, rows: n.sheets.reduce((k, s) => k + s.rows, 0) };
  for (const q of n.packs) {
    const c = contentsOf(q);
    out.sheets += c.sheets;
    out.packs += c.packs;
    out.rows += c.rows;
  }
  return out;
}

interface Tree extends Props {
  dnd: Dnd;
  typing: Typing;
  setTyping(t: Typing): void;
  all: { id: string; name: string; depth: number; inside: Set<string> }[];
  name(id: string): string;
}

function Pack({ node, parent, depth, tree, siblings = [] }: { node: PackNode; parent: string | null; depth: number; tree: Tree; siblings?: PackNode[] }) {
  const [open, setOpen] = useState(true);
  const empty = node.sheets.length === 0 && node.packs.length === 0;
  const { actions: a, typing: t, setTyping } = tree;
  const mine = t && "pack" in t && t.pack === node.id && !("sheet" in t) ? t.kind : null;
  const isRoot = depth === 0;
  const menu = [
    ...(a.sheets ? [{ label: "New sheet…", run: () => (setOpen(true), setTyping({ kind: "newSheet", pack: node.id })) }] : []),
    ...(a.packs ? [{ label: "New pack inside…", run: () => (setOpen(true), setTyping({ kind: "newPack", pack: node.id })) }] : []),
    ...(a.packs ? [{ label: "Rename…", run: () => setTyping({ kind: "renamePack", pack: node.id }) }] : []),
    ...(a.suggest && node.packs.length > 0 ? [{ label: "Suggest moves down…", run: () => a.suggest!(node.name) }] : []),
    ...(a.packs && !isRoot && tree.all.length > 2 ? [{ label: "Move to another pack…", run: () => setTyping({ kind: "movePack", pack: node.id }) }] : []),
    ...(a.packs && !isRoot ? order(siblings.map((q) => q.name), node.name, (after) => a.act((s) => s.orderPack(node.name, after))) : []),
    ...(a.packs && !isRoot
      ? [
          {
            label: "Delete…",
            danger: true,
            run: () => {
              const c = contentsOf(node);
              const what = c.sheets || c.packs ? `, with ${[c.sheets && plural(c.sheets, "sheet"), c.packs && plural(c.packs, "pack")].filter(Boolean).join(" and ")}${c.rows ? ` (${plural(c.rows, "row")})` : ""}` : "";
              if (confirm(`Delete the pack ${node.name}${what}? Undo brings it back.`)) a.act((s) => s.deletePack(node.name));
            },
          },
        ]
      : []),
  ];
  const { dnd } = tree;
  const onPack = (e: DragEvent) => {
    // A pack can go before, after or into; a sheet only into (last).
    const where = dnd.drag?.kind === "pack" ? third(e) : "into";
    if (!dnd.hover({ on: "pack", id: node.id, where }, e) && where !== "into") dnd.hover({ on: "pack", id: node.id, where: "into" }, e);
  };
  const draggable = a.packs && !isRoot && !mine;
  return (
    <div className="pack" style={{ marginLeft: isRoot ? 0 : 14 }}>
      <div
        className={`tree-row${overClass(dnd.over, "pack", node.id)}${dnd.drag?.kind === "pack" && dnd.drag.id === node.id ? " dragging" : ""}`}
        draggable={draggable}
        onDragStart={draggable ? (e) => dnd.start({ kind: "pack", id: node.id }, e, node.name) : undefined}
        onDragEnd={dnd.end}
        onDragOver={onPack}
        onDrop={(e) => dnd.over && dnd.over.on === "pack" && dnd.over.id === node.id && dnd.drop(dnd.over, e)}
        title={draggable ? "Drag to reorder, or onto another pack to move it there" : undefined}
      >
        {mine === "renamePack" ? (
          <NameBox start={node.name} label="Pack name" done={(n) => (setTyping(null), n !== null && a.act((s) => s.renamePack(node.name, n)))} />
        ) : (
          <button className="pack-name" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span className="caret">{open ? "▾" : "▸"}</span> {node.name} <Badges c={node} />
          </button>
        )}
        {mine === "movePack" && (
          <MoveBox
            label={`Move ${node.name} into`}
            options={tree.all.filter((x) => x.id !== node.id && x.id !== parent && !x.inside.has(node.id))}
            done={(to) => (setTyping(null), to !== null && a.act((s) => s.movePack(node.name, tree.name(to))))}
          />
        )}
        {menu.length > 0 && <RowMenu label={`${node.name}: more`} items={menu} />}
      </div>
      {open && (
        <ul className="sheet-list">
          {node.sheets.map((s) => (
            <SheetRow key={s.id} sheet={s} pack={node} tree={tree} />
          ))}
          {mine === "newSheet" && (
            <li>
              <NameBox start="" label="New sheet's name" done={(n) => (setTyping(null), n !== null && a.act((s) => s.createSheet(n, { pack: node.name })))} />
            </li>
          )}
          {empty && mine !== "newSheet" && mine !== "newPack" && <li className="muted small">Empty</li>}
          {node.packs.map((q) => (
            <li key={q.id} className="sub">
              <Pack node={q} parent={node.id} depth={depth + 1} tree={tree} siblings={node.packs} />
            </li>
          ))}
          {mine === "newPack" && (
            <li>
              <NameBox start="" label="New pack's name" done={(n) => (setTyping(null), n !== null && a.act((s) => s.createPack(n, node.name)))} />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function SheetRow({ sheet: s, pack, tree }: { sheet: SheetNode; pack: PackNode; tree: Tree }) {
  const { actions: a, typing: t, setTyping } = tree;
  const mine = t && "sheet" in t && t.sheet === s.id ? t.kind : null;
  const menu = a.sheets
    ? [
        { label: "Rename…", run: () => setTyping({ kind: "renameSheet", sheet: s.id, pack: pack.id }) },
        ...(tree.all.length > 1 ? [{ label: "Move to another pack…", run: () => setTyping({ kind: "moveSheet", sheet: s.id, pack: pack.id }) }] : []),
        ...order(pack.sheets.map((x) => x.name), s.name, (after) => a.act((x) => x.orderSheet(s.name, after, { pack: pack.name }))),
        {
          label: "Delete…",
          danger: true,
          run: () => {
            if (confirm(`Delete the sheet ${s.name}${s.rows ? `, with its ${plural(s.rows, "row")}` : ""}? Undo brings it back.`)) a.act((x) => x.deleteSheet(s.name, { pack: pack.name }));
          },
        },
      ]
    : [];
  const { dnd } = tree;
  const draggable = a.sheets && !mine;
  return (
    <li
      className={`tree-row${overClass(dnd.over, "sheet", s.id)}${dnd.drag?.kind === "sheet" && dnd.drag.id === s.id ? " dragging" : ""}`}
      draggable={draggable}
      onDragStart={draggable ? (e) => dnd.start({ kind: "sheet", id: s.id, pack: pack.id }, e, s.name) : undefined}
      onDragEnd={dnd.end}
      onDragOver={(e) => dnd.hover({ on: "sheet", id: s.id, where: half(e) }, e)}
      onDrop={(e) => dnd.over && dnd.over.on === "sheet" && dnd.over.id === s.id && dnd.drop(dnd.over, e)}
      title={draggable ? "Drag to reorder, or into another pack" : undefined}
    >
      {mine === "renameSheet" ? (
        <NameBox start={s.name} label="Sheet name" done={(n) => (setTyping(null), n !== null && a.act((x) => x.renameSheet(s.name, n, { pack: pack.name })))} />
      ) : (
        <a
          href={tree.href(s.id)}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            tree.open(s.id);
          }}
        >
          {s.name}
        </a>
      )}
      {s.kind === "scratch" && <span className="tag">scratch</span>}
      <span className="muted small">{plural(s.rows, "row")}</span>
      <Badges c={s} />
      {mine === "moveSheet" && (
        <MoveBox
          label={`Move ${s.name} into`}
          options={tree.all.filter((x) => x.id !== pack.id)}
          done={(to) => (setTyping(null), to !== null && a.act((x) => x.moveSheet(s.name, tree.name(to), { pack: pack.name })))}
        />
      )}
      {menu.length > 0 && <RowMenu label={`${s.name}: more`} items={menu} />}
    </li>
  );
}

/** A name typed in place: Enter keeps it, Escape or leaving the box doesn't. */
function NameBox(p: { start: string; label: string; done(name: string | null): void }) {
  const [v, setV] = useState(p.start);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="vf-input tree-input"
      value={v}
      aria-label={p.label}
      placeholder={p.label}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => p.done(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") p.done(v.trim() === "" || v.trim() === p.start ? null : v.trim());
        else if (e.key === "Escape") p.done(null);
      }}
    />
  );
}

/** The pack to move into, from a list. */
function MoveBox(p: { label: string; options: { id: string; name: string; depth: number }[]; done(to: string | null): void }) {
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <span className="tree-move">
      <span className="muted small">into</span>
      <select ref={ref} aria-label={p.label} defaultValue="" onChange={(e) => p.done(e.target.value || null)} onBlur={() => p.done(null)} onKeyDown={(e) => e.key === "Escape" && p.done(null)}>
        <option value="">Pick a pack</option>
        {p.options.map((o) => (
          <option key={o.id} value={o.id}>
            {"  ".repeat(o.depth)}
            {o.name}
          </option>
        ))}
      </select>
    </span>
  );
}

/** "Move up" and "Move down" among siblings, where it can go that way. */
function order(names: string[], me: string, go: (after: string | null) => void): MenuItem[] {
  const i = names.indexOf(me);
  const out: MenuItem[] = [];
  const up = neighbour(names, i, true);
  const down = neighbour(names, i, false);
  if (up !== undefined) out.push({ label: "Move up", run: () => go(up) });
  if (down !== undefined) out.push({ label: "Move down", run: () => go(down) });
  return out;
}

interface MenuItem {
  label: string;
  run(): void;
  danger?: boolean;
}

/** A ⋯ button with a short menu under it. */
function RowMenu(p: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("mousedown", away);
    addEventListener("keydown", esc);
    return () => {
      removeEventListener("mousedown", away);
      removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <span className="row-menu" ref={ref}>
      <button className="button quiet small row-menu-button" aria-label={p.label} aria-expanded={open} title="More" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <span className="menu-list row-menu-list" role="menu">
          {p.items.map((x) => (
            <button key={x.label} role="menuitem" className={x.danger ? "danger" : undefined} onClick={() => (setOpen(false), x.run())}>
              {x.label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

export function Badges({ c }: { c: Counts }) {
  return (
    <>
      {c.errors > 0 && <span className="badge error">{plural(c.errors, "error")}</span>}
      {c.warnings > 0 && <span className="badge warn">{plural(c.warnings, "warning")}</span>}
    </>
  );
}
