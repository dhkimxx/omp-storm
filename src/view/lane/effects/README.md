# The lane view's effects as built

Source: `../effects.ts` (`paint(scene, canvas, t, motion)`, `liveliness(snapshot)`) and the files next to this one. The numbers
below are constants at the top of the file that uses them (`timing.ts` for the durations). Cost: about 1 ms per frame at 120 columns, 10 rows.

## How a dot gets its look

- Every dot has a colour and an energy. The canvas blends energy with `energy ** 1.8`; the painter undoes that
  (`perceived`: `e ** 0.55` on dark, `e ** 0.42` on light) so the energies below read as perceived brightness.
  Above 1 the canvas pushes toward white (dark terminal) or a deep tone (light terminal).
- Line colour is OKLCH with one lightness for every hue: L 0.76 on dark, 0.54 on light, chroma 0.20. That is what
  makes the rainbow even. Text is lighter/darker still (L 0.84 / 0.42) so labels read on both backgrounds.
  "Flash white" is white on dark and a deep saturated tone of the hue (L 0.34) on light.
- Fixed meanings carry their own lightness: green L 0.80/0.56 (hue 152), amber L 0.84/0.68 (hue 78), red L 0.66/0.54
  (hue 24, chroma 0.225).
- Lane hue is `laneHue(slot)` (golden angle from 250); the slot is the timeline's stable `slot` for the lane (its index when
  absent), so a replan does not recolour the others. Watch out: slot 1 lands on hue 27, close to the
  fixed red. Red is told apart by its deeper lightness and by the cross, not by hue alone.
- Colour is never the only signal: state also shows in shape (dotted, double rail, thickness) and in brightness.

## Clocks

- `t` is animation time; events use `now - mark.at`.
- The phases that stop (`timing.ts: settleMs`) let their clocks run for a while and then stand still: waiting for the user
  and between rounds 2 s (the last events play out), the finale 2.2 s, lights-out 4 s. From then on both clocks are
  derived from the snapshot alone (the run time the phase settled at), so a picture that stops does not depend on `t`.
  `liveliness` reads the same function: `full` until the phase has settled, then `slow` (waiting for the user: the amber
  block pulses on the caller's own `t`, the one thing that keeps moving) or `still`.
- `motion: false`: events count as long past, `t` is frozen at 2.3 s, the scan sits mid-way, comets sit at a fixed spot,
  the waiting block is drawn at 80 percent pulse, freeze drain is full, the finale is its settled rainbow. Same picture,
  still, coloured.
- Accumulated phases (a speed that changes must not make the pattern jump): the aurora shift is the integral of the
  phase's speed over the run (stateless); lane drift and comets keep a small per-lane accumulator across calls
  (`math.ts: accumulate`, module state, keyed by lane name); a step of 500 ms or more adds nothing.

## Effects, row by row

| Effect | What was built | Numbers |
|---|---|---|
| Flowing gradient | Lane hue drifts as a sine along the path, travelling toward the head; speed follows `activity`. Running lines are 3 dots thick, energy 0.66 + 0.34 activity | drift ±26 degrees, wavelength 64 dots, speed 12 + 34 activity dots/s (the pattern moves at a quarter of that, `flow / 4`) |
| Comet | Fat lumps leave the start of the current running stretch and run to the head, white-hot head mixed 35 percent with the lane hue, fading tail; count and speed grow with activity; they run on past the head and re-enter after a gap | 1 to 3 comets, speed 24 + 44 activity dots/s, tail 18 dots, gap 30 dots, head energy 1.55, 3 dots thick for the first 8 dots |
| Aurora trunk (working) | Rolling sine on the trunk (2 dots thick) plus a thin counter-wave; bright head sweeps with a 22-dot trail | wave length 18 dots, 0.9 Hz, amplitude 1.5 dots, ramp in 0.5 s; head 28 dots/s, hot colour hue 220 |
| Aurora colour | Trunk colour is a set of bands: one pale ice-blue band (hue 218, chroma 0.15) from the start, plus one band per accepted lane in the lane's hue (chroma 0.27, gamut-clipped). A band exists to the right of its join point (ramp 18 dots) and leaks a little to its left (0.45, fading over 60 dots) so the trunk is not bare there and enters in time 0.9 s after the accept, over 1.1 s. Bands are cos^3 bumps, 0.145 of a period apart, so each hue keeps its own stretch of the trunk, blended as a hue vector so no grey appears; the base band is weakened as lanes join. Energy 0.80 + 0.34 band peak | wavelength 40 dots; flow speed per phase: working 17, workers 5, verifying 8, still phases 0 (dots/s) |
| Calm trunk (workers) | Wave amplitude 1.5 to 0 over 1.2 s, then a 3-dot-thick trunk that breathes in energy (x 0.78..1.12), a fourth row at the top of the breath | breath 4.2 s |
| Scan (verifying, reviewing) | Trunk: white-to-green band ±12 dots, energy up to 1.45, ping-pong over the trunk. Lanes in `reviewing`: double rail (rows at -1 and +1), green band ±9 dots on the rail, ping-pong over the lane's path; both use the same `pingPong(t)` so they move in one rhythm | period 2.9 s; diamond `◆` at the head pulses green to white |
| Branch | At a `start` mark: the grown part of the route is white-hot near its tip (energy 0.5..1.4), 7 sparks leave the tip | 0.6 s; sparks 26 dots/s |
| Merge burst | (1) the lane's light is a white-hot pulse with a 46-dot tail rising along the last 70 dots of the route into the trunk (first 45 percent); (2) a white flash spreads both ways along the trunk, 18 dots wide, energy 1.55 fading, white to green; (3) the join glows 5 by 4 dots; (4) 14 sparks in the lane's hue and 8 green ones fly out; (5) the `●` flashes white then green; the lane's own line drains from 0.5 s to 1.8 s to a pale tint of its own hue (chroma 0.075, energy capped at 0.46), not to grey; its join stays in full hue; sparks fly downward only (the trunk is the top row); the hue joins the aurora from 0.9 s | 1.3 s; front 80 dots; sparks 46 and 34 dots/s, life 0.9 and 0.8 s |
| Lightning | A zigzag of long strokes (about 5 dots tall, 4 to 9 dots sideways) with a white core two dots thick in a red sheath (halo at 0.6 energy, 3 to 4 dots out), from the trunk, 32 then 18 dots left of the cross, down to the cross, so it slashes across the lane bodies and not the glowing heads. Bolt 1 flickers (0 to 90 ms, 135 to 240 ms), bolt 2 white to red 275 to 500 ms, with forks. For the first 260 ms the other lanes within 44 dots left and 16 right of the cross dim to 45 percent, so the bolt is the brightest thing. A thunder ripple runs back along the struck lane (64 dots, from 150 ms); the cross glows; the lane turns red and stays at energy 0.5. Red keeps at least 0.9 of its energy in lights-out. On a light terminal the core is a deep red | 0.6 s |
| Bounce | A white-hot pulse starts at the hollow circle and recoils 38 dots back along the lane (ease out over 75 percent of the time), tail toward the circle; sparks at the circle. The ring `○` is white-hot during the bounce, then pale in the lane's hue. Not amber: amber is reserved for waiting on the user | 0.6 s |
| Round wipe | A bar (3 dots, energy 1.35) sweeps the whole canvas left to right with a stippled trail of 13 dots; the round tick is held back until the bar passes its column, then stamped white-hot for 260 ms; tick and number stay bright for the newest round, grey for older ones | 0.8 s, hue 200 |
| Rain | Only with 2 or more running lanes, motion and a moving clock: slanted 5-dot streaks in free cells (cells not used by a line, glyph or label). The spray fills the empty stretch up to 56 dots right of the heads (a white-hot leading dot, the tail in the lane's hue, fading over the last third of the stretch); a thinner shower tries the gaps among the lines. Tinted by the nearest running lane; spray count 1 per 4 dots of stretch per running lane (max 170), shower 1 per 24 dots (max 40) | fall 14 to 36 dots/s, energy 0.95 to 1.2 |
| Freeze | Everything is drained 85 percent to grey over 0.5 s (`canvas.drain`) and stops. Afterwards only the amber `█` at the trunk head and 3 fading amber dot columns before it pulse | pulse 2.4 s, block energy 0.6..1.0 |
| Dim wait | Still; energies x 0.55, text x 0.75, over 0.4 s | |
| Finale | A bright rainbow front runs the trunk once (front over 1.4 s, 70 dots wide, hue by position along the trunk + time) and leaves the full rainbow behind it, which is the settled picture (every hue once, 3 dots thick); lanes flash white top to bottom (first at 0.5 s, 170 ms apart, squeezed to fit 1.2 s when there are many lanes, 380 ms each) | 2.2 s |
| Lights out | Darkness front moves from the left over 3.2 s (16 dots soft edge, floor energy 0.04); lanes go dark one by one between 0.5 s and 3.1 s (500 ms fade each); red marks and the red line keep 90 percent; text fades to 55 percent | 4 s |

Other lane states: reserved = dotted (every 4th dot), waiting = every 6th dot, grey, plus a dotted link; submitted =
double rail, pale; unmet = dotted pale line; idle = thin grey; excluded = dotted grey with `⊘`; blocked = red; quiet =
solid, with the last 9 dots breathing (3.4 s); job nodes `■`/`□`, filled in turn every 420 ms while the lane runs;
the open end of a running lane has a pulsing head (0.52 s).

## Labels

- A lane's `progress` (results met of those in scope) follows its state word when the total is above 1: green when all are met, grey otherwise.

- Left: lane name in the lane's hue (bold while running, pale when finished), the lane's label word grey. Right: state word,
  coloured by state (hue for running, green for reviewing/accepted, red for blocked, grey otherwise).
- Trunk: the director label is coloured character by character from the aurora; the phase word likewise in
  `working`/`workers`; green in `verifying`; amber in `waiting-user`; grey otherwise.

## Notes for the product

- Sparks "above the join" are clipped: the trunk is row 0, so only the downward half shows. A spare row above the
  trunk would show the whole burst.
- Braille at two dots thick reads as dotted lines in most fonts; the colours carry the look. A solid trunk needs
  three dots, as built.
- Palette mapping: without truecolor the canvas reduces colours itself; the design relies on hue, so on 13 tones the
  aurora collapses to the nearest tone per cell.

## Lines of the graph (stems, arcs, joins)

A lane's stem (the vertical it drops from the trunk, shared by lanes that start together) and its peel arc, and its join
(the arc and vertical back up to the trunk) are drawn as one clear thin solid line (one dot wide) in the lane's hue at
energy 0.9 (0.8 for a join), whatever state the lane was in; an excluded lane's are grey and dim. Where a stem or a join
crosses another lane's row the lane has a one-dot gap on each side and the crossing is the clear line of the crossing lane's
own hue, so a gap always has a visible reason. The trunk label is `감독` (Storm's word for the director) and carries no counts.
