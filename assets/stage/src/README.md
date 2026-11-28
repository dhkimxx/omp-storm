# Stage art sources

Key-pose SVGs and sequence specs for the stage (docs/stage.md). `scripts/stage/bake.ts` turns them into the sprite
sheets and `assets/stage/index.json` (format `storm.stage-assets/v1`) that the renderer loads.

## Bake

```sh
bun scripts/stage/bake.ts                                            # full bake: every species, writes index.json and sheets
bun scripts/stage/bake.ts --check                                    # no rendering: is index.json baked from the current sources?
bun scripts/stage/bake.ts --contact /tmp/stage                       # full bake plus contact sheets
bun scripts/stage/bake.ts --only octopus --no-write --contact /tmp/oc  # one species, contact sheets only, writes nothing
```

- `--check` (run by `npm run verify`, so CI fails on stale art) recomputes each sequence's source hash (its JSON and key
  SVGs) and the bake tool's (bake.ts, png.ts, resvg version) and compares them with index.json, without rendering. It
  fails naming every sequence whose sources changed, appeared unbaked or disappeared, every missing sheet, and a changed
  bake tool. After changing sources (or bake.ts), run the full bake and commit the sources, sheets and index.json together.
- `--only SPECIES` bakes `src/SPECIES/` only and needs `--no-write` (index.json lists every species, so a partial bake
  never writes).
- `--contact DIR` writes `<species>-<actor>-<name>.png` (every frame, T1 at 2x then T2) and `<species>-<actor>.png` (one
  row per sequence, sampled frames, T1 left and T2 right), tinted the way the renderer tints. Read them as images.
- The bake prints each sequence's size and fails past the caps: 96 KiB per sequence (T1 + T2 + accent sheets),
  4 MiB for everything that ships (index.json and all sheets; `src/` is left out of the package). Same sources give
  the same bytes.
- **Budget: aim for at most 600 KiB of baked sheets per species** (sum the sizes the bake prints). Five species and
  their backgrounds share the 4 MiB. Slow or nearly still sequences (3.4 s breathing loops, long fades) need few frames:
  raise their `frameMs` (170–250) rather than baking frames that barely differ.

## Layout

`src/<species>/<actor>/<name>.json`, its key SVGs beside it. `<actor>` is `director`, `worker` or `fx`. Sequence names
are the renderer's poses: `ready`, `work`, `quiet`, `submit`, `review`, `accepted`, `unmet`, `blocked`, `excluded`,
`rest`, `waiting-user`, `finale`, `lights-out`, `gather`; workers also play `user-steer` and `user-stop`; `fx/background`
is the species' backdrop. A species handoff plays the leaving species' `excluded` and the arriving one's `gather`.

```json
{
	"w": 36, "h": 45,
	"anchor": { "x": 0, "y": 32 },
	"frameMs": 83,
	"durationMs": 2000,
	"loop": true,
	"keys": [
		{ "at": 0, "svg": "work.a.svg" },
		{ "at": 500, "svg": "work.b.svg", "ease": "out" },
		{ "at": 2000, "svg": "work.a.svg" }
	]
}
```

- `w`, `h`: T1 pixels, multiples of 9 (a cell is 9x18 T1 px; a T2 pixel is half a cell, 9x9). The SVG's own `width`
  and `height` must match.
- `anchor`: the pixel that sits on the individual's position in the scene.
- Keys: the first at 0, the last at `durationMs`, in order. `ease` belongs to the arriving key: `linear`, `in`, `out`,
  `inOut` (default, cubic).
- Frames: a loop has `round(durationMs / frameMs)` frames sampled over `[0, durationMs)`, so its last key should look like
  its first. A one-shot has one more, the last at `durationMs`, which the renderer holds. 12 fps is `frameMs: 83`; slow
  breathing loops and fades use fewer frames (170–330), a still pose one frame (`frameMs` = `durationMs`).

## Drawing rules

- **Only numbers move.** Each key SVG is split into numbers and the text between them; every key of a sequence must have
  the same text, number for number. The bake fails naming the file, line and column where they differ. Keep element
  order, attributes and path commands identical; hide parts with `opacity="0"` rather than leaving them out.
- **Grey is light.** Draw in greys: the sheet keeps luminance and alpha, and the renderer tints with the lane's colour
  (the director's: ice blue). White is the hottest light, black an opaque shadow. resvg ignores decimal `rgb(127.5,…)`;
  write greys as percentages, `rgb(42.5%,42.5%,42.5%)`. Avoid hex colours (their digits are tokenised as numbers).
- **Accent layer.** A top-level `<g id="accent">` (a direct child of `<svg>`, drawn last) becomes a separate layer that
  the renderer paints in the state's fixed colour: amber for `waiting-user`, red for a blocked edge, green for the accept
  flash, white-hot otherwise. Its contents may use anything in `<defs>`. Sequences whose accent is empty in every frame
  ship without one.
- **Look.** Luminous creatures on a dark stage: layered strokes and `feGaussianBlur` glows, readable silhouettes. Check the
  T2 column of the contact sheet: each block is one half cell, so features under ~9 px blur into their neighbours.
- Filters: give them `filterUnits="userSpaceOnUse"` regions that cover the box plus the blur, or glows clip.
- `fx/background`: a loop, 432x90 T1 px (48 cells x 5 rows); the renderer crops it from the left to the stage width and
  puts it at the bottom. Dark and low contrast, quieter than any individual. Mind the 96 KiB cap: few frames, slow
  `frameMs`.

## 종별 생성기

Species whose sources are generated: edit the generator, rerun it (it rewrites `src/<species>/` from scratch), then bake.

- octopus: `bun scripts/stage/art/octopus.ts` (director, worker and `fx/background`)
- orca: `bun scripts/stage/art/orca.ts`
- owl, starling: `bun scripts/stage/art/owl-starling/gen.ts` (`gen.ts work,rest` redoes only those owl director
  sequences; `peek.ts OUT.png ZOOM KEY.svg…` previews keys zoomed)
- ant: `bun scripts/stage/art/ant.ts` (director, worker and `fx/background`; `ant.ts worker/work,fx/background` redoes
  only those sequences)
- bee: `bun scripts/stage/art/bee.ts` (director, worker and `fx/background`)
