# Ryewired — Project Handoff

**What it is:** A canvas-based breadboard circuit simulator (samoff.com/ryewired) targeting guitar effects pedal hobbyists. Vanilla JS, zero external dependencies, no build step, real physical component appearance. The main app is web-only (never Electron/desktop); a separate admin tool for managing component definitions is intentionally Electron.

**Working conventions:** Discuss non-trivial changes before implementing. Prefer surgical, targeted fixes over rewrites. One task at a time. Tests happen in-browser; pushes back firmly if something claimed fixed still isn't.

---

## Architecture notes

- **Board row numbering** is non-sequential: rows 5–9 are the top half, rows 0–4 the bottom half. Rail rows are string keys (`'rtp'`/`'rtm'`/`'rbp'`/`'rbm'`), never used in row arithmetic. Row *lettering* is per-half: bottom half (rows 4→0) reads f,g,h,i,j top-to-bottom; top half (rows 5→9) reads a,b,c,d,e top-to-bottom. `board.js`'s `rowDisplayLabel()` handles this split correctly.
- **Column numbering** ascends right-to-left (group "1-5" at the right edge, "60" near the left, 3 unlabeled trailing holes at far left), matching a real breadboard photo the user provided.
- **Rail break:** both rails have a physical break at column 31 (`RAIL_BREAK = 31`), splitting each into two independent electrical segments (cols 0–30, 31–62) — deliberate, a "no-gap" redesign was discussed and explicitly deferred. Any code identifying "the ground/power net" must account for which segment a circuit is built in.
- **Electrical net model** (`buildNetMap` in `simulation.js`): within a column, all of rows 0–4 are bonded together, and all of rows 5–9 are bonded together (mimics a real breadboard's 5-hole strips). Different columns are never bonded without an explicit wire or component leg spanning them.
- **Fixed board columns:** Input jack = column 55, Output jack = column 6 (`workbench-strip.js`). Power rail columns are computed dynamically near board center.
- **DC solver** (`simulation.js`, `solveNetVoltages`): nodal analysis (conductance matrix) over resistors/pots, with diodes/LEDs and transistor base-emitter junctions modeled as a small "on" resistance (`RON=1`Ω for diodes, `RBE=10000`Ω for B-E junctions) plus a Vf-offset current source once forward-biased, or a very large "off" resistance (`ROFF=1e9`) otherwise — a standard piecewise-linear diode companion model, iterated (guess on/off state → solve → check → repeat) until stable.
- **BJT modeling** (see Fixed Bugs below for full history): base-emitter junction is a real edge; collector current is a linear dependent-source (not lagged — lagging caused divergence); saturation is a second binary state per transistor using a Vce-floor clamp (`RSAT=1`Ω, `VCESAT=0.2`V) rather than full Ebers-Moll, chosen for real-world audibility over textbook completeness.
- **Audio engine** (`audio-engine.js`, `traceSignalPath`/`buildAudioStage`): builds a real Web Audio graph by walking the actual wired topology (not a fixed template), one stage per component, reachable via BFS from the input net. Ground is a fixed 0V reference — real audio never appears there, `groundNet` is computed from the power block's actual connection columns (not hardcoded) to handle the rail break correctly.

---

## Completed features (this session and prior)

- **Load Sample Circuit** (File menu): `Modal.pickList()` — a new reusable list-picker mode added to the existing `Modal` module (same overlay/backdrop/Escape chrome as confirm/alert, swapped content). `vendor/circuits/manifest.json` lists bundled `.rw` files; add a line there for each new one, no code changes needed. Mirrors the existing bundled-audio-sample pattern in `storage.js`.
- **Sample-audio picker redesign**: replaced the Input panel's overloaded `<select>` (which mixed a bundled-sample filename with two synthetic sentinel values) with two plain buttons — "Load Sample Audio" (opens the same `Modal.pickList`) and "Load Custom Audio" (existing upload flow, relabeled). Structurally eliminates the two related dropdown bugs rather than patching around them.
- **Modal.pickList styling**: restyled from individually-bordered boxed rows to a single bordered container (like a DAW plugin/file browser) with flat rows, thin hairlines, full-width hover highlight.
- **Whole-wire dragging and copy/paste for jumpers**: free 2D movement (upgraded from an earlier, overly-conservative column-only version). Drag tracks a raw pixel offset live, then snaps one endpoint on release with the exact correction applied to the other (atomic, same technique whole-component dragging uses). Copy/paste stores both endpoints' offsets from their own midpoint.
- **Overlap/collision policy**: no leg/endpoint may land on an already-occupied hole, no exceptions (same-column holes are already bonded, so this costs nothing electrically). A new placement/paste that would collide just doesn't get placed; dragging an existing part that would collide snaps back.
- **Status bar auto-clear**: stale status messages now clear on the next click/keydown unless something set a fresh message during that same interaction (generation-counter tracked) — mode-describing messages (e.g. "Wire started at f12...") still persist correctly since the next relevant click re-sets them.

---

## Major bugs found and fixed (electrical/audio correctness)

1. **Hardcoded ground column (column 0)** — both `audio-engine.js`'s `groundNet` and `simulation.js`'s DC solver hardcoded the permanent supply's rail connection to column 0 instead of the power block's real, dynamically-computed connection columns. The DC-solver instance meant bias networks never received real voltage at all — likely the actual root cause of most historical "circuit won't clip/boost" complaints.
2. **Pot/3-leg ground-leg mismatch** during the audio BFS walk (ground dequeued first could match the wrong leg).
3. **Falsy-zero bug**: `parseFloat(x)||0.5` treated a wiper set to exactly 0 as 0.5, in both audio gain code and the DC solver.
4. **Stale DC values at playback start**: `Simulation.start()` only scheduled future ticks via `setInterval`, never running one synchronously — so `AudioEngine.start()` always computed gain from a stale/zero value. Fixed by forcing one synchronous tick before the audio graph rebuilds.
5. **BJT base-emitter loading**: the base-emitter junction wasn't a real solver edge, so base current never loaded the bias divider. Now modeled as a real diode-style edge; collector current is a linear dependent-source stamped directly into the same matrix solve (lagging it by an iteration, tried first, diverges — Ic is too steep a function of Vbe). Converges in ~2 iterations on standard bias circuits.
6. **Saturation modeling**: added as a third state per transistor (off/active/saturated) using a Vce-floor clamp rather than full Ebers-Moll (chosen for real-world audibility, per explicit user guidance to prioritize what pedal builders actually hear). Verified against 5 standalone circuits including a classic "transistor as a switch" case.
7. **Transistor hFE default bug**: `hfe` property defaulted to a hardcoded `100` in both `transistor_npn.json`/`transistor_pnp.json`, which always won the `||` fallback over the model's real rated hFE — meaning every transistor, regardless of selected model, silently used hFE=100. Fixed both files' defaults to `""` (empty, matching `leakage`'s existing convention).
8. **Model switching didn't actually update hFE/leakage** — added `ComponentRegistry.applyModelDefaults(inst)`, called at placement and whenever the model dropdown changes, so switching models resets hFE/leakage to that model's real rated values (a custom override belongs to the model it was set under).
9. **Gain formula miscalibrated against a hypothetical circuit, not a real one** — checked against a user's actual saved layout (R1=430k, R2=42k, Rc=10k, Re=390): raw gain lands in the 20–800+ range, mostly past where the original soft-knee (`maxGain=20, kneePoint=15`) still differentiated, compressing a real ~2.8x Ic swing across a model lineup down to <2dB. Recalibrated to `maxGain=35, kneePoint=80` — same swing now spans ~4.9dB.
10. **Shunt-capacitor mismatch**: `buildAudioStage`'s resistor case accepted any capacitor touching either of its own two nets as a shunt-filter partner, which could mismatch an unrelated capacitor sharing a busy hub node (e.g. a bias-divider junction) for a completely different purpose. Fixed by requiring the candidate capacitor's *other* leg to resolve specifically to `groundNet` (already computed elsewhere in `traceSignalPath`) — a real shunt-to-ground lowpass needs an actual path to ground, not just node-sharing.

All of the above were verified via standalone reproductions (not just `node --check`) before landing, several against the user's actual saved circuit data rather than hypothetical test values.

---

## Known open items

**Bugs:**
- **Electrolytic cap functionality** doesn't seem to be working correctly. I can add an electrolytic cap in any direction and it still works.

**Small/cosmetic:**
- `wire.js` has its own separate hardcoded row-letter helper (old a-j reversed array) that doesn't apply the top/bottom-half split `board.js`'s `rowDisplayLabel()` correctly handles — Jumper-tool status text shows the wrong letter for top-half rows.
- Sample-audio dropdown auto-switch / reload-stuck bugs from an early triage list were superseded by the full dropdown→buttons redesign — likely moot, not separately re-verified.
- **New Layout doesn't reset Input/Output** the way Clear Board does — it should, for consistency.
- **Jumper mode should auto-switch to Select mode** after clicking an existing endpoint (jumper or component leg) once a wire has just been created, rather than staying in Jumper mode. If an empty hole is clicked, it should stay in Jumper mode.
- **Components that span two holes** do no rotate correctly and stop rotating when they run out of space. Seems their not rotating in place around an axis, but to the nearest holes until there are no more holes.
- **All components** (excluding jumpers) need an optional "Title" field on the top of the other editable fields, and an optional "Description" bix (maybe 4 lines tall) right about the Remove button. This will alter the rw file format, so it needs to be backward compatible.

**Queued new components** (not started — several want their own scoping discussion first):
- MOSFET/JFET (2N7000, J201) — needs a new behavior.type with Vgs/Vp/Idss equations.
- Zener diodes (9V/5V) — needs reverse-breakdown modeling, likely a new `'zener'` behavior.type.
- General op-amps (TL072/LM741/LM308/JRC4558) — ideal/near-ideal virtual-short model to start.
- PT2399 delay chip — doesn't fit the existing per-component audio-stage model; likely needs a real Web Audio delay line; wants its own design discussion.
- LDR/vactrol for tremolo-vibrato — also wants its own scoping discussion.

**Shelved / parked (user's call when to revisit):**
- Real-time property updates during playback (change a value while simulation is running and hear it immediately, without stop/restart) — shelved because transistor audio still didn't feel right at the time; the underlying transistor issues are now fixed, so this could reasonably be revisited.
- Fuzz Face (NPN, germanium) `.rw` file — built and works (audio passes, fuzz functions), but the hand-authored board layout is visually messy; user parked cleanup for later. Not added to the sample-circuit manifest (offered, not done).

---

## Working files reference

Core JS modules: `app.js` (bootstrap, menu actions, layout I/O), `board.js` (canvas rendering, drag/drop, collision), `wire.js` (Jumper tool), `simulation.js` (DC solver), `audio-engine.js` (Web Audio graph), `properties-panel.js` (component property UI), `storage.js` (file I/O, bundled manifests), `components-registry.js` (component defs, instance creation), `modal.js` (confirm/alert/pickList), `workbench-strip.js` (permanent Input/Output/Power devices), `history.js`, `autosave.js`, `palette.js`, `oscilloscope.js`, `trace-overlay.js`, `shapes.js`, `utils.js`.

Component data: `data/components/*.json` (one file per component type, includes `properties` schema and `model_params` where applicable).