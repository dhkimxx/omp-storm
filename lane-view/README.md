# lane-view.webp: how it is made

`../lane-view.webp` is Storm's lane view (omp's live widget below the editor) playing a scripted run. Every row of every
frame is what the real widget returned; only the step from terminal cells to pixels is done here.

```
repo (omp-storm, main)               this folder
scripts/lane-clip.ts  ──frames.json──▶  render.mjs ──PNG per frame──▶ img2webp ──▶ lane-view.webp
(real LiveStatus widget)              (cells to pixels)                          stills.mjs (look at the result)
```

## Remake

Needs node, the repository's `bun` (`node_modules/.bin/bun`), `img2webp` and `webpmux` (libwebp tools), and macOS fonts
(Menlo, Apple SD Gothic Neo, Apple Color Emoji). The one npm package, `@napi-rs/canvas`, goes into a work folder, never
into the repository.

```sh
REPO=/path/to/omp-storm            # a checkout of main
LV=/path/to/assets-checkout/lane-view   # this folder
WORK=$(mktemp -d) && cd "$WORK" && npm init -y >/dev/null && npm install @napi-rs/canvas

# 1. Play the run through the real widget (80 columns, 85 ms ticks; the run is 1.9x longer than the story) and keep its rows.
(cd "$REPO" && node_modules/.bin/bun scripts/lane-clip.ts --out "$WORK/frames.json")

# 2. Draw the frames and encode them (about 100 s; the content dips to the background at the loop seam so it does not jump).
node "$LV/render.mjs" --frames frames.json --out lane-view.webp --quality 72
#    one frame as a PNG, to look at: node "$LV/render.mjs" --frames frames.json --still 9000 --out still.png --width 850

# 3. Cut stills from the finished file at the size GitHub shows (850 px) and look at them.
node "$LV/stills.mjs" lane-view.webp stills 600 2600 4500 5300 7000 9100 11900 13600
```

The frames come out the same whatever `COLORTERM` says: the widget draws in true colour with omp's default dark theme.

## What the clip shows

A new scenario written for the README (`scripts/lane-clip.ts`; the three in `scripts/lane-preview-scenario.ts` are
a way to look at the renderer, not a story): the director plans five lanes, they start one by one, `테스트` waits for
`구조-탐색` to submit, `구조-탐색` is reviewed and joins the trunk, `API-구현` is judged unmet on one of its two results
and runs again in round two, and when every result is accepted the trunk runs its rainbow. About 14 s to watch, one loop.

Two clocks: the run the widget sees lasts 27.4 s (`RUN_PER_STORY = 1.9` in the script: the fake clock moves 1.9 x 85 ms per
frame), so on the view's 30 s time axis the lanes are long lines and the trunk ends at about 91 percent of the width. The
view picks its axis as the smallest of 30, 45, 60 ... s that is 8 percent longer than the run, so keep the run under
27.7 s or the axis rescales mid-clip. The animation clock (the flowing light) is put back to story pace by a spy on
`laneFrame` that replaces its `t` argument; effects the renderer times in run time (a join's burst, the retry bounce, the
finale's front) play 1.9 x faster than in a live run. The scenario has no round cap and no budget, the defaults, so the
status row shows the round count alone (`↻ 2`) and the cost without a limit.

The scenario is a `RunRecord` that changes with a fake clock and is handed to `LiveStatus.show` like the controller
does, so the status row on top (phase, focus result, `이행 n/m`, round, workers, cost) is the widget's own too. The
elapsed-time chip shows `0분` or is dropped for width; the run is compressed into 14 seconds.

## When the view changes

Re-run the three steps. If the scenario no longer fits (a state was added, a label changed), edit the script's `LANES`,
`REVIEWING` and `PHASES` tables. If the glyph set changes, `render.mjs` complains about colour codes it does not know
(it understands reset, bold and 38;2 only) and draws every other glyph as text, Braille as dots.
