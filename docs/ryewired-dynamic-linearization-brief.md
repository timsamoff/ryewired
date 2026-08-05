# Ryewired — Dynamic Re-Linearization Architecture (scoping brief for a future session)

## Why this exists

Discovered while debugging why a Fuzz Face's "fuzz" control had no audible effect once emitter degeneration was correctly modeled. The knob's math was verified correct (real `Re` change, real gain change, real DC bias behavior), but nothing was audible because the deeper issue sits one level up: the entire audio engine linearizes each transistor stage **once, at Play time, around a single frozen DC operating point**, and then applies that one fixed gain and one fixed clipping curve to the whole signal from then on.

A real Fuzz Face (and many other pedal circuits) doesn't work that way. Q1 and Q2 are direct-coupled with no isolating cap between them, so the circuit's actual bias point shifts continuously in response to the instantaneous signal driving it. That's the real mechanism behind:
- the fuzz knob's low/medium/max character differences (gritty overdrive → violin sustain → wooly saturated compression)
- rolling the guitar's volume down cleaning the signal up, rather than just making it quieter
- general "interactivity" between the player's hands and the circuit

None of that can exist in a one-shot linearized model, no matter how correct the fixed operating point's math is. This is a structural ceiling, not a bug in any one component's model.

## Directive this serves

From the original project brief: Ryewired should behave and sound like real pedal circuits, generally, not just approximate one reference schematic. This needs to hold up across circuit families the app doesn't yet support but is expected to, including:
- Single-transistor circuits (e.g. a Bass Fuzz)
- Multi-transistor, heavily-feedback circuits (e.g. a 4-transistor Big Muff)
- Op-amp based drive/overdrive circuits (e.g. Tube Screamer, Dumble-style overdrive)
- Any circuit with tone pots, bias pots, or other in-circuit tweaks that are meant to audibly (and sometimes dramatically) change behavior, including "breaking" a circuit via an unusual value choice

## Two options considered, and why one was chosen

**Option 1 — per-component-type envelope followers.** Bolt a hand-tuned envelope-follower-driven modulation onto each `behavior.type` (BJT, op-amp, JFET, etc.), nudging gain/bias/clipping based on recent signal level. Rejected as the general solution: it doesn't transfer between topologies. A BJT's envelope response, an op-amp clipper's, and a JFET's would each need separate, hand-tuned heuristics with no shared logic, effectively a second, ad hoc modeling system living alongside the real solver, growing linearly with every new component type added to the queued list (MOSFET/JFET, zener, op-amps, PT2399, vactrol).

**Option 2 — block-rate re-linearization of the existing solver. (chosen direction)** The nodal-analysis DC solver in `simulation.js` is already fully general, it doesn't know or care whether it's solving a one-transistor fuzz or a four-transistor Muff, it just solves whatever netlist it's given. Right now it's only ever asked to solve once, at a frozen/silent operating point. If the same solver is instead re-run periodically using the actual instantaneous input signal as a real, time-varying source, direct-coupling effects, bias sag under a loud transient, and cleanup-on-volume-rolloff all emerge as real consequences of the real equations, for any topology, without per-component-type special-casing. Tone pots, bias pots, and "breaking" a circuit via a bad value choice are already just netlist values the solver respects, this approach lets the solver respond to the signal too, not just to fixed values.

## What this practically means (not true per-sample SPICE)

A full nonlinear transient solve on every audio sample (44.1kHz) is not realistic in a browser main thread. The realistic version of Option 2 is **block-rate re-linearization**: re-run the existing DC solver every N samples (roughly every 64–512 samples, a few milliseconds) using a tracked representative input level for that block, rather than once at Play. Bias sag and cleanup happen on the order of milliseconds to tens of milliseconds in a real circuit, well within what block-rate updates can resolve, so this is a reasonable "quasi-static" approximation rather than a real accuracy sacrifice for the character being chased here.

## Open design questions for the actual scoping session

- **Block size.** Where in the 64–512 sample range balances responsiveness against solver cost? Does this need to be adaptive (finer near fast transients, coarser on sustained/steady signal)?
- **What "instantaneous signal" means per block.** Peak? RMS? The actual sample value at the moment the block is solved? Different choices will sound different and have different cost.
- **How this replaces the current per-Play graph build.** Right now `buildAudioStage`/`traceSignalPath` run once at `start()`. Does block-rate solving replace that entirely, or does the existing one-shot build stay as a "cheap mode" fallback for circuits/performance situations that don't need dynamic behavior?
- **Performance budget.** Needs real profiling in-browser: how expensive is one solver pass, how many transistors/stages can this scale to before it can't keep up with real-time audio, and what degrades gracefully if it can't (frame drops? audible glitches? automatic fallback to static mode?).
- **Interaction with existing calibration.** The soft-knee gain calibration (`maxGain=35, kneePoint=80`) was tuned against a single static operating point measurement. Does that calibration still make sense once the operating point itself moves dynamically, or does it need to be revisited/recalibrated against the new dynamic behavior?
- **Scope of rollout.** Does this land as a global engine change (all circuits get dynamic behavior), or a per-circuit or per-stage opt-in, given the performance unknowns above?

## Explicitly not in scope for this brief

This is a separate, larger item from everything already shipped or scoped this session (reverse-polarity checking, emitter degeneration for gain, and the still-open transistor `leakage`/ICBO gap). Leakage in particular may end up interacting with this work later (a leakier germanium transistor's bias point would presumably also shift more dynamically), but that's worth confirming once this architecture exists, not a reason to bundle the two now.
