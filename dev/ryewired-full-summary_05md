# Ryewired — Handoff Summary

Ryewired (samoff.com/ryewired) is a canvas-based breadboard circuit simulator
for guitar-pedal hobbyists. Vanilla JS, zero external dependencies, no build
step. This document summarizes where the project stands and what's queued up
next, to bring a fresh chat up to speed. The accompanying zip contains the
full current project source.

## Architecture principles (keep these in mind for any new work)

- Zero external dependencies, flat vanilla JS, no build step.
- Real physical component appearance is a priority — things should look like
  actual parts, not schematic symbols.
- Prefer economical, surgical, targeted fixes over rewrites.
- The main app must stay web-only — never Electron/desktop. The separate
  `admin/` tool (for managing component JSON definitions) is intentionally
  Electron-based; that's fine and by design.
- Board row numbering is non-sequential: rows 5–9 are the top half, rows 0–4
  are the bottom half. Rail rows are string keys (`'rtp'`/`'rtm'`/`'rbp'`/`'rbm'`),
  never used in row arithmetic.
- The top/bottom rails each have a physical break at column 31
  (`RAIL_BREAK=31` in `board.js`), splitting each rail into two independent
  electrical segments (cols 0–30 and cols 31–62). Any code that identifies
  "the ground/power net" must account for which segment a given circuit is
  built in — several serious bugs this project has had came from code that
  assumed column 0 specifically.

## TOP PRIORITY — carried over from last session, explicitly deferred

**Getting transistor and diode values/functionality correct for clipping is
the current top priority**, per direct instruction. Two known, real gaps:

1. **BJT base-emitter junction isn't stamped into the DC solver's linear
   system**, the way diodes are. `simulation.js`'s nodal solve
   (`solveNetVoltages`) treats resistors, potentiometers, and diodes/LEDs as
   real circuit edges — but a transistor's base-emitter junction is *not* one
   of those edges. Instead, `Vbase`/`Vemitter` are read *after* the pure
   resistor-only solve has already finished (in the `case 'bjt_npn':` /
   `case 'bjt_pnp':` block), as if the transistor draws zero current from the
   bias network. This is a real modeling simplification, not just a display
   bug — it means base current isn't actually loading the divider the way a
   real transistor would. In practice this has produced correct-enough
   numbers for simple common-emitter stages tested so far (see the fixed bugs
   below), but it's still an approximation, and it's the most likely place
   for future clipping/gain accuracy issues to originate.

2. **A resistor's "find a paired shunt capacitor" search in `audio-engine.js`
   (`buildAudioStage`'s resistor case) is too loose.** It just checks whether
   a candidate capacitor's *either* leg touches *either* of the resistor's
   two nets — on a busy, heavily-fused hub node (e.g. a base-bias node also
   touched by an unrelated input-coupling capacitor), this can incorrectly
   "borrow" that unrelated cap as if it were a shunt-to-ground filter partner
   for a totally different resistor. Confirmed present in real test circuits.
   So far it has only ever affected dead-end branches (paths that don't reach
   Output), not the audible chain — but it's an accuracy bug waiting to bite
   on a more complex circuit. Fix direction: require the partner capacitor's
   *other* leg to specifically resolve to the ground net, not just touch
   either of the resistor's nets.

Both of these were explicitly flagged as **not yet fixed** at the end of the
last session, with an instruction to revisit once other things settled.
Given the user's stated priority above, **this is the natural next thing to
tackle**, likely starting with (1) since it's the deeper architectural gap —
properly stamping the base-emitter junction into the linear solve (e.g. via
Newton-Raphson iteration similar to how the diode on/off relaxation loop
already works) would meaningfully improve clipping accuracy across every
transistor-based circuit, not just fix one symptom.

## Also queued: new components to add

The user wants these added to the component library (`data/components/*.json`,
following the existing JSON schema — see any existing file like
`transistor_npn.json` or `diode.json` for the pattern: `properties`,
`model_params` per selectable model, `behavior.type`, `failure_modes`,
`visual`):

- **MOSFETs and JFETs** — at least the 2N7000 and J201 (both commonly used in fuzz/boost
  pedals), plus likely other common small-signal FETs. Will need a new
  `behavior.type` (e.g. `'mosfet'` or `'jfet'`) and corresponding DC-solver
  + audio-engine handling, analogous to how `bjt_npn`/`bjt_pnp` are handled
  now but with FET-appropriate equations (Vgs/Vp/Idss-style behavior rather
  than Vbe/hFE).
- **Zener diodes** — e.g. a 9V pull-down, 5V pull-down, and likely other
  common voltage values. These need reverse-breakdown behavior modeled (a
  Zener conducts in reverse once past its rated voltage), which is a
  different `behavior.type` from the existing forward-biased-only
  `'diode'`/`'led'` model — likely a new `'zener'` type, or an extension of
  the diode model with a `zener_voltage` property and reverse-conduction
  handling in the solver's diode edge logic.
- **General-purpose op-amps** — common pedal-circuit op-amps (e.g. TL072,
  LM741, LM308, JRC4558). Will need their own `behavior.type` and both DC and
  audio modeling (an ideal or near-ideal op-amp model — virtual short
  between inputs, output swings to rail, etc. — is a reasonable starting
  point rather than full transistor-level modeling).
- **PT2399** — a specific delay/echo IC commonly used in DIY pedal builds.
  This is a much bigger modeling task than a simple part (it's a whole
  clocked BBD-style delay chip) — likely needs its own dedicated audio-engine
  handling (probably a real delay line in the Web Audio graph) rather than
  fitting the existing per-component `buildAudioStage` pattern. Worth
  scoping as its own discussion before implementation, given it doesn't
  resemble any of the app's existing modeled parts.
  **LDR** — Light detecting diode for temolo/vibrato-style effects. (Would a Optocoupler/Vactrol be possible?)

## Existing UI/UX bugs and featurs

- Remove "Support This App" from Help menu and make it its own menu item at the end of the menu
- +/- symbols are still too far apart in Help menu
- Draggable Ghosts are stil difficult to place because it uses the center mouse position as the left-most hole. Make it choose the hole to the left of center (DC power supplies don't have this issue because their orientation is different)
- Bypass switch shouldn't restart playing audio, but only turn on the effect
- Draggable power supply UI still doesn't match permanent power supply:
    - Permanent power supply doesn't have Current Limit
    - Draggable power supply needs a slider for Battery Sag
- Choosing the sample audio file in the Input settings doesn't auto-change the Audio Source to Audio
- Clearing the board still doesn't reset the Input and Output settings to default
- The top half of the row lettering is backwards - should go a - e from top to bottom, not e - a
- Clicking an interactable in the Workbench Panel should deselect any selected component
- If the page reloads and Upload Audio... is chosen in the Input settings drop-down, choosing it again doesn't work - user has to switch back to sample file then choose Upload Audio... again

## Also queued: "Load Sample Circuit" menu feature

Near-future enhancement, not yet designed in detail: add a **Load Sample
Circuit** option to the File menu, with a flyout/submenu containing 3–4
prebuilt example circuits (e.g. a simple boost, something demonstrating
clipping, etc.) that a user can load with one click — good onboarding /
demo material once the transistor-accuracy work above is solid. Implementation
will likely mirror the existing `vendor/audio/manifest.json` +
`AudioEngine.getCachedSamples()` pattern already used for bundled sample
audio clips: a small manifest listing bundled `.rw` circuit files, fetched
and loaded via the existing `Board.loadLayout()`/`Storage` machinery. Worth a
short design discussion (where the circuits live, how many, whether they
double as regression-test fixtures) before implementation — this project's
established pattern is to discuss design before writing code for anything
non-trivial.

## Recent major work (this past session), for context

- **Two confirmed, major root-cause bugs fixed**, both stemming from the same
  underlying flaw (hardcoding rail connections to column 0 instead of using
  the power block's real, dynamically-computed connection columns):
  1. `audio-engine.js`'s `groundNet` (used by the branch-aware BFS audio
     walk) was fixed to use the real connection columns — previously a
     potentiometer (or any 3-leg part) could get incorrectly matched to its
     ground-connected leg instead of its real signal leg, because ground is
     typically discovered first in the walk and the match is "used up"
     permanently.
  2. `simulation.js`'s actual **DC/electrical solver** had the *same* bug,
     independently, and was never fixed until directly diagnosed at the very
     end of the last session — the permanent power supply's fixed +9V/GND
     voltages were applied to rail segment A (hardcoded column 0) regardless
     of where the power block's real leads land (which turned out to be
     segment B for every circuit built this session). This meant bias
     networks never actually received real voltage in the solve — confirmed
     by fully replicating the solver in a standalone script and running it
     against a real saved circuit file, both before and after the fix. This
     was very likely the actual root cause of every "circuit won't
     clip/boost" complaint across the whole session.
- A **timing bug** was also found and fixed: `Simulation.start()` only
  schedules future ticks via `setInterval`, never running one synchronously.
  But `AudioEngine.start()` (which reads a transistor's DC-solved collector
  current to compute its gain) was called immediately afterward in the same
  synchronous call, before any tick had run — so gain was always computed
  from a stale/zero value. Fixed by forcing one synchronous `Simulation.tick()`
  before `AudioEngine.start()`, in both places that rebuild the audio graph
  (the Play button, and the Bypass-toggle handler).
- A potentiometer wiper set to exactly `0` was being silently treated as
  `0.5` in two places, due to a classic `parseFloat(x) || 0.5` JavaScript
  falsy-zero bug (0 is falsy, so `0 || 0.5` evaluates to `0.5`). Fixed with a
  proper `Number.isNaN` check in both the audio gain code and the DC solver.
- Whole-wire dragging and copy/paste were added for jumpers (Select tool
  only — Jumper tool remains purely for drawing new jumpers). Scoped as
  column-only movement, since a wire's two endpoints can be a numeric row and
  a string rail-key simultaneously, and there's no sensible single "row
  delta" that applies to both.
- Tool shortcut keys: Jumper=J, Select=V, Voltmeter=M, Audio Probe=P.
- A large UX/bug-fix batch also landed: Redo shortcut fix, Clear Board
  resetting Audio Input, per-type capacitor colors, hole numbering/lettering
  direction (final state: ascends right-to-left, matching a real breadboard
  photo the user provided — both the printed numbers *and* the underlying
  physical gap spacing were fixed to agree with each other), In/Out jack
  swap, Bypass/Power group repositioning, draggable DC power supplies with
  independent on/off + battery sag + internal resistance, and a bundled
  "Sample Audio Clip" feature for the Input (a fetched/decoded WAV playable
  alongside user uploads, via `vendor/audio/manifest.json`).

## Suggested next steps for the new chat

1. Assess scop of Existing bugs and features and suggest where they should
   fall in the rest of the workload
2. Confirm scope and approach for the BJT base-emitter DC-solver modeling
   gap (item 1 under Top Priority) — this is probably the single highest-value
   fix available, since it likely underlies future clipping-accuracy issues
   the same way the rail-segment bug underlay this session's boost/clip bugs.
2. Fix the resistor/shunt-cap mispairing bug (item 2) — smaller, well-scoped,
   good follow-on.
3. Design and add the new components (MOSFET/JFET, Zener diodes, op-amps),
   each as its own discussion given they need new `behavior.type` handling
   in both the DC solver and the audio engine.  
4. Scope LDR/Octocoulper.
5. Scope the PT2399 separately — it doesn't fit the existing per-component
   audio model and deserves its own design conversation.
6. Design and implement the "Load Sample Circuit" File menu feature.