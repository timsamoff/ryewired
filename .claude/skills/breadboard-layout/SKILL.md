---
name: breadboard-layout
description: Build a clean, buildable .rw breadboard layout from a schematic, or diagnose a messy one. Use when converting a schematic into a .rw file, placing or rearranging components on the board, or when a layout looks wrong (parts stretched oddly, legs and jumpers piled into the same row, tangled wiring).
---

# Building a clean breadboard layout

Getting a circuit electrically correct is not the same as getting it *buildable*. A netlist that solves fine can still be unreadable on the board: parts stretched across half the width, three things crammed into one hole, jumpers crossing over components. The rules below were extracted from a hand-built reference layout (`Fuzz-Face-NPN_v04.rw`) and are what make the difference.

**Verify with the checker, don't eyeball it.** `check-layout.js` in this directory validates a `.rw` against every hard rule here. Run it on anything you generate:

```
node .claude/skills/breadboard-layout/check-layout.js <file.rw>
```

## Board geometry (the parts that will trip you up)

- **Two independent halves.** Rows 5-9 are one half, rows 0-4 the other. A column bonds rows 5-9 together and separately bonds rows 0-4 together. **The same column in different halves is a different net.** This is the single easiest thing to get wrong when reading or writing a file by hand.
- **Visual order, top to bottom:** top rails, row 5, 6, 7, 8, 9, center channel, row 4, 3, 2, 1, 0, bottom rails. Row 5 sits against the top rail and row 0 against the bottom rail, so the row indices are *not* a straightforward top-to-bottom sequence.
- **Rows 9 and 4 are the two rows flanking the center channel.** A jumper from `(9,c)` to `(4,c)` is the standard way to cross.
- **Columns ascend right to left**, 0 to 62. Column 62 is at the far left, column 0 at the far right.
- **Rails** are `rtp`, `rtm` (top) and `rbp`, `rbm` (bottom). Each spans the full board width as one net. The bottom rails are unpowered unless jumpered or given their own supply.
- **Workbench connection points:** Input is column 55, Output is column 6, both in row 5's half. Fixed, from `WorkbenchStrip.getConnectionPoints()`.

## The method

**1. Lay the signal chain out in descending column order.** Because columns ascend right to left, a chain that descends in column number reads left to right on screen, which matches the schematic. In the reference layout: input at 55, Q1 at 44-46, Q2 at 38-40, Fuzz at 33-35, tone cap at 30-32, Volume at 28-30, output at 6. Every stage moves right. Leave roughly 4-6 columns per stage.

**2. Put the active devices in one row of the top half, and keep them there.** Both transistors sit in row 6. That one decision drives everything else: their collectors, bases and emitters then have rows 5, 7, 8 available above and below within the same column strips.

**3. Put the pots and long resistors in the bottom half.** Pots in one row (row 1 in the reference), long feedback and bias resistors in their own rows (0 and 3), and leave a row empty between groups as a spacer (row 2 is deliberately empty).

**4. Reserve rows 9 and 4 for jumpers only.** No component legs. These are the crossing lanes, and keeping them clear is most of what makes a board readable.

**5. Connect to power and ground vertically.** A component with one leg in a rail and one in the adjacent board row, at the *same column*, is a clean rail run. `R33k` is `(5,46)` to `(rtp,46)`; `R470` is `(rtp,32)` to `(6,32)`.

**6. Use resistors as the long-distance element.** Resistors are the one part you can reasonably stretch, exactly as you would bend leads on a real board. The reference stretches the 8.2k across 8 columns and the 100k across 7. Do not stretch transistors or pots.

## Hard rules

These are the ones `check-layout.js` enforces:

- **One thing per hole.** Every component leg and every wire end gets its own hole. The reference layout has zero shared holes. Two legs in one hole is electrically identical to two legs in the same column strip, so there is never a reason to overlap them, and overlapping is what makes a board unreadable.
- **Two component legs never sit in the same column strip with nothing marking the connection.** This is legal (the column bonds them into one net) but reads as an accident, not a wiring decision — nothing on screen shows *why* those two legs are related, unlike a wire, which is a visible line you can trace. If two parts need to land on the same net, give one of them its own dedicated node/column and run an explicit jumper to the other, or to the rail, rather than relying on silent column-bonding to join them. A resistor divider's midpoint (two resistors that must share a net) is the case this comes up most: put each resistor in its own column, and wire the midpoint across with a jumper, instead of stacking both legs in one column strip a row apart.
- **Three-leg parts are never stretched.** Transistors and potentiometers go at their natural `leg_span` of 2: three adjacent columns in a single row. Every part in this app has `leg_span: 2`, so 2-leg parts naturally sit at `col` and `col+2`.
- **Cross-channel jumpers run straight.** Same column on both ends, `(9,c)` to `(4,c)`. All 9 crossings in the reference are straight. Diagonal jumpers across the channel are hard to follow.
- **Rows 9 and 4 hold no component legs.**
- **Rail connections are vertical.** Same column at both ends.
- **A column strip holds at most 5 things**, since it has 5 holes. Hitting that limit means the stage needs spreading out.

## Conventions worth following

- **Black wires for ground**, colors for signal. The reference uses `#000000` for all three rail-to-ground jumpers and varied colors elsewhere so crossings stay distinguishable.
- **Title the parts that matter.** `props.title` of `Q1`, `Q2`, `Fuzz`, `Volume` makes both the properties panel and any diagnostic output readable. Untitled parts show up as instance IDs like `RV44FO8`.
- **Keep the whole circuit between the connection points**, roughly columns 28 to 46 for a two-transistor pedal. Do not crowd against column 0 or 62.

## After laying out, check the electrical result too

Layout correctness and electrical correctness are separate. `check-layout.js` says nothing about whether the circuit works. Run the netlist diagnostic as well (see the Verification technique section of CLAUDE.md) to confirm the netlist matches the schematic, no semiconductor terminal is floating, and the DC operating point is sane. A layout can be beautiful and still be wired wrong, and a real Fuzz Face in this project was exactly that: Q2 placed one column off, leaving its collector connected to nothing.
