#!/usr/bin/env node
// Validates a .rw breadboard layout against the conventions in SKILL.md.
// Layout only — says nothing about whether the circuit works electrically.
//
//   node .claude/skills/breadboard-layout/check-layout.js <file.rw> [--verbose]
//
// Exit code 0 = no errors (warnings allowed), 1 = at least one error.
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2];
const VERBOSE = process.argv.includes('--verbose');
if (!FILE) {
  console.error('usage: node check-layout.js <file.rw> [--verbose]');
  process.exit(2);
}

// data/components lives four levels up from .claude/skills/breadboard-layout/
const REPO = path.resolve(__dirname, '..', '..', '..');
const COMP_DIR = path.join(REPO, 'data', 'components');

const defs = {};
for (const f of fs.readdirSync(COMP_DIR)) {
  if (!f.endsWith('.json') || f === 'manifest.json') continue;
  const d = JSON.parse(fs.readFileSync(path.join(COMP_DIR, f), 'utf8'));
  defs[d.id] = d;
}

let layout;
try { layout = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
catch (e) { console.error(`Could not parse ${FILE}: ${e.message}`); process.exit(2); }

const components = layout.components || [];
const wires      = layout.wires || [];

// Fixed by WorkbenchStrip.getConnectionPoints(); a part reaching one of these
// columns can't choose its length.
const IO_COLS = { input: 55, output: 6 };

const isRail   = r => typeof r === 'string';
const halfOf   = r => isRail(r) ? 'rail' : (Number(r) >= 5 ? 'top' : 'bottom');
const nameOf   = c => c.props?.title || c.instanceId;
const legName  = (c, i) => defs[c.defId]?.leg_labels?.[i] || `leg${i + 1}`;

const errors = [], warnings = [];
const err  = m => errors.push(m);
const warn = m => warnings.push(m);

// ── 1. One thing per hole ───────────────────────────────────────────────────
// Rails are exempt: they're one long net and parts legitimately share them.
// Keep the raw row alongside the occupants: reading it back out of the map key
// would turn it into a string, and then isRail() is true for every hole and
// the rail exemption silently swallows the whole check.
const holes = new Map();
const occupy = (r, c, what) => {
  const k = `${r},${c}`;
  if (!holes.has(k)) holes.set(k, { row: r, col: c, who: [] });
  holes.get(k).who.push(what);
};
for (const c of components) c.legs.forEach((l, i) => occupy(l.row, l.col, `${nameOf(c)}.${legName(c, i)}`));
for (const w of wires) { occupy(w.r1, w.c1, `wire ${w.id}`); occupy(w.r2, w.c2, `wire ${w.id}`); }
for (const { row, col, who } of holes.values()) {
  if (who.length > 1 && !isRail(row)) {
    err(`hole (${row},${col}) has ${who.length} things in it: ${who.join(' + ')}`);
  }
}

// ── 2. Three-leg parts must not be stretched ────────────────────────────────
for (const c of components) {
  const d = defs[c.defId];
  if (!d || (d.legs || 2) < 3) continue;
  const rows = [...new Set(c.legs.map(l => l.row))];
  const cols = c.legs.map(l => l.col);
  const span = Math.max(...cols) - Math.min(...cols);
  const natural = d.leg_span ?? 2;
  if (rows.length > 1) err(`${nameOf(c)} (${c.defId}) spans rows ${rows.join(',')} — 3-leg parts must sit in one row`);
  else if (span !== natural) err(`${nameOf(c)} (${c.defId}) is stretched across ${span} columns; 3-leg parts must stay at their natural span of ${natural}`);
}

// ── 3. Two-leg parts: stretching is allowed, but flag the extreme ───────────
for (const c of components) {
  const d = defs[c.defId];
  if (!d || (d.legs || 2) !== 2) continue;
  const rows = [...new Set(c.legs.map(l => l.row))];
  const cols = c.legs.map(l => l.col);
  const span = Math.max(...cols) - Math.min(...cols);
  if (rows.length > 1) {
    // Vertical run. Clean only if it's the same column at both ends.
    if (cols[0] !== cols[1]) {
      warn(`${nameOf(c)} runs diagonally from (${c.legs[0].row},${c.legs[0].col}) to (${c.legs[1].row},${c.legs[1].col}) — rail runs should be straight down one column`);
    }
    continue;
  }
  if (c.defId === 'resistor') continue;     // resistors are the stretchy element by convention
  // A coupling cap reaching the Input (col 55) or Output (col 6) connection
  // point has no choice about its length — those columns are fixed by the
  // workbench, and no other part can do that job.
  if (cols.includes(IO_COLS.input) || cols.includes(IO_COLS.output)) continue;
  if (span > 6) warn(`${nameOf(c)} (${c.defId}) is stretched across ${span} columns; prefer a resistor for long runs, or a jumper`);
}

// ── 4. Rows 9 and 4 are jumper lanes ────────────────────────────────────────
for (const c of components) {
  c.legs.forEach((l, i) => {
    if (l.row === 9 || l.row === 4) {
      warn(`${nameOf(c)}.${legName(c, i)} sits in row ${l.row}, which should be kept clear for cross-channel jumpers`);
    }
  });
}

// ── 5. Cross-channel jumpers run straight ───────────────────────────────────
let crossings = 0;
for (const w of wires) {
  const h1 = halfOf(w.r1), h2 = halfOf(w.r2);
  if (h1 === 'rail' || h2 === 'rail' || h1 === h2) continue;
  crossings++;
  if (w.c1 !== w.c2) {
    warn(`jumper ${w.id} crosses the channel diagonally, (${w.r1},${w.c1}) to (${w.r2},${w.c2}) — straight crossings are much easier to follow`);
  }
}

// ── 6. Column strips hold at most 5 ─────────────────────────────────────────
const strip = new Map();
const bump = (r, c) => {
  if (isRail(r)) return;
  const k = `${halfOf(r)}:${c}`;
  strip.set(k, (strip.get(k) || 0) + 1);
};
for (const c of components) c.legs.forEach(l => bump(l.row, l.col));
for (const w of wires) { bump(w.r1, w.c1); bump(w.r2, w.c2); }
for (const [k, n] of strip) if (n > 5) err(`column strip ${k} has ${n} connections but only 5 holes`);

// ── 6b. A part sharing a strip must actually terminate there ───────────────
// A column strip bonds rows 5-9 (or 0-4) together into one net, so two legs
// landing in the same strip a row apart ARE connected — but nothing on
// screen shows that, unlike a wire, which is a visible traceable line.
//
// The test isn't a headcount (tried that twice and got it wrong both
// directions — see git history). It's whether every part sharing the strip
// is actually DOING something to that strip's net, versus merely passing
// through it on the way to somewhere else. A part's FAR leg (the one not on
// the shared strip) makes its presence legible in any of three ways:
//   - It lands on a rail. Feeding/loading the net from supply or ground —
//     rule 5's canonical vertical connection, used throughout every bundled
//     reference circuit.
//   - It lands on the SAME net as the strip itself (a divider's second arm,
//     reached via a wire elsewhere). Also fine — both arms of a divider
//     genuinely belong to the node they're dividing.
//   - It has an explicit WIRE touching its own hole, even if that wire runs
//     off to a totally different net. The wire itself is the visible marker
//     of intent this whole check exists to require — found on both
//     ELECTRA-DISTORTION's input cap (couples straight into Q1's base
//     column, far leg wired to the Input connection point) and LPB-1's
//     inter-stage coupling cap (far leg wired onward to the next stage).
//     Neither is a coincidence; both are marked as deliberate by the wire.
// A part fails this only when its far leg is a bare, unwired dead end on a
// net unrelated to the strip — that's the real "looks like an accident"
// case: a JFET follower's source strip held the transistor's source, its Rs
// (terminates on a rail, fine) AND an output coupling cap whose far leg was
// a plain unwired hole on a completely separate output-resistor's net. The
// cap had no business being silently folded into the source strip at all.
// Net identity is computed the same way the app's own solver builds nets:
// union-find over column-bonding (within a half) plus explicit wires.
{
  const parent = new Map();
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  const netKey = (r, c) => isRail(r) ? `rail:${r}` : `${halfOf(r)}:${c}`;
  const ensure = (k) => { if (!parent.has(k)) parent.set(k, k); return k; };
  for (const c of components) c.legs.forEach(l => ensure(netKey(l.row, l.col)));
  for (const w of wires) {
    const ka = ensure(netKey(w.r1, w.c1)), kb = ensure(netKey(w.r2, w.c2));
    union(ka, kb);
  }

  const stripOwners = new Map(); // strip key -> Set of instanceIds
  const netHasWire   = new Set(); // union-find root -> a wire touches this net SOMEWHERE
  const stripKey = (r, c) => isRail(r) ? null : `${halfOf(r)}:${c}`;
  for (const c of components) {
    c.legs.forEach(l => {
      const k = stripKey(l.row, l.col);
      if (!k) return;
      if (!stripOwners.has(k)) stripOwners.set(k, new Set());
      stripOwners.get(k).add(c.instanceId);
    });
  }
  // A net counts as "marked deliberate" if a wire touches it ANYWHERE, not
  // just at the exact hole a leg sits in — a leg reaches the wire through
  // column-bonding just as validly as sitting directly on it. This is what
  // a plain per-hole check missed: FUZZ-FACE-NPN's output cap lands on
  // (7,30), which has no wire in that exact hole, but bonds (same column,
  // top half) to (9,30), which IS one end of a standard row-9-to-row-4
  // channel crossing onward to the Volume pot in the bottom half. Checking
  // the hole alone flagged a completely correctly-wired reference circuit.
  for (const w of wires) {
    netHasWire.add(find(netKey(w.r1, w.c1)));
    netHasWire.add(find(netKey(w.r2, w.c2)));
  }
  // Same idea for the fixed Input/Output connection points. A capacitor's
  // two legs are never unioned to each other (same rule the app's own
  // solver uses — see CLAUDE.md's net model), so this can't be "does the
  // net itself touch column 55" — it has to be "does some component with a
  // leg on THIS net also have a (different) leg at column 55 or 6". That's
  // exactly what a coupling cap looks like: one leg on the net it's
  // injecting into, the other leg at the fixed I/O point. ELECTRA-
  // DISTORTION's feedback resistor shares its base-side strip with Input
  // Cap, whose OTHER leg is at column 55 — that's what marks the base net
  // as deliberately reached, not the base leg's own net identity.
  const netTouchesIO = new Set();
  for (const c of components) {
    const hasIOLeg = c.legs.some(l => l.col === IO_COLS.input || l.col === IO_COLS.output);
    if (!hasIOLeg) continue;
    c.legs.forEach(l => {
      if (l.col === IO_COLS.input || l.col === IO_COLS.output) return;
      netTouchesIO.add(find(netKey(l.row, l.col)));
    });
  }

  for (const [k, owners] of stripOwners) {
    if (owners.size < 2) continue;
    // stripKey and netKey use the identical format for non-rail rows
    // (`${halfOf}:${col}`), so the strip's own key IS its net's union-find
    // key — no need to reconstruct a row/col pair from the string.
    const stripNet = find(k);
    for (const id of owners) {
      const c = components.find(cc => cc.instanceId === id);
      const d = defs[c.defId];
      if ((d?.legs || 2) >= 3) continue; // the anchoring device itself never needs to justify being on its own terminal
      const stray = c.legs.some(l => {
        if (l.col === IO_COLS.input || l.col === IO_COLS.output) return false; // fixed workbench connection point, no wire needed to justify it
        const legNet = find(netKey(l.row, l.col));
        if (legNet.startsWith('rail:')) return false;
        if (legNet === stripNet) return false;
        if (netHasWire.has(legNet) || netTouchesIO.has(legNet)) return false; // marked deliberate elsewhere on this net
        return true;
      });
      if (stray) {
        const names = [...owners].map(oid => nameOf(components.find(cc => cc.instanceId === oid)));
        err(`column strip ${k}: ${nameOf(c)} shares this strip with ${names.filter(n=>n!==nameOf(c)).join(', ')} but its other leg is an unwired dead end on a different, unrelated net — give it its own strip and run an explicit jumper instead of relying on column-bonding alone`);
        break;
      }
    }
  }
}

// ── 7. Conventions ──────────────────────────────────────────────────────────
for (const w of wires) {
  if ((isRail(w.r1) || isRail(w.r2)) && w.color && w.color.toLowerCase() !== '#000000') {
    warn(`wire ${w.id} runs to a rail but isn't black — black is the ground/rail convention here`);
  }
}
const allCols = [];
for (const c of components) c.legs.forEach(l => allCols.push(l.col));
for (const w of wires) { allCols.push(w.c1); allCols.push(w.c2); }
if (allCols.length) {
  const lo = Math.min(...allCols), hi = Math.max(...allCols);
  if (lo < 2 || hi > 60) warn(`layout spans columns ${lo}-${hi}, crowding the board edge (0-62)`);
}

// ── report ──────────────────────────────────────────────────────────────────
if (VERBOSE) {
  console.log(`${components.length} components, ${wires.length} wires, ${crossings} cross-channel jumpers`);
  const used = [...strip.entries()].filter(([, n]) => n > 0).length;
  console.log(`${used} column strips in use, ${holes.size} holes occupied`);
  console.log('');
}
for (const m of errors)   console.log(`  ERROR    ${m}`);
for (const m of warnings) console.log(`  warning  ${m}`);
if (!errors.length && !warnings.length) console.log('  clean — no layout problems found');
console.log('');
console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
console.log('Layout only. Electrical correctness is a separate check.');
process.exit(errors.length ? 1 : 0);
