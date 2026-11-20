# Spike S2: grid component

Throwaway prototype. The write-up and decision are in [docs/spikes/S2-grid-component.md](../../docs/spikes/S2-grid-component.md).

```bash
npm run dev -w @sapwood/spike-s2-grid      # then open http://localhost:5180
node spikes/s2-grid/src/model-check.ts     # the shared model on its own, in Node (N=rows)
```

Pages:

- `glide.html`: Glide Data Grid.
- `univer.html`: Univer.

Both accept `?rows=N` (default 100000). Run the "Scroll test" button with the page visible: browsers throttle background tabs.

Things to try in the showcase rows at the top:

- Edit C2, the ID prefix. It renames `mk_blaster`, and the rifle's `ENTITY("mk_blaster")` drops to `#REF!`.
- Undo with Ctrl+Z.
- Hover a red outline to see its message.
- Move the cursor between Weapon and Projectile rows. The sticky header follows.
- Copy cells, then paste them into Google Sheets or Excel, and the other way round.
