// ID suggestions under a text box (DESIGN §5.3, §9.3): as an ID is typed where a ref goes,
// the IDs it may point at are listed, best first. ↑ and ↓ move through them, Enter or Tab
// puts one in, Escape closes the list, and ↓ opens it on an empty box. Used by the panel,
// the formula bar, and the cell editor for ref cells (RefCellEditor, through Glide).

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ProvideEditorComponent, TextCell } from "@glideapps/glide-data-grid";
import type { Project } from "@thek42/sapwood-core";
import { candidates, complete, suggest, tokenAt, type RefTarget } from "./suggest.ts";

interface Options {
  project: Project;
  target: RefTarget | null;
  text: string;
  input: RefObject<HTMLInputElement | null>;
  /** Put this text in the box, with the caret here. */
  set(text: string, caret: number): void;
  /** Open from the start, with the caret here: an editor that typing began. */
  openAt?: number | undefined;
}

export interface Suggesting {
  /** Call from the box's keydown first; true when it used the key. */
  onKeyDown(e: KeyboardEvent<HTMLInputElement>): boolean;
  /** Call when the text changes by typing, to look again. */
  typed(): void;
  close(): void;
  /** The list, when open. */
  list: React.ReactNode;
}

export function useSuggest(o: Options): Suggesting {
  const [caret, setCaret] = useState<number | null>(o.openAt ?? null); // null: closed
  const [hi, setHi] = useState(0);
  const key = o.target ? `${o.target.from}|${o.target.reach ?? ""}|${JSON.stringify(o.target.targets)}` : "";
  const all = useMemo(() => (o.target ? candidates(o.project, o.target) : []), [o.project, key]);
  const tok = o.target && caret !== null ? tokenAt(o.text, caret, o.target.list) : null;
  // An ID typed in full needs nothing more, so Enter writes it rather than picking another.
  const items = tok && !all.some((c) => c.id === tok.prefix) ? suggest(all, tok.prefix) : [];
  const open = items.length > 0;
  useEffect(() => setHi(0), [tok?.prefix]);

  const pick = (i: number) => {
    const c = items[i];
    // Where the caret is now, in case it moved since the list was drawn.
    const at = o.input.current?.selectionStart ?? caret;
    const t = o.target && at !== null ? tokenAt(o.text, at, o.target.list) : tok;
    if (!c || !t) return;
    const r = complete(o.text, t, c.id);
    o.set(r.text, r.caret);
    setCaret(null);
    requestAnimationFrame(() => o.input.current?.setSelectionRange(r.caret, r.caret));
  };

  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !o.input.current) return setPos(null);
    const r = o.input.current.getBoundingClientRect();
    setPos({ left: r.left, top: r.bottom + 2, width: r.width });
  }, [open, o.text]);

  return {
    onKeyDown(e) {
      if (!o.target) return false;
      if (!open) {
        if (e.key === "ArrowDown" && !e.altKey) {
          setCaret(o.input.current?.selectionStart ?? o.text.length);
          e.preventDefault();
          e.stopPropagation();
          return true;
        }
        return false;
      }
      const stop = () => (e.preventDefault(), e.stopPropagation(), true);
      if (e.key === "ArrowDown") return setHi((h) => (h + 1) % items.length), stop();
      if (e.key === "ArrowUp") return setHi((h) => (h - 1 + items.length) % items.length), stop();
      if (e.key === "Enter" || e.key === "Tab") return pick(hi), stop();
      if (e.key === "Escape") return setCaret(null), stop();
      return false;
    },
    typed() {
      // Read now: by the time of a frame, more keys may have come.
      setCaret(o.input.current?.selectionStart ?? null);
    },
    close() {
      setCaret(null);
    },
    // On the page itself: inside Glide's cell editor it would be clipped. Glide leaves the
    // editor open for a click on it (click-outside-ignore).
    list:
      open && pos ? createPortal(
        <ul className="suggest click-outside-ignore" role="listbox" style={{ left: pos.left, top: pos.top, minWidth: Math.max(220, pos.width) }}>
          {items.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === hi}
              className={i === hi ? "on" : ""}
              onMouseDown={(e) => (e.preventDefault(), pick(i))}
              onMouseEnter={() => setHi(i)}
            >
              <span className="suggest-id">{c.id}</span>
              <span className="muted small">
                {c.type} · {c.where}
              </span>
            </li>
          ))}
        </ul>,
        document.body,
      ) : null,
  };
}

/** What the cell being edited accepts, set by the view as Glide asks for an editor. */
export const RefEditorContext = createContext<{ current: { project: Project; target: RefTarget } | null }>({ current: null });

/** Glide's cell editor for a ref cell: a text box with ID suggestions. */
export const RefCellEditor: ProvideEditorComponent<TextCell> = (p) => {
  const ctx = useContext(RefEditorContext).current;
  const [text, setText] = useState(p.initialValue ?? p.value.data);
  const input = useRef<HTMLInputElement>(null);
  const write = (t: string) => {
    setText(t);
    p.onChange({ ...p.value, data: t });
  };
  const s = useSuggest({
    project: ctx!.project,
    target: ctx?.target ?? null,
    text,
    input,
    set: (t) => write(t),
    openAt: p.initialValue !== undefined ? text.length : undefined,
  });
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    // Typing began the edit (the list is open for it already): Glide gets the text too.
    if (p.initialValue !== undefined) p.onChange({ ...p.value, data: p.initialValue });
  }, []);
  return (
    <>
      <input
        ref={input}
        className="ref-editor"
        value={text}
        spellCheck={false}
        onChange={(e) => (write(e.target.value), s.typed())}
        onKeyDown={(e) => {
          s.onKeyDown(e);
        }}
        onClick={() => s.typed()}
        onBlur={s.close}
      />
      {s.list}
    </>
  );
};
