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

// ── 6b. Two 2-leg parts must not share a column strip with no anchor ───────
// A column strip bonds rows 5-9 (or 0-4) together into one net, so two legs
// landing in the same strip a row apart ARE connected — but nothing on
// screen shows that, unlike a wire, which is a visible traceable line.
// Device-to-rail-resistor strips (rule 5: "connect to power and ground
// vertically") are exempt on purpose — every bundled reference circuit does
// this, and it's unambiguous because a 3-leg device's terminal anchors the
// strip's meaning; anything else landing there is obviously feeding or
// loading that terminal. The genuinely ambiguous case is two 2-leg parts
// (typically a resistor divider's midpoint) sharing a strip with NO 3-leg
// device anywhere in it — nothing marks that connection as deliberate rather
// than accidental. Confirmed on a real MOSFET gate-bias divider where R1 and
// R2's midpoint was left as bare column-bonding instead of an explicit
// jumper. Flag a strip only when it holds 2+ different component instances
// AND none of them is a 3-leg part AND no wire touches the strip.
const stripOwners  = new Map(); // key -> Set of instanceIds
const stripHasWire = new Map(); // key -> bool
const stripHas3Leg = new Map(); // key -> bool
const stripKey = (r, c) => isRail(r) ? null : `${halfOf(r)}:${c}`;
for (const c of components) {
  const d = defs[c.defId];
  const is3Leg = (d?.legs || 2) >= 3;
  c.legs.forEach(l => {
    const k = stripKey(l.row, l.col);
    if (!k) return;
    if (!stripOwners.has(k)) stripOwners.set(k, new Set());
    stripOwners.get(k).add(c.instanceId);
    if (is3Leg) stripHas3Leg.set(k, true);
  });
}
for (const w of wires) {
  for (const [r, cc] of [[w.r1, w.c1], [w.r2, w.c2]]) {
    const k = stripKey(r, cc);
    if (k) stripHasWire.set(k, true);
  }
}
for (const [k, owners] of stripOwners) {
  if (owners.size > 1 && !stripHas3Leg.get(k) && !stripHasWire.get(k)) {
    const names = [...owners].map(id => nameOf(components.find(c => c.instanceId === id)));
    err(`column strip ${k} silently joins ${names.join(' + ')} with no wire and no anchoring device — give one part its own strip and run an explicit jumper to the other (or to a rail) instead of relying on column-bonding alone`);
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
