# L0 spike: Storm lane view prototype

A throwaway prototype of the Storm lane view (the director's trunk and one branch per plan lane, drawn like a git
graph below the omp editor) in three visual variants, plus the facts about omp that decide how tall, how fast and how
colourful such a widget can be. Nothing under `src/` changes.

Contracts: `/tmp/storm-laneview-contract.md` (state language, shared model) and `/tmp/storm-laneview-v2-contract.md` (the
storm variant). The variants are `box/frame.ts` (box-drawing glyphs), `braille/frame.ts` (Braille dot canvas) and
`storm/frame.ts` (a new take on the Braille canvas, true colour, the one the user asked for after watching the first two:
"flashy is good, rainbow and moving gradients welcome"); all export `frame: Frame` from `model.ts`. Start with
[The storm variant](#the-storm-variant); the box/braille comparison and the host findings further down are from the first round.

## Files

| File | What it is |
|---|---|
| `model.ts` | The shared types (`RunSnapshot`, `Lane`, `Tone`, `Frame`, ...). |
| `scenario.ts` | A scripted 60 s run that loops: all six phases, all eleven lane states, a job lane, a dependency wait, an unmet-then-retry lane, a blocked lane, a user exclusion, two round boundaries. `snapshotAt(t)` cuts it the way a live run would see it. |
| `palette.ts` | `paint` for a plain terminal (`plainPaint`: truecolor, 256 colours or none; `detectColorDepth`) and from an omp theme (`themePaint`). |
| `play.ts` | The plain terminal player. Also exports `loadFrame` and `placeholderFrame`, which the extension reuses. |
| `extension.ts` | The omp demo extension: `/laneview box\|braille\|storm\|off [rows] [tickMs] [full\|happy\|crowd]`. `fill` is a measurement frame, not a design. The view is padded to exactly `rows` rows (default 8) so its height never changes. |
| `storm/` | The storm variant: `colour.ts` (OKLCH, mixing, lane hues), `canvas.ts` (Braille canvas with colour and energy), `scene.ts` + `layout.ts` (strands, marks, labels from a snapshot), `effects.ts` (every effect), `frame.ts` (glue), `DESIGN.md` (every number). |
| `stills/` | PNG pictures of the storm variant (`<scenario>-<moment>-<columns>-<dark or light>.png`), made with `play.ts --svg`. Generated locally; git ignores this folder. |
| `STILLS.md` | Text stills (no colour) of both variants at five moments: workers running, a lane joining the trunk, review, waiting for the user, stopping. |

## Watch it (run from the repository root, `/Users/dhkim/orca/omp-storm`)

Each variant has two commands: one for a plain terminal, one inside omp. Use a terminal at least 100 columns wide and
12 rows tall, in colour (truecolor shows the most). The scenario is a 60 s loop; Ctrl+C leaves the player, `/quit` leaves omp.

| Variant | Plain terminal | Inside omp (mounted below the editor) |
|---|---|---|
| box | `node_modules/.bin/bun spikes/l0/play.ts --variant box` | `node_modules/.bin/omp -e spikes/l0/extension.ts "/laneview box"` |
| braille | `node_modules/.bin/bun spikes/l0/play.ts --variant braille` | `node_modules/.bin/omp -e spikes/l0/extension.ts "/laneview braille"` |
| **storm** | `node_modules/.bin/bun spikes/l0/play.ts --variant storm --rows 12` | `node_modules/.bin/omp -e spikes/l0/extension.ts "/laneview storm 12"` |

The omp command starts your normal omp profile and runs the slash command as its first input, so no model call is made.
Typing `/laneview box`, `/laneview braille` or `/laneview off` in a running omp does the same and switches variant.

More switches:

```sh
node_modules/.bin/bun spikes/l0/play.ts --variant box --ascii --no-motion --speed 2   # ASCII glyphs, no motion, twice as fast
node_modules/.bin/bun spikes/l0/play.ts --variant braille --width 80 --rows 12        # fixed width, up to 12 rows
node_modules/.bin/bun spikes/l0/play.ts --variant braille --still 31000               # one frame, no colour codes, then exit
node_modules/.bin/omp -e spikes/l0/extension.ts --motion none "/laneview box"         # omp's motion off: states advance once a second
```

`--width N` fixes the width (default: the terminal's), `--rows N` is `maxRows` (default 10), `--speed X` plays the
scenario X times faster, `--still MS` prints the frame at scenario time MS. The player redraws in place at 85 ms, hides
the cursor and restores it on exit. Colour: truecolor when `COLORTERM` says so, 256 colours otherwise, none when stdout is
not a TTY or `NO_COLOR` is set. In omp, `/laneview box 12` sets the height (default 8, always held fixed) and
`/laneview box 12 120` also the redraw period in ms (default 85). The colours come from the active theme (`/settings`).

## The storm variant

Watch it (repository root; 120 columns or more and a true-colour terminal show it best, 12 rows tall for the crowd):

```sh
node_modules/.bin/bun spikes/l0/play.ts --variant storm --scenario full --rows 12     # plain terminal; scenarios: full (60 s), happy (finale), crowd (12 lanes)
node_modules/.bin/bun spikes/l0/play.ts --variant storm --scenario crowd --light      # for a light terminal background
node_modules/.bin/bun spikes/l0/play.ts --variant storm --colour 256                  # force 256 colours (or tones, truecolor)
node_modules/.bin/bun spikes/l0/play.ts --variant storm --still 24300 --svg /tmp/f.svg # one frame as a picture; the player prints the PNG commands (qlmanage, sips)
node_modules/.bin/omp -e spikes/l0/extension.ts "/laneview storm 12 85 crowd"          # inside omp: /laneview storm|box|braille|off [rows] [tickMs] [full|happy|crowd]
```

Inside omp the colours follow the theme's colour mode (true colour or 256) and light or dark. `--motion none` draws the same
picture still, with its colours. Below 60 columns or with ASCII symbols it falls back to the first Braille variant.

### What each effect means

One rule: **motion and brightness mean work happening now; an event gets one burst; a wait is still.**

| You see | It means |
|---|---|
| Each lane has its own hue (golden angle around the colour wheel); the name at the left takes it | which lane is which, however many there are |
| A lane's hue drifts and bright lumps ("comets") run along it toward the head | the worker is running; more lumps and faster flow = more activity |
| A thin solid line drops from the trunk (shared by lanes that start together) and each lane peels off to its own row | a lane starts; the graph rake |
| A short spray at the tip of a new curve | a lane just started (0.6 s) |
| The trunk is a rolling aurora wave with a bright head sweeping right | phase working (진행 중) |
| The trunk calms and breathes | workers are running (워커 작업 중) |
| A white-to-green band travels back and forth on the trunk and on double-railed lanes ending in a green `◆` | verification, lanes under review (검증 중, 검토 중) |
| The lane's light is drawn up into the trunk, a white flash spreads along the trunk, sparks fall below the join, a green `●` stays; the lane turns a pale tint of its own hue and its hue becomes one band of the trunk | a result was accepted (1.3 s). The trunk rainbow is the progress of the run: one colour at the start, a full flowing rainbow when all is accepted |
| A zigzag white-then-red bolt from the trunk to a red `✕`; then dim red | a lane is blocked (0.5 s) |
| Light recoils once from a hollow `○`, then flows forward again | unmet, retried (0.6 s) |
| A vertical bar of light sweeps the view and stamps the round number on the trunk | a new round (0.8 s) |
| Faint slanted streaks between the lanes and past the heads, tinted by the nearest running lane | two or more lanes are running; denser with more work |
| Colour drains from everything over half a second and the picture stops; only an amber `█` at the trunk head pulses slowly | the run waits for the user (응답 대기) |
| Still and dimmed | between rounds (다음 라운드 대기) |
| A rainbow wave runs the trunk, the lanes flash top to bottom, then a calm picture | finale: everything in scope accepted (종료 정리 중) |
| Colour goes out from the left, lanes go dark one by one, red marks stay | stopping with work left over (lights out) |
| Dotted = reserved, sparse dots plus a dotted link = waiting for another lane, thin and dim = idle, dotted with `⊘` = excluded, squares `■`/`□` filling in turn = a job lane running | lane states without motion |

Colour is never the only signal: shape (dotted, double rail, thickness, node glyphs) and brightness carry the state too.
Three colours keep one meaning: green acceptance, amber waiting for the user, red blocked.

### Pictures

`stills/` (generated locally, ignored by git) holds 35 PNGs at 80, 120 and 160 columns, dark and light background: workers running, a branch growing, the bolt,
review scan, merge burst, freeze, dim wait, round wipe, second verification, finale and settled finale, the crowd's shared
stems, its folding and joins, and lights out. The name is `<scenario>-<moment>-<columns>-<dark|light>.png`. A still cannot show
motion; the PNG is made through macOS `qlmanage`, which draws every Braille cell as a 2 by 4 dot pattern, so dim dots look
smaller there than in a terminal.

### Measured (E4)

Mounted below the editor in a real omp on a pty (isolated HOME, offline fake provider, screen read back with pyte):

| omp | terminal | view | editor | result |
|---|---|---|---|---|
| 19.0.1 (pinned) | 120 x 40 | storm, 10 rows, full | typed text visible | the editor's bottom row stayed on one row for 25 s; the first trunk row is the row right under it; widest row 120 |
| 19.0.1 | 160 x 50 | storm, 12 rows, crowd | same | same, widest 160 |
| 19.1.1 (temp prefix, `--ignore-scripts`) | 120 x 40 | storm, 10 rows, full | same | same |
| 19.1.1 | 80 x 30 | storm, 8 rows, crowd | same | same, widest 80 |
| 19.1.1 | 100 x 30 | storm, 8 rows, happy, `--motion none` | same | same |

The widget keeps a fixed height (the extension pads to `rows`), sits directly under the editor, and typing worked while it
animated. In a plain terminal all three variants play with no error. Sweep of 94,416 storm frames (three scenarios, 40 to 200
columns, `maxRows` 3 to 12, motion on and off, truecolor, 256 and tones, dark and light): no exception, no row wider than the
columns, no more rows than `maxRows`.

Cost at 120 columns, 12 rows, crowd scenario, whole omp process, 30 s after 5 s of warm-up, `ps` cputime on a busy laptop
(other omp sessions and a browser running, so read it as plus or minus 2 points; two runs each):

| tick | CPU, % of one core | bytes written to the terminal | frames/s |
|---|---|---|---|
| no widget (idle omp) | 3.3, 2.8 | 0 | 0 |
| 120 ms | 6.0, 5.9 | 52 KB/s | 8 |
| 85 ms | 11.0 (outlier), 5.9 | 72 KB/s | 12 |
| 50 ms | 9.9, 7.3 | 122 KB/s | 20 |

`frame()` itself costs 0.9 ms (120 columns, 12 rows; 0.5 ms with 7 rows, 1.0 ms at 160 columns). A full frame is 5.9 KB median,
8.6 KB at most at 120 columns in the crowd (4.5 KB at 80, 7.5 KB at 160; 3.5 KB for the six-lane scenario); omp rewrites changed
rows only, so a quiet phase writes less.

**Recommended tick: 85 ms** (the radar's own tick, about 12 frames/s): 3 points over idle, 70 KB/s. 50 ms costs 70 percent more
bytes for a smoothness the 2 by 4 dot grid barely shows; 120 ms halves the traffic but the comets start to step (they move
3 to 8 dots per frame). Use 120 ms only over a slow link. A tick of 33 ms would hit omp's own `tui.maxFps` cap (30) anyway.

## The two variants compared (first round)

The user watched box and braille and chose Braille; the recommendation below was written before that choice.


Both draw the same state language from the same snapshot, so the difference is only the drawing. Stills of both are in
`STILLS.md`. I (the integrating worker) watched them as text and as screen dumps in a pty, not by eye in colour, so the
colour and motion judgments below are from the frame data and the other workers' tone dumps; the feel needs a human look
at the four commands above.

| | box | braille |
|---|---|---|
| Look | crisp git graph: heavy trunk, rounded corners, `├ ┤ ┼ ┴`, double lines, round and square nodes | dot-drawn S-curves out of and into the trunk, thick/thin flowing light, a sine for the radar's wind |
| Motion | colour only, one cell per step; pulses jump a cell | colour plus thickness (2 to 4 dot rows), half-cell glide, a real sine; but one colour per cell, so a bright pulse recolours its whole cell |
| Readable without colour | yes: head glyph (`▸ • ◆ █`), line style, node shape and the state word each carry the state | mostly: thickness, rails and nodes carry it, but the 4 by 4 dot nodes (ring, disc, slashed circle) are small and font dependent |
| Time axis | 1 column = 1 s, then the old history is squeezed into 40 % with an unmarked seam | span steps (30 s, 1 m, 2 m ...), the whole run always visible, the span printed at the trunk's end; rescales when the run crosses a step |
| Weak spot | motion is the coarser of the two; ambiguous-width glyphs (box drawing, `◉ ● ○ ◆ ▸`) shift columns in a terminal that draws them double wide | the lanes start within a second of each other, so their curves knot together at the left; the waiting link is faint; depends on the font drawing empty Braille dots as blank |
| ASCII fallback | clean one-glyph-per-state set, good | works, every state distinct, less pretty |
| Native (Tern) | maps straight onto `describe` spans (finding 5) | only as static rows |
| Cost per frame | 0.03 to 0.06 ms | 0.07 to 0.10 ms (both negligible against omp's own 4 to 7 % of a core) |

**Recommendation: build `box`, and borrow one thing from `braille`.** The box view is the one that stays legible in every
terminal and font, without colour, in ASCII, and in the 80-column layout, it has a direct native form, and it is the
simpler code to own. Braille's real gain is the half-cell glide of the trunk's motions and the thickness channel; if the
box trunk feels too steppy once someone has watched it in colour, take the trunk row only from braille (a Braille
trunk over box lanes) rather than switching the whole view. Do not pick braille for the lanes: its curve knot and tiny
nodes are the parts that need the most work. This is a recommendation from structure and stills; the user's own look at
the two omp commands should overrule it.

## Host findings (omp 19.0.1, pinned; rechecked on 19.1.1)

Paths are under `node_modules/@oh-my-pi/`. "Observed" means: the pinned `omp` in a pty (isolated HOME, the offline fake
provider of `scripts/e2e/harness.ts`, `-e spikes/l0/extension.ts`), the screen read back through a terminal emulator
(pyte), no model call but the fake one. `fill` is the measurement frame: exactly N rows, every cell changing each tick.

### 1. Height

- A component widget has no row limit. Only string-array widgets are cut at 10 lines plus a "... (widget truncated)" row
  (`pi-coding-agent/src/modes/controllers/extension-ui-controller.ts:73,457-471`); a factory's component is mounted as is.
- Observed, 100 columns, chat already filling the screen. The widget is the last thing on screen; the editor sits just
  above it. 8, 12 and 16 rows all draw fully on a 30-row and on a 50-row terminal. The editor (prompt row) moved:
  30 rows: 21 → 17 → 13 (8 → 12 → 16 rows); 50 rows: 41 → 37 → 33. A 60-row widget on a 30-row terminal scrolls its own
  first rows off the top and pushes the editor and the status line out of view.
- **Growing pushes the editor up in the same frame; shrinking does not bring it back.** After 16 → 8 rows (or `off`) the
  editor stayed on row 13 with blank rows under the widget (30-row run: prompt row 13 after 16, 8, off, 12, 4 rows).
  Cause: `hookWidgetContainerBelow` is in none of the composer's chrome classes, so it counts as persistent chrome whose
  floor only rises (`pi-tui/src/prompt/composer.ts:105-150, 309-330, 552`; the root list is
  `pi-coding-agent/src/modes/interactive-mode.ts:2747-2836`). The editor settles back only when new transcript output
  fills the screen again.
- **Recommendation:** pick the height once per run and never change it. `rows = min(1 + lanes, 12)` is wrong because the
  lane count grows during a run; use a fixed `rows = clamp(terminalRows / 3, 6, 12)` computed when the run starts (8 on a
  30-row terminal, 12 on 50 or more), fold the rest into the summary row, and keep returning exactly that many rows even
  when there are fewer lanes (blank rows). Remove the widget only when the run ends and accept the floating editor.
  Keep the widget plus the editor well under the terminal height (a 60-row widget on 30 rows scrolls itself off), and
  re-pick the height only on a terminal resize.

### 2. Position

- Below-editor widgets are the last child of the runtime stack: after the editor container
  (`interactive-mode.ts:2776`, and in the Tern dock `:2832`).
- Observed with the default composer (`band`, `composer.shape` in `modes/settings.ts:129`) and with `box`: the status line
  is part of the editor (a band above the prompt, or in the top border), so there is **no footer under the widget** and
  the widget occupies the very bottom rows of the window.
- With the shapes that detach the status bar (`pi`, `rail`, `field`, `borderless`: `statusAttachment: "none"` in
  `pi-tui/src/components/composer/*.ts`) the one-row bottom status bar is drawn **below** the widget. Observed for `pi` and
  `rail`: editor, widget rows, then the status bar on the last row. So "bottom of the window" is the widget's place only
  for `band`, `box` and the chip shapes (`claude`, `rule`, not run).
- No way to pin something lower: `setFooter` and `setHeader` are no-ops in the TUI
  (`extension-ui-controller.ts:248-249`). `ui.setStatus` only adds a segment to the status line. `setEditorComponent`
  exists (`:250`) but replacing the editor is out of scope. A widget cannot be positioned by an offset.
- Several below-editor widgets stack in insertion order; setting an existing key moves it to the end of its map.

### 3. Repaint cost

- omp repaints **changed rows only**: each frame compares every viewport row with the previous one
  (`pi-tui/src/tui.ts:3940-3955`, `#rowNeedsRewrite` at `:4609`) and writes just the differing rows. A widget tick
  (`requestComponentRender`, `:2873`) is an ordinary render, so the whole component tree is re-rendered and compared, but
  only the widget's rows reach the terminal. Observed: `fill` with 12 rows at 85 ms wrote 4212 row rewrites in 30 s
  = 11.7 frames/s × 12 rows, nothing else; no erase-screen or erase-below sequences. 8 rows: 7.9 rows/frame; 1 row: 1.
- The frame rate is capped by `tui.maxFps` (default 30, min interval 33 ms, `pi-tui/src/frame-rate.ts:8`), so 85, 120 and
  200 ms ticks all pass unchanged.
- Process CPU over 30 s, whole omp process (bun), worst-case `fill` (every cell changes every tick), `ps` cputime
  sampling, background priority, one run each, so read it as ± 2 points:

  | Case | CPU (% of one core) | Bytes written |
  |---|---|---|
  | no widget (idle) | 1.5 | 0 |
  | 12 rows, 85 ms | 5.9 | 45 KiB/s |
  | 12 rows, 120 ms | 6.9 | 32 KiB/s |
  | 12 rows, 200 ms | 6.7 | 19 KiB/s |
  | 8 rows, 85 ms | 8.5 | 30 KiB/s |
  | 1 row, 85 ms | 5.8 | 4 KiB/s |

  The differences between rows and ticks are inside the noise: the cost is about 4 to 7 points of one core for any of
  them, dominated by re-rendering the tree, not by the rows written. The real variants' own `frame()` time is not in
  these numbers (the player runs them at 85 ms; measure that separately if a variant is heavy).
- Flicker and tearing: omp wraps each paint in DEC 2026 synchronized output (`tui.ts:97-104`) on terminals it knows
  (kitty, ghostty, wezterm, iterm2, alacritty, Windows Terminal, multiplexers that honour it) or that report mode 2026
  (`pi-tui/src/terminal-capabilities.ts:310-335`). Observed with `TERM_PROGRAM=ghostty`: 11.5 frames/s, each in one
  begin/end pair, 7.9 rows rewritten per frame. Without it (plain `xterm-256color`, no probe answer) frames are plain CUP row
  rewrites with no wrapper, so a slow terminal can show a partly painted frame; at 45 KiB/s that is unlikely but possible.
  I could not look at a real display, so flicker is judged from the byte stream only.
- Recommendation: 85 ms is fine; keep the number of **changing cells** low rather than rows (a row that did not change costs
  no output), and never change a row's text without a reason (the "still means waiting" rule saves bytes too).

### 4. Motion settings

- The switch is `tui.motion` (`full`, `reduced`, `none`; env `PI_MOTION`; flag `--motion`)
  (`pi-coding-agent/src/modes/settings.ts:704`, presets in `src/config/motion-presets.ts`). `cfgMotionResolved`
  (`settings.ts:724-740`) pushes three process-wide values into pi-tui: the spinner interval, the shimmer mode
  (`display.shimmer`: `classic`, `kitt`, `disabled`; forced to `disabled` unless motion is `full`) and the motion-effects
  flag.
- An extension reads them from `@oh-my-pi/pi-tui`, the same module instance as the host (Storm already does it in
  `src/view/live.ts`): `motionEffectsEnabled()` (`pi-tui/src/motion-effects.ts`), `shimmerEnabled()`
  (`pi-tui/src/theme/shimmer.ts:154`) and `onMotionEffectsChange(listener)`. There is **no change event for the shimmer
  mode**, only for the effects flag; read `shimmerEnabled()` on every render. There is no separate "reduced motion" flag:
  `reduced` and `none` are both `effects: false` with shimmer disabled and differ only in spinner speed (250 ms vs static).
  The OS reduced-motion preference is not read, except from a Tern terminal (`cx.reduceMotion`, native only).
- `--motion none`: spinners static, shimmer disabled, effects off. omp itself still repaints on content changes; widgets
  that gate on the two functions above stop. Observed with the demo: `full` 11.5 frames/s × 8 rows; `reduced` and `none`
  1 frame/s × 8 rows (the demo's deliberate 1 s tick that advances states with `motion: false`).
- Recommendation: `animated = motionEffectsEnabled() && shimmerEnabled()`, exactly Storm's radar gate (`live.ts:589`).
  When false: no timer faster than the state changes, frames with `motion: false`, and the one-line fallback of the
  contract.

### 5. Native (Tern) rendering

Not run: no Tern terminal here. From the sources only.

- With a TSP terminal, omp calls `describe(cx)` instead of `render()` (`pi-tui/src/tui.ts:278`, `native/node.ts`). A
  component without `describe` becomes a `rows` node: its ANSI rows from `render(cx.cols)`, a "migration fallback only"
  (`pi-wire/src/tsp.ts:715-720`). So the lane view appears as static pre-rendered rows; the local timer should be off, since
  `isNativeRendering()` is the signal Storm uses to stop it (`src/view/live.ts:537,593`), and Tern clocks motion itself.
- What `describe` may draw (`pi-wire/src/tsp.ts:40-90`): semantic nodes only, no pixels or canvas: `col`/`row`, `text` with
  spans (semantic tones `accent success warning error muted dim`, omp theme token names, and a per-span `fx`:
  `shimmer`, `pulse`, `none`, `tsp.ts:108`), `shimmer` (`classic` or `kitt` with a three-tier palette, `:527`), `spinner`,
  `progress` (0 to 1 or indeterminate), `meter` (`bar`, `ring`, `blocks`), `chart` (`spark`, `bars`, `heatmap`), `badge`,
  `icon`, `status`/`seg`, `ansi` (raw output).
- It can animate, but only by those host-clocked effects, and `cx.reduceMotion` / `cx.supports("shimmer")` say whether to.
  A new description every 85 ms is possible in principle (the node is re-described when the component is invalidated) but is
  not what the protocol is for, and I could not test whether Tern accepts that rate.
- What the lane view could be there: a `col` with one `row` per lane. The trunk: a `shimmer` node, `classic` for `working`
  and `workers`, **`kitt` for `verifying`** (its ping-pong sweep is the radar's back-and-forth); `waiting-user` a plain
  warning-toned span. Lane lines are text spans of box glyphs in the role tone; `running` gets `fx: "shimmer"`, `quiet`
  `fx: "pulse"` (the breath), every other state plain spans. A one-shot flash (`accepted`, `blocked`) has no node; it would
  be a short-lived `fx` that the controller removes after about 600 ms. The Braille canvas variant has no native form
  except as `rows`; the `box` variant maps onto spans directly, so on that path box is the one to build.

### 6. Colour

- A theme has no "role" tokens. `ThemeColor` (`pi-tui/src/theme/schema.ts:92-161`) has `accent`, `success`, `warning`,
  `error`, `muted`, `dim`, `text`, `border*`, `md*`, `syntax*`, `thinking*`, `statusLine*`, and optional `subagent1..6`. **None
  of the 102 bundled themes declares `subagentN`**, and the obvious distinct-looking tokens (`borderAccent`,
  `customMessageLabel`, `syntaxString`, `syntaxType`, `statusLineModel`) are the same colour or within OKLab 0.06 of each
  other in 96 of the 102 themes (`alabaster` is almost monochrome). Mapping tones to such tokens does not give five hues.
- What gives them: omp's own agent colours, `agentPalette(theme).subagents`
  (`pi-tui/src/overlays/agent-identity.ts:64-150`): a declared `subagentN` keeps its slot, free slots are filled from the
  theme's ANSI palette or from hues derived from the session accent, at least 0.1 OKLab apart, readable on the card
  backgrounds. Checked on `dark`, `light`, `alabaster`, `dark-abyss`, `dark-dracula`, `dark-monochrome`, `light-arctic`:
  six distinct hues each. `themePaint` uses it for `role1..role5` (`getSessionAccentAnsi` turns the hex into the
  terminal's depth), and `fg dim muted accent success warning error` map to the same-named tokens, `bright` to `mdLink`
  (the radar's peak colour).
- The role hues can look like `success` (green) or `warning` (yellow): `dark`'s role 2 is green `#0dbc79`, role 3 yellow
  `#e5e510`. So state never rides on hue alone (the contract already says so), and the accepted node and the verifying scan
  should use `success` with a distinct glyph, not just a colour.
- Truecolor detection: `theme.getColorMode()` (`pi-tui/src/theme/theme-class.ts:512`) gives `truecolor` or `256color`,
  decided by `detectColorMode` (`theme/color.ts:15`): `WT_SESSION`, else the terminal table in
  `terminal-capabilities.ts` (so `COLORTERM=truecolor|24bit` counts, plus known terminals); there is no 16-colour mode.
  Theme tokens already come out at that depth, so a variant needs no detection of its own; the plain player does its own
  (`palette.ts`: `COLORTERM`, `TERM`, `NO_COLOR`, TTY).

### 7. Width

- The widget gets the terminal width (`render(width)`); there is no padding for component widgets. Observed on a 30-row
  terminal with the box variant mounted: resizing 100 → 70 → 59 → 40 → 30 → 100 columns redrew the widget at each width
  within 2.5 s, kept its height (7 rows), and the editor did not move; nothing crashed.
- omp clips any over-wide row itself (`tui.ts` `#prepareLine`, `:4337-4380`), so a variant that overshoots loses its right
  end (the state word) instead of breaking the layout; it should still fit, since the right end is where the state sits.
- Under 60 columns omp does nothing special; the status line and the editor drop segments (observed: 59 columns lost the
  `master` and cost segments, 40 the model name, 30 the profile name) while the widget keeps all its rows. The one-line fallback is the
  variant's (contract: below 60 columns, or motion off). The box variant here truncates lane names to `탐…`/`테스트-…` and
  state words to `작업 …` instead; at 40 and 30 columns that is already hard to read, which supports the contract's one-line fallback below 60
  columns.

### Observed in the demo, both versions

Final integration run: omp 19.0.1 (pinned) and omp 19.1.1 (installed with `npm install --prefix <tmp> --ignore-scripts`
and run with the pinned bun), isolated HOME and the offline fake provider of `scripts/e2e/harness.ts`, in a pty read back
through a terminal emulator (pyte), `"/laneview box"` or `"/laneview braille"` as the first input.

| Run | Terminal | Time | Result (19.0.1 and 19.1.1 alike) |
|---|---|---|---|
| box, braille | 120 x 40 | 70 s (a whole scenario loop plus a restart) | widget directly under the editor, status line above the prompt; the editor's prompt row never moved; a typed `hello` appeared in the editor while the widget animated; 90 to 97 % of 0.25 s samples differed from the previous one (it moves) |
| box | 80 x 30 | 30 s | same, widest row 80 |
| braille | 160 x 50 | 30 s | same, widest row 160 |
| box, braille with `--motion none` | 100 x 30 | 25 s | still frames, one change per second (states advance, glyphs do not), 25 to 28 changes in 25 s; typing works |

Findings from this run:

- **Both versions behave the same** for finding 1 (height), 2 (position, band composer), 4 (motion flag reaches the
  extension) and 7 (rows fit the width). The extension imports `@oh-my-pi/pi-tui` from the repository's 19.0.1, yet under
  19.1.1 it still followed `--motion none`, so the host's motion state reaches an extension on both versions.
  Not re-measured on 19.1.1: CPU, resize, the other composer shapes.
- **The height must be fixed, and the variants alone do not do that.** In the first 1.5 s of every scenario loop no lane
  exists, so a variant returns a one-row frame and then a seven-row frame. The extension now pads every frame to exactly
  `rows` rows (default 8, `rows >= 7` for the six-lane scenario), and in the final run the editor row did not change
  during that moment. A real integration must do the same: pick the height at run start and return that many rows always.
- The 19.1.1 and 19.0.1 editors can sit on different rows (17 against 19 on a 40-row terminal): their start screens
  differ in height. Within one run the row never changed.
- Screen reads taken between two writes sometimes show one widget row blank or cut for a sample (4 of 260 samples at
  worst). The frames themselves never contain a blank or short row (checked over a full loop), and the next sample was
  whole, so this is a half-repainted screen caught by the emulator (no synchronized output without a known `TERM_PROGRAM`),
  not a drawing bug. A real terminal can show the same for a moment on a slow connection.
- `/laneview fill 8|12|16|60` and `/laneview off` were used for the height, repaint and width runs of findings 1 to 3 and 7.

Plain terminal: both variants played the whole scenario at 80, 120 and 160 columns, motion on and off, unicode and ASCII
(24 runs in a pty at six times speed): no error output, the block stayed in place at eight lines (trunk, six lanes, clock),
and Ctrl+C restored the cursor. A sweep of 135,552 frames (60, 80, 120 and 160 columns, `maxRows` 4, 10 and 12, motion
on/off, ASCII on/off, colour on/off, two scenario loops) found no exception, no row wider than the terminal (display width,
Hangul as two cells), and no more rows than `maxRows`. ASCII mode keeps Korean labels and uses `…` for clipped names.

## Not verified

- Tern (native) rendering: everything in finding 5 is from the sources. No Tern terminal, so no check that `rows`
  fallback animates, that `kitt`/`pulse` look as described, or whether Tern takes 85 ms re-descriptions.
- Real-display flicker and tearing: only the byte stream and the emulator's final screen were read; no GPU terminal was
  watched. DEC 2026 behaviour was checked by counting sequences, not by looking.
- CPU: one 30 s run per case, `ps` cputime, background priority, so noise of about 2 points hides any tick or row effect;
  only "a few percent of one core" is established. Cost of the variants' own `frame()` is not included.
- The composer shapes `claude`, `rule`, `field`, `borderless` were not run (position is read from `statusAttachment`);
  `pi`, `rail`, `box` and `band` were.
- Colour: only truecolor was exercised; 256-colour output of `themePaint` and light themes were not looked at (ANSI strings
  were printed for `dark`; bold did not show there because stdout was not a TTY). Hue distinctness was computed for 7
  themes through `agentPalette`; the 96-of-102 collision figure is for the fallback tokens, computed from the theme files.
- Motion was tested with `--motion` only, not through `/settings` or `display.shimmer` alone.
- Resize was tested through a pty window-size change and SIGWINCH with a terminal emulator, not with a real window, so
  scrollback "rebuild" behaviour on resize (`tui.resizeScrollback`) is not covered.
- Editor "jump" was measured as prompt-row positions between frames, not as a visual animation.
- Colour and motion of both variants were checked from tone dumps and from "does this frame differ from the last one", not
  by eye in a colour terminal. Nothing here says how the flow, the flash or the breath actually looks.
- A terminal that draws ambiguous-width glyphs (box drawing, `◉ ● ○ ◆ ▸ ✕`) two cells wide would misalign `box`; the
  display-width checks assume one cell. The ASCII mode avoids them.
