# Lane view clips: how they are made

Two clips of Storm's lane view (omp's live widget below the editor) playing a scripted run. Every row of every frame
is what the real widget returned, and every stage picture is the one the product encodes; only the step from terminal
cells to pixels is done here.

| File | Shown by | What it is |
|---|---|---|
| `../lane-view-stage.webp` | README of `main` from 0.32.0 | 120 columns: the animal stage (as an image, T1) beside the lane graph |
| `../lane-view.webp` | README of 0.31.x (kept as it is) | 80 columns: the lane graph alone (no stage at that width) |

```
repo (omp-storm, main)               this folder
scripts/lane-clip.ts  ──frames.json──▶  render.mjs ──PNG per frame──▶ img2webp ──▶ lane-view-stage.webp
(real LiveStatus widget,              (cells to pixels, the stage                 stills.mjs (look at the result)
 the stage's T1 picture)               PNG scaled into its cells)
```

## Remake

Needs node, the repository's `bun` (`node_modules/.bin/bun`), `img2webp` and `webpmux` (libwebp tools), and macOS fonts
(Menlo, Apple SD Gothic Neo, Apple Color Emoji). The one npm package, `@napi-rs/canvas`, goes into a work folder, never
into the repository.

```sh
REPO=/path/to/omp-storm            # a checkout of main
LV=/path/to/assets-checkout/lane-view   # this folder
WORK=$(mktemp -d) && cd "$WORK" && npm init -y >/dev/null && npm install @napi-rs/canvas

# 1. Play the run through the real widget (120 columns, 85 ms ticks) and keep its rows and the stage's pictures.
#    It prints which species the stage showed from when.
(cd "$REPO" && node_modules/.bin/bun scripts/lane-clip.ts --out "$WORK/frames.json")

# 2. Draw the frames and encode them (about 2 min; the content dips to the background at the loop seam so it does not jump).
node "$LV/render.mjs" --frames frames.json --out lane-view-stage.webp --cell 14 --quality 62
#    one frame as a PNG, to look at: node "$LV/render.mjs" --frames frames.json --still 9500 --out still.png --width 850 --cell 14

# 3. Cut stills from the finished file at the size GitHub shows (850 px) and look at them.
node "$LV/stills.mjs" lane-view-stage.webp stills 1200 3500 6500 9500 12500 15500
```

`--cell 14` draws 14 px cells: 1722 px for 120 columns, twice the 850 px GitHub shows, so the picture stays sharp on a
high-density screen. Quality 62 keeps the file under 3 MB (the stage moves in every frame); at 72 it is 3.3 MB and looks
the same at the size shown. The old clip is remade the same way with `--story lanes` in step 1 and `--cell 16 --quality
72`, out `lane-view.webp`, in step 2 (stills at 600 2600 4500 5300 7000 9100 11900 13600).

The frames come out the same whatever `COLORTERM` says: the widget draws in true colour with omp's default dark theme.

## The stage in the frames

The test host draws no images, so in its rows the widget puts the stage's text tier (braille) where a terminal with
images shows a picture. For every frame the script also asks the product for the T1 picture of the same snapshot at the
same moment (`stagePicture`, then `encodeStageFrame`: the 256-colour indexed PNG the image channel sends, 9 x 18 px per
cell) and writes it with the cells it covers: `stage: { png, column, row, columns, rows, phrase }`, rows counted from the
widget's status row. `render.mjs` skips the text cells in that box and draws the PNG scaled into it with smoothing on, as
a terminal scales an inline image to its cells (here 14 x 27 px cells, so the picture stretches a little in width, as
it would in a terminal whose cells are not exactly 1:2). The phrase row under the box (`개미 · 하나씩 처리하는 중`) is
text in the product too and is drawn as text.

At 120 columns the stage takes 36 columns (30 percent, within 28 to 48) and the graph 83; the view is 7 rows (the trunk
and six lanes), so the picture is 36 x 6 cells (324 x 108 px) over its phrase row.

## What the stage clip shows

`--story stage` in `scripts/lane-clip.ts`, about 17 s of watching, one loop. The director plans six lanes and the stage
plays its species as the record changes; every switch is a full handoff (each species stands over 3 s of run time):

| Story time | Species | Why (the record) |
|---|---|---|
| 0 to 2.3 s | starlings, `팀을 모으는 중` | the start, and the plan landing at 0.6 s, gather the team |
| 2.3 to 4.7 s | bees, `여러 갈래 조사 중` | only the two read lanes (`구조-탐색`, `자료-조사`) run |
| 4.7 to 8.1 s | octopus, `일을 나눠 맡기는 중` | two writers with file lists join the readers: one arm per lane |
| 8.1 to 11.0 s | ants, `하나씩 처리하는 중` | `설정-이전` (a writer without a file list) works alone and `문서` waits its turn |
| 11.0 to 14.3 s | orcas, `검토하는 중` | the reviewer judges every submitted lane; `문서` runs and submits meanwhile, accepted lanes join the trunk |
| 14.3 s to the end | orcas, `마무리 중` | every result is accepted: the orcas' finale, the trunk's rainbow |

Two clocks: the run the widget sees lasts 26.1 s (`runPerStory: 1.5`: the fake clock moves 1.5 x 85 ms per frame), so
on the view's 30 s time axis the lanes are long lines. The view picks its axis as the smallest of 30, 45, 60 ... s that
is 8 percent longer than the run, so keep the run under 27.7 s or the axis rescales mid-clip. The animation clock (the
flowing light, the creatures' loops) is put back to story pace by spies on `laneFrame` and `laneViewFrame` that replace
their `t` argument; what the product times in run time (a join's burst, the stage's handoffs, acts, gathering and
finale) plays 1.5 x faster than in a live run.

The scenario is a `RunRecord` that changes with a fake clock and is handed to `LiveStatus.show` like the controller
does, so the status row on top (phase, focus result, `이행 n/m`, round, workers, cost) is the widget's own too. The
elapsed-time chip shows `0분`; the run is compressed into the clip.

## What the lanes clip shows

`--story lanes` (`lane-view.webp`, 80 columns): the director plans five lanes, they start one by one, `테스트` waits for
`구조-탐색` to submit, `구조-탐색` is reviewed and joins the trunk, `API-구현` is judged unmet on one of its two results
and runs again in round two, and when every result is accepted the trunk runs its rainbow. About 14 s to watch, a run
of 27.4 s (`runPerStory: 1.9`). The scenario has no round cap and no budget, so the status row shows the round count
alone (`↻ 2`) and the cost without a limit.

## When the view changes

Re-run the three steps. If the scenario no longer fits (a state was added, a label changed, a species' rule moved),
edit the story's `lanes`, `reviewing` and `phases` tables in the script and check the species list it prints. If the
glyph set changes, `render.mjs` complains about colour codes it does not know (it understands reset, bold and 38;2
only) and draws every other glyph as text, Braille as dots.
