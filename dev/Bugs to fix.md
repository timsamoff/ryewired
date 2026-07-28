Bugs to fix
Electrolytic cap direction not enforced. Right now a cap can be placed backward and still function. Needs polarity checking added to the DC solver or placement logic (electrolytics are directional; reversed placement should either fail placement, warn, or actually degrade/fail electrically). Worth a quick discussion on which behavior you want before touching code.
wire.js's hardcoded row-letter helper. Cosmetic only, affects Jumper-tool status text on top-half rows. Straightforward: swap in the same split logic board.js's rowDisplayLabel() already uses, or better, just call that function directly and remove the duplicate.
New Layout doesn't reset Input/Output. Should mirror Clear Board's behavior. Given the earlier bug where resetInput() existed but wasn't exported, worth double-checking both resetInput() and resetOutput() are wired into whatever New Layout calls.
Jumper mode doesn't auto-switch to Select after clicking an existing endpoint. Needs the mode-switch to fire only when the click lands on an occupied endpoint post-wire-creation, and NOT fire on an empty hole click (which should keep you in Jumper mode for the next wire).
Two-hole components don't rotate correctly. They walk to adjacent holes instead of rotating in place around a fixed axis, and run out of room. This sounds like the rotation logic is treating the component's anchor point wrong, probably worth a short design discussion since it may need a real rotation-around-center rewrite rather than a patch.
Feature to add
Title + Description fields on all non-jumper components. Title at top, Description (multi-line) near the Remove button. Since this changes the .rw file format, needs a backward-compatible migration path added to whatever function currently handles old-format loads (likely alongside the existing migrateLayout() used for sample circuits).
Queued components (each wants its own scoping talk first)
MOSFET/JFET (2N7000, J201) — new behavior.type with Vgs/Vp/Idss equations.
Zener diodes (9V/5V) — reverse-breakdown modeling, likely new 'zener' behavior.type.
General op-amps (TL072/LM741/LM308/JRC4558) — start with ideal/near-ideal virtual-short model.
PT2399 delay chip — doesn't fit the per-component audio-stage model, probably needs a real Web Audio delay line.
LDR/vactrol for tremolo-vibrato — also its own discussion.
Parked, revisit when ready
Real-time property updates during playback. Was shelved because transistor audio didn't feel right, but the BJT loading and saturation fixes are done now, so this is worth reconsidering whenever you want.
Fuzz Face .rw layout cleanup. Circuit works, layout is just visually messy. Not in the sample-circuit manifest yet either, that's still your call.