// The pack tree on the home page (DESIGN §7.1, §9.1): packs with their sheets and sub-packs,
// each with its validation badges. Each pack and sheet has a ⋯ menu: a new sheet or pack in
// it, rename, or move to another pack. Sheets are an Editor's to make, rename and move; packs
// a Developer's (§11.2). Names are typed in place: Enter to keep, Escape to leave it.

import { useEffect, useRef, useState } from "react";
import type { Change, Sapwood } from "@thek42/sapwood-core";
import type { Counts, PackNode, SheetNode } from "./home.ts";
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
  return <Pack node={p.root} parent={null} depth={0} tree={{ ...p, typing, setTyping, all, name }} />;
}

interface Tree extends Props {
  typing: Typing;
  setTyping(t: Typing): void;
  all: { id: string; name: string; depth: number; inside: Set<string> }[];
  name(id: string): string;
}

function Pack({ node, parent, depth, tree }: { node: PackNode; parent: string | null; depth: number; tree: Tree }) {
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
  ];
  return (
    <div className="pack" style={{ marginLeft: isRoot ? 0 : 14 }}>
      <div className="tree-row">
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
              <Pack node={q} parent={node.id} depth={depth + 1} tree={tree} />
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
      ]
    : [];
  return (
    <li className="tree-row">
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

/** A ⋯ button with a short menu under it. */
function RowMenu(p: { label: string; items: { label: string; run(): void }[] }) {
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
            <button key={x.label} role="menuitem" onClick={() => (setOpen(false), x.run())}>
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
